import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { round2 } from '../../common/money';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Parses one CSV line honouring double-quoted cells. */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

function toIsoDate(raw: string): string | null {
  const s = raw.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // dd/mm/yyyy or dd-mm-yyyy (the Indian bank statement default)
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? `20${m[3]}` : m[3];
    return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

const num = (raw: string | undefined) => {
  if (!raw) return 0;
  const n = Number(raw.replace(/[,₹$\s]/g, ''));
  return Number.isFinite(n) ? n : 0;
};

/**
 * Turns a bank statement CSV into signed rows. Accepts either a single
 * `amount` column (negative = money out) or separate `debit` / `credit`
 * columns, which is how most Indian bank exports look.
 */
export function parseStatement(csv: string) {
  const lines = csv
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((l) => l.trim());
  if (lines.length < 2)
    throw new BadRequestException('The statement has no rows');
  const head = parseCsvLine(lines[0]).map((h) => h.toLowerCase());
  const find = (...names: string[]) =>
    head.findIndex((h) => names.some((n) => h.includes(n)));
  const iDate = find('date');
  const iDesc = find('description', 'narration', 'particulars', 'details');
  const iRef = find('reference', 'ref', 'cheque', 'utr');
  const iAmount = head.findIndex((h) => h === 'amount');
  const iDebit = find('debit', 'withdrawal');
  const iCredit = find('credit', 'deposit');
  if (iDate < 0 || iDesc < 0 || (iAmount < 0 && iDebit < 0 && iCredit < 0))
    throw new BadRequestException(
      'Statement needs date, description and amount (or debit/credit) columns',
    );
  const rows: {
    postedOn: string;
    description: string;
    reference: string;
    amount: number;
  }[] = [];
  const skipped: number[] = [];
  lines.slice(1).forEach((line, idx) => {
    const c = parseCsvLine(line);
    const postedOn = toIsoDate(c[iDate] ?? '');
    const amount =
      iAmount >= 0 ? num(c[iAmount]) : num(c[iCredit]) - num(c[iDebit]);
    if (!postedOn || !amount) {
      skipped.push(idx + 2);
      return;
    }
    rows.push({
      postedOn,
      description: (c[iDesc] ?? '').slice(0, 300) || 'Bank transaction',
      reference: iRef >= 0 ? (c[iRef] ?? '').slice(0, 80) : '',
      amount: round2(amount),
    });
  });
  return { rows, skipped };
}

@Injectable()
export class LedgerService {
  constructor(private readonly prisma: PrismaService) {}

  // --- Budgets ---------------------------------------------------------------

  async setBudget(
    branchId: string,
    dto: { month: string; category: string; amount: number },
  ) {
    if (!MONTH.test(dto.month))
      throw new BadRequestException('Month must look like 2026-10');
    const category = dto.category.trim();
    if (!category) throw new BadRequestException('Category is required');
    return this.prisma.budget.upsert({
      where: {
        branchId_month_category: { branchId, month: dto.month, category },
      },
      update: { amount: dto.amount },
      create: { branchId, month: dto.month, category, amount: dto.amount },
    });
  }

  async deleteBudget(branchId: string, id: string) {
    const b = await this.prisma.budget.findFirst({ where: { id, branchId } });
    if (!b) throw new NotFoundException('Budget not found');
    await this.prisma.budget.delete({ where: { id } });
    return { ok: true };
  }

  /** Budget vs actual spend per category for one month. */
  async budgetVsActual(branchId: string, month: string) {
    if (!MONTH.test(month))
      throw new BadRequestException('Month must look like 2026-10');
    const [y, m] = month.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1));
    const to = new Date(Date.UTC(y, m, 1));
    const [budgets, spend] = await Promise.all([
      this.prisma.budget.findMany({
        where: { branchId, month },
        orderBy: { category: 'asc' },
      }),
      this.prisma.expense.groupBy({
        by: ['category'],
        where: { branchId, spentOn: { gte: from, lt: to } },
        _sum: { amount: true },
      }),
    ]);
    const actualBy = new Map<string, number>();
    for (const s of spend)
      actualBy.set(
        s.category.trim().toLowerCase(),
        round2(Number(s._sum.amount ?? 0)),
      );
    const used = new Set<string>();
    const rows = budgets.map((b) => {
      const key = b.category.trim().toLowerCase();
      used.add(key);
      const budget = Number(b.amount);
      const actual = actualBy.get(key) ?? 0;
      return {
        id: b.id,
        category: b.category,
        budget,
        actual,
        remaining: round2(budget - actual),
        percentUsed: budget > 0 ? Math.round((actual / budget) * 100) : 0,
      };
    });
    const unbudgeted = [...actualBy.entries()]
      .filter(([k]) => !used.has(k))
      .map(([category, actual]) => ({ category, actual }));
    const totalBudget = round2(rows.reduce((s, r) => s + r.budget, 0));
    const totalActual = round2(rows.reduce((s, r) => s + r.actual, 0));
    return {
      month,
      rows,
      unbudgeted,
      totalBudget,
      totalActual,
      remaining: round2(totalBudget - totalActual),
    };
  }

  // --- Bank reconciliation ---------------------------------------------------

  async importStatement(branchId: string, csv: string) {
    const { rows, skipped } = parseStatement(csv);
    if (rows.length > 5000)
      throw new BadRequestException('Import at most 5000 rows at a time');
    const res = await this.prisma.bankTransaction.createMany({
      data: rows.map((r) => ({
        branchId,
        postedOn: new Date(`${r.postedOn}T00:00:00.000Z`),
        description: r.description,
        reference: r.reference,
        amount: r.amount,
      })),
      skipDuplicates: true,
    });
    const matched = await this.autoMatch(branchId);
    return {
      imported: res.count,
      duplicatesIgnored: rows.length - res.count,
      skippedLines: skipped,
      autoMatched: matched,
    };
  }

  /**
   * Matches money-out lines to unmatched expenses with the same amount spent
   * within 5 days of the bank posting date. One expense matches one line.
   */
  async autoMatch(branchId: string): Promise<number> {
    const txs = await this.prisma.bankTransaction.findMany({
      where: { branchId, status: 'UNMATCHED', amount: { lt: 0 } },
      orderBy: { postedOn: 'asc' },
    });
    let count = 0;
    if (txs.length) {
    const taken = new Set(
      (
        await this.prisma.bankTransaction.findMany({
          where: { branchId, expenseId: { not: null } },
          select: { expenseId: true },
        })
      ).map((t) => t.expenseId as string),
    );
    const expenses = await this.prisma.expense.findMany({
      where: { branchId, paidFromCash: false },
    });
    for (const t of txs) {
      const amt = Math.abs(Number(t.amount));
      const best = expenses
        .filter(
          (e) =>
            !taken.has(e.id) &&
            Math.abs(Number(e.amount) - amt) < 0.005 &&
            Math.abs(e.spentOn.getTime() - t.postedOn.getTime()) <=
              5 * 86400000,
        )
        .sort(
          (a, b) =>
            Math.abs(a.spentOn.getTime() - t.postedOn.getTime()) -
            Math.abs(b.spentOn.getTime() - t.postedOn.getTime()),
        )[0];
      if (!best) continue;
      taken.add(best.id);
      await this.prisma.bankTransaction.update({
        where: { id: t.id },
        data: { status: 'MATCHED', expenseId: best.id },
      });
      count++;
    }
    }
    const inbound = await this.prisma.bankTransaction.findMany({
      where: { branchId, status: 'UNMATCHED', amount: { gt: 0 }, reference: { not: '' } },
    });
    for (const line of inbound) {
      const payment = await this.prisma.payment.findFirst({
        where: {
          order: { branchId },
          bankMatches: { none: {} },
          OR: [{ reference: line.reference }, { utr: line.reference }],
        },
      });
      if (!payment || Math.abs(Number(payment.amount) - Number(line.amount)) >= 0.005) continue;
      await this.prisma.bankTransaction.update({
        where: { id: line.id },
        data: { status: 'MATCHED', paymentId: payment.id },
      });
      count++;
    }
    return count;
  }

  async reconciliation(branchId: string, from?: string, to?: string) {
    const where = {
      branchId,
      ...(from || to
        ? {
            postedOn: {
              ...(from ? { gte: new Date(`${from}T00:00:00.000Z`) } : {}),
              ...(to ? { lte: new Date(`${to}T00:00:00.000Z`) } : {}),
            },
          }
        : {}),
    };
    const txs = await this.prisma.bankTransaction.findMany({
      where,
      orderBy: [{ postedOn: 'desc' }, { createdAt: 'desc' }],
      take: 1000,
    });
    const expenseIds = txs.map((t) => t.expenseId).filter(Boolean) as string[];
    const expenses = expenseIds.length
      ? await this.prisma.expense.findMany({
          where: { id: { in: expenseIds } },
          select: { id: true, category: true, note: true, spentOn: true },
        })
      : [];
    const byId = new Map(expenses.map((e) => [e.id, e]));
    const count = (s: string) => txs.filter((t) => t.status === s).length;
    return {
      summary: {
        total: txs.length,
        matched: count('MATCHED'),
        unmatched: count('UNMATCHED'),
        ignored: count('IGNORED'),
        moneyIn: round2(
          txs
            .filter((t) => Number(t.amount) > 0)
            .reduce((s, t) => s + Number(t.amount), 0),
        ),
        moneyOut: round2(
          txs
            .filter((t) => Number(t.amount) < 0)
            .reduce((s, t) => s + Number(t.amount), 0),
        ),
      },
      transactions: txs.map((t) => ({
        id: t.id,
        postedOn: t.postedOn,
        description: t.description,
        reference: t.reference,
        amount: Number(t.amount),
        status: t.status,
        expense: t.expenseId ? (byId.get(t.expenseId) ?? null) : null,
      })),
    };
  }

  async setBankStatus(
    branchId: string,
    id: string,
    status: 'UNMATCHED' | 'IGNORED',
  ) {
    const t = await this.prisma.bankTransaction.findFirst({
      where: { id, branchId },
    });
    if (!t) throw new NotFoundException('Bank transaction not found');
    return this.prisma.bankTransaction.update({
      where: { id },
      data: { status, expenseId: null },
    });
  }

  /** Candidate expenses a user can pick for a manual match. */
  async matchCandidates(branchId: string, id: string) {
    const t = await this.prisma.bankTransaction.findFirst({
      where: { id, branchId },
    });
    if (!t) throw new NotFoundException('Bank transaction not found');
    const taken = (
      await this.prisma.bankTransaction.findMany({
        where: { branchId, expenseId: { not: null } },
        select: { expenseId: true },
      })
    ).map((x) => x.expenseId as string);
    const around = 15 * 86400000;
    return this.prisma.expense.findMany({
      where: {
        branchId,
        id: { notIn: taken },
        spentOn: {
          gte: new Date(t.postedOn.getTime() - around),
          lte: new Date(t.postedOn.getTime() + around),
        },
      },
      orderBy: { spentOn: 'desc' },
      take: 50,
    });
  }

  async matchManually(branchId: string, id: string, expenseId: string) {
    const [t, e] = await Promise.all([
      this.prisma.bankTransaction.findFirst({ where: { id, branchId } }),
      this.prisma.expense.findFirst({ where: { id: expenseId, branchId } }),
    ]);
    if (!t || !e)
      throw new NotFoundException('Transaction or expense not found');
    const used = await this.prisma.bankTransaction.findFirst({
      where: { branchId, expenseId, NOT: { id } },
    });
    if (used) throw new BadRequestException('That expense is already matched');
    return this.prisma.bankTransaction.update({
      where: { id },
      data: { status: 'MATCHED', expenseId },
    });
  }

  // --- Balance sheet ---------------------------------------------------------

  /**
   * Management balance sheet as of a date. It is derived from what the POS
   * records, not a double-entry ledger, so it is a snapshot for the owner —
   * not a statutory filing. Cash is "all money taken less all money paid
   * out"; equity is the balancing figure (assets minus liabilities).
   */
  async balanceSheet(branchId: string, asOf: string) {
    const end = new Date(`${asOf}T23:59:59.999Z`);
    const endDate = new Date(`${asOf}T00:00:00.000Z`);
    const [
      payments,
      refunds,
      expenses,
      supplierPaid,
      payroll,
      ingredients,
      invoices,
      giftCards,
    ] = await Promise.all([
      this.prisma.payment.aggregate({
        where: {
          order: { branchId },
          createdAt: { lte: end },
          method: {
            in: ['CASH', 'CARD', 'UPI', 'WALLET', 'BANK_TRANSFER', 'OTHER'],
          },
        },
        _sum: { amount: true },
      }),
      this.prisma.refund.aggregate({
        where: { order: { branchId }, createdAt: { lte: end } },
        _sum: { amount: true },
      }),
      this.prisma.expense.aggregate({
        where: { branchId, spentOn: { lte: endDate } },
        _sum: { amount: true },
      }),
      this.prisma.supplierPayment.aggregate({
        where: { branchId, paidAt: { lte: end } },
        _sum: { amount: true },
      }),
      this.prisma.payrollRun.findMany({
        where: { branchId, status: 'FINALIZED', periodEnd: { lte: endDate } },
        include: { lines: true },
      }),
      this.prisma.ingredient.findMany({
        where: { branchId },
        select: { currentStock: true, costPerUnit: true },
      }),
      this.prisma.supplierInvoice.findMany({
        where: { branchId, invoiceDate: { lte: end } },
        select: { totalAmount: true, amountPaid: true },
      }),
      this.prisma.giftCard.findMany({
        where: { branchId },
        select: { balance: true },
      }),
    ]);
    const payrollPaid = round2(
      payroll
        .flatMap((r) => r.lines)
        .reduce(
          (s, l) => s + Number(l.basePay) - Number(l.unpaidLeaveDeduction),
          0,
        ),
    );
    const cash = round2(
      Number(payments._sum.amount ?? 0) -
        Number(refunds._sum.amount ?? 0) -
        Number(expenses._sum.amount ?? 0) -
        Number(supplierPaid._sum.amount ?? 0) -
        payrollPaid,
    );
    const inventory = round2(
      ingredients.reduce(
        (s, i) =>
          s + Math.max(0, Number(i.currentStock)) * Number(i.costPerUnit),
        0,
      ),
    );
    const payables = round2(
      invoices.reduce(
        (s, i) => s + Math.max(0, Number(i.totalAmount) - Number(i.amountPaid)),
        0,
      ),
    );
    const giftLiability = round2(
      giftCards.reduce((s, g) => s + Number(g.balance), 0),
    );
    const totalAssets = round2(cash + inventory);
    const totalLiabilities = round2(payables + giftLiability);
    return {
      asOf,
      assets: [
        { label: 'Cash and bank (net of all payments out)', amount: cash },
        { label: 'Inventory at cost', amount: inventory },
      ],
      liabilities: [
        { label: 'Supplier invoices unpaid', amount: payables },
        { label: 'Gift card balances owed', amount: giftLiability },
      ],
      totalAssets,
      totalLiabilities,
      equity: round2(totalAssets - totalLiabilities),
      note: 'Management snapshot built from POS records, not a statutory balance sheet.',
    };
  }
}
