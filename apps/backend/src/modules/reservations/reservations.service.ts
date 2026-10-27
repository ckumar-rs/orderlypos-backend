import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type {
  CreateReservationDto,
  ReservationDepositDto,
  ReservationStatusDto,
} from '@nodedr-restaurant/types';
import { NotificationsService } from '../../notifications/notifications.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { MessagingService } from '../messaging/messaging.service';
import { postHouseLedger } from '../commerce/house-ledger';
import { WebhooksService } from '../webhooks/webhooks.service';
import { collectNoShow, reservationForecast } from './reservation-plan';
import { suggestTable } from './suggest-table';

/** WhatsApp needs country code, no + or leading zero. A 10-digit India mobile gets 91. */
function whatsappMeNumber(phone: string): string | null {
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10 || digits.length > 15) return null;
  return digits.length === 10 ? `91${digits}` : digits;
}

export interface CreateReservationOptions {
  // True only for the public "website" booking path (integrations.service's
  // createReservation, called with an `reservations:write` API key). Staff
  // creating a reservation from the dashboard are never capped — they can
  // always merge tables or make a judgment call the online flow can't.
  fromWebsite?: boolean;
}

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly notifications: NotificationsService,
    private readonly webhooks: WebhooksService,
    private readonly messaging: MessagingService,
  ) {}

  list(branchId: string, date?: string) {
    const where: Record<string, unknown> = { branchId };
    if (date) {
      const start = new Date(date);
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(end.getDate() + 1);
      where.reservedAt = { gte: start, lt: end };
    }
    return this.prisma.reservation.findMany({
      where,
      include: { table: { select: { id: true, number: true, name: true } } },
      orderBy: { reservedAt: 'asc' },
    });
  }

  async create(
    branchId: string,
    dto: CreateReservationDto,
    options: CreateReservationOptions = {},
    userId?: string,
  ) {
    // A client-supplied tableId from another branch/restaurant must never
    // be trusted directly — without this check, this write would flip a
    // foreign tenant's real table to RESERVED on their own live floor view.
    if (dto.tableId) {
      const table = await this.prisma.table.findFirst({
        where: { id: dto.tableId, floor: { branchId } },
        select: { id: true },
      });
      if (!table) {
        throw new BadRequestException('Table is invalid for this branch');
      }
    }

    if (options.fromWebsite) {
      await this.assertWithinOnlineBookingCapacity(branchId, dto.guestCount);
    }

    // Website bookings are "online"; with auto-confirm on they skip the
    // manual Accept step and go straight to CONFIRMED.
    const autoConfirm = options.fromWebsite
      ? (
          await this.prisma.branch.findUnique({
            where: { id: branchId },
            select: { autoConfirmReservations: true },
          })
        )?.autoConfirmReservations
      : false;

    const { seating, depositMethod, tableId, ...rest } = dto;
    const assigned =
      tableId ??
      (
        await suggestTable(
          this.prisma,
          branchId,
          dto.guestCount,
          dto.reservedAt,
          dto.durationMinutes ?? 90,
          seating,
        )
      )?.tableId;
    const depositAmount = Number(dto.deposit ?? 0);
    const depositPaid = Boolean(dto.depositPaid) && depositAmount > 0;
    const method = depositMethod ?? 'HOUSE';

    const created = await this.prisma.$transaction(async (tx) => {
      if (depositPaid && method === 'WALLET') {
        await this.changeWallet(tx, branchId, dto.phone, depositAmount, 'debit');
      }
      const reservation = await tx.reservation.create({
        data: {
          ...rest,
          branchId,
          tableId: assigned ?? null,
          depositPaid,
          depositStatus: depositPaid ? 'HELD' : 'NONE',
          depositMethod: depositPaid ? method : null,
          ...(options.fromWebsite ? { channel: 'ONLINE' as const } : {}),
          ...(autoConfirm ? { status: 'CONFIRMED' as const } : {}),
        },
      });
      // Holding a table for a reservation marks it RESERVED on the floor
      // view immediately, not just when the guest physically arrives.
      if (reservation.tableId) {
        await tx.table.update({
          where: { id: reservation.tableId },
          data: { status: 'RESERVED', statusSince: new Date() },
        });
      }
      return reservation;
    });

    this.realtime.emitToBranch(branchId, 'reservation.created', {
      id: created.id,
    });
    if (created.tableId) {
      this.realtime.emitToBranch(branchId, 'table.updated', {
        id: created.tableId,
      });
    }

    // Best-effort, same pattern as OrdersService.checkout()'s "order.new"
    // notify: the reservation has already committed by this point, so a
    // notification failure must never surface as a failed booking. Targeted
    // by permission (reservations.manage), not a hardcoded role, so any
    // custom front-of-house role holding it gets the alert.
    try {
      await this.notifications.notifyByPermission(
        branchId,
        'reservations.manage',
        {
          type: 'reservation.new',
          title: options.fromWebsite
            ? 'New online reservation'
            : 'New reservation',
          body: `${created.customerName} — party of ${created.guestCount}, ${new Date(
            created.reservedAt,
          ).toLocaleString()}`,
          entity: 'Reservation',
          entityId: created.id,
        },
      );
    } catch (err) {
      this.logger.warn(
        `Failed to send reservation.new notification for reservation ${created.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    void this.webhooks.emitForBranch(branchId, 'reservation.created', {
      reservationId: created.id,
      customerName: created.customerName,
      phone: created.phone,
      guestCount: created.guestCount,
      reservedAt: created.reservedAt,
      channel: created.channel,
    });

    const restaurant = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: {
        restaurantId: true,
        restaurant: {
          select: {
            name: true,
            reservationMessage: true,
            waCloudEnabled: true,
            smsEnabled: true,
          },
        },
      },
    });
    const guestNotice = this.guestNotice(restaurant?.restaurant, created);
    if (guestNotice?.text && created.phone && restaurant) {
      const channels = [
        restaurant.restaurant.waCloudEnabled ? 'WHATSAPP' : null,
        restaurant.restaurant.smsEnabled ? 'SMS' : null,
      ].filter((channel): channel is 'WHATSAPP' | 'SMS' => channel != null);
      for (const channel of channels) {
        void this.messaging
          .dispatch({
            restaurantId: restaurant.restaurantId,
            branchId,
            channel,
            purpose: 'RESERVATION',
            to: created.phone,
            body: guestNotice.text,
          })
          .catch((err) =>
            this.logger.warn(
              `Reservation notice ${created.id} failed: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }
    }
    if (userId && depositPaid && method !== 'WALLET') {
      try {
        await postHouseLedger(this.prisma, branchId, userId, {
          name: created.customerName,
          phone: created.phone,
          kind: 'ADVANCE',
          amount: Number(created.deposit),
          reference: created.depositReference || 'Reservation deposit',
          reservationId: created.id,
        });
      } catch (err) {
        await this.prisma.reservation.update({
          where: { id: created.id },
          data: { depositPaid: false, depositStatus: 'NONE', depositMethod: null },
        });
        throw err;
      }
    }
    return {
      ...created,
      guestNotice,
    };
  }

  private guestNotice(
    restaurant:
      | { name: string; reservationMessage: string | null }
      | undefined,
    reservation: {
      customerName: string;
      phone: string | null;
      guestCount: number;
      reservedAt: Date;
      deposit: { toString(): string } | number | null;
    },
  ) {
    const template = restaurant?.reservationMessage?.trim();
    if (!template) return null;
    const vars: Record<string, string> = {
      name: reservation.customerName,
      phone: reservation.phone ?? '',
      guests: String(reservation.guestCount),
      when: reservation.reservedAt.toISOString(),
      deposit:
        reservation.deposit == null ? '' : String(reservation.deposit),
      restaurant: restaurant?.name ?? '',
    };
    const text = template.replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? '');
    const digits = (reservation.phone ?? '').replace(/\D/g, '');
    const whatsappNumber = whatsappMeNumber(reservation.phone ?? '');
    return {
      text,
      whatsappUrl: whatsappNumber
        ? `https://wa.me/${whatsappNumber}?text=${encodeURIComponent(text)}`
        : null,
      smsUrl: digits
        ? `sms:${digits}?body=${encodeURIComponent(text)}`
        : null,
    };
  }

  // Online (website/API) bookings are capped at what roughly 2 tables can
  // seat — a large party still gets in touch with the restaurant directly
  // rather than the site silently accepting a booking no single pair of
  // tables can actually hold. Computed from the branch's own configured
  // table capacities (largest two), not a hardcoded guest count, since
  // table sizes vary per restaurant. If the branch has no tables configured
  // yet, there's nothing to compare against — fail open rather than block
  // every online booking because the floor plan isn't set up.
  private async assertWithinOnlineBookingCapacity(
    branchId: string,
    guestCount: number,
  ) {
    const tables = await this.prisma.table.findMany({
      where: { floor: { branchId } },
      select: { capacity: true },
      orderBy: { capacity: 'desc' },
      take: 2,
    });
    if (tables.length === 0) return;

    const maxOnlineGuests = tables.reduce((sum, t) => sum + t.capacity, 0);
    if (guestCount > maxOnlineGuests) {
      throw new BadRequestException(
        `Online booking is limited to ${maxOnlineGuests} guests (about 2 tables). For a larger party, please call the restaurant directly to reserve.`,
      );
    }
  }

  async updateStatus(
    branchId: string,
    id: string,
    status: ReservationStatusDto,
    userId?: string,
  ) {
    if (status === 'NO_SHOW') {
      if (!userId) throw new BadRequestException('A staff member is required to collect a no-show fee');
      return this.settleNoShow(branchId, userId, id);
    }
    const reservation = await this.prisma.reservation.findFirst({
      where: { id, branchId },
    });
    if (!reservation) throw new NotFoundException('Reservation not found');

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.reservation.update({
        where: { id },
        data: { status },
      });

      // Arriving a reservation with an assigned table occupies it; completing
      // or cancelling releases it back to available. Mirrors the same
      // table-status side effect checkout() already applies for dine-in
      // orders, kept consistent rather than leaving reservations silently
      // out of sync with the floor view.
      if (result.tableId) {
        if (status === 'ARRIVED') {
          await tx.table.update({
            where: { id: result.tableId },
            data: { status: 'OCCUPIED', statusSince: new Date() },
          });
        } else if (status === 'COMPLETED' || status === 'CANCELLED') {
          await tx.table.update({
            where: { id: result.tableId },
            data: { status: 'AVAILABLE', statusSince: new Date() },
          });
        }
      }

      return result;
    });

    this.realtime.emitToBranch(branchId, 'reservation.updated', {
      id: updated.id,
      status,
    });
    if (updated.tableId) {
      this.realtime.emitToBranch(branchId, 'table.updated', {
        id: updated.tableId,
      });
    }
    return updated;
  }

  @Cron('0 */15 * * * *')
  async remindReservations() {
    const now = new Date();
    const until = new Date(now.getTime() + 2 * 60 * 60 * 1000);
    const due = await this.prisma.reservation.findMany({
      where: {
        reminderSentAt: null,
        phone: { not: null },
        status: { in: ['RESERVED', 'CONFIRMED'] },
        reservedAt: { gte: now, lte: until },
      },
      include: { branch: { select: { restaurantId: true } } },
      take: 40,
    });
    for (const row of due) {
      if (!row.phone) continue;
      const ready = await this.messaging.isChannelReady(row.branch.restaurantId, 'SMS');
      if (!ready) continue;
      try {
        const sent = await this.messaging.dispatch({
          restaurantId: row.branch.restaurantId,
          branchId: row.branchId,
          channel: 'SMS',
          purpose: 'RESERVATION',
          to: row.phone,
          body: `Reminder: your table for ${row.guestCount} is at ${row.reservedAt.toLocaleString()}.`,
        });
        if (sent?.status === 'SENT') {
          await this.prisma.reservation.update({
            where: { id: row.id },
            data: { reminderSentAt: new Date() },
          });
        }
      } catch (err) {
        this.logger.warn(
          `Reservation SMS ${row.id} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async sendSms(branchId: string, id: string) {
    const reservation = await this.requireReservation(branchId, id);
    if (!reservation.phone) throw new BadRequestException('This reservation has no phone number');
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { restaurantId: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    const ready = await this.messaging.isChannelReady(branch.restaurantId, 'SMS');
    if (!ready) {
      throw new BadRequestException('Turn on SMS in Operations and store the provider URL and key');
    }
    const sent = await this.messaging.dispatch({
      restaurantId: branch.restaurantId,
      branchId,
      channel: 'SMS',
      purpose: 'RESERVATION',
      to: reservation.phone,
      body: `Your table for ${reservation.guestCount} is booked for ${reservation.reservedAt.toLocaleString()}.`,
    });
    return { channel: 'SMS', status: sent?.status ?? 'QUEUED' };
  }

  async assignTable(branchId: string, id: string, area?: string | null) {
    const reservation = await this.requireReservation(branchId, id);
    if (reservation.status === 'CANCELLED' || reservation.status === 'NO_SHOW' || reservation.status === 'COMPLETED') {
      throw new BadRequestException('This reservation is no longer open');
    }
    const choice = await suggestTable(
      this.prisma,
      branchId,
      reservation.guestCount,
      reservation.reservedAt,
      reservation.durationMinutes,
      area,
      reservation.id,
    );
    if (!choice) throw new BadRequestException('No free table fits this party at that time');
    const updated = await this.prisma.$transaction(async (tx) => {
      if (reservation.tableId && reservation.tableId !== choice.tableId) {
        const previous = await tx.table.findUnique({ where: { id: reservation.tableId } });
        if (previous?.status === 'RESERVED') {
          await tx.table.update({
            where: { id: previous.id },
            data: { status: 'AVAILABLE', statusSince: new Date() },
          });
        }
      }
      const result = await tx.reservation.update({
        where: { id: reservation.id },
        data: { tableId: choice.tableId },
      });
      await tx.table.update({
        where: { id: choice.tableId },
        data: { status: 'RESERVED', statusSince: new Date() },
      });
      return result;
    });
    this.realtime.emitToBranch(branchId, 'reservation.updated', { id: updated.id });
    this.realtime.emitToBranch(branchId, 'table.updated', { id: choice.tableId });
    return { ...updated, floorName: choice.floorName, seating: choice.seating };
  }

  async forecast(branchId: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { restaurant: { select: { timezone: true } } },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    const zone = branch.restaurant.timezone || 'UTC';
    const now = new Date();
    const historyStart = new Date(now.getTime() - 56 * 86_400_000);
    const [history, upcoming, tableSupply] = await Promise.all([
      this.prisma.reservation.findMany({
        where: { branchId, reservedAt: { gte: historyStart, lt: now } },
        select: { reservedAt: true, guestCount: true, status: true },
      }),
      this.prisma.reservation.findMany({
        where: { branchId, reservedAt: { gte: now } },
        select: { reservedAt: true, guestCount: true, status: true },
      }),
      this.prisma.table.count({ where: { floor: { branchId } } }),
    ]);
    const days = Array.from({ length: 7 }, (_, index) => {
      const date = new Date(now.getTime() + index * 86_400_000);
      return { day: civilDay(date, zone), weekday: weekdayIndex(date, zone) };
    });
    return reservationForecast({
      history: history.map((row) => ({
        day: civilDay(row.reservedAt, zone),
        weekday: weekdayIndex(row.reservedAt, zone),
        guests: row.guestCount,
        status: row.status,
      })),
      upcoming: upcoming.map((row) => ({
        day: civilDay(row.reservedAt, zone),
        weekday: weekdayIndex(row.reservedAt, zone),
        guests: row.guestCount,
        status: row.status,
      })),
      days,
      tableSupply,
    });
  }

  async deposits(branchId: string) {
    const rows = await this.prisma.reservation.findMany({
      where: { branchId, deposit: { gt: 0 } },
      orderBy: { reservedAt: 'desc' },
      take: 100,
      include: {
        table: { select: { number: true, name: true } },
      },
    });
    const ids = rows.map((row) => row.id);
    const entries = ids.length
      ? await this.prisma.houseAccountEntry.findMany({
          where: { reservationId: { in: ids } },
          select: { reservationId: true, kind: true, amount: true, reference: true },
        })
      : [];
    return rows.map((row) => ({
      id: row.id,
      customerName: row.customerName,
      phone: row.phone,
      reservedAt: row.reservedAt,
      status: row.status,
      deposit: Number(row.deposit ?? 0),
      depositStatus: this.depositState(row),
      depositMethod: row.depositMethod,
      feeCharged: Number(row.feeCharged),
      table: row.table,
      ledger: entries
        .filter((entry) => entry.reservationId === row.id)
        .map((entry) => ({
          kind: entry.kind,
          amount: Number(entry.amount),
          reference: entry.reference,
        })),
    }));
  }

  async collectDeposit(
    branchId: string,
    userId: string,
    id: string,
    input: ReservationDepositDto = {},
  ) {
    const reservation = await this.requireReservation(branchId, id);
    const amount = Number(reservation.deposit ?? 0);
    if (!(amount > 0)) throw new BadRequestException('This reservation has no deposit amount');
    if (this.depositState(reservation) === 'HELD') {
      return { depositPaid: true, amount, depositStatus: 'HELD' };
    }
    if (this.depositState(reservation) === 'FORFEITED' || this.depositState(reservation) === 'REFUNDED') {
      throw new BadRequestException('This deposit is already closed');
    }
    const method = input.method ?? 'HOUSE';
    if (method === 'WALLET') {
      await this.changeWallet(this.prisma, branchId, reservation.phone, amount, 'debit');
    } else {
      await postHouseLedger(this.prisma, branchId, userId, {
        name: reservation.customerName,
        phone: reservation.phone,
        kind: 'ADVANCE',
        amount,
        reference: input.reference?.trim() || 'Reservation deposit',
        reservationId: reservation.id,
      });
    }
    await this.prisma.reservation.update({
      where: { id: reservation.id },
      data: {
        depositPaid: true,
        depositStatus: 'HELD',
        depositMethod: method,
        depositReference: input.reference?.trim() || null,
      },
    });
    return { depositPaid: true, amount, depositStatus: 'HELD', method };
  }

  async refundDeposit(branchId: string, userId: string, id: string) {
    const reservation = await this.requireReservation(branchId, id);
    if (this.depositState(reservation) !== 'HELD') {
      throw new BadRequestException('Only a held deposit can be refunded');
    }
    const amount = Number(reservation.deposit ?? 0);
    if (reservation.depositMethod === 'WALLET') {
      await this.changeWallet(this.prisma, branchId, reservation.phone, amount, 'credit');
    } else {
      await postHouseLedger(this.prisma, branchId, userId, {
        name: reservation.customerName,
        phone: reservation.phone,
        kind: 'CHARGE',
        amount,
        reference: 'Deposit refund',
        reservationId: reservation.id,
      });
    }
    await this.prisma.reservation.update({
      where: { id: reservation.id },
      data: { depositStatus: 'REFUNDED' },
    });
    return { depositStatus: 'REFUNDED', amount };
  }

  async forfeitDeposit(branchId: string, userId: string, id: string) {
    const reservation = await this.requireReservation(branchId, id);
    if (this.depositState(reservation) !== 'HELD') {
      throw new BadRequestException('Only a held deposit can be forfeited');
    }
    const amount = Number(reservation.deposit ?? 0);
    if (reservation.depositMethod !== 'WALLET') {
      await postHouseLedger(this.prisma, branchId, userId, {
        name: reservation.customerName,
        phone: reservation.phone,
        kind: 'CHARGE',
        amount,
        reference: 'Deposit forfeited',
        reservationId: reservation.id,
      });
    }
    await this.prisma.reservation.update({
      where: { id: reservation.id },
      data: { depositStatus: 'FORFEITED' },
    });
    return { depositStatus: 'FORFEITED', amount };
  }

  async settleNoShow(branchId: string, userId: string, id: string) {
    const reservation = await this.requireReservation(branchId, id);
    if (reservation.status === 'NO_SHOW') {
      return { status: 'NO_SHOW', fee: Number(reservation.feeCharged), already: true };
    }
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { restaurant: { select: { noShowFee: true } } },
    });
    const fee = Number(branch?.restaurant.noShowFee ?? 0);
    const wallet = await this.walletAmount(branchId, reservation.phone);
    const held = this.depositState(reservation) === 'HELD';
    const plan = collectNoShow({
      fee,
      deposit: Number(reservation.deposit ?? 0),
      depositHeld: held,
      depositOnHouse: held && reservation.depositMethod !== 'WALLET',
      wallet,
    });
    if (plan.fromWallet > 0) {
      await this.changeWallet(this.prisma, branchId, reservation.phone, plan.fromWallet, 'debit');
    }
    if (plan.forfeitHouseCredit) {
      await postHouseLedger(this.prisma, branchId, userId, {
        name: reservation.customerName,
        phone: reservation.phone,
        kind: 'CHARGE',
        amount: plan.fromDeposit,
        reference: 'Deposit forfeited',
        reservationId: reservation.id,
      });
    }
    if (plan.fromHouse > 0) {
      await postHouseLedger(this.prisma, branchId, userId, {
        name: reservation.customerName,
        phone: reservation.phone,
        kind: 'CHARGE',
        amount: plan.fromHouse,
        reference: `No-show ${reservation.customerName}`,
        reservationId: reservation.id,
      });
    }
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.reservation.update({
        where: { id: reservation.id },
        data: {
          status: 'NO_SHOW',
          feeCharged: fee,
          ...(plan.fromDeposit > 0 ? { depositStatus: 'FORFEITED' } : {}),
        },
      });
      if (result.tableId) {
        await tx.table.update({
          where: { id: result.tableId },
          data: { status: 'AVAILABLE', statusSince: new Date() },
        });
      }
      return result;
    });
    this.realtime.emitToBranch(branchId, 'reservation.updated', { id: updated.id, status: 'NO_SHOW' });
    if (updated.tableId) {
      this.realtime.emitToBranch(branchId, 'table.updated', { id: updated.tableId });
    }
    return { status: 'NO_SHOW', fee, ...plan };
  }

  private depositState(reservation: { depositStatus: string; depositPaid: boolean }) {
    if (reservation.depositStatus === 'NONE' && reservation.depositPaid) return 'HELD';
    return reservation.depositStatus;
  }

  private async requireReservation(branchId: string, id: string) {
    const reservation = await this.prisma.reservation.findFirst({ where: { id, branchId } });
    if (!reservation) throw new NotFoundException('Reservation not found');
    return reservation;
  }

  private async walletAmount(branchId: string, phone: string | null) {
    const match = await this.findWallet(branchId, phone);
    return match ? Number(match.walletBalance) : 0;
  }

  private async changeWallet(
    db: PrismaService | { customer: PrismaService['customer'] },
    branchId: string,
    phone: string | null | undefined,
    amount: number,
    direction: 'debit' | 'credit',
  ) {
    const match = await this.findWallet(branchId, phone);
    if (!match) throw new BadRequestException('No customer wallet matches this phone');
    if (direction === 'credit') {
      await db.customer.update({
        where: { id: match.id },
        data: { walletBalance: { increment: amount } },
      });
      return;
    }
    const updated = await db.customer.updateMany({
      where: { id: match.id, walletBalance: { gte: amount } },
      data: { walletBalance: { decrement: amount } },
    });
    if (updated.count === 0) throw new BadRequestException('Customer wallet balance is too low');
  }

  private async findWallet(branchId: string, phone: string | null | undefined) {
    const wanted = (phone ?? '').replace(/\D/g, '');
    if (wanted.length < 8) return null;
    const customers = await this.prisma.customer.findMany({
      where: { branchId },
      select: { id: true, phone: true, walletBalance: true },
    });
    return customers.find((row) => (row.phone ?? '').replace(/\D/g, '') === wanted) ?? null;
  }
}

function civilDay(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function weekdayIndex(date: Date, timeZone: string) {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(date);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(name);
}
