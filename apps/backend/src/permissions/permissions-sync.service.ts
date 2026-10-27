import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { PERMISSIONS } from '@nodedr-restaurant/types';
import { PrismaService } from '../prisma/prisma.service';

// Roles this deep are meant to always hold every permission that exists —
// see DEFAULT_ROLE_PERMISSIONS in packages/types. RolePermission rows are
// normally only granted once, at signup/seed time. When a later release
// adds a new permission (e.g. kds.manage for the Kitchen Display module),
// every restaurant that signed up *before* that release never gets it
// backfilled — their OWNER silently loses access to the new nav tab/feature
// until someone creates a brand-new account, which is exactly the bug
// report this fixes: "Kitchen tab broken, but a new account worked".
const ALWAYS_FULL_ACCESS_ROLES = ['OWNER', 'ADMINISTRATOR'] as const;

@Injectable()
export class PermissionsSyncService implements OnModuleInit {
  private readonly logger = new Logger(PermissionsSyncService.name);

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.sync();
  }

  async sync() {
    for (const permission of PERMISSIONS) {
      await this.prisma.permission.upsert({
        where: { key: permission.key },
        update: { label: permission.label, category: permission.category },
        create: permission,
      });
    }
    const allPermissions = await this.prisma.permission.findMany();

    const roles = await this.prisma.role.findMany({
      where: { name: { in: [...ALWAYS_FULL_ACCESS_ROLES] } },
      include: { permissions: true },
    });

    for (const role of roles) {
      const grantedIds = new Set(role.permissions.map((p) => p.permissionId));
      const missing = allPermissions.filter((p) => !grantedIds.has(p.id));
      if (missing.length === 0) continue;

      await this.prisma.rolePermission.createMany({
        data: missing.map((p) => ({ roleId: role.id, permissionId: p.id })),
        skipDuplicates: true,
      });
      this.logger.log(
        `Backfilled ${missing.length} new permission(s) onto role ${role.id} (${role.name})`,
      );
    }
  }
}
