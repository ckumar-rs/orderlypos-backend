import { applyDecorators, UseGuards } from '@nestjs/common';
import { ApiCookieAuth } from '@nestjs/swagger';
import type { PermissionKey } from '@nodedr-restaurant/types';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { PermissionsGuard } from '../guards/permissions.guard';
import { RequirePermission } from './permissions.decorator';

// Combines "must be logged in" + "must hold these permissions" into one
// decorator so every protected route reads @Auth('menu.manage') instead of
// three stacked decorators repeated on every controller method.
export const Auth = (...permissions: PermissionKey[]) =>
  applyDecorators(
    UseGuards(JwtAuthGuard, PermissionsGuard),
    RequirePermission(...permissions),
    ApiCookieAuth(),
  );
