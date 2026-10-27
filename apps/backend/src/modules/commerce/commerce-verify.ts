import { createHmac, timingSafeEqual } from 'node:crypto';

const PAID = new Set([
  'paid',
  'captured',
  'success',
  'successful',
  'txn_success',
  'completed',
  'authorized',
]);

export function isPaidStatus(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const text = value.trim().toLowerCase();
  return PAID.has(text) || text.includes('captured') || text.endsWith('.paid') || text.endsWith('_success');
}

export function collectStrings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string' && value.trim()) out.push(value.trim());
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, out));
  else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) collectStrings(item, out);
  }
  return out;
}

export function readGatewayRef(body: unknown): {
  refs: string[];
  status: string | null;
  utr: string | null;
  url: string | null;
} {
  const root = body && typeof body === 'object' ? (body as Record<string, unknown>) : {};
  const data = root.data && typeof root.data === 'object' ? (root.data as Record<string, unknown>) : {};
  const refs = [
    root.intentId,
    root.order_id,
    root.orderId,
    root.payment_id,
    root.paymentId,
    root.id,
    root.merchantTransactionId,
    root.txnId,
    data.order_id,
    data.orderId,
    data.id,
  ]
    .filter((value): value is string => typeof value === 'string' && value.length > 0);
  const status =
    typeof root.status === 'string'
      ? root.status
      : typeof data.status === 'string'
        ? data.status
        : typeof root.event === 'string'
          ? root.event
          : null;
  const utrCandidate = [root.utr, root.rrn, root.bank_reference, data.utr, data.rrn].find(
    (value) => typeof value === 'string',
  );
  const urlCandidate = [root.short_url, root.url, root.checkoutUrl, data.short_url, data.url].find(
    (value) => typeof value === 'string',
  );
  return {
    refs,
    status,
    utr: typeof utrCandidate === 'string' ? utrCandidate : null,
    url: typeof urlCandidate === 'string' ? urlCandidate : null,
  };
}

export function signaturesMatch(secret: string, raw: Buffer, presented: string | undefined): boolean {
  if (!presented) return false;
  const mac = createHmac('sha256', secret).update(raw).digest('hex');
  const a = Buffer.from(mac);
  const b = Buffer.from(presented.trim());
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function secretsMatch(stored: string, presented: string | undefined): boolean {
  if (!presented) return false;
  const a = Buffer.from(stored);
  const b = Buffer.from(presented);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
