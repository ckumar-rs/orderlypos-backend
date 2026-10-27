import { deviceGate } from './device-gate';

const now = new Date('2026-10-26T12:00:00Z');

describe('device gate', () => {
  it('lets every protected route through when the switch is off', () => {
    expect(
      deviceGate({
        requireDevice: false,
        path: '/api/v1/orders',
        method: 'GET',
        hasToken: false,
        known: false,
        lastSeenAt: null,
        now,
      }),
    ).toBe('allow');
  });

  it('refuses a protected route without a known, recent device', () => {
    const base = {
      requireDevice: true,
      path: '/api/v1/kds/tickets',
      method: 'GET',
      hasToken: true,
      known: true,
      lastSeenAt: new Date('2026-10-26T11:30:00Z'),
      now,
    };
    expect(deviceGate({ ...base, hasToken: false, known: false, lastSeenAt: null })).toBe('missing');
    expect(deviceGate({ ...base, known: false })).toBe('unknown');
    expect(deviceGate(base)).toBe('stale');
    expect(deviceGate({ ...base, lastSeenAt: new Date('2026-10-26T11:50:00Z') })).toBe('allow');
  });

  it('keeps login, settings, registration, and heartbeat available', () => {
    const locked = {
      requireDevice: true,
      method: 'POST',
      hasToken: false,
      known: false,
      lastSeenAt: null,
      now,
    };
    expect(deviceGate({ ...locked, path: '/api/v1/auth/login' })).toBe('allow');
    expect(deviceGate({ ...locked, path: '/api/v1/platform/security' })).toBe('allow');
    expect(deviceGate({ ...locked, path: '/api/v1/platform/devices' })).toBe('allow');
    expect(
      deviceGate({
        ...locked,
        path: '/api/v1/platform/devices/heartbeat',
        hasToken: true,
        known: true,
        lastSeenAt: new Date('2026-10-26T08:00:00Z'),
      }),
    ).toBe('allow');
  });
});
