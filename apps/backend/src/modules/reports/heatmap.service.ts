import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { BranchTimeService } from '../../common/services/branch-time.service';
import { isSqlite } from '../../common/sqlite';
import { zonedRange } from '../../common/time';
import { PrismaService } from '../../prisma/prisma.service';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

@Injectable()
export class HeatmapService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: BranchTimeService,
  ) {}

  async sales(branchId: string, from: string, to: string) {
    const tz = await this.time.tzForBranch(branchId);
    if (!/^[A-Za-z0-9_/+-]+$/.test(tz)) {
      throw new Error('Unexpected timezone');
    }
    const range = zonedRange(from, to, tz);
    const rows = isSqlite()
      ? await this.bucketInProcess(branchId, range, tz)
      : await this.prisma.$queryRaw<
          { dow: number; hour: number; total: Prisma.Decimal; orders: number }[]
        >(Prisma.sql`
      SELECT EXTRACT(DOW FROM ("billedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}))::int AS dow,
             EXTRACT(HOUR FROM ("billedAt" AT TIME ZONE 'UTC' AT TIME ZONE ${tz}))::int AS hour,
             COALESCE(SUM("totalAmount"), 0) AS total,
             COUNT(*)::int AS orders
      FROM "orders"
      WHERE "branchId" = ${branchId}
        AND "status" = 'PAID'
        AND "billedAt" >= ${range.gte}
        AND "billedAt" < ${range.lt}
      GROUP BY 1, 2
    `);
    const cells = DAYS.map((day, dow) => ({
      day,
      hours: Array.from({ length: 24 }, (_, hour) => {
        const hit = rows.find((row) => Number(row.dow) === dow && Number(row.hour) === hour);
        return {
          hour,
          total: hit ? Number(hit.total) : 0,
          orders: hit ? Number(hit.orders) : 0,
        };
      }),
    }));
    const max = Math.max(0, ...cells.flatMap((cell) => cell.hours.map((hour) => hour.total)));
    return { from, to, timezone: tz, max, cells };
  }

  private async bucketInProcess(
    branchId: string,
    range: { gte: Date; lt: Date },
    tz: string,
  ) {
    const orders = await this.prisma.order.findMany({
      where: { branchId, status: 'PAID', billedAt: range },
      select: { billedAt: true, totalAmount: true },
    });
    const buckets = new Map<string, { dow: number; hour: number; total: number; orders: number }>();
    for (const order of orders) {
      if (!order.billedAt) continue;
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        weekday: 'short',
        hour: 'numeric',
        hourCycle: 'h23',
      }).formatToParts(order.billedAt);
      const weekday = parts.find((part) => part.type === 'weekday')?.value ?? 'Sun';
      const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? 0);
      const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(weekday);
      const key = `${dow}:${hour}`;
      const current = buckets.get(key) ?? { dow, hour, total: 0, orders: 0 };
      current.total += Number(order.totalAmount);
      current.orders += 1;
      buckets.set(key, current);
    }
    return [...buckets.values()].map((row) => ({ ...row, total: new Prisma.Decimal(row.total) }));
  }
}
