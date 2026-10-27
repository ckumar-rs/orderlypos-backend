import { SetMetadata } from '@nestjs/common';
import type { PermissionKey } from '@nodedr-restaurant/types';

export const PERMISSIONS_KEY = 'requiredPermissions';

// Usage: @RequirePermission('menu.manage') on any controller method.
// PermissionsGuard reads this metadata and checks it against the caller's
// role-derived permission set — never a hardcoded role check in the handler.
export const RequirePermission = (...permissions: PermissionKey[]) =>
  SetMetadata(PERMISSIONS_KEY, permissions);
