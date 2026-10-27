import { signaturesMatch, isPaidStatus, readGatewayRef, secretsMatch } from './commerce-verify';

describe('commerce-verify', () => {
  it('accepts a paid status and reads gateway ids', () => {
    expect(isPaidStatus('captured')).toBe(true);
    expect(isPaidStatus('failed')).toBe(false);
    const parsed = readGatewayRef({
      order_id: 'order_1',
      status: 'paid',
      utr: 'UTR9',
      short_url: 'https://pay.example/1',
    });
    expect(parsed.refs).toContain('order_1');
    expect(parsed.utr).toBe('UTR9');
    expect(parsed.url).toBe('https://pay.example/1');
  });

  it('checks the hmac of the raw body', () => {
    const raw = Buffer.from('{"ok":true}');
    const { createHmac } = require('node:crypto') as typeof import('node:crypto');
    const mac = createHmac('sha256', 'secret').update(raw).digest('hex');
    expect(signaturesMatch('secret', raw, mac)).toBe(true);
    expect(signaturesMatch('secret', raw, 'nope')).toBe(false);
    expect(secretsMatch('secret', 'secret')).toBe(true);
  });
});
