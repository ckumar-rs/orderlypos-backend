import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { CreateRoleDto, UpdateRoleDto } from '@nodedr-restaurant/types';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../prisma/prisma.service';

const SELECT = {
  id: true,
  name: true,
  label: true,
  isSystem: true,
  createdAt: true,
  permissions: {
    select: {
      permission: { select: { key: true, label: true, category: true } },
    },
  },
} as const;

// Backs Settings > Roles — lets an Owner create roles beyond the seeded 11
// (Role.name became a plain String in this phase; see schema.prisma).
// `GET /v1/users/roles` (used by the staff-create role picker) stays on
// UsersService.listRoles — unrelated, unchanged, still just a
// `role.findMany` scoped by restaurant, so a newly created custom role
// shows up there automatically.
@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  list(restaurantId: string) {
    return this.prisma.role.findMany({
      where: { restaurantId },
      select: SELECT,
      orderBy: { label: 'asc' },
    });
  }

  async create(restaurantId: string, actorId: string, dto: CreateRoleDto) {
    const permissions = await this.assertPermissionKeysValid(
      dto.permissionKeys,
    );

    const role = await this.prisma.role.create({
      data: {
        restaurantId,
        name: dto.name,
        label: dto.label,
        isSystem: false,
        permissions: {
          create: permissions.map((p) => ({ permissionId: p.id })),
        },
      },
      select: SELECT,
    });

    await this.audit.record({
      userId: actorId,
      action: 'role.created',
      entity: 'Role',
      entityId: role.id,
      metadata: {
        name: role.name,
        label: role.label,
        permissionKeys: dto.permissionKeys,
      },
    });

    return role;
  }

  async update(
    restaurantId: string,
    actorId: string,
    id: string,
    dto: UpdateRoleDto,
  ) {
    const existing = await this.getForRestaurant(restaurantId, id);

    const nextPermissions = dto.permissionKeys
      ? await this.assertPermissionKeysValid(dto.permissionKeys)
      : undefined;

    const updated = await this.prisma.$transaction(async (tx) => {
      if (nextPermissions) {
        const currentKeys = new Set(
          existing.permissions.map((p) => p.permission.key),
        );
        const nextKeys = new Set(nextPermissions.map((p) => p.key));
        const toAdd = nextPermissions.filter((p) => !currentKeys.has(p.key));
        const toRemoveKeys = [...currentKeys].filter(
          (key) => !nextKeys.has(key),
        );

        if (toRemoveKeys.length > 0) {
          await tx.rolePermission.deleteMany({
            where: { roleId: id, permission: { key: { in: toRemoveKeys } } },
          });
        }
        if (toAdd.length > 0) {
          await tx.rolePermission.createMany({
            data: toAdd.map((p) => ({ roleId: id, permissionId: p.id })),
            skipDuplicates: true,
          });
        }
      }

      return tx.role.update({
        where: { id },
        data: { label: dto.label },
        select: SELECT,
      });
    });

    await this.audit.record({
      userId: actorId,
      action: 'role.updated',
      entity: 'Role',
      entityId: id,
      metadata: { label: dto.label, permissionKeys: dto.permissionKeys },
    });

    return updated;
  }

  async remove(restaurantId: string, actorId: string, id: string) {
    const existing = await this.getForRestaurant(restaurantId, id);
    if (existing.isSystem) {
      throw new BadRequestException(
        'Seeded system roles cannot be deleted — create a custom role instead',
      );
    }

    const assignedCount = await this.prisma.user.count({
      where: { roleId: id },
    });
    if (assignedCount > 0) {
      throw new ConflictException(
        `Cannot delete this role — ${assignedCount} staff account(s) are still assigned to it`,
      );
    }

    await this.prisma.role.delete({ where: { id } });

    await this.audit.record({
      userId: actorId,
      action: 'role.deleted',
      entity: 'Role',
      entityId: id,
      metadata: { name: existing.name, label: existing.label },
    });

    return { ok: true };
  }

  private async getForRestaurant(restaurantId: string, id: string) {
    const role = await this.prisma.role.findFirst({
      where: { id, restaurantId },
      select: SELECT,
    });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  private async assertPermissionKeysValid(keys: string[]) {
    if (keys.length === 0) return [];
    const found = await this.prisma.permission.findMany({
      where: { key: { in: keys } },
      select: { id: true, key: true },
    });
    if (found.length !== new Set(keys).size) {
      const foundKeys = new Set(found.map((p) => p.key));
      const invalid = keys.filter((key) => !foundKeys.has(key));
      throw new BadRequestException(
        `Unknown permission key(s): ${invalid.join(', ')}`,
      );
    }
    return found;
  }
}
