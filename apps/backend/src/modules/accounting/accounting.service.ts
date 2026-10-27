import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CashClosingDto, ExpenseDto } from '@nodedr-restaurant/types';
import { zonedRange } from '../../common/time';
import { BranchTimeService } from '../../common/services/branch-time.service';
import { PrismaService } from '../../prisma/prisma.service';
import { expectedCash, gstSummary, round2 } from './accounting.calc';
import { JournalService } from './journal.service';
import {
  parseTallyXmlResult,
  tallyLiveImportXml,
  tallyPingXml,
  tallyServerUrl,
} from './tally';

const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`);
const dayAfter = (d: string) => new Date(dayStart(d).getTime() + 86_400_000);

@Injectable()
export class AccountingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: BranchTimeService,
    private readonly journal: JournalService,
  ) {}

  // --- Expenses ------------------------------------------------------------

  listExpenses(branchId: string, from: string, to: string) {
    return this.prisma.expense.findMany({
      where: { branchId, spentOn: { gte: dayStart(from), lte: dayStart(to) } },
      orderBy: [{ spentOn: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
  }

  createExpense(branchId: string, userId: string, dto: ExpenseDto) {
    return this.prisma.expense.create({
      data: {
        branchId,
        createdById: userId,
        spentOn: dayStart(dto.spentOn),
        category: dto.category,
        amount: dto.amount,
        note: dto.note,
        paidFromCash: dto.paidFromCash,
        status: 'PENDING',
      },
    });
  }

  async deleteExpense(branchId: string, id: string) {
    const expense = await this.prisma.expense.findFirst({
      where: { id, branchId },
    });
    if (!expense) throw new NotFoundException('Expense not found');
    const closed = await this.prisma.cashClosing.findUnique({
      where: {
        branchId_businessDate: { branchId, businessDate: expense.spentOn },
      },
    });
    if (closed && expense.paidFromCash)
      throw new BadRequestException(
        'That day is already closed — the cash count includes this expense',
      );
    await this.prisma.expense.delete({ where: { id } });
    return { ok: true };
  }

  async decideExpense(
    branchId: string,
    id: string,
    userId: string,
    status: 'APPROVED' | 'REJECTED',
  ) {
    const expense = await this.prisma.expense.findFirst({
      where: { id, branchId },
    });
    if (!expense) throw new NotFoundException('Expense not found');
    if (expense.status !== 'PENDING') {
      throw new BadRequestException('This expense has already been decided');
    }
    const updated = await this.prisma.expense.update({
      where: { id },
      data: { status, decidedById: userId, decidedAt: new Date() },
    });
    if (status === 'APPROVED') {
      await this.journal.tryPostExpense(branchId, userId, updated).catch(() => null);
    }
    return updated;
  }

  listPettyCash(branchId: string, from: string, to: string) {
    return this.prisma.pettyCashEntry.findMany({
      where: { branchId, spentOn: { gte: dayStart(from), lte: dayStart(to) } },
      orderBy: [{ spentOn: 'desc' }, { createdAt: 'desc' }],
      take: 500,
    });
  }

  async addPettyCash(
    branchId: string,
    userId: string,
    dto: { direction: 'IN' | 'OUT'; amount: number; reason: string; spentOn: string },
  ) {
    if (dto.direction === 'OUT') {
      const balance = await this.pettyBalance(branchId);
      if (dto.amount > balance) {
        throw new BadRequestException('Petty cash does not have that much');
      }
    }
    return this.prisma.pettyCashEntry.create({
      data: {
        branchId,
        createdById: userId,
        direction: dto.direction,
        amount: dto.amount,
        reason: dto.reason,
        spentOn: dayStart(dto.spentOn),
      },
    });
  }

  async pettyBalance(branchId: string) {
    const rows = await this.prisma.pettyCashEntry.findMany({
      where: { branchId },
      select: { direction: true, amount: true },
    });
    return round2(
      rows.reduce(
        (sum, row) =>
          sum + (row.direction === 'IN' ? 1 : -1) * Number(row.amount),
        0,
      ),
    );
  }

  // --- Daily cash closing --------------------------------------------------

  /** What the till should hold for a day, before anyone counts it. */
  async closingPreview(branchId: string, date: string, openingFloat = 0) {
    const from = dayStart(date); // @db.Date column: a plain calendar date
    const range = zonedRange(date, date, await this.time.tzForBranch(branchId));
    const [sales, refunds, expenses] = await Promise.all([
      this.prisma.payment.aggregate({
        where: {
          method: 'CASH',
          createdAt: range,
          order: { branchId },
        },
        _sum: { amount: true },
      }),
      this.prisma.refund.aggregate({
        where: {
          method: 'CASH',
          createdAt: range,
          order: { branchId },
        },
        _sum: { amount: true },
      }),
      this.prisma.expense.aggregate({
        where: { branchId, spentOn: from, paidFromCash: true, status: 'APPROVED' },
        _sum: { amount: true },
      }),
    ]);
    const cashSales = Number(sales._sum.amount ?? 0);
    const cashRefunds = Number(refunds._sum.amount ?? 0);
    const cashExpenses = Number(expenses._sum.amount ?? 0);
    return {
      businessDate: date,
      openingFloat,
      cashSales: round2(cashSales - cashRefunds),
      cashExpenses: round2(cashExpenses),
      expectedCash: expectedCash(
        openingFloat,
        cashSales,
        cashRefunds,
        cashExpenses,
      ),
    };
  }

  async closeDay(branchId: string, userId: string, dto: CashClosingDto) {
    const existing = await this.prisma.cashClosing.findUnique({
      where: {
        branchId_businessDate: {
          branchId,
          businessDate: dayStart(dto.businessDate),
        },
      },
    });
    if (existing) throw new BadRequestException('This day is already closed');
    const p = await this.closingPreview(
      branchId,
      dto.businessDate,
      dto.openingFloat,
    );
    return this.prisma.cashClosing.create({
      data: {
        branchId,
        businessDate: dayStart(dto.businessDate),
        openingFloat: dto.openingFloat,
        cashSales: p.cashSales,
        cashExpenses: p.cashExpenses,
        expectedCash: p.expectedCash,
        countedCash: dto.countedCash,
        variance: round2(dto.countedCash - p.expectedCash),
        note: dto.note,
        closedById: userId,
      },
    });
  }

  listClosings(branchId: string) {
    return this.prisma.cashClosing.findMany({
      where: { branchId },
      orderBy: { businessDate: 'desc' },
      take: 60,
    });
  }

  // --- Reports -------------------------------------------------------------

  /** Profit & loss for a period (cash-basis on bills paid in the period). */
  async profitAndLoss(branchId: string, from: string, to: string) {
    const f = dayStart(from); // date columns (expenses, payroll periods)
    const t = dayAfter(to);
    const range = zonedRange(from, to, await this.time.tzForBranch(branchId));
    const [orders, refunds, expenses, runs] = await Promise.all([
      this.prisma.order.aggregate({
        where: { branchId, status: 'PAID', billedAt: range },
        _sum: { totalAmount: true, tipAmount: true, taxAmount: true },
        _count: { _all: true },
      }),
      this.prisma.refund.aggregate({
        where: { createdAt: range, order: { branchId } },
        _sum: { amount: true },
      }),
      this.prisma.expense.groupBy({
        by: ['category'],
        where: { branchId, spentOn: { gte: f, lt: t }, status: 'APPROVED' },
        _sum: { amount: true },
        orderBy: { category: 'asc' },
      }),
      this.prisma.payrollRun.findMany({
        where: {
          branchId,
          status: 'FINALIZED',
          periodEnd: { gte: f, lt: t },
        },
        include: { lines: true },
      }),
    ]);

    // Tips belong to staff, not the restaurant, so they are excluded from
    // revenue (and from payroll cost below).
    const collected =
      Number(orders._sum.totalAmount ?? 0) - Number(orders._sum.tipAmount ?? 0);
    const tax = Number(orders._sum.taxAmount ?? 0);
    const refunded = Number(refunds._sum.amount ?? 0);
    const netSales = round2(collected - tax - refunded);
    const expenseRows = expenses.map((e) => ({
      category: e.category,
      amount: round2(Number(e._sum.amount ?? 0)),
    }));
    const totalExpenses = round2(expenseRows.reduce((s, e) => s + e.amount, 0));
    const payrollCost = round2(
      runs
        .flatMap((r) => r.lines)
        .reduce(
          (s, l) =>
            s +
            Number(l.basePay) -
            Number(l.unpaidLeaveDeduction) +
            Number(l.pfEmployer) +
            Number(l.esiEmployer),
          0,
        ),
    );
    return {
      from,
      to,
      orders: orders._count._all,
      grossCollected: round2(collected),
      taxCollected: round2(tax),
      refunds: round2(refunded),
      netSales,
      expenses: expenseRows,
      totalExpenses,
      payrollCost,
      netProfit: round2(netSales - totalExpenses - payrollCost),
    };
  }

  async gstReport(branchId: string, from: string, to: string) {
    const orders = await this.prisma.order.findMany({
      where: {
        branchId,
        status: 'PAID',
        billedAt: zonedRange(from, to, await this.time.tzForBranch(branchId)),
      },
      select: {
        subtotal: true,
        discountAmount: true,
        loyaltyDiscountAmount: true,
        items: { select: { lineTotal: true, taxRateSnapshot: true } },
      },
    });
    const lines = orders.flatMap((o) => {
      const subtotal = Number(o.subtotal);
      const charged =
        subtotal - Number(o.discountAmount) - Number(o.loyaltyDiscountAmount);
      const factor = subtotal > 0 ? Math.max(0, charged) / subtotal : 1;
      return o.items.map((i) => ({
        lineTotal: Number(i.lineTotal),
        taxRatePercent: Number(i.taxRateSnapshot),
        factor,
      }));
    });
    return { from, to, orders: orders.length, ...gstSummary(lines) };
  }

  /** Cross-branch snapshot for the whole restaurant. */
  async branchOverview(restaurantId: string, from: string, to: string) {
    const range = zonedRange(
      from,
      to,
      await this.time.tzForRestaurant(restaurantId),
    );
    const branches = await this.prisma.branch.findMany({
      where: { restaurantId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    return Promise.all(
      branches.map(async (b) => {
        const [sales, open, ingredients] = await Promise.all([
          this.prisma.order.aggregate({
            where: {
              branchId: b.id,
              status: 'PAID',
              billedAt: range,
            },
            _sum: { totalAmount: true },
            _count: { _all: true },
          }),
          this.prisma.order.count({
            where: { branchId: b.id, status: 'OPEN' },
          }),
          this.prisma.ingredient.findMany({
            where: { branchId: b.id },
            select: {
              currentStock: true,
              reorderLevel: true,
              costPerUnit: true,
            },
          }),
        ]);
        return {
          branchId: b.id,
          name: b.name,
          orders: sales._count._all,
          sales: round2(Number(sales._sum.totalAmount ?? 0)),
          openOrders: open,
          lowStockItems: ingredients.filter(
            (i) =>
              Number(i.reorderLevel) > 0 &&
              Number(i.currentStock) <= Number(i.reorderLevel),
          ).length,
          inventoryValue: round2(
            ingredients.reduce(
              (s, i) => s + Number(i.currentStock) * Number(i.costPerUnit),
              0,
            ),
          ),
        };
      }),
    );
  }

  async accountingExport(branchId: string, from: string, to: string) {
    const range = zonedRange(from, to, await this.time.tzForBranch(branchId));
    const [branch, orders, expenses] = await Promise.all([
      this.prisma.branch.findUnique({
        where: { id: branchId },
        select: {
          name: true,
          restaurant: {
            select: {
              name: true,
              tallyCompanyName: true,
              tallyLedgers: { select: { sourceKey: true, ledgerName: true } },
            },
          },
        },
      }),
      this.prisma.order.findMany({
        where: { branchId, status: 'PAID', billedAt: range },
        select: {
          orderNumber: true,
          totalAmount: true,
          billedAt: true,
          payments: { select: { method: true, amount: true } },
        },
        orderBy: { billedAt: 'asc' },
        take: 2000,
      }),
      this.prisma.expense.findMany({
        where: {
          branchId,
          status: 'APPROVED',
          spentOn: { gte: dayStart(from), lte: dayStart(to) },
        },
        select: { category: true, amount: true, spentOn: true, note: true },
        orderBy: { spentOn: 'asc' },
        take: 2000,
      }),
    ]);
    const companyName =
      branch?.restaurant.tallyCompanyName?.trim() ||
      branch?.restaurant.name ||
      branch?.name ||
      'Restaurant';
    const ledgerByMethod = new Map(
      (branch?.restaurant.tallyLedgers ?? []).map((row) => [
        row.sourceKey,
        row.ledgerName,
      ]),
    );
    const vouchers = [
      ...orders.flatMap((order) => {
        const date = (order.billedAt ?? new Date()).toISOString();
        const groups = new Map<string, number>();
        for (const payment of order.payments) {
          const ledger =
            ledgerByMethod.get(payment.method) ??
            ledgerByMethod.get('OTHER') ??
            payment.method;
          groups.set(ledger, (groups.get(ledger) ?? 0) + Number(payment.amount));
        }
        return [...groups.entries()].map(([ledger, amount]) => ({
          date,
          number: order.orderNumber,
          narration: `Sale ${order.orderNumber}`,
          type: 'Sales' as const,
          amount: round2(amount),
          ledger,
        }));
      }),
      ...expenses.map((expense) => ({
        date: expense.spentOn.toISOString(),
        number: `EXP-${expense.spentOn.toISOString().slice(0, 10)}`,
        narration: expense.note?.trim() || expense.category,
        type: 'Payment' as const,
        amount: round2(Number(expense.amount)),
        ledger: expense.category,
      })),
    ];
    return { companyName, vouchers };
  }

  private async tallyTarget(branchId: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: {
        restaurantId: true,
        restaurant: {
          select: {
            tallyEnabled: true,
            tallyHost: true,
            tallyPort: true,
            tallyUseHttps: true,
            tallyCompanyName: true,
            name: true,
          },
        },
      },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    const host = branch.restaurant.tallyHost?.trim();
    const port = branch.restaurant.tallyPort;
    if (!host || !port) {
      throw new BadRequestException(
        'Set the Tally XML Server host and port in Operations before posting',
      );
    }
    return {
      restaurantId: branch.restaurantId,
      url: tallyServerUrl(host, port, branch.restaurant.tallyUseHttps),
      companyName:
        branch.restaurant.tallyCompanyName?.trim() || branch.restaurant.name,
    };
  }

  private async postXml(url: string, xml: string) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'text/xml; charset=utf-8' },
      body: xml,
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    return { okHttp: res.ok, status: res.status, text };
  }

  async pingTally(branchId: string) {
    const target = await this.tallyTarget(branchId);
    try {
      const posted = await this.postXml(target.url, tallyPingXml(target.companyName));
      const parsed = parseTallyXmlResult(posted.text);
      return {
        url: target.url,
        reachable: posted.okHttp || posted.text.includes('ENVELOPE'),
        httpStatus: posted.status,
        result: parsed,
      };
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error
          ? `Tally XML Server did not answer at ${target.url}: ${err.message}`
          : 'Tally XML Server did not answer',
      );
    }
  }

  async pushTally(branchId: string, from: string, to: string) {
    const target = await this.tallyTarget(branchId);
    const { companyName, vouchers } = await this.accountingExport(
      branchId,
      from,
      to,
    );
    if (vouchers.length === 0) {
      throw new BadRequestException('No paid bills or approved expenses in that range');
    }
    const xml = tallyLiveImportXml(companyName, vouchers);
    try {
      const posted = await this.postXml(target.url, xml);
      const parsed = parseTallyXmlResult(posted.text);
      const row = await this.prisma.tallyPost.create({
        data: {
          restaurantId: target.restaurantId,
          branchId,
          fromDate: dayStart(from),
          toDate: dayStart(to),
          status: parsed.ok || posted.okHttp ? 'SENT' : 'FAILED',
          voucherCount: vouchers.length,
          response: posted.text.slice(0, 4000),
          error: parsed.ok ? null : parsed.message || `HTTP ${posted.status}`,
        },
      });
      return { ...row, url: target.url, result: parsed };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Tally post failed';
      await this.prisma.tallyPost.create({
        data: {
          restaurantId: target.restaurantId,
          branchId,
          fromDate: dayStart(from),
          toDate: dayStart(to),
          status: 'FAILED',
          voucherCount: vouchers.length,
          error: message,
        },
      });
      throw new BadRequestException(
        `Could not reach Tally at ${target.url}: ${message}`,
      );
    }
  }

  listTallyPosts(branchId: string) {
    return this.prisma.tallyPost.findMany({
      where: { branchId },
      orderBy: { createdAt: 'desc' },
      take: 20,
    });
  }
}
