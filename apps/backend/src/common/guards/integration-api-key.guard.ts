import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { createHash } from 'node:crypto';
import type { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';
import { INTEGRATION_SCOPES_KEY } from '../decorators/require-scope.decorator';

// Authenticates every route on IntegrationsController — the public REST API
// external websites use as a backend (see docs/integrations-api.md). A
// deliberately separate credential from staff sessions/StaffApiKey: this
// key carries no employee identity, just an explicit `scopes` list and an
// optional branch scope, so a leaked integration key can only do exactly
// what it was issued for, never anything a staff login could.
@Injectable()
export class IntegrationApiKeyGuard implements CanActivate {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request: Request = context.switchToHttp().getRequest();

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
    const key = await this.prisma.integrationApiKey.findUnique({
      where: { tokenHash },
    });
    if (!key || key.revokedAt) {
      throw new UnauthorizedException('Invalid or revoked API key');
    }

    const required = this.reflector.getAllAndOverride<string[]>(
      INTEGRATION_SCOPES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (required?.length) {
      const missing = required.filter((scope) => !key.scopes.includes(scope));
      if (missing.length > 0) {
        throw new ForbiddenException(
          `This API key is missing required scope(s): ${missing.join(', ')}`,
        );
      }
    }

    request.integrationKey = {
      id: key.id,
      restaurantId: key.restaurantId,
      branchId: key.branchId,
      scopes: key.scopes,
    };

    // Best-effort — must never block an already-authenticated request.
    this.prisma.integrationApiKey
      .update({ where: { id: key.id }, data: { lastUsedAt: new Date() } })
      .catch(() => undefined);

    return true;
  }
}
