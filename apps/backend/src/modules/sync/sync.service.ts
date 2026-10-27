import {
  BadRequestException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { SyncIngestDto } from '@nodedr-restaurant/types';
import { Prisma } from '@prisma/client';
import { openSecret } from '../../auth/totp';
import { PrismaService } from '../../prisma/prisma.service';

const BATCH = 50;

@Injectable()
export class SyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private keyMaterial() {
    return (
      this.config.get<string>('WEBHOOK_KEY') ??
      this.config.get<string>('JWT_SECRET') ??
      ''
    );
  }

  async status(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
      select: {
        syncEnabled: true,
        syncHqUrl: true,
        syncHqTokenSealed: true,
        syncIntervalSec: true,
        syncLastAt: true,
        syncLastError: true,
      },
    });
    const branches = await this.prisma.branch.findMany({
      where: { restaurantId, isActive: true },
      select: { id: true, name: true },
    });
    const pending = await this.prisma.syncOutbox.groupBy({
      by: ['branchId'],
      where: {
        syncedAt: null,
        branchId: { in: branches.map((row) => row.id) },
      },
      _count: { _all: true },
    });
    const byBranch = new Map(pending.map((row) => [row.branchId, row._count._all]));
    const hqCount = await this.prisma.hqSyncEvent.count({
      where: { restaurantId },
    });
    return {
      enabled: Boolean(restaurant?.syncEnabled),
      hqUrl: restaurant?.syncHqUrl ?? null,
      tokenConfigured: Boolean(restaurant?.syncHqTokenSealed),
      intervalSec: restaurant?.syncIntervalSec ?? 60,
      lastAt: restaurant?.syncLastAt ?? null,
      lastError: restaurant?.syncLastError ?? null,
      hqEvents: hqCount,
      branches: branches.map((branch) => ({
        ...branch,
        pending: byBranch.get(branch.id) ?? 0,
      })),
    };
  }

  async badge(restaurantId: string) {
    const status = await this.status(restaurantId);
    return {
      enabled: status.enabled,
      lastAt: status.lastAt,
      lastError: status.lastError,
      pending: status.branches.reduce((sum, branch) => sum + branch.pending, 0),
    };
  }

  async listHqEvents(restaurantId: string) {
    return this.prisma.hqSyncEvent.findMany({
      where: { restaurantId },
      orderBy: { receivedAt: 'desc' },
      take: 80,
    });
  }

  async tickRestaurant(restaurantId: string) {
    const restaurant = await this.prisma.restaurant.findUnique({
      where: { id: restaurantId },
    });
    if (!restaurant?.syncEnabled) {
      return { queued: 0, sent: 0, skipped: true };
    }
    const queued = await this.enqueueMissing(restaurantId);
    const sent = await this.flush(restaurant);
    await this.prisma.restaurant.update({
      where: { id: restaurantId },
      data: { syncLastAt: new Date(), syncLastError: null },
    });
    return { queued, sent, skipped: false };
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async tickAll() {
    const restaurants = await this.prisma.restaurant.findMany({
      where: { syncEnabled: true },
    });
    const now = Date.now();
    for (const restaurant of restaurants) {
      const waitMs = (restaurant.syncIntervalSec || 60) * 1000;
      if (restaurant.syncLastAt && now - restaurant.syncLastAt.getTime() < waitMs) {
        continue;
      }
      try {
        await this.tickRestaurant(restaurant.id);
      } catch (err) {
        await this.prisma.restaurant.update({
          where: { id: restaurant.id },
          data: {
            syncLastAt: new Date(),
            syncLastError: err instanceof Error ? err.message : 'Sync failed',
          },
        });
      }
    }
  }

  async ingest(token: string | undefined, dto: SyncIngestDto) {
    if (!token) throw new UnauthorizedException('Missing sync token');
    const restaurants = await this.prisma.restaurant.findMany({
      where: { syncHqTokenSealed: { not: null } },
      select: { id: true, syncHqTokenSealed: true },
    });
    const restaurant = restaurants.find((row) => {
      try {
        return (
          !!row.syncHqTokenSealed &&
          openSecret(row.syncHqTokenSealed, this.keyMaterial()) === token
        );
      } catch {
        return false;
      }
    });
    if (!restaurant) throw new UnauthorizedException('Invalid sync token');
    return this.storeEvents(restaurant.id, dto);
  }

  private async storeEvents(restaurantId: string, dto: SyncIngestDto) {
    let stored = 0;
    let conflicts = 0;
    const localBranch = await this.prisma.branch.findFirst({
      where: { restaurantId },
      select: { id: true },
    });
    for (const event of dto.events) {
      const where = {
        restaurantId_sourceBranchId_entityType_entityId: {
          restaurantId,
          sourceBranchId: dto.sourceBranchId,
          entityType: event.entityType,
          entityId: event.entityId,
        },
      };
      const existing = await this.prisma.hqSyncEvent.findUnique({ where });
      if (existing && JSON.stringify(existing.payload) !== JSON.stringify(event.payload)) {
        conflicts += 1;
        if (localBranch) {
          await this.prisma.offlineConflict.create({
            data: {
              branchId: localBranch.id,
              requestId: event.entityId,
              reason: `HQ ${event.entityType} disagrees with the copy already stored`,
              payload: { stored: existing.payload, incoming: event.payload } as Prisma.InputJsonValue,
            },
          });
        }
        continue;
      }
      if (existing) continue;
      await this.prisma.hqSyncEvent.create({
        data: {
          restaurantId,
          sourceBranchId: dto.sourceBranchId,
          sourceBranchName: dto.sourceBranchName,
          entityType: event.entityType,
          entityId: event.entityId,
          occurredAt: new Date(event.occurredAt),
          payload: event.payload as Prisma.InputJsonValue,
        },
      });
      stored += 1;
    }
    return { stored, conflicts };
  }

  private async enqueueMissing(restaurantId: string) {
    const branches = await this.prisma.branch.findMany({
      where: { restaurantId, isActive: true },
      select: { id: true, name: true },
    });
    let queued = 0;
    for (const branch of branches) {
      const [orders, payments, movements, journals] = await Promise.all([
        this.prisma.order.findMany({
          where: { branchId: branch.id, status: 'PAID' },
          select: {
            id: true,
            orderNumber: true,
            billedAt: true,
            totalAmount: true,
            type: true,
          },
          take: 300,
          orderBy: { billedAt: 'desc' },
        }),
        this.prisma.payment.findMany({
          where: { order: { branchId: branch.id } },
          select: {
            id: true,
            method: true,
            amount: true,
            createdAt: true,
            orderId: true,
          },
          take: 400,
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.stockMovement.findMany({
          where: { branchId: branch.id },
          select: {
            id: true,
            type: true,
            quantity: true,
            createdAt: true,
            ingredientId: true,
          },
          take: 300,
          orderBy: { createdAt: 'desc' },
        }),
        this.prisma.journalVoucher.findMany({
          where: { branchId: branch.id },
          select: {
            id: true,
            number: true,
            postedOn: true,
            narration: true,
            sourceType: true,
          },
          take: 200,
          orderBy: { createdAt: 'desc' },
        }),
      ]);
      queued += await this.enqueue(
        branch.id,
        orders.map((row) => ({
          entityType: 'ORDER',
          entityId: row.id,
          occurredAt: row.billedAt ?? new Date(),
          payload: {
            id: row.id,
            orderNumber: row.orderNumber,
            billedAt: row.billedAt?.toISOString() ?? null,
            totalAmount: Number(row.totalAmount),
            type: row.type,
            branchName: branch.name,
          },
        })),
      );
      queued += await this.enqueue(
        branch.id,
        payments.map((row) => ({
          entityType: 'PAYMENT',
          entityId: row.id,
          occurredAt: row.createdAt,
          payload: {
            id: row.id,
            method: row.method,
            amount: Number(row.amount),
            createdAt: row.createdAt.toISOString(),
            orderId: row.orderId,
            branchName: branch.name,
          },
        })),
      );
      queued += await this.enqueue(
        branch.id,
        movements.map((row) => ({
          entityType: 'STOCK_MOVEMENT',
          entityId: row.id,
          occurredAt: row.createdAt,
          payload: {
            id: row.id,
            type: row.type,
            quantity: Number(row.quantity),
            createdAt: row.createdAt.toISOString(),
            ingredientId: row.ingredientId,
            branchName: branch.name,
          },
        })),
      );
      queued += await this.enqueue(
        branch.id,
        journals.map((row) => ({
          entityType: 'JOURNAL',
          entityId: row.id,
          occurredAt: row.postedOn,
          payload: {
            id: row.id,
            number: row.number,
            postedOn: row.postedOn.toISOString(),
            narration: row.narration,
            sourceType: row.sourceType,
            branchName: branch.name,
          },
        })),
      );
    }
    return queued;
  }

  private async enqueue(
    branchId: string,
    rows: {
      entityType: string;
      entityId: string;
      occurredAt: Date;
      payload: Prisma.InputJsonValue;
    }[],
  ) {
    let added = 0;
    for (const row of rows) {
      const created = await this.prisma.syncOutbox.upsert({
        where: {
          branchId_entityType_entityId: {
            branchId,
            entityType: row.entityType,
            entityId: row.entityId,
          },
        },
        create: {
          branchId,
          entityType: row.entityType,
          entityId: row.entityId,
          occurredAt: row.occurredAt,
          payload: row.payload,
        },
        update: {},
      });
      if (!created.syncedAt && created.attempts === 0) added += 1;
    }
    return added;
  }

  private async flush(restaurant: {
    id: string;
    syncHqUrl: string | null;
    syncHqTokenSealed: string | null;
  }) {
    const pending = await this.prisma.syncOutbox.findMany({
      where: { syncedAt: null, branch: { restaurantId: restaurant.id } },
      include: { branch: { select: { id: true, name: true } } },
      orderBy: { occurredAt: 'asc' },
      take: BATCH,
    });
    if (pending.length === 0) return 0;
    const groups = new Map<string, typeof pending>();
    for (const row of pending) {
      const bucket = groups.get(row.branchId) ?? [];
      bucket.push(row);
      groups.set(row.branchId, bucket);
    }
    let sent = 0;
    for (const rows of groups.values()) {
      const dto: SyncIngestDto = {
        sourceBranchId: rows[0].branch.id,
        sourceBranchName: rows[0].branch.name,
        events: rows.map((row) => ({
          entityType: row.entityType,
          entityId: row.entityId,
          occurredAt: row.occurredAt.toISOString(),
          payload: row.payload,
        })),
      };
      try {
        if (restaurant.syncHqUrl?.trim()) {
          await this.postRemote(restaurant, dto);
        } else {
          await this.storeEvents(restaurant.id, dto);
        }
        await this.prisma.syncOutbox.updateMany({
          where: { id: { in: rows.map((row) => row.id) } },
          data: { syncedAt: new Date(), lastError: null },
        });
        sent += rows.length;
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Flush failed';
        await this.prisma.syncOutbox.updateMany({
          where: { id: { in: rows.map((row) => row.id) } },
          data: { attempts: { increment: 1 }, lastError: message },
        });
        throw new BadRequestException(message);
      }
    }
    return sent;
  }

  private async postRemote(
    restaurant: { syncHqUrl: string | null; syncHqTokenSealed: string | null },
    dto: SyncIngestDto,
  ) {
    const url = `${restaurant.syncHqUrl!.replace(/\/$/, '')}/api/v1/sync/ingest`;
    if (!/^https?:\/\//i.test(url)) {
      throw new BadRequestException('HQ URL must start with http:// or https://');
    }
    const token = restaurant.syncHqTokenSealed
      ? openSecret(restaurant.syncHqTokenSealed, this.keyMaterial())
      : '';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(dto),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      throw new Error(`HQ answered ${res.status}`);
    }
  }
}
