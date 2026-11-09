import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  LeaveBalanceDto,
  LeaveRequestDto,
  ManagerLeaveDto,
  PerformanceReviewDto,
  ShiftDto,
  StaffPayDto,
} from '@nodedr-restaurant/types';
import { localDate, zonedRange } from '../../common/time';
import { BranchTimeService } from '../../common/services/branch-time.service';
import { PrismaService } from '../../prisma/prisma.service';
import {
  branchTeamHrSettings,
  readBranchSettingsMap,
} from '../settings/settings-kv';
import {
  computePayroll,
  daysInclusive,
  round2,
  type StatutoryRates,
} from './payroll.calc';

const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`);
const USER = { select: { id: true, name: true } } as const;
const BALANCE_TYPES = ['ANNUAL', 'SICK'] as const;

function isoDay(d: Date) {
  return d.toISOString().slice(0, 10);
}

function overlapDays(
  start: Date,
  end: Date,
  windowStart: Date,
  windowEnd: Date,
) {
  const s = Math.max(start.getTime(), windowStart.getTime());
  const e = Math.min(end.getTime(), windowEnd.getTime());
  if (e < s) return 0;
  return Math.round((e - s) / 86_400_000) + 1;
}

@Injectable()
export class HrService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly time: BranchTimeService,
  ) {}

  private async assertStaffInBranch(branchId: string, userId: string) {
    const link = await this.prisma.userBranch.findFirst({
      where: { branchId, userId, user: { isActive: true } },
    });
    if (!link)
      throw new BadRequestException('That staff member is not in this branch');
  }

  private async teamHr(branchId: string) {
    return branchTeamHrSettings(
      await readBranchSettingsMap(this.prisma, branchId),
    );
  }

  // --- Shifts --------------------------------------------------------------

  async listShifts(
    branchId: string,
    from?: string,
    to?: string,
    userId?: string,
  ) {
    const tz = await this.time.tzForBranch(branchId);
    const r = zonedRange(from ?? to ?? '1970-01-01', to ?? '9999-12-30', tz);
    return this.prisma.shift.findMany({
      where: {
        branchId,
        ...(userId ? { userId } : {}),
        ...(from || to
          ? {
              startsAt: {
                ...(from ? { gte: r.gte } : {}),
                ...(to ? { lt: r.lt } : {}),
              },
            }
          : {}),
      },
      include: { user: USER },
      orderBy: { startsAt: 'asc' },
      take: 500,
    });
  }

  async createShift(branchId: string, dto: ShiftDto) {
    await this.assertStaffInBranch(branchId, dto.userId);
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    await this.assertNoShiftClash(dto.userId, startsAt, endsAt);
    await this.assertNotOnLeave(branchId, dto.userId, startsAt, endsAt);
    return this.prisma.shift.create({
      data: { branchId, userId: dto.userId, startsAt, endsAt, note: dto.note },
      include: { user: USER },
    });
  }

  async updateShift(branchId: string, id: string, dto: ShiftDto) {
    const shift = await this.prisma.shift.findFirst({ where: { id, branchId } });
    if (!shift) throw new NotFoundException('Shift not found');
    await this.assertStaffInBranch(branchId, dto.userId);
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    await this.assertNoShiftClash(dto.userId, startsAt, endsAt, id);
    await this.assertNotOnLeave(branchId, dto.userId, startsAt, endsAt);
    return this.prisma.shift.update({
      where: { id },
      data: { userId: dto.userId, startsAt, endsAt, note: dto.note },
      include: { user: USER },
    });
  }

  async deleteShift(branchId: string, id: string) {
    const shift = await this.prisma.shift.findFirst({
      where: { id, branchId },
    });
    if (!shift) throw new NotFoundException('Shift not found');
    await this.prisma.shift.delete({ where: { id } });
    return { ok: true };
  }

  private async assertNoShiftClash(
    userId: string,
    startsAt: Date,
    endsAt: Date,
    exceptId?: string,
  ) {
    const clash = await this.prisma.shift.findFirst({
      where: {
        userId,
        ...(exceptId ? { id: { not: exceptId } } : {}),
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
    });
    if (clash)
      throw new BadRequestException(
        'That person already has a shift at this time',
      );
  }

  private async assertNotOnLeave(
    branchId: string,
    userId: string,
    startsAt: Date,
    endsAt: Date,
  ) {
    const tz = await this.time.tzForBranch(branchId);
    const onLeave = await this.prisma.leaveRequest.findFirst({
      where: {
        branchId,
        userId,
        status: 'APPROVED',
        startDate: { lte: dayStart(localDate(endsAt, tz)) },
        endDate: { gte: dayStart(localDate(startsAt, tz)) },
      },
    });
    if (onLeave)
      throw new BadRequestException(
        'That person has approved leave on this day',
      );
  }

  // --- Leave ---------------------------------------------------------------

  async requestLeave(userId: string, dto: LeaveRequestDto) {
    await this.assertStaffInBranch(dto.branchId, userId);
    await this.assertLeaveCapacity(
      dto.branchId,
      userId,
      dto.type,
      dto.startDate,
      dto.endDate,
    );
    return this.prisma.leaveRequest.create({
      data: {
        branchId: dto.branchId,
        userId,
        type: dto.type,
        startDate: dayStart(dto.startDate),
        endDate: dayStart(dto.endDate),
        reason: dto.reason,
      },
      include: { user: USER },
    });
  }

  async createLeaveForStaff(
    branchId: string,
    managerId: string,
    dto: ManagerLeaveDto,
  ) {
    await this.assertStaffInBranch(branchId, dto.userId);
    await this.assertLeaveCapacity(
      branchId,
      dto.userId,
      dto.type,
      dto.startDate,
      dto.endDate,
    );
    const approveNow = dto.approveNow === true;
    const created = await this.prisma.leaveRequest.create({
      data: {
        branchId,
        userId: dto.userId,
        type: dto.type,
        startDate: dayStart(dto.startDate),
        endDate: dayStart(dto.endDate),
        reason: dto.reason,
        status: approveNow ? 'APPROVED' : 'PENDING',
        ...(approveNow
          ? { decidedById: managerId, decidedAt: new Date() }
          : {}),
      },
      include: { user: USER },
    });
    if (approveNow) {
      await this.clearShiftsDuringLeave(
        branchId,
        dto.userId,
        dto.startDate,
        dto.endDate,
      );
    }
    return created;
  }

  myLeave(userId: string) {
    return this.prisma.leaveRequest.findMany({
      where: { userId },
      orderBy: { startDate: 'desc' },
      take: 100,
    });
  }

  listLeave(branchId: string, status?: string) {
    return this.prisma.leaveRequest.findMany({
      where: {
        branchId,
        ...(status === 'PENDING' ||
        status === 'APPROVED' ||
        status === 'REJECTED' ||
        status === 'CANCELLED'
          ? { status }
          : {}),
      },
      include: { user: USER },
      orderBy: { startDate: 'desc' },
      take: 200,
    });
  }

  async decideLeave(
    branchId: string,
    id: string,
    deciderId: string,
    status: 'APPROVED' | 'REJECTED',
  ) {
    const leave = await this.prisma.leaveRequest.findFirst({
      where: { id, branchId },
    });
    if (!leave) throw new NotFoundException('Leave request not found');
    if (leave.status !== 'PENDING')
      throw new BadRequestException('Already decided');
    if (status === 'APPROVED') {
      await this.assertLeaveCapacity(
        branchId,
        leave.userId,
        leave.type,
        isoDay(leave.startDate),
        isoDay(leave.endDate),
        leave.id,
      );
    }
    const updated = await this.prisma.leaveRequest.update({
      where: { id },
      data: { status, decidedById: deciderId, decidedAt: new Date() },
      include: { user: USER },
    });
    if (status === 'APPROVED') {
      await this.clearShiftsDuringLeave(
        branchId,
        leave.userId,
        isoDay(leave.startDate),
        isoDay(leave.endDate),
      );
    }
    return updated;
  }

  async cancelLeave(
    branchId: string,
    id: string,
    actorId: string,
    asManager: boolean,
  ) {
    const leave = await this.prisma.leaveRequest.findFirst({
      where: { id, branchId },
    });
    if (!leave) throw new NotFoundException('Leave request not found');
    if (!asManager && leave.userId !== actorId)
      throw new ForbiddenException('You can only cancel your own leave');
    if (leave.status === 'CANCELLED' || leave.status === 'REJECTED')
      throw new BadRequestException('This leave is already closed');
    if (!asManager && leave.status !== 'PENDING')
      throw new BadRequestException('Only pending leave can be withdrawn');
    if (asManager && leave.status !== 'PENDING' && leave.status !== 'APPROVED')
      throw new BadRequestException('This leave cannot be cancelled');
    return this.prisma.leaveRequest.update({
      where: { id },
      data: {
        status: 'CANCELLED',
        decidedById: actorId,
        decidedAt: new Date(),
      },
      include: { user: USER },
    });
  }

  async listBalances(branchId: string, year?: number) {
    const y = year ?? new Date().getUTCFullYear();
    const hr = await this.teamHr(branchId);
    const links = await this.prisma.userBranch.findMany({
      where: { branchId, user: { isActive: true } },
      include: { user: USER },
    });
    const overrides = await this.prisma.leaveBalance.findMany({
      where: { branchId, year: y, type: { in: [...BALANCE_TYPES] } },
    });
    const overrideMap = new Map(
      overrides.map((row) => [
        `${row.userId}:${row.type}`,
        Number(row.entitledDays),
      ]),
    );
    const booked = await this.prisma.leaveRequest.findMany({
      where: {
        branchId,
        status: { in: ['APPROVED', 'PENDING'] },
        type: { in: [...BALANCE_TYPES] },
        startDate: { lte: dayStart(`${y}-12-31`) },
        endDate: { gte: dayStart(`${y}-01-01`) },
      },
    });
    const usedMap = new Map<string, number>();
    const pendingMap = new Map<string, number>();
    const yearStart = dayStart(`${y}-01-01`);
    const yearEnd = dayStart(`${y}-12-31`);
    for (const leave of booked) {
      const days = overlapDays(
        leave.startDate,
        leave.endDate,
        yearStart,
        yearEnd,
      );
      const key = `${leave.userId}:${leave.type}`;
      if (leave.status === 'APPROVED')
        usedMap.set(key, (usedMap.get(key) ?? 0) + days);
      else pendingMap.set(key, (pendingMap.get(key) ?? 0) + days);
    }

    return links.flatMap((link) =>
      BALANCE_TYPES.map((type) => {
        const entitled =
          overrideMap.get(`${link.user.id}:${type}`) ??
          (type === 'ANNUAL' ? hr.leaveAnnualDays : hr.leaveSickDays);
        const used = usedMap.get(`${link.user.id}:${type}`) ?? 0;
        const pending = pendingMap.get(`${link.user.id}:${type}`) ?? 0;
        return {
          userId: link.user.id,
          name: link.user.name,
          type,
          year: y,
          entitledDays: entitled,
          usedDays: used,
          pendingDays: pending,
          remainingDays: round2(entitled - used - pending),
          overridden: overrideMap.has(`${link.user.id}:${type}`),
        };
      }),
    );
  }

  async myBalances(branchId: string, userId: string, year?: number) {
    const rows = await this.listBalances(branchId, year);
    return rows.filter((row) => row.userId === userId);
  }

  async setBalance(branchId: string, dto: LeaveBalanceDto) {
    await this.assertStaffInBranch(branchId, dto.userId);
    return this.prisma.leaveBalance.upsert({
      where: {
        branchId_userId_type_year: {
          branchId,
          userId: dto.userId,
          type: dto.type,
          year: dto.year,
        },
      },
      create: {
        branchId,
        userId: dto.userId,
        type: dto.type,
        year: dto.year,
        entitledDays: dto.entitledDays,
      },
      update: { entitledDays: dto.entitledDays },
    });
  }

  private async assertLeaveCapacity(
    branchId: string,
    userId: string,
    type: string,
    startDate: string,
    endDate: string,
    /** When approving, exclude this pending request from the pending tally. */
    exceptPendingId?: string,
  ) {
    if (type !== 'ANNUAL' && type !== 'SICK') return;
    const year = Number(startDate.slice(0, 4));
    const endYear = Number(endDate.slice(0, 4));
    if (year !== endYear)
      throw new BadRequestException(
        'Leave that crosses a calendar year must be split into two requests',
      );
    const balances = await this.listBalances(branchId, year);
    const row = balances.find((b) => b.userId === userId && b.type === type);
    if (!row) return;
    let credit = 0;
    if (exceptPendingId) {
      const existing = await this.prisma.leaveRequest.findFirst({
        where: { id: exceptPendingId, status: 'PENDING' },
      });
      if (existing)
        credit = daysInclusive(isoDay(existing.startDate), isoDay(existing.endDate));
    }
    const requested = daysInclusive(startDate, endDate);
    const available = round2(row.remainingDays + credit);
    if (requested > available + 1e-9)
      throw new BadRequestException(
        `Not enough ${type.toLowerCase()} leave remaining (${available} day(s) left)`,
      );
  }

  private async clearShiftsDuringLeave(
    branchId: string,
    userId: string,
    startDate: string,
    endDate: string,
  ) {
    const tz = await this.time.tzForBranch(branchId);
    const range = zonedRange(startDate, endDate, tz);
    await this.prisma.shift.deleteMany({
      where: {
        branchId,
        userId,
        startsAt: { lt: range.lt },
        endsAt: { gt: range.gte },
      },
    });
  }

  // --- Pay profiles --------------------------------------------------------

  async listPay(branchId: string) {
    const links = await this.prisma.userBranch.findMany({
      where: { branchId, user: { isActive: true } },
      include: { user: { select: { id: true, name: true, payProfile: true } } },
    });
    return links.map((l) => ({
      userId: l.user.id,
      name: l.user.name,
      payType: l.user.payProfile?.payType ?? null,
      rate: l.user.payProfile ? Number(l.user.payProfile.rate) : null,
    }));
  }

  async setPay(branchId: string, userId: string, dto: StaffPayDto) {
    await this.assertStaffInBranch(branchId, userId);
    return this.prisma.staffPay.upsert({
      where: { userId },
      create: { userId, payType: dto.payType, rate: dto.rate },
      update: { payType: dto.payType, rate: dto.rate },
    });
  }

  // --- Payroll -------------------------------------------------------------

  listRuns(branchId: string) {
    return this.prisma.payrollRun.findMany({
      where: { branchId },
      orderBy: { periodStart: 'desc' },
      take: 50,
    });
  }

  async getRun(branchId: string, id: string) {
    const run = await this.prisma.payrollRun.findFirst({
      where: { id, branchId },
      include: {
        lines: { include: { user: USER }, orderBy: { user: { name: 'asc' } } },
      },
    });
    if (!run) throw new NotFoundException('Payroll run not found');
    return run;
  }

  /** Builds a DRAFT run from clock-in/out hours, pay profiles, leave and tips. */
  async createRun(branchId: string, periodStart: string, periodEnd: string) {
    const overlap = await this.prisma.payrollRun.findFirst({
      where: {
        branchId,
        periodStart: { lte: dayStart(periodEnd) },
        periodEnd: { gte: dayStart(periodStart) },
      },
    });
    if (overlap)
      throw new BadRequestException(
        'A payroll run already covers part of this period',
      );

    const from = dayStart(periodStart);
    const tz = await this.time.tzForBranch(branchId);
    const zoned = zonedRange(periodStart, periodEnd, tz);

    const links = await this.prisma.userBranch.findMany({
      where: {
        branchId,
        user: { isActive: true, payProfile: { isNot: null } },
      },
      include: { user: { select: { id: true, payProfile: true } } },
    });
    if (links.length === 0)
      throw new BadRequestException(
        'Set a pay rate for at least one staff member first',
      );

    const records = await this.prisma.attendance.findMany({
      where: {
        branchId,
        clockOutAt: { not: null, gt: zoned.gte },
        clockInAt: { lt: zoned.lt },
      },
    });
    const hours = new Map<string, number>();
    for (const r of records) {
      const start = Math.max(r.clockInAt.getTime(), zoned.gte.getTime());
      const end = Math.min(r.clockOutAt!.getTime(), zoned.lt.getTime());
      if (end > start)
        hours.set(
          r.userId,
          (hours.get(r.userId) ?? 0) + (end - start) / 3_600_000,
        );
    }

    const leaves = await this.prisma.leaveRequest.findMany({
      where: {
        branchId,
        status: 'APPROVED',
        type: 'UNPAID',
        startDate: { lte: dayStart(periodEnd) },
        endDate: { gte: from },
      },
    });
    const unpaidDays = new Map<string, number>();
    for (const l of leaves) {
      const days = overlapDays(
        l.startDate,
        l.endDate,
        from,
        dayStart(periodEnd),
      );
      if (days > 0)
        unpaidDays.set(l.userId, (unpaidDays.get(l.userId) ?? 0) + days);
    }

    const tips = await this.prisma.order.aggregate({
      where: { branchId, status: 'PAID', billedAt: zoned },
      _sum: { tipAmount: true },
    });
    const tipPool = round2(Number(tips._sum.tipAmount ?? 0));

    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { country: true },
    });
    const hr = await this.teamHr(branchId);
    const applyStatutory =
      branch?.country === 'IN' && hr.payrollStatutoryEnabled;
    const rates: boolean | StatutoryRates = applyStatutory
      ? {
          pfRate: hr.payrollPfRate,
          pfWageCeiling: hr.payrollPfWageCeiling,
          esiGrossLimit: hr.payrollEsiGrossLimit,
          esiEmployeeRate: hr.payrollEsiEmployeeRate,
          esiEmployerRate: hr.payrollEsiEmployerRate,
        }
      : false;

    const lines = computePayroll(
      periodStart,
      periodEnd,
      tipPool,
      links.map((l) => ({
        userId: l.user.id,
        payType: l.user.payProfile!.payType,
        rate: Number(l.user.payProfile!.rate),
        hoursWorked: hours.get(l.user.id) ?? 0,
        unpaidLeaveDays: unpaidDays.get(l.user.id) ?? 0,
      })),
      rates,
    );

    return this.prisma.payrollRun.create({
      data: {
        branchId,
        periodStart: from,
        periodEnd: dayStart(periodEnd),
        tipPool,
        totalNet: round2(lines.reduce((s, l) => s + l.netPay, 0)),
        lines: { create: lines },
      },
      include: { lines: { include: { user: USER } } },
    });
  }

  async finalizeRun(branchId: string, id: string) {
    const run = await this.getRun(branchId, id);
    if (run.status !== 'DRAFT')
      throw new BadRequestException('Already finalized');
    return this.prisma.payrollRun.update({
      where: { id },
      data: { status: 'FINALIZED', finalizedAt: new Date() },
    });
  }

  async deleteRun(branchId: string, id: string) {
    const run = await this.getRun(branchId, id);
    if (run.status !== 'DRAFT')
      throw new BadRequestException(
        'A finalized payroll run cannot be deleted',
      );
    await this.prisma.payrollRun.delete({ where: { id } });
    return { ok: true };
  }

  async payslipCsv(branchId: string, id: string) {
    const run = await this.getRun(branchId, id);
    const header = [
      'Staff',
      'Hours',
      'Base',
      'PF employee',
      'PF employer',
      'ESI employee',
      'ESI employer',
      'TDS',
      'Unpaid leave',
      'Tips',
      'Net',
    ];
    const rows = run.lines.map((l) =>
      [
        l.user.name,
        l.hoursWorked,
        l.basePay,
        l.pfEmployee,
        l.pfEmployer,
        l.esiEmployee,
        l.esiEmployer,
        l.tds,
        l.unpaidLeaveDeduction,
        l.tipShare,
        l.netPay,
      ].join(','),
    );
    return {
      filename: `payroll-${isoDay(run.periodStart)}-${isoDay(run.periodEnd)}.csv`,
      csv: [header.join(','), ...rows].join('\n'),
    };
  }

  // --- Performance ---------------------------------------------------------

  async performance(branchId: string, from: string, to: string) {
    const range = zonedRange(from, to, await this.time.tzForBranch(branchId));
    const f = range.gte;
    const t = range.lt;
    const [orders, attendance, links, reviews] = await Promise.all([
      this.prisma.order.groupBy({
        by: ['createdById'],
        where: { branchId, status: 'PAID', billedAt: range },
        _count: { _all: true },
        _sum: { totalAmount: true, tipAmount: true },
      }),
      this.prisma.attendance.findMany({
        where: {
          branchId,
          clockOutAt: { not: null, gt: f },
          clockInAt: { lt: t },
        },
      }),
      this.prisma.userBranch.findMany({
        where: { branchId },
        include: { user: USER },
      }),
      this.prisma.performanceReview.findMany({
        where: {
          branchId,
          periodStart: { lte: dayStart(to) },
          periodEnd: { gte: dayStart(from) },
        },
        include: {
          user: USER,
          createdBy: USER,
        },
        orderBy: { createdAt: 'desc' },
        take: 200,
      }),
    ]);
    const hours = new Map<string, number>();
    for (const r of attendance) {
      const s = Math.max(r.clockInAt.getTime(), f.getTime());
      const e = Math.min(r.clockOutAt!.getTime(), t.getTime());
      if (e > s)
        hours.set(r.userId, (hours.get(r.userId) ?? 0) + (e - s) / 3_600_000);
    }
    const byUser = new Map(orders.map((o) => [o.createdById, o]));
    const metrics = links
      .map((l) => {
        const o = byUser.get(l.user.id);
        const h = hours.get(l.user.id) ?? 0;
        const sales = Number(o?._sum.totalAmount ?? 0);
        return {
          userId: l.user.id,
          name: l.user.name,
          orders: o?._count._all ?? 0,
          sales: round2(sales),
          tips: round2(Number(o?._sum.tipAmount ?? 0)),
          hoursWorked: round2(h),
          salesPerHour: h > 0 ? round2(sales / h) : null,
        };
      })
      .sort((a, b) => b.sales - a.sales);
    return { metrics, reviews };
  }

  async createReview(
    branchId: string,
    authorId: string,
    dto: PerformanceReviewDto,
  ) {
    await this.assertStaffInBranch(branchId, dto.userId);
    return this.prisma.performanceReview.create({
      data: {
        branchId,
        userId: dto.userId,
        periodStart: dayStart(dto.periodStart),
        periodEnd: dayStart(dto.periodEnd),
        rating: dto.rating,
        note: dto.note,
        createdById: authorId,
      },
      include: { user: USER, createdBy: USER },
    });
  }

  async deleteReview(branchId: string, id: string) {
    const row = await this.prisma.performanceReview.findFirst({
      where: { id, branchId },
    });
    if (!row) throw new NotFoundException('Review not found');
    await this.prisma.performanceReview.delete({ where: { id } });
    return { ok: true };
  }
}
