import { randomBytes } from 'node:crypto';
import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type {
  DeliveryStatusDto,
  DeliveryZoneDto,
  DeliveryZoneUpdateDto,
  DriverLocationDto,
} from '@nodedr-restaurant/types';
import { isSqlite, stringList } from '../../common/sqlite';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import {
  branchDeliveryTracking,
  readBranchSettingsMap,
} from '../settings/settings-kv';
import { WebhooksService } from '../webhooks/webhooks.service';

// Forward-only lifecycle; FAILED is reachable from any open state.
const NEXT: Record<DeliveryStatusDto, DeliveryStatusDto[]> = {
  UNASSIGNED: ['ASSIGNED', 'FAILED'],
  ASSIGNED: ['PICKED_UP', 'UNASSIGNED', 'FAILED'],
  PICKED_UP: ['DELIVERED', 'FAILED'],
  DELIVERED: [],
  FAILED: ['UNASSIGNED'],
};

const ORDER_INCLUDE = {
  driver: { select: { id: true, name: true } },
  deliveryZone: { select: { id: true, name: true } },
} as const;

@Injectable()
export class DeliveryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly webhooks: WebhooksService,
  ) {}

  // --- Zones ---------------------------------------------------------------

  listZones(branchId: string) {
    return this.prisma.deliveryZone.findMany({
      where: { branchId },
      orderBy: { name: 'asc' },
    });
  }

  async createZone(branchId: string, dto: DeliveryZoneDto) {
    await this.assertPincodesFree(branchId, dto.pincodes);
    return this.prisma.deliveryZone.create({ data: { ...dto, branchId } });
  }

  async updateZone(branchId: string, id: string, dto: DeliveryZoneUpdateDto) {
    await this.getZone(branchId, id);
    if (dto.pincodes) await this.assertPincodesFree(branchId, dto.pincodes, id);
    return this.prisma.deliveryZone.update({ where: { id }, data: dto });
  }

  async deleteZone(branchId: string, id: string) {
    await this.getZone(branchId, id);
    // Orders keep their snapshotted fee; the zone link is set null.
    await this.prisma.deliveryZone.delete({ where: { id } });
    return { ok: true };
  }

  private async getZone(branchId: string, id: string) {
    const zone = await this.prisma.deliveryZone.findFirst({
      where: { id, branchId },
    });
    if (!zone) throw new NotFoundException('Delivery zone not found');
    return zone;
  }

  /** A pincode may belong to only one active zone, or quotes would be ambiguous. */
  private async assertPincodesFree(
    branchId: string,
    pincodes: string[],
    exceptId?: string,
  ) {
    const clash = isSqlite()
      ? (
          await this.prisma.deliveryZone.findMany({
            where: {
              branchId,
              isActive: true,
              ...(exceptId ? { id: { not: exceptId } } : {}),
            },
            select: { name: true, pincodes: true },
          })
        ).find((zone) => stringList(zone.pincodes).some((code) => pincodes.includes(code)))
      : await this.prisma.deliveryZone.findFirst({
          where: {
            branchId,
            isActive: true,
            pincodes: { hasSome: pincodes },
            ...(exceptId ? { id: { not: exceptId } } : {}),
          },
          select: { name: true },
        });
    if (clash)
      throw new BadRequestException(
        `A pincode is already covered by the zone "${clash.name}"`,
      );
  }

  /** Public-safe quote: fee/ETA for a pincode, no zone internals. */
  async quote(branchId: string, pincode: string) {
    const zone = isSqlite()
      ? (
          await this.prisma.deliveryZone.findMany({
            where: { branchId, isActive: true },
          })
        ).find((row) => stringList(row.pincodes).includes(pincode))
      : await this.prisma.deliveryZone.findFirst({
          where: { branchId, isActive: true, pincodes: { has: pincode } },
        });
    if (!zone) return { deliverable: false as const };
    return {
      deliverable: true as const,
      zoneName: zone.name,
      fee: Number(zone.fee),
      minOrderAmount: Number(zone.minOrderAmount),
      etaMinutes: zone.etaMinutes,
    };
  }

  // --- Deliveries ----------------------------------------------------------

  /** Active deliveries, or history (DELIVERED/FAILED) when history=true. */
  list(branchId: string, history = false) {
    return this.prisma.order.findMany({
      where: {
        branchId,
        type: 'DELIVERY',
        status: { not: 'CANCELLED' },
        deliveryStatus: history
          ? { in: ['DELIVERED', 'FAILED'] }
          : { in: ['UNASSIGNED', 'ASSIGNED', 'PICKED_UP'] },
      },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: history ? 'desc' : 'asc' },
      take: 200,
    });
  }

  /** Staff who can be assigned: active users with access to this branch. */
  listDrivers(branchId: string) {
    return this.prisma.user.findMany({
      where: {
        isActive: true,
        branches: { some: { branchId } },
        role: { name: 'DELIVERY_STAFF' },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });
  }

  async assignDriver(branchId: string, orderId: string, driverId: string) {
    const order = await this.getDelivery(branchId, orderId);
    if (!['UNASSIGNED', 'ASSIGNED'].includes(order.deliveryStatus ?? ''))
      throw new BadRequestException(
        'This delivery can no longer be reassigned',
      );
    const driver = await this.prisma.user.findFirst({
      where: { id: driverId, isActive: true, branches: { some: { branchId } } },
      select: { id: true },
    });
    if (!driver)
      throw new BadRequestException('Driver not found for this branch');
    return this.save(branchId, orderId, {
      driverId,
      deliveryStatus: 'ASSIGNED',
      trackingToken: order.trackingToken ?? randomBytes(16).toString('hex'),
    });
  }

  async setStatus(
    branchId: string,
    orderId: string,
    status: DeliveryStatusDto,
  ) {
    const order = await this.getDelivery(branchId, orderId);
    const current: DeliveryStatusDto = order.deliveryStatus ?? 'UNASSIGNED';
    if (!NEXT[current].includes(status))
      throw new BadRequestException(`Cannot move from ${current} to ${status}`);
    if (status === 'PICKED_UP' && !order.driverId)
      throw new BadRequestException('Assign a driver first');
    return this.save(branchId, orderId, {
      deliveryStatus: status,
      ...(status === 'UNASSIGNED' ? { driverId: null } : {}),
      ...(status === 'DELIVERED' ? { deliveredAt: new Date() } : {}),
    });
  }

  /**
   * Open deliveries with latest GPS + stale / geofence flags for the live map.
   */
  async live(branchId: string) {
    const tracking = branchDeliveryTracking(
      await readBranchSettingsMap(this.prisma, branchId),
    );
    const staleMs = Math.max(1, tracking.deliveryTrackingStaleMinutes) * 60_000;
    const now = Date.now();
    const orders = await this.prisma.order.findMany({
      where: {
        branchId,
        type: 'DELIVERY',
        status: { not: 'CANCELLED' },
        deliveryStatus: { in: ['ASSIGNED', 'PICKED_UP'] },
      },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'asc' },
      take: 200,
    });
    const recentEvents = await this.prisma.deliveryTrackingEvent.findMany({
      where: {
        orderId: { in: orders.map((o) => o.id) },
        createdAt: { gte: new Date(now - 24 * 60 * 60_000) },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    const latestByOrder = new Map<string, (typeof recentEvents)[number]>();
    for (const event of recentEvents) {
      if (!latestByOrder.has(event.orderId)) latestByOrder.set(event.orderId, event);
    }
    return {
      branch: {
        lat: tracking.deliveryTrackingLat,
        lng: tracking.deliveryTrackingLng,
        radiusKm: tracking.deliveryTrackingRadiusKm,
        staleMinutes: tracking.deliveryTrackingStaleMinutes,
      },
      deliveries: orders.map((order) => {
        const at = order.driverLocationAt
          ? order.driverLocationAt.getTime()
          : null;
        const staleGps =
          order.deliveryStatus === 'PICKED_UP' &&
          (at == null || now - at > staleMs);
        if (staleGps) {
          void this.maybeRecordStale(order.id);
        }
        const lastEvent = latestByOrder.get(order.id);
        return {
          id: order.id,
          orderNumber: order.orderNumber,
          deliveryStatus: order.deliveryStatus,
          guestName: order.guestName,
          deliveryAddress: order.deliveryAddress,
          driver: order.driver,
          driverLat: order.driverLat,
          driverLng: order.driverLng,
          driverLocationAt: order.driverLocationAt,
          trackingToken: order.trackingToken,
          staleGps,
          lastEvent: lastEvent
            ? {
                type: lastEvent.type,
                createdAt: lastEvent.createdAt,
              }
            : null,
        };
      }),
    };
  }

  /**
   * The assigned driver (or a delivery manager standing in for a demo)
   * records where this device is. Nothing is read unless this is called.
   */
  async shareLocation(
    branchId: string,
    orderId: string,
    userId: string,
    canManage: boolean,
    dto: DriverLocationDto,
  ) {
    const order = await this.getDelivery(branchId, orderId);
    const open = order.deliveryStatus === 'ASSIGNED' || order.deliveryStatus === 'PICKED_UP';
    if (!open) {
      throw new BadRequestException('Location is shared only while the delivery is out');
    }
    if (order.driverId !== userId && !canManage) {
      throw new ForbiddenException('Only the assigned driver can share this location');
    }
    const prevPing = await this.prisma.driverPing.findFirst({
      where: { orderId },
      orderBy: { recordedAt: 'desc' },
    });
    await this.prisma.driverPing.create({
      data: { orderId, lat: dto.lat, lng: dto.lng },
    });
    await this.maybeGeofenceEvent(
      branchId,
      orderId,
      prevPing ? { lat: Number(prevPing.lat), lng: Number(prevPing.lng) } : null,
      { lat: dto.lat, lng: dto.lng },
    );
    return this.save(branchId, orderId, {
      driverLat: dto.lat,
      driverLng: dto.lng,
      driverLocationAt: new Date(),
    });
  }

  async trail(branchId: string, orderId: string) {
    const order = await this.getDelivery(branchId, orderId);
    const [pings, events, tracking] = await Promise.all([
      this.prisma.driverPing.findMany({
        where: { orderId },
        orderBy: { recordedAt: 'asc' },
      }),
      this.prisma.deliveryTrackingEvent.findMany({
        where: { orderId },
        orderBy: { createdAt: 'asc' },
      }),
      readBranchSettingsMap(this.prisma, branchId).then(branchDeliveryTracking),
    ]);
    return {
      trackingToken: order.trackingToken,
      branch: {
        lat: tracking.deliveryTrackingLat,
        lng: tracking.deliveryTrackingLng,
        radiusKm: tracking.deliveryTrackingRadiusKm,
      },
      pings: pings.map((p) => ({
        lat: Number(p.lat),
        lng: Number(p.lng),
        recordedAt: p.recordedAt,
      })),
      events: events.map((e) => ({
        type: e.type,
        lat: e.lat == null ? null : Number(e.lat),
        lng: e.lng == null ? null : Number(e.lng),
        createdAt: e.createdAt,
      })),
    };
  }

  async publicTrack(token: string) {
    const order = await this.prisma.order.findFirst({
      where: { trackingToken: token },
      select: {
        id: true,
        orderNumber: true,
        deliveryStatus: true,
        driverLat: true,
        driverLng: true,
        driverLocationAt: true,
        branchId: true,
      },
    });
    if (!order) throw new NotFoundException('Tracking link not found');
    const [pings, tracking] = await Promise.all([
      this.prisma.driverPing.findMany({
        where: { orderId: order.id },
        orderBy: { recordedAt: 'asc' },
        select: { lat: true, lng: true, recordedAt: true },
      }),
      readBranchSettingsMap(this.prisma, order.branchId).then(
        branchDeliveryTracking,
      ),
    ]);
    return {
      orderNumber: order.orderNumber,
      status: order.deliveryStatus,
      driverLat: order.driverLat == null ? null : Number(order.driverLat),
      driverLng: order.driverLng == null ? null : Number(order.driverLng),
      driverLocationAt: order.driverLocationAt,
      branch: {
        lat: tracking.deliveryTrackingLat,
        lng: tracking.deliveryTrackingLng,
        radiusKm: tracking.deliveryTrackingRadiusKm,
      },
      pings: pings.map((p) => ({
        lat: Number(p.lat),
        lng: Number(p.lng),
        recordedAt: p.recordedAt,
      })),
    };
  }

  private async maybeGeofenceEvent(
    branchId: string,
    orderId: string,
    prev: { lat: number; lng: number } | null,
    next: { lat: number; lng: number },
  ) {
    const tracking = branchDeliveryTracking(
      await readBranchSettingsMap(this.prisma, branchId),
    );
    if (
      tracking.deliveryTrackingLat == null ||
      tracking.deliveryTrackingLng == null ||
      tracking.deliveryTrackingRadiusKm <= 0
    ) {
      return;
    }
    const origin = {
      lat: tracking.deliveryTrackingLat,
      lng: tracking.deliveryTrackingLng,
    };
    const radiusM = tracking.deliveryTrackingRadiusKm * 1000;
    const wasInside =
      prev == null ? null : haversineMeters(origin, prev) <= radiusM;
    const isInside = haversineMeters(origin, next) <= radiusM;
    if (wasInside === null || wasInside === isInside) return;
    const type = isInside ? 'GEOFENCE_ENTER' : 'GEOFENCE_EXIT';
    await this.prisma.deliveryTrackingEvent.create({
      data: {
        orderId,
        type,
        lat: next.lat,
        lng: next.lng,
      },
    });
    this.realtime.emitToBranch(branchId, 'delivery.tracking', {
      orderId,
      type,
    });
  }

  private async maybeRecordStale(orderId: string) {
    const recent = await this.prisma.deliveryTrackingEvent.findFirst({
      where: {
        orderId,
        type: 'GPS_STALE',
        createdAt: { gte: new Date(Date.now() - 30 * 60_000) },
      },
    });
    if (recent) return;
    await this.prisma.deliveryTrackingEvent.create({
      data: { orderId, type: 'GPS_STALE' },
    });
  }

  private async getDelivery(branchId: string, orderId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id: orderId, branchId, type: 'DELIVERY' },
    });
    if (!order) throw new NotFoundException('Delivery order not found');
    return order;
  }

  private async save(
    branchId: string,
    orderId: string,
    data: Record<string, unknown>,
  ) {
    const updated = await this.prisma.order.update({
      where: { id: orderId },
      data,
      include: ORDER_INCLUDE,
    });
    this.realtime.emitToBranch(branchId, 'order.updated', { id: orderId });
    void this.webhooks.emitForBranch(branchId, 'delivery.updated', {
      orderId,
      orderNumber: updated.orderNumber,
      status: updated.deliveryStatus,
      driver: updated.driver?.name ?? null,
      address: updated.deliveryAddress,
    });
    return updated;
  }
}

function haversineMeters(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
) {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
