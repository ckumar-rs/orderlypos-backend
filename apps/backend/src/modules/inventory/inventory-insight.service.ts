import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { addDaysToDate, localDateKey, zonedRange } from '../../common/time';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { EmailService } from '../email/email.service';
import { nextAlertTier, type AlertTier } from './alert-tier';
import { anomaly } from './anomaly';
import { menuEngineering } from './menu-engineering';
import { recipeCost } from './recipe-cost';
import { BUILTIN_CONVERSIONS, convertQuantity, type ConversionRow } from './unit-convert';

@Injectable()
export class InventoryInsightService {
  private readonly logger = new Logger(InventoryInsightService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
  ) {}

  async listUnits(branchId: string) {
    const custom = await this.prisma.unitConversion.findMany({
      where: { branchId },
      orderBy: [{ fromUnit: 'asc' }, { toUnit: 'asc' }],
    });
    return {
      builtin: BUILTIN_CONVERSIONS,
      custom: custom.map((row) => ({
        id: row.id,
        fromUnit: row.fromUnit,
        toUnit: row.toUnit,
        factor: Number(row.factor),
      })),
    };
  }

  async createUnit(branchId: string, fromUnit: string, toUnit: string, factor: number) {
    if (fromUnit === toUnit) throw new BadRequestException('Choose two different units');
    if (!(factor > 0)) throw new BadRequestException('The factor must be greater than zero');
    const builtin = BUILTIN_CONVERSIONS.some(
      (row) =>
        (row.fromUnit === fromUnit && row.toUnit === toUnit) ||
        (row.fromUnit === toUnit && row.toUnit === fromUnit),
    );
    if (builtin) throw new BadRequestException('That conversion is already built in');
    return this.prisma.unitConversion.upsert({
      where: { branchId_fromUnit_toUnit: { branchId, fromUnit: fromUnit as never, toUnit: toUnit as never } },
      create: { branchId, fromUnit: fromUnit as never, toUnit: toUnit as never, factor },
      update: { factor },
    });
  }

  async deleteUnit(branchId: string, id: string) {
    const row = await this.prisma.unitConversion.findFirst({ where: { id, branchId } });
    if (!row) throw new NotFoundException('Conversion not found');
    await this.prisma.unitConversion.delete({ where: { id } });
    return { ok: true };
  }

  async recipes(branchId: string) {
    const [items, custom] = await Promise.all([
      this.prisma.menuItem.findMany({
        where: { branchId, isActive: true },
        include: { recipeLines: { include: { ingredient: true } } },
        orderBy: { name: 'asc' },
      }),
      this.customRows(branchId),
    ]);
    return items.map((item) => {
      const priced = item.recipeLines.map((line) => ({
        quantity: this.stockQuantity(line, custom),
        costPerUnit: Number(line.ingredient.costPerUnit),
      }));
      const cost = recipeCost(priced, item.servings, item.yieldQuantity == null ? null : Number(item.yieldQuantity));
      return {
        id: item.id,
        name: item.name,
        price: Number(item.price),
        servings: item.servings,
        yieldQuantity: item.yieldQuantity == null ? null : Number(item.yieldQuantity),
        yieldUnit: item.yieldUnit,
        portionStep: Number(item.portionStep),
        lines: item.recipeLines.length,
        batchCost: cost.batchCost,
        perServing: cost.perServing,
        perYield: cost.perYield,
      };
    });
  }

  async engineering(branchId: string, from: string, to: string) {
    if (from > to) throw new BadRequestException('The start date is after the end date');
    const tz = await this.timezone(branchId);
    const range = zonedRange(from, to, tz);
    const [items, sales, custom] = await Promise.all([
      this.prisma.menuItem.findMany({
        where: { branchId, isActive: true },
        include: { recipeLines: { include: { ingredient: true } } },
      }),
      this.prisma.orderItem.findMany({
        where: { order: { branchId, status: 'PAID', createdAt: range } },
        select: { menuItemId: true, quantity: true, weightKg: true, portionFactor: true, unitPriceSnapshot: true },
      }),
      this.customRows(branchId),
    ]);
    const sold = new Map<string, { qty: number; price: number }>();
    for (const line of sales) {
      const units = (line.weightKg != null ? Number(line.weightKg) : line.quantity) * Number(line.portionFactor);
      const current = sold.get(line.menuItemId) ?? { qty: 0, price: Number(line.unitPriceSnapshot) };
      current.qty += units;
      current.price = Number(line.unitPriceSnapshot);
      sold.set(line.menuItemId, current);
    }
    const rows = menuEngineering(
      items
        .filter((item) => item.recipeLines.length > 0 || sold.has(item.id))
        .map((item) => {
          const priced = item.recipeLines.map((line) => ({
            quantity: this.stockQuantity(line, custom),
            costPerUnit: Number(line.ingredient.costPerUnit),
          }));
          const cost = recipeCost(priced, item.servings, null);
          const sale = sold.get(item.id);
          return {
            id: item.id,
            name: item.name,
            sold: Math.round((sale?.qty ?? 0) * 1000) / 1000,
            price: sale?.price ?? Number(item.price),
            foodCost: cost.perServing,
          };
        }),
    );
    return { from, to, rows };
  }

  async anomalies(branchId: string) {
    const tz = await this.timezone(branchId);
    const today = localDateKey(new Date(), tz);
    const start = addDaysToDate(today, -13);
    const range = zonedRange(start, today, tz);
    const days: string[] = [];
    for (let i = 0; i < 14; i += 1) days.push(addDaysToDate(start, i));
    const [orders, waste, refunds, movements] = await Promise.all([
      this.prisma.order.findMany({
        where: { branchId, status: 'PAID', createdAt: range },
        select: { createdAt: true, totalAmount: true, discountAmount: true },
      }),
      this.prisma.wasteLog.findMany({
        where: { branchId, createdAt: range },
        select: { createdAt: true, quantity: true, unitCostAtWaste: true },
      }),
      this.prisma.refund.findMany({
        where: { order: { branchId }, createdAt: range },
        select: { createdAt: true, amount: true },
      }),
      this.prisma.stockMovement.findMany({
        where: { branchId, createdAt: range, type: { in: ['ADJUSTMENT', 'WASTE', 'RECEIPT'] } },
        select: { createdAt: true, quantity: true },
      }),
    ]);
    const bucket = () => new Map(days.map((day) => [day, 0]));
    const sales = bucket();
    const discounts = bucket();
    const wasteCost = bucket();
    const refundTotal = bucket();
    const stock = bucket();
    const dayOf = (instant: Date) => localDateKey(instant, tz);
    for (const order of orders) {
      const day = dayOf(order.createdAt);
      if (!sales.has(day)) continue;
      sales.set(day, (sales.get(day) ?? 0) + Number(order.totalAmount));
      discounts.set(day, (discounts.get(day) ?? 0) + Number(order.discountAmount));
    }
    for (const row of waste) {
      const day = dayOf(row.createdAt);
      if (!wasteCost.has(day)) continue;
      wasteCost.set(day, (wasteCost.get(day) ?? 0) + Number(row.quantity) * Number(row.unitCostAtWaste));
    }
    for (const row of refunds) {
      const day = dayOf(row.createdAt);
      if (!refundTotal.has(day)) continue;
      refundTotal.set(day, (refundTotal.get(day) ?? 0) + Number(row.amount));
    }
    for (const row of movements) {
      const day = dayOf(row.createdAt);
      if (!stock.has(day)) continue;
      stock.set(day, (stock.get(day) ?? 0) + Math.abs(Number(row.quantity)));
    }
    const metrics = [
      ['Sales', sales],
      ['Discounts', discounts],
      ['Waste', wasteCost],
      ['Refunds', refundTotal],
      ['Stock movement', stock],
    ] as const;
    return metrics.flatMap(([name, values]) => {
      const result = anomaly(days.map((day) => values.get(day) ?? 0));
      if (!result?.flagged) return [];
      return [{ metric: name, ...result }];
    });
  }

  listAlerts(branchId: string) {
    return this.prisma.inventoryAlert.findMany({
      where: { branchId },
      orderBy: { openedAt: 'asc' },
    });
  }

  async runAlerts(branchId: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { restaurantId: true, restaurant: { select: { demoMode: true, name: true } } },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    const soon = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const [ingredients, batches, existing] = await Promise.all([
      this.prisma.ingredient.findMany({ where: { branchId, isActive: true } }),
      this.prisma.stockBatch.findMany({
        where: { branchId, quantityRemaining: { gt: 0 }, expiryDate: { not: null, lte: soon } },
        include: { ingredient: { select: { name: true } } },
      }),
      this.prisma.inventoryAlert.findMany({ where: { branchId } }),
    ]);
    const open = [
      ...ingredients
        .filter((item) => Number(item.reorderLevel) > 0 && Number(item.currentStock) <= Number(item.reorderLevel))
        .map((item) => ({
          kind: 'LOW_STOCK',
          subjectKey: item.id,
          title: `${item.name} is at ${Number(item.currentStock)} ${item.unit} (reorder ${Number(item.reorderLevel)})`,
        })),
      ...batches.map((batch) => ({
        kind: 'EXPIRY',
        subjectKey: batch.id,
        title: `${batch.ingredient.name} expires ${batch.expiryDate?.toISOString().slice(0, 10) ?? ''}`.trim(),
      })),
    ];
    const live = new Set(open.map((item) => `${item.kind}:${item.subjectKey}`));
    const stale = existing.filter((row) => !live.has(`${row.kind}:${row.subjectKey}`));
    if (stale.length > 0) {
      await this.prisma.inventoryAlert.deleteMany({ where: { id: { in: stale.map((row) => row.id) } } });
    }
    for (const item of open) {
      const previous = existing.find((row) => row.kind === item.kind && row.subjectKey === item.subjectKey);
      const ageHours = previous ? (Date.now() - previous.openedAt.getTime()) / 3_600_000 : 0;
      const tier = nextAlertTier((previous?.tier as AlertTier | undefined) ?? null, ageHours);
      if (!tier) continue;
      await this.deliver(branchId, branch.restaurantId, branch.restaurant.demoMode, branch.restaurant.name, tier, item.title);
      await this.prisma.inventoryAlert.upsert({
        where: {
          branchId_kind_subjectKey: { branchId, kind: item.kind, subjectKey: item.subjectKey },
        },
        create: { branchId, kind: item.kind, subjectKey: item.subjectKey, title: item.title, tier },
        update: { title: item.title, tier, lastSentAt: new Date() },
      });
    }
    return this.listAlerts(branchId);
  }

  @Cron(CronExpression.EVERY_HOUR)
  async scheduledAlerts() {
    const branches = await this.prisma.branch.findMany({
      select: { id: true, restaurant: { select: { timezone: true } } },
    });
    const now = new Date();
    for (const branch of branches) {
      let hour = -1;
      try {
        hour = Number(
          new Intl.DateTimeFormat('en-US', {
            timeZone: branch.restaurant.timezone,
            hour: 'numeric',
            hourCycle: 'h23',
          }).format(now),
        );
      } catch {
        continue;
      }
      if (hour !== 9) continue;
      try {
        await this.runAlerts(branch.id);
      } catch (err) {
        this.logger.warn(
          `Inventory alerts failed for ${branch.id}: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private async deliver(
    branchId: string,
    restaurantId: string,
    demoMode: boolean,
    restaurantName: string,
    tier: AlertTier,
    title: string,
  ) {
    const permission = tier === 'ESCALATE' ? 'settings.manage' : 'inventory.manage';
    const label = tier === 'ESCALATE' ? `Escalated: ${title}` : title;
    try {
      await this.notifications.notifyByPermission(branchId, permission, {
        type: tier === 'ESCALATE' ? 'stock.escalated' : 'stock.alert',
        title: tier === 'PUSH' ? 'Inventory alert' : tier === 'EMAIL' ? 'Inventory alert still open' : 'Inventory alert escalated',
        body: label,
        entity: 'InventoryAlert',
      });
    } catch (err) {
      this.logger.warn(`Inventory push failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (tier === 'PUSH' || demoMode) return;
    if (!(await this.email.isConfiguredFor(restaurantId))) return;
    const people = await this.prisma.user.findMany({
      where: {
        isActive: true,
        email: { not: null },
        branches: { some: { branchId } },
        role: { permissions: { some: { permission: { key: permission } } } },
      },
      select: { email: true },
    });
    const to = people.map((person) => person.email).filter((email): email is string => Boolean(email));
    if (to.length === 0) return;
    try {
      await this.email.sendEach(
        to.map((address) => ({
          to: address,
          subject: `${restaurantName}: ${label}`,
          text: label,
        })),
        restaurantId,
      );
    } catch (err) {
      this.logger.warn(`Inventory email failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async timezone(branchId: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { restaurant: { select: { timezone: true } } },
    });
    return branch?.restaurant.timezone || 'Asia/Kolkata';
  }

  private async customRows(branchId: string): Promise<ConversionRow[]> {
    const rows = await this.prisma.unitConversion.findMany({ where: { branchId } });
    return rows.map((row) => ({ fromUnit: row.fromUnit, toUnit: row.toUnit, factor: Number(row.factor) }));
  }

  private stockQuantity(
    line: { quantity: { toString(): string }; unit: string | null; ingredient: { unit: string } },
    custom: ConversionRow[],
  ) {
    const from = line.unit ?? line.ingredient.unit;
    const converted = convertQuantity(Number(line.quantity), from, line.ingredient.unit, custom);
    return converted ?? Number(line.quantity);
  }
}
