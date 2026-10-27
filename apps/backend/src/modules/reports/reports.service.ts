import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { permissionSatisfied } from '@nodedr-restaurant/types';
import { BranchTimeService } from '../../common/services/branch-time.service';
import { localDate, localMinuteAndDay, zonedRange } from '../../common/time';
import { PrismaService } from '../../prisma/prisma.service';
import { AccountingService } from '../accounting/accounting.service';
import type { CsvValue } from './csv';

export interface ReportResult {
  key: string;
  title: string;
  columns: string[];
  rows: CsvValue[][];
}

export const REPORT_CATALOG = [
  { key: 'sales-daily', title: 'Daily sales', group: 'Sales' },
  { key: 'sales-by-item', title: 'Sales by item', group: 'Sales' },
  { key: 'sales-by-category', title: 'Sales by category', group: 'Sales' },
  { key: 'popular-items', title: 'Popular items', group: 'Sales' },
  { key: 'slow-movers', title: 'Slow movers', group: 'Sales' },
  { key: 'payment-methods', title: 'Payment methods', group: 'Sales' },
  { key: 'discounts', title: 'Discounts & coupons', group: 'Sales' },
  { key: 'tax', title: 'Tax (GST) summary', group: 'Tax' },
  { key: 'peak-hours', title: 'Peak hours', group: 'Analytics' },
  { key: 'food-cost', title: 'Food cost & margins', group: 'Analytics' },
  { key: 'customers', title: 'Top customers', group: 'Customers' },
  { key: 'retention', title: 'New vs returning customers', group: 'Customers' },
  { key: 'staff-sales', title: 'Staff sales', group: 'Staff' },
  { key: 'table-turnover', title: 'Table turnover', group: 'Operations' },
  { key: 'reservations', title: 'Reservations', group: 'Operations' },
  { key: 'delivery', title: 'Deliveries', group: 'Operations' },
  { key: 'waste', title: 'Waste', group: 'Inventory' },
  {
    key: 'inventory-valuation',
    title: 'Inventory valuation',
    group: 'Inventory',
  },
] as const;

// Reports that expose revenue / sales totals. They need the dedicated
// dashboard.sales.view permission on top of reports.access, so granting
// reports.access (e.g. to an inventory manager) never leaks sales figures.
export const SALES_REPORT_KEYS: ReadonlySet<string> = new Set([
  'sales-daily',
  'sales-by-item',
  'sales-by-category',
  'popular-items',
  'slow-movers',
  'payment-methods',
  'discounts',
  'tax',
  'peak-hours',
  'food-cost',
  'customers',
  'retention',
  'staff-sales',
]);

export function canViewReport(
  permissions: readonly string[],
  key: string,
): boolean {
  return (
    !SALES_REPORT_KEYS.has(key) ||
    permissionSatisfied(permissions, 'dashboard.sales.view')
  );
}

export function assertCanViewReport(
  permissions: readonly string[],
  key: string,
): void {
  if (!canViewReport(permissions, key)) {
    throw new ForbiddenException('Missing permission: dashboard.sales.view');
  }
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

@Injectable()
export class ReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: BranchTimeService,
    private readonly accounting: AccountingService,
  ) {}

  catalog(permissions: readonly string[]) {
    return REPORT_CATALOG.filter((r) => canViewReport(permissions, r.key));
  }

  async run(
    key: string,
    branchId: string,
    from: string,
    to: string,
  ): Promise<ReportResult> {
    const entry = REPORT_CATALOG.find((r) => r.key === key);
    if (!entry) throw new BadRequestException(`Unknown report "${key}"`);
    for (const d of [from, to]) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d)))
        throw new BadRequestException('from and to must be YYYY-MM-DD');
    }
    if (to < from)
      throw new BadRequestException('"to" cannot be before "from"');
    if (Date.parse(to) - Date.parse(from) > 366 * 86_400_000)
      throw new BadRequestException('Choose a range of at most one year');

    const tz = await this.time.tzForBranch(branchId);
    const range = zonedRange(from, to, tz);
    const base = { key, title: entry.title };
    const out = (columns: string[], rows: CsvValue[][]) => ({
      ...base,
      columns,
      rows,
    });

    switch (key) {
      case 'sales-daily': {
        const orders = await this.prisma.order.findMany({
          where: { branchId, status: 'PAID', billedAt: range },
          select: {
            billedAt: true,
            totalAmount: true,
            tipAmount: true,
            taxAmount: true,
            discountAmount: true,
          },
        });
        const byDay = new Map<
          string,
          { n: number; sales: number; tax: number; disc: number; tips: number }
        >();
        for (const o of orders) {
          const d = localDate(o.billedAt!, tz);
          const row = byDay.get(d) ?? {
            n: 0,
            sales: 0,
            tax: 0,
            disc: 0,
            tips: 0,
          };
          row.n++;
          row.sales += Number(o.totalAmount) - Number(o.tipAmount);
          row.tax += Number(o.taxAmount);
          row.disc += Number(o.discountAmount);
          row.tips += Number(o.tipAmount);
          byDay.set(d, row);
        }
        return out(
          [
            'Date',
            'Orders',
            'Sales (excl. tips)',
            'Tax included',
            'Discounts',
            'Tips',
          ],
          [...byDay.entries()]
            .sort()
            .map(([d, r]) => [
              d,
              r.n,
              round2(r.sales),
              round2(r.tax),
              round2(r.disc),
              round2(r.tips),
            ]),
        );
      }

      case 'sales-by-item':
      case 'popular-items':
      case 'slow-movers': {
        const [items, menu] = await Promise.all([
          this.prisma.orderItem.groupBy({
            by: ['menuItemId', 'nameSnapshot'],
            where: {
              order: { branchId, status: 'PAID', billedAt: range },
              status: { not: 'CANCELLED' },
            },
            _sum: { quantity: true, lineTotal: true },
          }),
          this.prisma.menuItem.findMany({
            where: { branchId, isActive: true },
            select: { id: true, name: true },
          }),
        ]);
        const sold = new Map(items.map((i) => [i.menuItemId, i]));
        let rows: { name: string; qty: number; revenue: number }[] = items.map(
          (i) => ({
            name: i.nameSnapshot,
            qty: i._sum.quantity ?? 0,
            revenue: round2(Number(i._sum.lineTotal ?? 0)),
          }),
        );
        if (key === 'slow-movers') {
          rows = menu.map((m) => ({
            name: m.name,
            qty: sold.get(m.id)?._sum.quantity ?? 0,
            revenue: round2(Number(sold.get(m.id)?._sum.lineTotal ?? 0)),
          }));
          rows.sort((a, b) => a.qty - b.qty || a.name.localeCompare(b.name));
        } else {
          rows.sort((a, b) =>
            key === 'sales-by-item' ? b.revenue - a.revenue : b.qty - a.qty,
          );
        }
        if (key !== 'sales-by-item') rows = rows.slice(0, 25);
        return out(
          ['Item', 'Quantity', 'Revenue'],
          rows.map((r) => [r.name, r.qty, r.revenue]),
        );
      }

      case 'sales-by-category': {
        const lines = await this.prisma.orderItem.findMany({
          where: {
            order: { branchId, status: 'PAID', billedAt: range },
            status: { not: 'CANCELLED' },
          },
          select: {
            quantity: true,
            lineTotal: true,
            menuItem: { select: { category: { select: { name: true } } } },
          },
        });
        const by = new Map<string, { qty: number; revenue: number }>();
        for (const l of lines) {
          const name = l.menuItem.category.name;
          const r = by.get(name) ?? { qty: 0, revenue: 0 };
          r.qty += l.quantity;
          r.revenue += Number(l.lineTotal);
          by.set(name, r);
        }
        return out(
          ['Category', 'Quantity', 'Revenue'],
          [...by.entries()]
            .sort((a, b) => b[1].revenue - a[1].revenue)
            .map(([n, r]) => [n, r.qty, round2(r.revenue)]),
        );
      }

      case 'payment-methods': {
        const g = await this.prisma.payment.groupBy({
          by: ['method'],
          where: { createdAt: range, order: { branchId, status: 'PAID' } },
          _count: { _all: true },
          _sum: { amount: true },
        });
        return out(
          ['Method', 'Payments', 'Amount'],
          g.map((r) => [
            r.method,
            r._count._all,
            round2(Number(r._sum.amount ?? 0)),
          ]),
        );
      }

      case 'discounts': {
        const orders = await this.prisma.order.findMany({
          where: {
            branchId,
            status: 'PAID',
            billedAt: range,
            discountAmount: { gt: 0 },
          },
          select: {
            orderNumber: true,
            billedAt: true,
            discountAmount: true,
            couponCode: true,
            promotionName: true,
          },
          orderBy: { billedAt: 'asc' },
        });
        return out(
          ['Order', 'Date', 'Discount', 'Coupon', 'Happy hour'],
          orders.map((o) => [
            o.orderNumber,
            localDate(o.billedAt!, tz),
            round2(Number(o.discountAmount)),
            o.couponCode,
            o.promotionName,
          ]),
        );
      }

      case 'tax': {
        const g = await this.accounting.gstReport(branchId, from, to);
        return out(
          ['Rate %', 'Taxable value', 'Tax', 'Total'],
          [
            ...g.rows.map((r) => [
              r.ratePercent,
              r.taxableValue,
              r.tax,
              r.total,
            ]),
            [
              'Total',
              g.totalTaxable,
              g.totalTax,
              round2(g.totalTaxable + g.totalTax),
            ],
          ],
        );
      }

      case 'peak-hours': {
        const orders = await this.prisma.order.findMany({
          where: { branchId, status: 'PAID', billedAt: range },
          select: { createdAt: true, totalAmount: true },
        });
        const cell = new Map<string, { n: number; sales: number }>();
        for (const o of orders) {
          const { day, minute } = localMinuteAndDay(o.createdAt, tz);
          const k = `${day}-${Math.floor(minute / 60)}`;
          const c = cell.get(k) ?? { n: 0, sales: 0 };
          c.n++;
          c.sales += Number(o.totalAmount);
          cell.set(k, c);
        }
        const rows = [...cell.entries()]
          .map(([k, c]) => {
            const [d, h] = k.split('-').map(Number);
            return { d, h, ...c };
          })
          .sort((a, b) => b.n - a.n || a.d - b.d || a.h - b.h);
        return out(
          ['Day', 'Hour', 'Orders', 'Sales'],
          rows.map((r) => [
            DAYS[r.d],
            `${String(r.h).padStart(2, '0')}:00`,
            r.n,
            round2(r.sales),
          ]),
        );
      }

      case 'food-cost': {
        const [items, sold] = await Promise.all([
          this.prisma.menuItem.findMany({
            where: { branchId, isActive: true },
            select: {
              id: true,
              name: true,
              price: true,
              recipeLines: {
                select: {
                  quantity: true,
                  ingredient: { select: { costPerUnit: true } },
                },
              },
            },
          }),
          this.prisma.orderItem.groupBy({
            by: ['menuItemId'],
            where: {
              order: { branchId, status: 'PAID', billedAt: range },
              status: { not: 'CANCELLED' },
            },
            _sum: { quantity: true },
          }),
        ]);
        const qty = new Map(
          sold.map((s) => [s.menuItemId, s._sum.quantity ?? 0]),
        );
        const rows = items
          .filter((i) => i.recipeLines.length > 0)
          .map((i) => {
            const cost = i.recipeLines.reduce(
              (s, r) =>
                s + Number(r.quantity) * Number(r.ingredient.costPerUnit),
              0,
            );
            const price = Number(i.price);
            const units = qty.get(i.id) ?? 0;
            return [
              i.name,
              round2(price),
              round2(cost),
              round2(price - cost),
              price > 0 ? round2(((price - cost) / price) * 100) : 0,
              units,
              round2((price - cost) * units),
            ];
          })
          .sort((a, b) => Number(b[6]) - Number(a[6]));
        return out(
          [
            'Item',
            'Price',
            'Recipe cost',
            'Margin',
            'Margin %',
            'Units sold',
            'Total margin',
          ],
          rows,
        );
      }

      case 'customers': {
        const g = await this.prisma.order.groupBy({
          by: ['customerId'],
          where: {
            branchId,
            status: 'PAID',
            billedAt: range,
            customerId: { not: null },
          },
          _count: { _all: true },
          _sum: { totalAmount: true },
          orderBy: { _sum: { totalAmount: 'desc' } },
          take: 50,
        });
        const people = await this.prisma.customer.findMany({
          where: { id: { in: g.map((r) => r.customerId!) } },
          select: { id: true, name: true, phone: true, loyaltyPoints: true },
        });
        const byId = new Map(people.map((p) => [p.id, p]));
        return out(
          ['Customer', 'Phone', 'Orders', 'Spend', 'Loyalty points'],
          g.map((r) => {
            const p = byId.get(r.customerId!);
            return [
              p?.name ?? '(no name)',
              p?.phone,
              r._count._all,
              round2(Number(r._sum.totalAmount ?? 0)),
              p?.loyaltyPoints ?? 0,
            ];
          }),
        );
      }

      case 'retention': {
        const inRange = await this.prisma.order.findMany({
          where: {
            branchId,
            status: 'PAID',
            billedAt: range,
            customerId: { not: null },
          },
          select: { customerId: true, billedAt: true },
        });
        const ids = [...new Set(inRange.map((o) => o.customerId!))];
        const earlier = await this.prisma.order.findMany({
          where: {
            branchId,
            status: 'PAID',
            billedAt: { lt: range.gte },
            customerId: { in: ids },
          },
          select: { customerId: true },
          distinct: ['customerId'],
        });
        const returning = new Set(earlier.map((o) => o.customerId!));
        const byMonth = new Map<string, { n: Set<string>; r: Set<string> }>();
        for (const o of inRange) {
          const m = localDate(o.billedAt!, tz).slice(0, 7);
          const row = byMonth.get(m) ?? {
            n: new Set<string>(),
            r: new Set<string>(),
          };
          (returning.has(o.customerId!) ? row.r : row.n).add(o.customerId!);
          byMonth.set(m, row);
        }
        return out(
          ['Month', 'New customers', 'Returning customers', 'Returning %'],
          [...byMonth.entries()].sort().map(([m, r]) => {
            const total = r.n.size + r.r.size;
            return [
              m,
              r.n.size,
              r.r.size,
              total ? round2((r.r.size / total) * 100) : 0,
            ];
          }),
        );
      }

      case 'staff-sales': {
        const g = await this.prisma.order.groupBy({
          by: ['createdById'],
          where: { branchId, status: 'PAID', billedAt: range },
          _count: { _all: true },
          _sum: { totalAmount: true, tipAmount: true },
        });
        const users = await this.prisma.user.findMany({
          where: { id: { in: g.map((r) => r.createdById) } },
          select: { id: true, name: true },
        });
        const names = new Map(users.map((u) => [u.id, u.name]));
        return out(
          ['Staff', 'Orders', 'Sales', 'Tips'],
          g
            .sort(
              (a, b) =>
                Number(b._sum.totalAmount ?? 0) -
                Number(a._sum.totalAmount ?? 0),
            )
            .map((r) => [
              names.get(r.createdById) ?? 'Unknown',
              r._count._all,
              round2(Number(r._sum.totalAmount ?? 0)),
              round2(Number(r._sum.tipAmount ?? 0)),
            ]),
        );
      }

      case 'table-turnover': {
        const orders = await this.prisma.order.findMany({
          where: {
            branchId,
            status: 'PAID',
            billedAt: range,
            tableId: { not: null },
          },
          select: {
            createdAt: true,
            billedAt: true,
            table: { select: { number: true, name: true } },
          },
        });
        const by = new Map<string, { n: number; mins: number }>();
        for (const o of orders) {
          const name = o.table?.name ?? `Table ${o.table?.number}`;
          const r = by.get(name) ?? { n: 0, mins: 0 };
          r.n++;
          r.mins += (o.billedAt!.getTime() - o.createdAt.getTime()) / 60_000;
          by.set(name, r);
        }
        return out(
          ['Table', 'Orders', 'Avg minutes per order'],
          [...by.entries()]
            .sort((a, b) => b[1].n - a[1].n)
            .map(([n, r]) => [n, r.n, round2(r.mins / r.n)]),
        );
      }

      case 'reservations': {
        const g = await this.prisma.reservation.groupBy({
          by: ['status'],
          where: { branchId, reservedAt: range },
          _count: { _all: true },
          _sum: { guestCount: true },
        });
        return out(
          ['Status', 'Reservations', 'Guests'],
          g.map((r) => [r.status, r._count._all, r._sum.guestCount ?? 0]),
        );
      }

      case 'delivery': {
        const orders = await this.prisma.order.findMany({
          where: {
            branchId,
            type: 'DELIVERY',
            createdAt: range,
            deliveryStatus: { not: null },
          },
          select: {
            deliveryStatus: true,
            deliveryFee: true,
            createdAt: true,
            deliveredAt: true,
          },
        });
        const by = new Map<
          string,
          { n: number; fee: number; mins: number; timed: number }
        >();
        for (const o of orders) {
          const k = o.deliveryStatus!;
          const r = by.get(k) ?? { n: 0, fee: 0, mins: 0, timed: 0 };
          r.n++;
          r.fee += Number(o.deliveryFee);
          if (o.deliveredAt) {
            r.mins +=
              (o.deliveredAt.getTime() - o.createdAt.getTime()) / 60_000;
            r.timed++;
          }
          by.set(k, r);
        }
        return out(
          ['Status', 'Orders', 'Delivery fees', 'Avg minutes to deliver'],
          [...by.entries()].map(([k, r]) => [
            k,
            r.n,
            round2(r.fee),
            r.timed ? round2(r.mins / r.timed) : null,
          ]),
        );
      }

      case 'waste': {
        const logs = await this.prisma.wasteLog.findMany({
          where: { branchId, createdAt: range },
          select: { reason: true, quantity: true, unitCostAtWaste: true },
        });
        const by = new Map<string, { n: number; cost: number }>();
        for (const l of logs) {
          const r = by.get(l.reason) ?? { n: 0, cost: 0 };
          r.n++;
          r.cost += Number(l.quantity) * Number(l.unitCostAtWaste);
          by.set(l.reason, r);
        }
        return out(
          ['Reason', 'Entries', 'Cost'],
          [...by.entries()]
            .sort((a, b) => b[1].cost - a[1].cost)
            .map(([k, r]) => [k, r.n, round2(r.cost)]),
        );
      }

      default: {
        // inventory-valuation (a point-in-time report; the range is ignored)
        const ing = await this.prisma.ingredient.findMany({
          where: { branchId },
          select: {
            name: true,
            unit: true,
            currentStock: true,
            costPerUnit: true,
          },
          orderBy: { name: 'asc' },
        });
        const rows = ing.map((i) => [
          i.name,
          i.unit,
          Number(i.currentStock),
          round2(Number(i.costPerUnit)),
          round2(Number(i.currentStock) * Number(i.costPerUnit)),
        ]);
        return out(
          ['Ingredient', 'Unit', 'In stock', 'Cost per unit', 'Value'],
          [
            ...rows,
            [
              'Total',
              '',
              '',
              '',
              round2(rows.reduce((s, r) => s + Number(r[4]), 0)),
            ],
          ],
        );
      }
    }
  }
}
