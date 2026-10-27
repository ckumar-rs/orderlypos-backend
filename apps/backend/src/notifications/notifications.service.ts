import { Injectable, NotFoundException } from '@nestjs/common';
import type { NotificationListQueryDto } from '@nodedr-restaurant/types';
import { PrismaService } from '../prisma/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';

export interface NotifyPayload {
  type: string;
  title: string;
  body: string;
  entity?: string;
  entityId?: string;
}

// Backs the dashboard topbar's notification bell: persists one
// `Notification` row per resolved recipient, then pushes a live event over
// the *existing* realtime gateway (no second websocket layer) so a
// connected client can play a sound/haptic and refresh its unread count.
//
// Recipient-targeting deliberately does NOT reuse `RealtimeGateway.
// emitToBranch()`. Every socket connected to a branch — waiter, cashier,
// kitchen — sits in the same `branch:<id>` room (see realtime.gateway.ts),
// because most existing events (table/KOT/order updates) genuinely are
// "everyone on this branch should see this". A permission-gated
// notification (e.g. "kitchen staff only") is NOT that: broadcasting it to
// the branch room would leak a kitchen-only alert onto a waiter's screen
// just because they're logged into the same branch. So `RealtimeGateway`
// gained a second room per socket, keyed to the authenticated user's own
// id (`user:<id>`, joined in `handleConnection` regardless of which branch
// is being viewed), and `emitToUsers()` targets exactly that — see
// realtime.gateway.ts for the full reasoning.
//
// The realtime payload is deliberately a lightweight "something changed"
// signal (type/title/body/entity/entityId, no row `id`) rather than the
// created rows themselves: when `notifyByPermission` resolves multiple
// recipients, each gets their own `Notification` row with a different id,
// but they'd all receive the same single socket emit — sending back one
// row's id would be wrong for every recipient but that one. The client
// treats receipt as "play feedback and refetch your own list from
// GET /v1/notifications", the same "socket event -> invalidate -> refetch
// truth from REST" pattern `useRealtime.ts` already uses for KOT/table/order
// events, rather than trusting socket payload as authoritative data.
@Injectable()
export class NotificationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
  ) {}

  // All active staff assigned to this branch whose role holds the given
  // permission key — resolved via User -> Role -> RolePermission ->
  // Permission, never by hardcoded role name (Phase 2 made Role.name
  // free-form, so a custom "Sous Chef" role can hold kds.manage without
  // being named KITCHEN_STAFF).
  async notifyByPermission(
    branchId: string,
    permissionKey: string,
    payload: NotifyPayload,
  ) {
    const recipients = await this.prisma.user.findMany({
      where: {
        isActive: true,
        branches: { some: { branchId } },
        role: {
          permissions: { some: { permission: { key: permissionKey } } },
        },
      },
      select: { id: true },
    });
    if (recipients.length === 0) return;

    await this.prisma.notification.createMany({
      data: recipients.map((r) => ({
        branchId,
        recipientUserId: r.id,
        type: payload.type,
        title: payload.title,
        body: payload.body,
        entity: payload.entity ?? null,
        entityId: payload.entityId ?? null,
      })),
    });

    this.realtime.emitToUsers(
      recipients.map((r) => r.id),
      'notification.created',
      payload,
    );
  }

  async notifyUser(userId: string, branchId: string, payload: NotifyPayload) {
    await this.prisma.notification.create({
      data: {
        branchId,
        recipientUserId: userId,
        type: payload.type,
        title: payload.title,
        body: payload.body,
        entity: payload.entity ?? null,
        entityId: payload.entityId ?? null,
      },
    });

    this.realtime.emitToUsers([userId], 'notification.created', payload);
  }

  async list(userId: string, query: NotificationListQueryDto) {
    const { unreadOnly, page, pageSize } = query;
    const where = {
      recipientUserId: userId,
      ...(unreadOnly ? { readAt: null } : {}),
    };

    const [data, total, unreadCount] = await Promise.all([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({
        where: { recipientUserId: userId, readAt: null },
      }),
    ]);

    return {
      data,
      total,
      unreadCount,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  async markRead(userId: string, id: string) {
    const notification = await this.prisma.notification.findFirst({
      where: { id, recipientUserId: userId },
      select: { id: true, readAt: true },
    });
    if (!notification) throw new NotFoundException('Notification not found');
    if (notification.readAt) return notification;

    return this.prisma.notification.update({
      where: { id },
      data: { readAt: new Date() },
    });
  }

  async markAllRead(userId: string) {
    await this.prisma.notification.updateMany({
      where: { recipientUserId: userId, readAt: null },
      data: { readAt: new Date() },
    });
    return { ok: true };
  }
}
