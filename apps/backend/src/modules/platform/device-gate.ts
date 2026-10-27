export const DEVICE_STALE_MS = 15 * 60 * 1000;

export function deviceGate(input: {
  requireDevice: boolean;
  path: string;
  method: string;
  hasToken: boolean;
  known: boolean;
  lastSeenAt: Date | null;
  now: Date;
}) {
  const path = input.path.split('?')[0];
  if (
    path.includes('/v1/public') ||
    path.includes('/v1/auth') ||
    path.includes('/v1/platform/security') ||
    path.includes('/v1/settings')
  ) {
    return 'allow' as const;
  }
  const registering = input.method === 'POST' && path.endsWith('/platform/devices');
  const heartbeat = input.method === 'POST' && path.endsWith('/platform/devices/heartbeat');
  if (!input.requireDevice || registering) return 'allow' as const;
  if (!input.hasToken) return 'missing' as const;
  if (!input.known) return 'unknown' as const;
  if (heartbeat) return 'allow' as const;
  if (!input.lastSeenAt || input.now.getTime() - input.lastSeenAt.getTime() > DEVICE_STALE_MS) {
    return 'stale' as const;
  }
  return 'allow' as const;
}
