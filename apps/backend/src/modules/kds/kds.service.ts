import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { KotPrintService } from '../orders/kot-print.service';
import { OrdersService } from '../orders/orders.service';
import { longestPrep, ticketIsLate } from './late-ticket';
import { reportWindow, stationPerformance, type StationSample } from './station-performance';

@Injectable()
export class KdsService {
  private readonly logger = new Logger(KdsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
    private readonly kotPrint: KotPrintService,
    private readonly notifications: NotificationsService,
  ) {}

  /** One push per ticket, to kitchen staff, once it passes its prep target. */
  @Cron(CronExpression.EVERY_MINUTE)
  async alertLateTickets() {
    const now = new Date();
    const tickets = await this.prisma.kot.findMany({
      where: { status: { in: ['NEW', 'ACCEPTED', 'PREPARING'] }, held: false },
      select: {
        id: true,
        ticketNumber: true,
        status: true,
        held: true,
        createdAt: true,
        order: { select: { branchId: true, orderNumber: true } },
        items: {
          select: {
            orderItem: { select: { menuItem: { select: { prepTimeMinutes: true } } } },
          },
        },
      },
      take: 200,
    });
    for (const ticket of tickets) {
      const prepMinutes = longestPrep(
        ticket.items.map((item) => item.orderItem.menuItem.prepTimeMinutes),
      );
      if (
        !ticketIsLate({
          status: ticket.status,
          held: ticket.held,
          createdAt: ticket.createdAt,
          prepMinutes,
          now,
        })
      ) {
        continue;
      }
      const already = await this.prisma.notification.findFirst({
        where: { type: 'kot.late', entityId: ticket.id },
        select: { id: true },
      });
      if (already) continue;
      try {
        await this.notifications.notifyByPermission(ticket.order.branchId, 'kds.manage', {
          type: 'kot.late',
          title: 'Kitchen ticket is late',
          body: `Ticket ${ticket.ticketNumber} on ${ticket.order.orderNumber} is past its prep target`,
          entity: 'Kot',
          entityId: ticket.id,
        });
      } catch (err) {
        this.logger.warn(
          `Late ticket ${ticket.id} was not announced: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  async workload(branchId: string) {
    const [stations, tickets] = await Promise.all([
      this.prisma.kitchenStation.findMany({
        where: { branchId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.kot.findMany({
        where: {
          order: { branchId },
          status: { in: ['NEW', 'ACCEPTED', 'PREPARING', 'READY'] },
        },
        select: { stationId: true, status: true },
      }),
    ]);
    const counts = new Map<string, number>();
    for (const ticket of tickets) {
      const key = ticket.stationId ?? 'unassigned';
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return {
      openTickets: tickets.length,
      stations: [
        ...stations.map((station) => ({
          id: station.id,
          name: station.name,
          openTickets: counts.get(station.id) ?? 0,
        })),
        { id: null, name: 'Unassigned', openTickets: counts.get('unassigned') ?? 0 },
      ],
    };
  }

  async onlineOrders(branchId: string) {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { onlineOrdersPaused: true },
    });
    if (!branch) throw new NotFoundException('Branch not found');
    return { paused: branch.onlineOrdersPaused };
  }

  async setOnlineOrders(branchId: string, paused: boolean) {
    await this.prisma.branch.update({
      where: { id: branchId },
      data: { onlineOrdersPaused: paused },
    });
    return { paused };
  }

  /** Stations a KDS screen can be pinned to; needs only kds.manage (not menu.manage). */
  listStations(branchId: string) {
    return this.prisma.kitchenStation.findMany({
      where: { branchId },
      select: { id: true, name: true, role: true },
      orderBy: { name: 'asc' },
    });
  }

  listCourses(branchId: string) {
    return this.prisma.kitchenCourse.findMany({
      where: { branchId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  // A screen pinned to a station also shows tickets with no station: menu
  // items nobody assigned to a station still have to be cooked somewhere, and
  // hiding them from every pinned screen made those orders vanish.
  async listActiveTickets(branchId: string, stationId?: string) {
    return this.prisma.kot.findMany({
      where: {
        order: { branchId },
        status: { notIn: ['SERVED', 'CANCELLED', 'REJECTED'] },
        ...(stationId ? { OR: [{ stationId }, { stationId: null }] } : {}),
      },
      include: {
        station: true,
        course: true,
        order: {
          select: {
            orderNumber: true,
            type: true,
            table: true,
            guestName: true,
            notes: true,
            channel: true,
            foodPlatform: true,
            externalOrderId: true,
            customer: { select: { name: true, phone: true } },
          },
        },
        items: { include: { orderItem: { include: { modifiers: true, menuItem: { select: { prepTimeMinutes: true } } } } } },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  // Incoming orders (website / QR) that nobody has accepted yet. They have no
  // kitchen ticket until accepted, so without this the kitchen screen could
  // not show them at all.
  listIncoming(branchId: string) {
    return this.prisma.order.findMany({
      where: { branchId, status: 'OPEN', acceptance: 'PENDING' },
      select: {
        id: true,
        orderNumber: true,
        type: true,
        channel: true,
        guestName: true,
        notes: true,
        createdAt: true,
        scheduledFor: true,
        table: { select: { number: true, name: true } },
        customer: { select: { name: true, phone: true } },
        items: {
          select: {
            id: true,
            nameSnapshot: true,
            quantity: true,
            kitchenNote: true,
            modifiers: { select: { nameSnapshot: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  // What a waiter or cashier may see of the kitchen: where each live ticket
  // is, with no customer contact details. Open to anyone who can take orders.
  async progress(branchId: string) {
    const kots = await this.prisma.kot.findMany({
      where: {
        order: { branchId, status: 'OPEN' },
        status: { notIn: ['CANCELLED', 'REJECTED'] },
      },
      select: {
        id: true,
        orderId: true,
        status: true,
        createdAt: true,
        readyAt: true,
        order: {
          select: {
            orderNumber: true,
            type: true,
            table: { select: { id: true, number: true, name: true } },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return kots;
  }

  updateStatus(
    branchId: string,
    kotId: string,
    status: string,
    userId?: string,
  ) {
    return this.ordersService.updateKotStatus(branchId, kotId, status, userId);
  }

  rejectTicket(
    branchId: string,
    kotId: string,
    userId: string,
    input: {
      reason: string;
      confirmStarted?: boolean;
      mayRejectStarted: boolean;
    },
  ) {
    return this.ordersService.rejectKot(branchId, kotId, userId, input);
  }

  acceptIncoming(branchId: string, orderId: string, userId: string) {
    return this.ordersService.acceptOrder(branchId, orderId, userId);
  }

  declineIncoming(
    branchId: string,
    orderId: string,
    userId: string,
    reason: string,
  ) {
    return this.ordersService.rejectOrder(branchId, orderId, userId, reason);
  }

  updateItemStatus(
    branchId: string,
    kotItemId: string,
    status: string,
    delayReason?: string,
  ) {
    return this.ordersService.updateKotItemStatus(
      branchId,
      kotItemId,
      status,
      delayReason,
    );
  }

  setHeld(branchId: string, kotId: string, held: boolean) {
    return this.ordersService.setKotHeld(branchId, kotId, held);
  }

  assembleExpo(branchId: string, orderId: string) {
    return this.ordersService.assembleExpo(branchId, orderId);
  }

  fireCourse(branchId: string, orderId: string, courseId: string) {
    return this.ordersService.fireCourse(branchId, orderId, courseId);
  }

  passExpo(branchId: string, orderId: string, userId?: string) {
    return this.ordersService.passExpo(branchId, orderId, userId);
  }

  async expoBoard(branchId: string) {
    const kots = await this.prisma.kot.findMany({
      where: {
        order: { branchId, status: 'OPEN' },
        status: { notIn: ['SERVED', 'CANCELLED', 'REJECTED'] },
      },
      include: {
        station: { select: { id: true, name: true, role: true } },
        course: { select: { id: true, name: true } },
        items: { include: { orderItem: { include: { modifiers: true, menuItem: { select: { prepTimeMinutes: true } } } } } },
        order: {
          select: {
            id: true,
            orderNumber: true,
            type: true,
            table: { select: { number: true, name: true } },
            guestName: true,
          },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    const byOrder = new Map<string, typeof kots>();
    for (const kot of kots) {
      const bucket = byOrder.get(kot.order.id) ?? [];
      bucket.push(kot);
      byOrder.set(kot.order.id, bucket);
    }
    return [...byOrder.values()].map((tickets) => {
      const order = tickets[0].order;
      const live = tickets.filter((ticket) => ticket.status !== 'SERVED');
      return {
        orderId: order.id,
        orderNumber: order.orderNumber,
        type: order.type,
        table: order.table,
        guestName: order.guestName,
        allReady: live.length > 0 && live.every((ticket) => !ticket.held && ticket.status === 'READY'),
        assembled: tickets.every((ticket) => ticket.expoAssembledAt),
        kots: tickets,
      };
    });
  }

  print(branchId: string, kotId: string, reprint: boolean) {
    return this.kotPrint.printTicket(branchId, kotId, reprint);
  }

  setPriority(branchId: string, kotId: string, isPriority: boolean) {
    return this.ordersService.setKotPriority(branchId, kotId, isPriority);
  }

  async getPerformanceReport(branchId: string, date?: string) {
    const { start, end, hours } = reportWindow(date, new Date());
    const [stations, kots] = await Promise.all([
      this.prisma.kitchenStation.findMany({
        where: { branchId },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.kot.findMany({
        where: {
          order: { branchId },
          status: { notIn: ['CANCELLED', 'REJECTED'] },
          OR: [{ createdAt: { gte: start, lt: end } }, { readyAt: { gte: start, lt: end } }],
        },
        select: {
          stationId: true,
          createdAt: true,
          readyAt: true,
          station: { select: { name: true } },
          items: {
            select: {
              wasDelayed: true,
              orderItem: { select: { menuItem: { select: { prepTimeMinutes: true } } } },
            },
          },
        },
      }),
    ]);

    const samples: StationSample[] = kots.map((kot) => {
      const prep = kot.items
        .map((item) => item.orderItem.menuItem?.prepTimeMinutes ?? 0)
        .filter((minutes) => minutes > 0);
      return {
        stationId: kot.stationId,
        stationName: kot.station?.name ?? 'Unassigned',
        createdAt: kot.createdAt,
        readyAt: kot.readyAt,
        prepMinutes: prep.length > 0 ? Math.max(...prep) : null,
        wasDelayed: kot.items.some((item) => item.wasDelayed),
      };
    });
    const measured = stationPerformance(samples, start, end, hours);
    const byId = new Map(measured.map((row) => [row.stationId, row]));
    const rows = stations.map(
      (station) =>
        byId.get(station.id) ?? {
          stationId: station.id,
          stationName: station.name,
          ticketsReady: 0,
          avgMinutesToReady: null,
          delayRate: null,
          throughputPerHour: 0,
          slaCompliance: null,
        },
    );
    const unassigned = byId.get('unassigned');
    if (unassigned) rows.push(unassigned);
    return rows;
  }
}
