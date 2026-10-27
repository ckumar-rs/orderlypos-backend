import { appReceivesEvents } from './app-target';

describe('appReceivesEvents', () => {
  const ready = { enabled: true, baseUrl: 'https://vendor.example/hook', hasSecret: true };

  it('calls an enabled app that has a URL and a secret', () => {
    expect(appReceivesEvents(ready)).toBe(true);
  });

  it('skips an app that is off, or missing a URL or a secret', () => {
    expect(appReceivesEvents({ ...ready, enabled: false })).toBe(false);
    expect(appReceivesEvents({ ...ready, baseUrl: '  ' })).toBe(false);
    expect(appReceivesEvents({ ...ready, baseUrl: null })).toBe(false);
    expect(appReceivesEvents({ ...ready, hasSecret: false })).toBe(false);
  });
});
