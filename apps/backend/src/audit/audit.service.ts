import { Injectable } from '@nestjs/common';
import type { AuditLogListQueryDto } from '@nodedr-restaurant/types';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface RecordAuditLogInput {
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  metadata?: Prisma.InputJsonValue | null;
}

// Activates the `AuditLog` model (schema.prisma) as a real, queryable trail
// of who-did-what. Deliberately a thin, explicit helper — NOT a global
// interceptor — so each call site passes structured `metadata` that's
// actually meaningful for its own domain (e.g. `{ amount, reason }` for a
// refund, `{ before, changes }` for an edit) instead of a generic dumped
// request body.
//
// Phase 1 (2026-08) wires `.record()` into: staff create/update
// (modules/users/users.service.ts), order refund + cancel/void
// (modules/orders/orders.service.ts), menu item updates
// (modules/menu/menu.service.ts), and restaurant/branch settings changes
// (modules/settings/settings.service.ts) — the flows that matter most for
// an owner reviewing history. This is a deliberately scoped first pass, not
// an exhaustive sweep of every mutation in every module. Adding a new call
// site later is just: import `AuditModule` into that feature module, inject
// `AuditService` into its service, and call `.record()` once the mutation
// has actually committed.
//
// Known limitation: `AuditLog.userId` is nullable (`onDelete: SetNull` on
// the `User` relation), and restaurant-scoping for `list()`/`listEntities()`
// below is derived via the `user.restaurantId` join (AuditLog itself has no
// `restaurantId` column). An entry whose actor user has since been deleted
// becomes unscoped and will no longer surface in any restaurant's audit log
// view. Acceptable for this first pass; revisit if that becomes a real
// problem (e.g. by denormalizing `restaurantId` onto `AuditLog` directly).
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async record(input: RecordAuditLogInput): Promise<void> {
    await this.prisma.auditLog.create({
      data: {
        userId: input.userId ?? null,
        action: input.action,
        entity: input.entity,
        entityId: input.entityId ?? null,
        metadata: input.metadata ?? undefined,
      },
    });
  }

  async list(restaurantId: string, query: AuditLogListQueryDto) {
    const { entity, action, userId, from, to, page, pageSize } = query;
    const where: Prisma.AuditLogWhereInput = {
      user: { restaurantId, ...(userId ? { id: userId } : {}) },
      ...(entity ? { entity } : {}),
      ...(action ? { action } : {}),
      ...(from || to
        ? {
            createdAt: {
              ...(from ? { gte: from } : {}),
              ...(to ? { lte: to } : {}),
            },
          }
        : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.auditLog.findMany({
        where,
        include: { user: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
    };
  }

  // Distinct entity types actually present for this restaurant — the
  // frontend derives its filter chips from this rather than a hardcoded
  // list, so a new `entity` string used at a future call site shows up
  // automatically (same idea as construction-erp's `distinct: ["entityType"]`
  // pattern).
  async listEntities(restaurantId: string): Promise<string[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: { user: { restaurantId } },
      distinct: ['entity'],
      select: { entity: true },
      orderBy: { entity: 'asc' },
    });
    return rows.map((r) => r.entity);
  }
}
