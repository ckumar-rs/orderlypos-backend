import {
  base32Decode,
  base32Encode,
  generateRecoveryCode,
  hotp,
  openSecret,
  otpauthUrl,
  sealSecret,
  verifyTotp,
} from './totp';

// RFC 6238 appendix B: SHA1 secret "12345678901234567890"
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('totp', () => {
  it('round-trips base32', () => {
    const buf = Buffer.from('hello world');
    expect(base32Decode(base32Encode(buf)).toString()).toBe('hello world');
    expect(base32Encode(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('matches the RFC 6238 test vectors (6-digit tails)', () => {
    const key = Buffer.from('12345678901234567890');
    expect(hotp(key, Math.floor(59 / 30))).toBe('287082');
    expect(hotp(key, Math.floor(1111111109 / 30))).toBe('081804');
    expect(hotp(key, Math.floor(1234567890 / 30))).toBe('005924');
    expect(hotp(key, Math.floor(20000000000 / 30))).toBe('353130');
  });

  it('accepts the current code and one step of drift, nothing else', () => {
    const now = 1_700_000_000_000;
    const key = base32Decode(RFC_SECRET);
    const step = Math.floor(now / 1000 / 30);
    expect(verifyTotp(RFC_SECRET, hotp(key, step), now)).toBe(step);
    expect(verifyTotp(RFC_SECRET, hotp(key, step - 1), now)).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, hotp(key, step + 1), now)).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, hotp(key, step + 5), now)).toBeNull();
  });

  it('rejects malformed codes', () => {
    expect(verifyTotp(RFC_SECRET, '12345')).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef')).toBeNull();
    expect(verifyTotp(RFC_SECRET, '')).toBeNull();
  });

  it('seals a secret and refuses a tampered or wrong-key one', () => {
    const sealed = sealSecret('JBSWY3DPEHPK3PXP', 'key-a');
    expect(sealed).not.toContain('JBSWY3DPEHPK3PXP');
    expect(openSecret(sealed, 'key-a')).toBe('JBSWY3DPEHPK3PXP');
    expect(() => openSecret(sealed, 'key-b')).toThrow();
    const parts = sealed.split('.');
    parts[3] = Buffer.from('tampered').toString('base64url');
    expect(() => openSecret(parts.join('.'), 'key-a')).toThrow();
  });

  it('builds a standard otpauth URL and distinct recovery codes', () => {
    expect(otpauthUrl('ABC', 'a@b.com', 'My Cafe')).toBe(
      'otpauth://totp/My%20Cafe%3Aa%40b.com?secret=ABC&issuer=My%20Cafe&algorithm=SHA1&digits=6&period=30',
    );
    const a = generateRecoveryCode();
    expect(a).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(generateRecoveryCode()).not.toBe(a);
  });
});
