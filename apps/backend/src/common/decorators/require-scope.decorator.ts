import { SetMetadata } from '@nestjs/common';
import type { IntegrationScope } from '@nodedr-restaurant/types';

export const INTEGRATION_SCOPES_KEY = 'requiredIntegrationScopes';

// Usage: @RequireScope('orders:write') on an IntegrationsController method.
// IntegrationApiKeyGuard reads this metadata and checks it against the
// calling key's own `scopes` array — mirrors RequirePermission/
// PermissionsGuard's pattern, just for external-integration credentials
// instead of staff roles.
export const RequireScope = (...scopes: IntegrationScope[]) =>
  SetMetadata(INTEGRATION_SCOPES_KEY, scopes);
