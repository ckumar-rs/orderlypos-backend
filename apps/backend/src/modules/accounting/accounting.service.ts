import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CashClosingDto, ExpenseDto } from '@nodedr-restaurant/types';
import { zonedRange } from '../../common/time';
import { BranchTimeService } from '../../common/services/branch-time.service';
import { PrismaService } from '../../prisma/prisma.service';
import { expectedCash, gstSummary, retainedCash, round2 } from './accounting.calc';
import { branchGstState } from '../../common/india-gst';
import { gstRequirements, planGstBilling } from './gst-billing';
import { JournalService } from './journal.service';
import {
  branchAccountingSettings,
  readBranchSettingsMap,
} from '../settings/settings-kv';
import {
  parseTallyXmlResult,
  tallyLiveImportXml,
  tallyPingXml,
  tallyServerUrl,
} from './tally';

const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`);
const dayAfter = (d: string) => new Date(dayStart(d).getTime() + 86_400_000);
const prevDay = (d: string) =>
  new Date(dayStart(d).getTime() - 86_400_000).toISOString().slice(0, 10);

const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
const ATTACHMENT_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
]);

@Injectable()
export class AccountingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: BranchTimeService,
    private readonly journal: JournalService,
  ) {}

  private async accountingSettings(branchId: string) {
    return branchAccountingSettings(
      await readBranchSettingsMap(this.prisma, branchId),
    );
  }

  /** Throws when `date` (YYYY-MM-DD) falls inside a locked period. */
  async assertUnlocked(branchId: string, date: string) {
    const d = dayStart(date);
    const lock = await this.prisma.accountingPeriodLock.findFirst({
      where: {
        branchId,
        fromDate: { lte: d },
        toDate: { gte: d },
      },
      select: { fromDate: true, toDate: true, reason: true },
    });
    if (!lock) return;
    const from = lock.fromDate.toISOString().slice(0, 10);
    const to = lock.toDate.toISOString().slice(0, 10);
    throw new BadRequestException(
      lock.reason?.trim()
        ? `Period ${from}–${to} is locked: ${lock.reason}`
        : `Period ${from}–${to} is locked`,
    );
  }

  // --- Expenses ------------------------------------------------------------

  listExpenses(branchId: string, from: string, to: string) {
    return this.prisma.expense.findMany({
      where: { branchId, spentOn: { gte: dayStart(from), lte: dayStart(to) } },
      orderBy: [{ spentOn: 'desc' }, { createdAt: 'desc' }],
      take: 500,
      include: {
        attachments: {
          select: { id: true, fileName: true, mimeType: true, size: true, createdAt: true },
        },
      },
    });
  }

  async createExpense(branchId: string, userId: string, dto: ExpenseDto) {
    await this.assertUnlocked(branchId, dto.spentOn);
    const settings = await this.accountingSettings(branchId);
    const status = settings.expenseRequireApproval ? 'PENDING' : 'APPROVED';
    const created = await this.prisma.expense.create({
      data: {
        branchId,
        createdById: userId,
        spentOn: dayStart(dto.spentOn),
        category: dto.category,
        amount: dto.amount,
        note: dto.note,
        vendor: dto.vendor,
        paidFromCash: dto.paidFromCash,
        status,
        ...(status === 'APPROVED'
          ? { decidedById: userId, decidedAt: new Date() }
          : {}),
      },
    });
    if (status === 'APPROVED') {
      const posted = await this.journal.tryPostExpense(branchId, userId, created);
      if (!posted) {
        // Keep the expense — ops still need the spend on record — but tell
        // the cashier to map ledgers so Post missing can catch up.
        return {
          ...created,
          journalWarning:
            'Saved without a journal entry. Map CASH/BANK and this category under Journals, then Post missing.',
        };
      }
    }
    return created;
  }

  async updateExpense(branchId: string, id: string, dto: ExpenseDto) {
    const expense = await this.prisma.expense.findFirst({
      where: { id, branchId },
    });
    if (!expense) throw new NotFoundException('Expense not found');
    if (expense.status !== 'PENDING') {
      throw new BadRequestException('Only a pending expense can be edited');
    }
    await this.assertUnlocked(branchId, dto.spentOn);
    await this.assertUnlocked(
      branchId,
      expense.spentOn.toISOString().slice(0, 10),
    );
    const closed = await this.prisma.cashClosing.findUnique({
      where: {
        branchId_businessDate: { branchId, businessDate: dayStart(dto.spentOn) },
      },
    });
    if (closed && dto.paidFromCash)
      throw new BadRequestException(
        'That day is already closed — cash expenses cannot be changed',
      );
    return this.prisma.expense.update({
      where: { id },
      data: {
        spentOn: dayStart(dto.spentOn),
        category: dto.category,
        amount: dto.amount,
        note: dto.note,
        vendor: dto.vendor,
        paidFromCash: dto.paidFromCash,
      },
    });
  }

  async deleteExpense(branchId: string, id: string) {
    const expense = await this.prisma.expense.findFirst({
      where: { id, branchId },
    });
    if (!expense) throw new NotFoundException('Expense not found');
    await this.assertUnlocked(
      branchId,
      expense.spentOn.toISOString().slice(0, 10),
    );
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

  async addExpenseAttachment(
    branchId: string,
    expenseId: string,
    file: {
      originalname: string;
      mimetype: string;
      size: number;
      buffer: Buffer;
    },
  ) {
    const expense = await this.prisma.expense.findFirst({
      where: { id: expenseId, branchId },
    });
    if (!expense) throw new NotFoundException('Expense not found');
    await this.assertUnlocked(
      branchId,
      expense.spentOn.toISOString().slice(0, 10),
    );
    if (!ATTACHMENT_TYPES.has(file.mimetype)) {
      throw new BadRequestException('Attach a PDF or image (PNG/JPEG/WebP)');
    }
    if (file.size > ATTACHMENT_MAX_BYTES) {
      throw new BadRequestException('File must be 5 MB or smaller');
    }
    const count = await this.prisma.expenseAttachment.count({
      where: { expenseId },
    });
    if (count >= 5) {
      throw new BadRequestException('An expense can hold at most 5 receipts');
    }
    return this.prisma.expenseAttachment.create({
      data: {
        expenseId,
        fileName:
          file.originalname
            // eslint-disable-next-line no-control-regex -- strip control chars from client names
            .replace(/[\\/\u0000-\u001f"]/g, '_')
            .slice(0, 150) || 'receipt',
        mimeType: file.mimetype,
        size: file.size,
        data: new Uint8Array(file.buffer),
      },
      select: {
        id: true,
        fileName: true,
        mimeType: true,
        size: true,
        createdAt: true,
      },
    });
  }

  async getExpenseAttachment(branchId: string, expenseId: string, fileId: string) {
    const expense = await this.prisma.expense.findFirst({
      where: { id: expenseId, branchId },
      select: { id: true },
    });
    if (!expense) throw new NotFoundException('Expense not found');
    const file = await this.prisma.expenseAttachment.findFirst({
      where: { id: fileId, expenseId },
    });
    if (!file) throw new NotFoundException('Attachment not found');
    return file;
  }

  async deleteExpenseAttachment(
    branchId: string,
    expenseId: string,
    fileId: string,
  ) {
    await this.getExpenseAttachment(branchId, expenseId, fileId);
    const expense = await this.prisma.expense.findFirst({
      where: { id: expenseId, branchId },
      select: { spentOn: true },
    });
    if (expense) {
      await this.assertUnlocked(
        branchId,
        expense.spentOn.toISOString().slice(0, 10),
      );
    }
    await this.prisma.expenseAttachment.delete({ where: { id: fileId } });
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
      const posted = await this.journal.tryPostExpense(branchId, userId, updated);
      if (!posted) {
        throw new BadRequestException(
          'Approved, but no ledger map is set for this category (or CASH/BANK). Map accounts under Journals, then use Post missing.',
        );
      }
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
    await this.assertUnlocked(branchId, dto.spentOn);
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

  async updatePettyCash(
    branchId: string,
    id: string,
    dto: { direction: 'IN' | 'OUT'; amount: number; reason: string; spentOn: string },
  ) {
    const row = await this.prisma.pettyCashEntry.findFirst({
      where: { id, branchId },
    });
    if (!row) throw new NotFoundException('Petty cash entry not found');
    await this.assertUnlocked(branchId, dto.spentOn);
    await this.assertUnlocked(branchId, row.spentOn.toISOString().slice(0, 10));
    const balance = await this.pettyBalance(branchId);
    const prior = (row.direction === 'IN' ? 1 : -1) * Number(row.amount);
    const next = (dto.direction === 'IN' ? 1 : -1) * dto.amount;
    // Recompute as if this row were removed, then apply the new amount.
    const without = round2(balance - prior);
    if (without + next < -0.001) {
      throw new BadRequestException('Petty cash does not have that much');
    }
    return this.prisma.pettyCashEntry.update({
      where: { id },
      data: {
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

  async deletePettyCash(branchId: string, id: string) {
    const row = await this.prisma.pettyCashEntry.findFirst({
      where: { id, branchId },
    });
    if (!row) throw new NotFoundException('Petty cash entry not found');
    await this.assertUnlocked(branchId, row.spentOn.toISOString().slice(0, 10));
    await this.prisma.pettyCashEntry.delete({ where: { id } });
    return { ok: true };
  }

  // --- Daily cash closing --------------------------------------------------

  /** What the till should hold for a day, before anyone counts it. */
  async closingPreview(branchId: string, date: string, openingFloat?: number) {
    const from = dayStart(date); // @db.Date column: a plain calendar date
    const range = zonedRange(date, date, await this.time.tzForBranch(branchId));
    const settings = await this.accountingSettings(branchId);
    const prior = await this.prisma.cashClosing.findUnique({
      where: {
        branchId_businessDate: {
          branchId,
          businessDate: dayStart(prevDay(date)),
        },
      },
      select: { countedCash: true, bankDrop: true, safeDrop: true },
    });
    const suggestedOpeningFloat = prior
      ? retainedCash(
          Number(prior.countedCash),
          Number(prior.bankDrop),
          Number(prior.safeDrop),
        )
      : 0;
    const float =
      openingFloat != null && Number.isFinite(openingFloat)
        ? openingFloat
        : suggestedOpeningFloat;
    const [sales, refunds, expenses, petty] = await Promise.all([
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
      this.prisma.pettyCashEntry.findMany({
        where: { branchId, spentOn: from },
        select: { direction: true, amount: true },
      }),
    ]);
    const cashSales = Number(sales._sum.amount ?? 0);
    const cashRefunds = Number(refunds._sum.amount ?? 0);
    const approvedCashExpenses = Number(expenses._sum.amount ?? 0);
    const pettyNetOut = round2(
      petty.reduce(
        (sum, row) =>
          sum + (row.direction === 'OUT' ? 1 : -1) * Number(row.amount),
        0,
      ),
    );
    const pettyInTill = settings.pettyCashInTillClose
      ? Math.max(0, pettyNetOut)
      : 0;
    const cashExpenses = round2(approvedCashExpenses + pettyInTill);
    const expected = expectedCash(
      float,
      cashSales,
      cashRefunds,
      cashExpenses,
    );
    return {
      businessDate: date,
      openingFloat: float,
      suggestedOpeningFloat,
      cashSales: round2(cashSales - cashRefunds),
      cashExpenses: round2(cashExpenses),
      pettyCashInTillClose: settings.pettyCashInTillClose,
      pettyNetOut,
      expectedCash: expected,
      varianceWarnAmount: settings.cashVarianceWarnAmount,
    };
  }

  async closeDay(branchId: string, userId: string, dto: CashClosingDto) {
    await this.assertUnlocked(branchId, dto.businessDate);
    const existing = await this.prisma.cashClosing.findUnique({
      where: {
        branchId_businessDate: {
          branchId,
          businessDate: dayStart(dto.businessDate),
        },
      },
    });
    if (existing) throw new BadRequestException('This day is already closed');
    const bankDrop = dto.bankDrop ?? 0;
    const safeDrop = dto.safeDrop ?? 0;
    if (bankDrop + safeDrop > dto.countedCash + 0.001) {
      throw new BadRequestException(
        'Bank and safe drops cannot exceed counted cash',
      );
    }
    const p = await this.closingPreview(
      branchId,
      dto.businessDate,
      dto.openingFloat,
    );
    const variance = round2(dto.countedCash - p.expectedCash);
    const warn = p.varianceWarnAmount;
    const note =
      warn > 0 && Math.abs(variance) >= warn && !dto.note?.trim()
        ? `Variance ${variance} exceeds warn threshold ${warn}`
        : dto.note;
    return this.prisma.cashClosing.create({
      data: {
        branchId,
        businessDate: dayStart(dto.businessDate),
        openingFloat: dto.openingFloat,
        cashSales: p.cashSales,
        cashExpenses: p.cashExpenses,
        expectedCash: p.expectedCash,
        countedCash: dto.countedCash,
        bankDrop,
        safeDrop,
        variance,
        note,
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

  /** Reopen a closed day so staff can recount (deletes the closing row). */
  async reopenDay(branchId: string, id: string) {
    const row = await this.prisma.cashClosing.findFirst({
      where: { id, branchId },
    });
    if (!row) throw new NotFoundException('Cash closing not found');
    await this.assertUnlocked(
      branchId,
      row.businessDate.toISOString().slice(0, 10),
    );
    await this.prisma.cashClosing.delete({ where: { id } });
    return { ok: true, businessDate: row.businessDate.toISOString().slice(0, 10) };
  }

  async adjustClosing(
    branchId: string,
    id: string,
    dto: { countedCash?: number; note?: string },
  ) {
    const row = await this.prisma.cashClosing.findFirst({
      where: { id, branchId },
    });
    if (!row) throw new NotFoundException('Cash closing not found');
    await this.assertUnlocked(
      branchId,
      row.businessDate.toISOString().slice(0, 10),
    );
    const counted =
      dto.countedCash != null ? dto.countedCash : Number(row.countedCash);
    return this.prisma.cashClosing.update({
      where: { id },
      data: {
        countedCash: counted,
        variance: round2(counted - Number(row.expectedCash)),
        ...(dto.note !== undefined ? { note: dto.note } : {}),
      },
    });
  }

  // --- Reports -------------------------------------------------------------

  /** Profit & loss for a period (cash-basis on bills paid in the period). */
  async profitAndLoss(branchId: string, from: string, to: string) {
    const f = dayStart(from); // date columns (expenses, payroll periods)
    const t = dayAfter(to);
    const range = zonedRange(from, to, await this.time.tzForBranch(branchId));
    const [orders, refunds, expenses, runs, soldLines] = await Promise.all([
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
      this.prisma.orderItem.findMany({
        where: {
          complimentary: false,
          order: { branchId, status: 'PAID', billedAt: range },
        },
        select: {
          quantity: true,
          portionFactor: true,
          menuItem: { select: { costPrice: true } },
        },
      }),
    ]);

    // Tips belong to staff, not the restaurant, so they are excluded from
    // revenue (and from payroll cost below).
    const collected =
      Number(orders._sum.totalAmount ?? 0) - Number(orders._sum.tipAmount ?? 0);
    const tax = Number(orders._sum.taxAmount ?? 0);
    const refunded = Number(refunds._sum.amount ?? 0);
    const netSales = round2(collected - tax - refunded);
    const cogs = round2(
      soldLines.reduce((sum, line) => {
        const cost = Number(line.menuItem.costPrice ?? 0);
        if (!(cost > 0)) return sum;
        return (
          sum +
          cost * Number(line.quantity) * Number(line.portionFactor ?? 1)
        );
      }, 0),
    );
    const grossProfit = round2(netSales - cogs);
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
      cogs,
      grossProfit,
      expenses: expenseRows,
      totalExpenses,
      payrollCost,
      netProfit: round2(grossProfit - totalExpenses - payrollCost),
    };
  }

  async gstReport(branchId: string, from: string, to: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { taxMode: true },
    });
    const taxMode = (branch?.taxMode === 'EXCLUSIVE' ? 'EXCLUSIVE' : 'INCLUSIVE') as
      | 'INCLUSIVE'
      | 'EXCLUSIVE';
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
    return { from, to, orders: orders.length, taxMode, ...gstSummary(lines, taxMode) };
  }

  async gstBilling(branchId: string, from: string, to: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { gstNumber: true, gstStateCode: true, name: true, taxMode: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    const taxMode = (branch.taxMode === 'EXCLUSIVE' ? 'EXCLUSIVE' : 'INCLUSIVE') as
      | 'INCLUSIVE'
      | 'EXCLUSIVE';
    const orders = await this.prisma.order.findMany({
      where: {
        branchId,
        status: 'PAID',
        billedAt: zonedRange(from, to, await this.time.tzForBranch(branchId)),
      },
      orderBy: { billedAt: 'desc' },
      take: 500,
      select: {
        orderNumber: true,
        billedAt: true,
        guestName: true,
        subtotal: true,
        discountAmount: true,
        loyaltyDiscountAmount: true,
        customer: { select: { name: true, gstStateCode: true } },
        items: {
          select: { nameSnapshot: true, hsnCode: true, quantity: true, lineTotal: true, taxRateSnapshot: true },
        },
        refunds: { select: { amount: true, createdAt: true } },
      },
    });
    const plan = planGstBilling(
      branchGstState(branch.gstStateCode, branch.gstNumber),
      orders.map((order) => ({
        orderNumber: order.orderNumber,
        billedAt: (order.billedAt ?? order.refunds[0]?.createdAt ?? new Date()).toISOString(),
        guestName: order.guestName || order.customer?.name || null,
        guestState: order.customer?.gstStateCode ?? null,
        subtotal: Number(order.subtotal),
        discountAmount: Number(order.discountAmount),
        loyaltyDiscountAmount: Number(order.loyaltyDiscountAmount),
        lines: order.items.map((item) => ({
          name: item.nameSnapshot,
          hsnCode: item.hsnCode,
          quantity: item.quantity,
          lineTotal: Number(item.lineTotal),
          taxRatePercent: Number(item.taxRateSnapshot),
        })),
        refunds: order.refunds.map((refund) => ({
          amount: Number(refund.amount),
          createdAt: refund.createdAt.toISOString(),
        })),
      })),
      taxMode,
    );
    return {
      from,
      to,
      branchName: branch.name,
      gstin: branch.gstNumber,
      stateCode: branch.gstStateCode,
      taxMode,
      requirements: gstRequirements({
        gstin: branch.gstNumber,
        stateCode: branch.gstStateCode,
        missingHsn: plan.missingHsn,
        lineCount: plan.lineCount,
      }),
      documents: plan.documents,
      creditNotes: plan.creditNotes,
      hsn: plan.hsn,
      rates: plan.rates,
      cgst: plan.cgst,
      sgst: plan.sgst,
      utgst: plan.utgst,
      igst: plan.igst,
    };
  }

  /** Simplified GSTR-1 style JSON for portal handoff (B2C + HSN + CDNR). */
  async gstr1Export(branchId: string, from: string, to: string) {
    const billing = await this.gstBilling(branchId, from, to);
    const b2cs = billing.rates.rows.map((row) => ({
      rt: row.ratePercent,
      sply_ty: 'INTRA',
      txval: row.taxableValue,
      iamt: 0,
      camt: round2(row.tax / 2),
      samt: round2(row.tax - row.tax / 2),
      csamt: 0,
    }));
    return {
      gstin: billing.gstin,
      fp: from.slice(0, 7).replace('-', ''),
      from,
      to,
      taxMode: billing.taxMode,
      b2cs,
      hsn: {
        data: billing.hsn.map((row, idx) => ({
          num: idx + 1,
          hsn_sc: row.code === 'Missing' ? '' : row.code,
          txval: row.taxable,
          iamt: 0,
          camt: round2(row.tax / 2),
          samt: round2(row.tax - row.tax / 2),
          csamt: 0,
        })),
      },
      cdnr: billing.creditNotes.map((note) => ({
        nt: {
          ntty: 'C',
          nt_num: note.orderNumber,
          nt_dt: note.createdAt.slice(0, 10),
          val: note.amount,
          txval: note.taxable,
          iamt: note.igst,
          camt: note.cgst,
          samt: note.sgst + note.utgst,
        },
      })),
      meta: {
        branchName: billing.branchName,
        documentCount: billing.documents.length,
        cgst: billing.cgst,
        sgst: billing.sgst,
        utgst: billing.utgst,
        igst: billing.igst,
      },
    };
  }

  profitAndLossCsv(pnl: Awaited<ReturnType<AccountingService['profitAndLoss']>>) {
    const lines = [
      ['Metric', 'Amount'],
      ['Orders', String(pnl.orders)],
      ['Gross collected', String(pnl.grossCollected)],
      ['Tax collected', String(pnl.taxCollected)],
      ['Refunds', String(pnl.refunds)],
      ['Net sales', String(pnl.netSales)],
      ['COGS', String(pnl.cogs)],
      ['Gross profit', String(pnl.grossProfit)],
      ...pnl.expenses.map((e) => [e.category, String(e.amount)] as [string, string]),
      ['Payroll', String(pnl.payrollCost)],
      ['Net profit', String(pnl.netProfit)],
    ];
    return lines
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
  }

  gstCsv(gst: Awaited<ReturnType<AccountingService['gstReport']>>) {
    const lines = [
      ['Rate %', 'Taxable', 'Tax', 'Total'],
      ...gst.rows.map(
        (r) =>
          [
            String(r.ratePercent),
            String(r.taxableValue),
            String(r.tax),
            String(r.total),
          ] as [string, string, string, string],
      ),
      ['TOTAL', String(gst.totalTaxable), String(gst.totalTax), ''],
    ];
    return lines
      .map((row) => row.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');
  }

  async consolidatedProfitAndLoss(restaurantId: string, from: string, to: string) {
    const branches = await this.prisma.branch.findMany({
      where: { restaurantId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const rows = await Promise.all(
      branches.map(async (b) => {
        const pnl = await this.profitAndLoss(b.id, from, to);
        return { branchId: b.id, name: b.name, ...pnl };
      }),
    );
    const sum = (pick: (r: (typeof rows)[number]) => number) =>
      round2(rows.reduce((s, r) => s + pick(r), 0));
    return {
      from,
      to,
      branches: rows,
      totals: {
        orders: rows.reduce((s, r) => s + r.orders, 0),
        grossCollected: sum((r) => r.grossCollected),
        taxCollected: sum((r) => r.taxCollected),
        refunds: sum((r) => r.refunds),
        netSales: sum((r) => r.netSales),
        cogs: sum((r) => r.cogs),
        grossProfit: sum((r) => r.grossProfit),
        totalExpenses: sum((r) => r.totalExpenses),
        payrollCost: sum((r) => r.payrollCost),
        netProfit: sum((r) => r.netProfit),
      },
    };
  }

  listPeriodLocks(branchId: string) {
    return this.prisma.accountingPeriodLock.findMany({
      where: { branchId },
      orderBy: { fromDate: 'desc' },
      take: 60,
    });
  }

  async createPeriodLock(
    branchId: string,
    userId: string,
    dto: { fromDate: string; toDate: string; reason?: string },
  ) {
    if (dto.toDate < dto.fromDate) {
      throw new BadRequestException('toDate must be on or after fromDate');
    }
    return this.prisma.accountingPeriodLock.create({
      data: {
        branchId,
        fromDate: dayStart(dto.fromDate),
        toDate: dayStart(dto.toDate),
        reason: dto.reason,
        lockedById: userId,
      },
    });
  }

  async deletePeriodLock(branchId: string, id: string) {
    const row = await this.prisma.accountingPeriodLock.findFirst({
      where: { id, branchId },
    });
    if (!row) throw new NotFoundException('Period lock not found');
    await this.prisma.accountingPeriodLock.delete({ where: { id } });
    return { ok: true };
  }

  listTillHistory(branchId: string, from?: string, to?: string) {
    return this.prisma.tillSession.findMany({
      where: {
        branchId,
        ...(from || to
          ? {
              openedAt: {
                ...(from ? { gte: dayStart(from) } : {}),
                ...(to ? { lt: dayAfter(to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { openedAt: 'desc' },
      take: 100,
      include: {
        openedBy: { select: { name: true } },
        closedBy: { select: { name: true } },
      },
    });
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
