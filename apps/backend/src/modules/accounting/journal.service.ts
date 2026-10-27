import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  JournalVoucherDto,
  LedgerAccountDto,
  LedgerAccountMapDto,
} from '@nodedr-restaurant/types';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { round2 } from './accounting.calc';
import { assertBalanced, nextJournalNumber } from './journal';

@Injectable()
export class JournalService {
  constructor(private readonly prisma: PrismaService) {}

  listAccounts(branchId: string) {
    return this.prisma.ledgerAccount.findMany({
      where: { branchId },
      orderBy: [{ type: 'asc' }, { code: 'asc' }],
    });
  }

  async createAccount(branchId: string, dto: LedgerAccountDto) {
    try {
      return await this.prisma.ledgerAccount.create({
        data: {
          branchId,
          code: dto.code.trim(),
          name: dto.name.trim(),
          type: dto.type,
          isActive: dto.isActive ?? true,
        },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new BadRequestException('That account code already exists');
      }
      throw err;
    }
  }

  async updateAccount(
    branchId: string,
    id: string,
    dto: Partial<LedgerAccountDto>,
  ) {
    const row = await this.prisma.ledgerAccount.findFirst({
      where: { id, branchId },
    });
    if (!row) throw new NotFoundException('Account not found');
    return this.prisma.ledgerAccount.update({
      where: { id },
      data: {
        ...(dto.code != null ? { code: dto.code.trim() } : {}),
        ...(dto.name != null ? { name: dto.name.trim() } : {}),
        ...(dto.type ? { type: dto.type } : {}),
        ...(dto.isActive != null ? { isActive: dto.isActive } : {}),
      },
    });
  }

  listMaps(branchId: string) {
    return this.prisma.ledgerAccountMap.findMany({
      where: { branchId },
      include: { account: { select: { id: true, code: true, name: true } } },
      orderBy: { sourceKey: 'asc' },
    });
  }

  async upsertMap(branchId: string, dto: LedgerAccountMapDto) {
    const account = await this.prisma.ledgerAccount.findFirst({
      where: { id: dto.accountId, branchId },
    });
    if (!account) throw new BadRequestException('Account is not on this branch');
    return this.prisma.ledgerAccountMap.upsert({
      where: {
        branchId_sourceKey: { branchId, sourceKey: dto.sourceKey.trim() },
      },
      create: {
        branchId,
        sourceKey: dto.sourceKey.trim(),
        accountId: dto.accountId,
      },
      update: { accountId: dto.accountId },
    });
  }

  async deleteMap(branchId: string, id: string) {
    const row = await this.prisma.ledgerAccountMap.findFirst({
      where: { id, branchId },
    });
    if (!row) throw new NotFoundException('Mapping not found');
    await this.prisma.ledgerAccountMap.delete({ where: { id } });
    return { ok: true };
  }

  async listJournals(branchId: string, from: string, to: string) {
    return this.prisma.journalVoucher.findMany({
      where: {
        branchId,
        postedOn: {
          gte: new Date(`${from}T00:00:00.000Z`),
          lte: new Date(`${to}T00:00:00.000Z`),
        },
      },
      orderBy: [{ postedOn: 'desc' }, { createdAt: 'desc' }],
      take: 400,
      include: {
        lines: {
          include: { account: { select: { code: true, name: true, type: true } } },
        },
      },
    });
  }

  async postJournal(
    branchId: string,
    userId: string,
    dto: JournalVoucherDto,
    extras?: { sourceType?: string; sourceId?: string },
  ) {
    assertBalanced(dto.lines);
    const accountIds = [...new Set(dto.lines.map((line) => line.accountId))];
    const accounts = await this.prisma.ledgerAccount.count({
      where: { id: { in: accountIds }, branchId, isActive: true },
    });
    if (accounts !== accountIds.length) {
      throw new BadRequestException('One or more accounts are invalid');
    }
    if (extras?.sourceId) {
      const existing = await this.prisma.journalVoucher.findFirst({
        where: {
          branchId,
          sourceType: extras.sourceType ?? 'MANUAL',
          sourceId: extras.sourceId,
        },
      });
      if (existing) return existing;
    }
    const number =
      dto.number?.trim() ||
      nextJournalNumber(
        (
          await this.prisma.journalVoucher.findMany({
            where: { branchId, number: { startsWith: `JV-${dto.postedOn.replace(/-/g, '')}-` } },
            select: { number: true },
          })
        ).map((row) => row.number),
        dto.postedOn,
      );
    try {
      return await this.prisma.journalVoucher.create({
        data: {
          branchId,
          number,
          postedOn: new Date(`${dto.postedOn}T00:00:00.000Z`),
          narration: dto.narration.trim(),
          sourceType: extras?.sourceType ?? 'MANUAL',
          sourceId: extras?.sourceId ?? null,
          createdById: userId,
          lines: {
            create: dto.lines.map((line) => ({
              accountId: line.accountId,
              debit: round2(Number(line.debit) || 0),
              credit: round2(Number(line.credit) || 0),
            })),
          },
        },
        include: { lines: true },
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new BadRequestException('That voucher number already exists');
      }
      throw err;
    }
  }

  async trialBalance(branchId: string, from: string, to: string) {
    const vouchers = await this.prisma.journalVoucher.findMany({
      where: {
        branchId,
        postedOn: {
          gte: new Date(`${from}T00:00:00.000Z`),
          lte: new Date(`${to}T00:00:00.000Z`),
        },
      },
      include: {
        lines: {
          include: { account: { select: { id: true, code: true, name: true, type: true } } },
        },
      },
    });
    const byAccount = new Map<
      string,
      { accountId: string; code: string; name: string; type: string; debit: number; credit: number }
    >();
    for (const voucher of vouchers) {
      for (const line of voucher.lines) {
        const row =
          byAccount.get(line.accountId) ??
          {
            accountId: line.accountId,
            code: line.account.code,
            name: line.account.name,
            type: line.account.type,
            debit: 0,
            credit: 0,
          };
        row.debit = round2(row.debit + Number(line.debit));
        row.credit = round2(row.credit + Number(line.credit));
        byAccount.set(line.accountId, row);
      }
    }
    const rows = [...byAccount.values()].sort((a, b) => a.code.localeCompare(b.code));
    return {
      from,
      to,
      rows,
      totalDebit: round2(rows.reduce((sum, row) => sum + row.debit, 0)),
      totalCredit: round2(rows.reduce((sum, row) => sum + row.credit, 0)),
    };
  }

  async tryPostSale(
    branchId: string,
    userId: string,
    order: {
      id: string;
      orderNumber: string;
      billedAt: Date | null;
      payments: { method: string; amount: unknown }[];
    },
  ) {
    const maps = await this.mapByKey(branchId);
    const sales = maps.get('SALES');
    if (!sales || order.payments.length === 0) return null;
    const groups = new Map<string, number>();
    for (const payment of order.payments) {
      const account =
        maps.get(payment.method) ?? maps.get('OTHER') ?? maps.get('CASH');
      if (!account) return null;
      groups.set(
        account.id,
        round2((groups.get(account.id) ?? 0) + Number(payment.amount)),
      );
    }
    const postedOn = (order.billedAt ?? new Date()).toISOString().slice(0, 10);
    const lines = [...groups.entries()].flatMap(([accountId, amount]) => [
      { accountId, debit: amount, credit: 0 },
      { accountId: sales.id, debit: 0, credit: amount },
    ]);
    return this.postJournal(
      branchId,
      userId,
      {
        postedOn,
        narration: `Sale ${order.orderNumber}`,
        lines,
      },
      { sourceType: 'SALE', sourceId: order.id },
    );
  }

  async tryPostExpense(
    branchId: string,
    userId: string,
    expense: {
      id: string;
      category: string;
      amount: unknown;
      spentOn: Date;
      paidFromCash: boolean;
    },
  ) {
    const maps = await this.mapByKey(branchId);
    const expenseAccount =
      maps.get(expense.category) ?? maps.get('EXPENSE');
    const creditAccount =
      maps.get(expense.paidFromCash ? 'CASH' : 'BANK') ??
      maps.get('CASH') ??
      maps.get('BANK');
    if (!expenseAccount || !creditAccount) return null;
    const amount = round2(Number(expense.amount));
    return this.postJournal(
      branchId,
      userId,
      {
        postedOn: expense.spentOn.toISOString().slice(0, 10),
        narration: expense.category,
        lines: [
          { accountId: expenseAccount.id, debit: amount, credit: 0 },
          { accountId: creditAccount.id, debit: 0, credit: amount },
        ],
      },
      { sourceType: 'EXPENSE', sourceId: expense.id },
    );
  }

  async autoPostMissing(branchId: string, userId: string) {
    const [orders, expenses] = await Promise.all([
      this.prisma.order.findMany({
        where: { branchId, status: 'PAID' },
        select: {
          id: true,
          orderNumber: true,
          billedAt: true,
          payments: { select: { method: true, amount: true } },
        },
        take: 200,
        orderBy: { billedAt: 'desc' },
      }),
      this.prisma.expense.findMany({
        where: { branchId, status: 'APPROVED' },
        take: 200,
        orderBy: { spentOn: 'desc' },
      }),
    ]);
    const posted = await this.prisma.journalVoucher.findMany({
      where: {
        branchId,
        sourceType: { in: ['SALE', 'EXPENSE'] },
        sourceId: { not: null },
      },
      select: { sourceType: true, sourceId: true },
    });
    const seen = new Set(posted.map((row) => `${row.sourceType}:${row.sourceId}`));
    let created = 0;
    for (const order of orders) {
      if (seen.has(`SALE:${order.id}`)) continue;
      const row = await this.tryPostSale(branchId, userId, order);
      if (row && !seen.has(`SALE:${order.id}`)) created += 1;
    }
    for (const expense of expenses) {
      if (seen.has(`EXPENSE:${expense.id}`)) continue;
      const row = await this.tryPostExpense(branchId, userId, expense);
      if (row) created += 1;
    }
    return { created };
  }

  private async mapByKey(branchId: string) {
    const rows = await this.prisma.ledgerAccountMap.findMany({
      where: { branchId },
      include: { account: true },
    });
    return new Map(rows.map((row) => [row.sourceKey, row.account]));
  }
}
