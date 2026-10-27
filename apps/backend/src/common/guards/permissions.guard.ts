import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  permissionSatisfied,
  type PermissionKey,
} from '@nodedr-restaurant/types';
import { PERMISSIONS_KEY } from '../decorators/permissions.decorator';
import type { AuthenticatedRequest } from '../types/authenticated-request';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<PermissionKey[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    );

    if (!required || required.length === 0) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const user = request.user;
    if (!user) {
      throw new ForbiddenException('No authenticated user');
    }

    const hasAll = required.every((permission) =>
      permissionSatisfied(user.permissions, permission),
    );
    if (!hasAll) {
      throw new ForbiddenException(
        `Missing permission: ${required.join(', ')}`,
      );
    }

    return true;
  }
}
