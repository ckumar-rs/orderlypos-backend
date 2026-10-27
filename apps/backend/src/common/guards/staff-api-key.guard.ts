import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { SessionUser } from '@nodedr-restaurant/types';
import { PrismaService } from '../../prisma/prisma.service';
import type { AuthenticatedRequest } from '../types/authenticated-request';

// Authenticates the MCP server (src/mcp/) via a personal access token
// (StaffApiKey) instead of the cookie-based Passport JWT session — an AI
// client has no browser cookie jar. Resolves to the exact same SessionUser
// shape a cookie session produces and writes it to request.user, so every
// existing permission check downstream (PermissionsGuard, manual
// user.permissions checks in MCP tool handlers) applies identically to
// whether the caller is a browser or an MCP client. Deliberately a
// standalone guard rather than extending JwtAuthGuard (passport-jwt) — this
// isn't a JWT, and bolting a second credential type onto the passport
// strategy would be a much larger, riskier change for the same result.
@Injectable()
export class StaffApiKeyGuard implements CanActivate {
  constructor(private readonly prisma: PrismaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request: AuthenticatedRequest = context.switchToHttp().getRequest();

    const header = request.headers.authorization;
    const rawToken = header?.startsWith('Bearer ')
      ? header.slice('Bearer '.length).trim()
      : null;
    if (!rawToken) {
      throw new UnauthorizedException(
        'Missing Authorization: Bearer <api key> header',
      );
    }

    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const key = await this.prisma.staffApiKey.findUnique({
      where: { tokenHash },
      include: {
        user: {
          include: {
            role: {
              include: { permissions: { include: { permission: true } } },
            },
          },
        },
      },
    });

    if (!key || key.revokedAt) {
      throw new UnauthorizedException('Invalid or revoked API key');
    }
    if (!key.user.isActive) {
      throw new UnauthorizedException('Staff account is not active');
    }

    const sessionUser: SessionUser = {
      id: key.user.id,
      restaurantId: key.user.restaurantId,
      name: key.user.name,
      roleId: key.user.roleId,
      roleName: key.user.role.name,
      permissions: key.user.role.permissions.map((rp) => rp.permission.key),
    };
    request.user = sessionUser;

    // Best-effort — must never block an already-authenticated request.
    this.prisma.staffApiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return true;
  }
}
