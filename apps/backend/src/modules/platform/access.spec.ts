import { clientIp, ipAllowed } from './access';

describe('network allow list', () => {
  it('allows every address until a list is saved', () => {
    expect(ipAllowed('', '10.0.0.8')).toBe(true);
    expect(ipAllowed('10.0.0.8, 10.0.0.9', '10.0.0.9')).toBe(true);
    expect(ipAllowed('10.0.0.8', '10.0.0.9')).toBe(false);
  });

  it('reads the client address the proxy forwarded', () => {
    expect(clientIp({ 'x-forwarded-for': '203.0.113.5, 10.0.0.1' }, '10.0.0.1')).toBe(
      '203.0.113.5',
    );
    expect(clientIp({}, '::ffff:127.0.0.1')).toBe('127.0.0.1');
  });
});
