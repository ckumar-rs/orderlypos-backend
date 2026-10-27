import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { SessionUser } from '@nodedr-restaurant/types';
import { openSecret } from '../../auth/totp';
import { PrismaService } from '../../prisma/prisma.service';
import { completeChatJson } from '../inventory/ai-chat';
import { longestPrep, ticketIsLate } from '../kds/late-ticket';
import {
  asksAboutOtherBranches,
  asksForPrivateContact,
  filterTools,
  renderAnswer,
  replyStaysInside,
  toolsForQuestion,
  type AgentScope,
  type BranchFacts,
  type ComparisonRow,
} from './agent-plan';

const LIST_CAP = 15;

function money(value: unknown) {
  return Number(value ?? 0).toFixed(2);
}

function startOfLocalDay(now: Date) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  return start;
}

function startOfLocalMonth(now: Date) {
  const start = startOfLocalDay(now);
  start.setDate(1);
  return start;
}

@Injectable()
export class AgentService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async ask(
    user: SessionUser,
    branchId: string,
    question: string,
    scope: AgentScope,
  ) {
    const text = question.trim();
    if (text.length < 2 || text.length > 500) {
      throw new BadRequestException('Ask a question in a sentence or two');
    }
    if (scope === 'restaurant' && !user.permissions.includes('reports.access')) {
      throw new ForbiddenException(
        'The restaurant agent is for people who can open reports for every branch',
      );
    }
    const home = await this.prisma.branch.findFirst({
      where: { id: branchId, restaurantId: user.restaurantId, isActive: true },
      select: { id: true, name: true },
    });
    if (!home) throw new BadRequestException('Choose a branch first');

    const planned = toolsForQuestion(text, scope);
    const { allowed, skipped } = filterTools(planned, user.permissions, scope);
    const branches =
      scope === 'branch'
        ? [home]
        : await this.prisma.branch.findMany({
            where: { restaurantId: user.restaurantId, isActive: true },
            select: { id: true, name: true },
            orderBy: { name: 'asc' },
            take: 12,
          });
    const now = new Date();
    const facts: BranchFacts[] = [];
    for (const branch of branches) {
      facts.push(await this.branchFacts(branch.id, branch.name, allowed, now));
    }
    const comparison = allowed.includes('branch_comparison')
      ? await this.comparison(user.restaurantId, now)
      : undefined;
    const records = renderAnswer({
      branches: facts,
      comparison,
      skipped,
      privateContact: asksForPrivateContact(text),
      otherBranchesFromBranchChat: scope === 'branch' && asksAboutOtherBranches(text),
    });
    const phrased = await this.phrase(user.restaurantId, text, records);
    return {
      answer: phrased ?? records,
      source: phrased ? 'model' : 'records',
      scope,
      tools: allowed,
      skipped,
    };
  }

  private async branchFacts(
    branchId: string,
    branchName: string,
    tools: string[],
    now: Date,
  ): Promise<BranchFacts> {
    const facts: BranchFacts = { branchName };
    const day = startOfLocalDay(now);
    const month = startOfLocalMonth(now);
    if (tools.includes('sales_today')) facts.salesToday = await this.sales(branchId, day);
    if (tools.includes('sales_month')) facts.salesMonth = await this.sales(branchId, month);
    if (tools.includes('open_orders')) facts.openOrders = await this.openOrders(branchId);
    if (tools.includes('late_tickets')) facts.lateTickets = await this.lateTickets(branchId, now);
    if (tools.includes('low_stock')) facts.lowStock = await this.lowStock(branchId);
    if (tools.includes('reservations_today')) {
      facts.reservations = await this.reservations(branchId, day);
    }
    return facts;
  }

  private async sales(branchId: string, from: Date) {
    const [total, orders] = await Promise.all([
      this.prisma.order.aggregate({
        where: { branchId, status: 'PAID', billedAt: { gte: from } },
        _sum: { totalAmount: true },
      }),
      this.prisma.order.count({
        where: { branchId, status: 'PAID', billedAt: { gte: from } },
      }),
    ]);
    return { orders, total: money(total._sum.totalAmount) };
  }

  private async openOrders(branchId: string) {
    const rows = await this.prisma.order.findMany({
      where: { branchId, status: 'OPEN' },
      orderBy: { createdAt: 'asc' },
      take: LIST_CAP,
      select: {
        orderNumber: true,
        type: true,
        totalAmount: true,
        table: { select: { number: true } },
      },
    });
    return rows.map((row) => ({
      orderNumber: row.orderNumber,
      type: row.type,
      total: money(row.totalAmount),
      table: row.table?.number ?? null,
    }));
  }

  private async lateTickets(branchId: string, now: Date) {
    const rows = await this.prisma.kot.findMany({
      where: {
        held: false,
        status: { in: ['NEW', 'ACCEPTED', 'PREPARING'] },
        order: { branchId },
      },
      orderBy: { createdAt: 'asc' },
      take: 80,
      select: {
        ticketNumber: true,
        status: true,
        createdAt: true,
        station: { select: { name: true } },
        order: { select: { orderNumber: true } },
        items: {
          select: {
            orderItem: { select: { menuItem: { select: { prepTimeMinutes: true } } } },
          },
        },
      },
    });
    return rows
      .filter((row) =>
        ticketIsLate({
          status: row.status,
          held: false,
          createdAt: row.createdAt,
          prepMinutes: longestPrep(
            row.items.map((item) => item.orderItem.menuItem?.prepTimeMinutes),
          ),
          now,
        }),
      )
      .slice(0, LIST_CAP)
      .map((row) => ({
        ticketNumber: row.ticketNumber,
        orderNumber: row.order.orderNumber,
        station: row.station?.name ?? 'Kitchen',
        status: row.status,
        ageMinutes: Math.max(1, Math.round((now.getTime() - row.createdAt.getTime()) / 60_000)),
      }));
  }

  private async lowStock(branchId: string) {
    const rows = await this.prisma.ingredient.findMany({
      where: { branchId, isActive: true, reorderLevel: { gt: 0 } },
      select: { name: true, currentStock: true, reorderLevel: true },
      orderBy: { name: 'asc' },
    });
    return rows
      .filter((row) => Number(row.currentStock) <= Number(row.reorderLevel))
      .slice(0, 20)
      .map((row) => ({
        name: row.name,
        stock: money(row.currentStock),
        reorder: money(row.reorderLevel),
      }));
  }

  private async reservations(branchId: string, day: Date) {
    const end = new Date(day);
    end.setDate(end.getDate() + 1);
    const rows = await this.prisma.reservation.findMany({
      where: {
        branchId,
        reservedAt: { gte: day, lt: end },
        status: { in: ['RESERVED', 'CONFIRMED', 'ARRIVED'] },
      },
      orderBy: { reservedAt: 'asc' },
      take: LIST_CAP,
      select: {
        customerName: true,
        guestCount: true,
        reservedAt: true,
        status: true,
        table: { select: { number: true } },
      },
    });
    return rows.map((row) => ({
      name: row.customerName,
      guests: row.guestCount,
      at: row.reservedAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }),
      table: row.table?.number ?? null,
      status: row.status,
    }));
  }

  private async comparison(restaurantId: string, now: Date): Promise<ComparisonRow[]> {
    const start = startOfLocalMonth(now);
    const branches = await this.prisma.branch.findMany({
      where: { restaurantId, isActive: true },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
    const ids = branches.map((branch) => branch.id);
    const [orders, noShows] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['branchId'],
        where: { branchId: { in: ids }, status: 'PAID', billedAt: { gte: start } },
        _sum: { totalAmount: true, guestCount: true },
        _count: { _all: true },
      }),
      this.prisma.reservation.groupBy({
        by: ['branchId'],
        where: { branchId: { in: ids }, status: 'NO_SHOW', reservedAt: { gte: start } },
        _count: { id: true },
      }),
    ]);
    const sales = new Map(orders.map((row) => [row.branchId, row]));
    const missed = new Map(noShows.map((row) => [row.branchId, row._count.id]));
    return branches
      .map((branch) => {
        const row = sales.get(branch.id);
        const count = row?._count._all ?? 0;
        const total = Number(row?._sum.totalAmount ?? 0);
        return {
          name: branch.name,
          orders: count,
          sales: total.toFixed(2),
          aov: (count ? total / count : 0).toFixed(2),
          covers: Number(row?._sum.guestCount ?? 0),
          noShows: missed.get(branch.id) ?? 0,
        };
      })
      .sort((a, b) => Number(b.sales) - Number(a.sales));
  }

  private async phrase(restaurantId: string, question: string, records: string) {
    try {
      const restaurant = await this.prisma.restaurant.findUnique({
        where: { id: restaurantId },
        select: {
          aiEnabled: true,
          aiBaseUrl: true,
          aiModel: true,
          aiTokenSealed: true,
        },
      });
      const token = restaurant?.aiTokenSealed
        ? openSecret(
            restaurant.aiTokenSealed,
            this.config.get<string>('WEBHOOK_KEY') ?? this.config.get<string>('JWT_SECRET') ?? '',
          )
        : '';
      if (!restaurant?.aiEnabled || !restaurant.aiBaseUrl || !restaurant.aiModel || !token) {
        return null;
      }
      const reply = await completeChatJson({
        baseUrl: restaurant.aiBaseUrl,
        token,
        model: restaurant.aiModel,
        system:
          'You answer a restaurant manager from the records below. Use only numbers that already appear. Do not invent a branch, an order, or a stock figure. Do not tell anyone to take a payment, change a price, edit stock, or send a message. If a line says Not included, say that login cannot see it. Keep the reply under 120 words.',
        user: `Question: ${question}\n\nRecords:\n${records}`,
      });
      return replyStaysInside(reply, records) ? reply : null;
    } catch {
      return null;
    }
  }
}
