// RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30 s), built on node:crypto so there
// is no extra dependency to audit. Compatible with Google Authenticator,
// Authy, 1Password, etc.
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const STEP_SECONDS = 30;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Invalid base32 character');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function generateSecret(): string {
  return base32Encode(randomBytes(20)); // 160 bits
}

export function hotp(secret: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const offset = h[h.length - 1] & 0x0f;
  const code =
    ((h[offset] & 0x7f) << 24) |
    (h[offset + 1] << 16) |
    (h[offset + 2] << 8) |
    h[offset + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

export const stepAt = (ms: number) => Math.floor(ms / 1000 / STEP_SECONDS);

/**
 * Checks a code against the current step and one step either side (clock
 * drift). Returns the matching step, or null. Callers must reject a step
 * that is not greater than the last one accepted, so a code is single-use.
 */
export function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs = Date.now(),
  window = 1,
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretBase32);
  const current = stepAt(nowMs);
  for (let w = -window; w <= window; w++) {
    const expected = hotp(secret, current + w);
    if (timingSafeEqual(Buffer.from(expected), Buffer.from(code)))
      return current + w;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer: string) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`;
}

// --- Secret at rest ---------------------------------------------------------
// AES-256-GCM so a database leak alone does not hand over every user's
// second factor. Format: v1.<iv>.<tag>.<ciphertext> (base64url).

const keyFrom = (material: string) =>
  createHash('sha256').update(`2fa-secret:${material}`).digest();

export function sealSecret(secret: string, keyMaterial: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyFrom(keyMaterial), iv);
  const ct = Buffer.concat([c.update(secret, 'utf8'), c.final()]);
  return ['v1', iv, c.getAuthTag(), ct]
    .map((p) => (typeof p === 'string' ? p : p.toString('base64url')))
    .join('.');
}

export function openSecret(sealed: string, keyMaterial: string): string {
  const [v, iv, tag, ct] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Bad sealed secret');
  const d = createDecipheriv(
    'aes-256-gcm',
    keyFrom(keyMaterial),
    Buffer.from(iv, 'base64url'),
  );
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([
    d.update(Buffer.from(ct, 'base64url')),
    d.final(),
  ]).toString('utf8');
}

/** Human-friendly one-time recovery code, e.g. "7KQ2-9XMD-4TPA". */
export function generateRecoveryCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I
  const bytes = randomBytes(12);
  const chars = [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
}
