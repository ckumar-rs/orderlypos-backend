import { signPayload, verifySignature } from './signing';

describe('webhook signing', () => {
  const body = '{"event":"order.paid"}';

  it('verifies what it signed', () => {
    const h = signPayload('whsec_abc', body, 1_700_000_000);
    expect(verifySignature('whsec_abc', body, h, 300, 1_700_000_010)).toBe(
      true,
    );
  });

  it('rejects a tampered body, wrong secret, and stale timestamps', () => {
    const h = signPayload('whsec_abc', body, 1_700_000_000);
    expect(
      verifySignature('whsec_abc', body + ' ', h, 300, 1_700_000_010),
    ).toBe(false);
    expect(verifySignature('whsec_other', body, h, 300, 1_700_000_010)).toBe(
      false,
    );
    expect(verifySignature('whsec_abc', body, h, 300, 1_700_000_999)).toBe(
      false,
    );
  });

  it('rejects malformed headers', () => {
    expect(verifySignature('s', body, 'garbage')).toBe(false);
    expect(verifySignature('s', body, 't=1')).toBe(false);
  });
});
