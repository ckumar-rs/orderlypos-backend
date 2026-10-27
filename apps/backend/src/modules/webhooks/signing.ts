import { createHmac, timingSafeEqual } from 'node:crypto';

/** Stripe-style: header `t=<unix seconds>,v1=<hex hmac-sha256 of "<t>.<body>">`. */
export function signPayload(secret: string, body: string, nowSeconds: number) {
  const mac = createHmac('sha256', secret)
    .update(`${nowSeconds}.${body}`)
    .digest('hex');
  return `t=${nowSeconds},v1=${mac}`;
}

/** What a receiver runs. Exported so docs and tests share one definition. */
export function verifySignature(
  secret: string,
  body: string,
  header: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const parts: Record<string, string> = {};
  for (const p of header.split(',')) {
    const i = p.indexOf('=');
    if (i > 0) parts[p.slice(0, i)] = p.slice(i + 1);
  }
  const t = Number(parts.t);
  const v1 = parts.v1;
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(nowSeconds - t) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret)
    .update(`${t}.${body}`)
    .digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(v1);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Retry schedule after a failed attempt (attempt number -> wait), in ms. */
export const BACKOFF_MS = [
  60_000,
  5 * 60_000,
  30 * 60_000,
  2 * 3600_000,
  12 * 3600_000,
];
export const MAX_ATTEMPTS = BACKOFF_MS.length + 1;
