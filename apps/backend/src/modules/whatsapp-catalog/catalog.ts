import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Meta Marketing API catalog batch.
 * POST /{version}/{catalog-id}/items_batch
 * https://developers.facebook.com/docs/marketing-api/catalog/guides/manage-catalog-items
 * The product id in `data.id` is the retailer id. Price is a decimal string
 * plus the ISO currency, for example "240.00 INR". Availability is
 * "in stock" or "out of stock". This file does not call Kapso. The installed
 * messaging module already sends WhatsApp Cloud text and templates.
 */
export const CATALOG_GRAPH_VERSION = 'v21.0';

export function retailerIdForMenuItem(menuItemId: string): string {
  return `item_${menuItemId}`;
}

export function catalogPrice(amount: number, currency: string): string {
  const code = (currency.trim() || 'INR').toUpperCase();
  return `${amount.toFixed(2)} ${code}`;
}

export function catalogAvailability(isActive: boolean): 'in stock' | 'out of stock' {
  return isActive ? 'in stock' : 'out of stock';
}

export function publicCatalogImage(
  imageUrl: string | null | undefined,
  assetBase: string | null | undefined,
): string | null {
  const raw = imageUrl?.trim() ?? '';
  if (!raw) return null;
  if (/^https:\/\//i.test(raw)) return raw;
  const base = assetBase?.trim().replace(/\/$/, '') ?? '';
  if (raw.startsWith('/') && /^https:\/\//i.test(base)) return `${base}${raw}`;
  return null;
}

export interface CatalogItemInput {
  menuItemId: string;
  name: string;
  description: string | null;
  price: number;
  currency: string;
  imageUrl: string | null;
  isActive: boolean;
  link: string | null;
}

export interface CatalogBatchRequest {
  method: 'UPDATE';
  data: Record<string, string>;
}

export type CatalogPlan =
  | { ok: true; request: CatalogBatchRequest; hash: string; availability: 'in stock' | 'out of stock' }
  | { ok: false; reason: string };

function stableHash(data: Record<string, string>): string {
  const keys = Object.keys(data).sort();
  const stable: Record<string, string> = {};
  for (const key of keys) stable[key] = data[key];
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

export function catalogBatchRequest(
  item: CatalogItemInput,
  assetBase: string | null,
): CatalogPlan {
  const id = retailerIdForMenuItem(item.menuItemId);
  if (!item.isActive) {
    const data = { id, availability: 'out of stock' };
    return {
      ok: true,
      request: { method: 'UPDATE', data },
      hash: stableHash(data),
      availability: 'out of stock',
    };
  }
  const image = publicCatalogImage(item.imageUrl, assetBase);
  if (!image) return { ok: false, reason: 'Meta needs a public https image' };
  const data: Record<string, string> = {
    id,
    title: item.name.trim().slice(0, 200),
    description: (item.description?.trim() || item.name).trim().slice(0, 5000),
    availability: 'in stock',
    condition: 'new',
    price: catalogPrice(item.price, item.currency),
    image_link: image,
  };
  if (item.link && /^https:\/\//i.test(item.link)) data.link = item.link;
  return {
    ok: true,
    request: { method: 'UPDATE', data },
    hash: stableHash(data),
    availability: 'in stock',
  };
}

export function itemsBatchBody(requests: CatalogBatchRequest[]) {
  return {
    allow_upsert: true,
    item_type: 'PRODUCT_ITEM',
    requests,
  };
}

export function wabaCatalogUrl(base: string, version: string, wabaId: string): string {
  return `${base.replace(/\/$/, '')}/${version}/${wabaId}/product_catalogs`;
}

export function itemsBatchUrl(base: string, version: string, catalogId: string): string {
  return `${base.replace(/\/$/, '')}/${version}/${catalogId}/items_batch`;
}

export function nextCatalogAttempt(attempts: number, now: Date): Date {
  const minutes = Math.min(60, Math.max(1, attempts) * 2);
  return new Date(now.getTime() + minutes * 60_000);
}

export interface CatalogConnectionRow {
  phoneNumberId: string;
  connectionStatus: string;
  restaurantId: string;
  branchId: string;
}

export function connectionForPhone<T extends CatalogConnectionRow>(
  rows: T[],
  phoneNumberId: string,
): T | null {
  const id = phoneNumberId.trim();
  return rows.find((row) => row.phoneNumberId === id && row.connectionStatus === 'CONNECTED') ?? null;
}

export function verifyTokenHash(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function metaHubChallenge(
  query: Record<string, unknown>,
  expectedToken: string,
): string | null {
  const mode = String(query['hub.mode'] ?? '');
  const token = String(query['hub.verify_token'] ?? '');
  const challenge = String(query['hub.challenge'] ?? '');
  if (mode !== 'subscribe' || !challenge || !expectedToken) return null;
  const left = Buffer.from(token);
  const right = Buffer.from(expectedToken);
  if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
  return challenge;
}

export function verifyMetaSignature(
  raw: Buffer,
  header: string | undefined,
  appSecret: string,
): boolean {
  if (!header || !appSecret) return false;
  const expected = `sha256=${createHmac('sha256', appSecret).update(raw).digest('hex')}`;
  const left = Buffer.from(header);
  const right = Buffer.from(expected);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function catalogLifecycle(body: unknown): {
  phoneNumberId: string | null;
  status: 'CONNECTED' | 'DISCONNECTED' | null;
} {
  if (!body || typeof body !== 'object') return { phoneNumberId: null, status: null };
  const record = body as Record<string, unknown>;
  let phone = typeof record.phone_number_id === 'string' ? record.phone_number_id : null;
  const entry = Array.isArray(record.entry) ? record.entry[0] : null;
  if (!phone && entry && typeof entry === 'object') {
    const changes = (entry as { changes?: unknown }).changes;
    const change = Array.isArray(changes) ? changes[0] : null;
    const value = change && typeof change === 'object' ? (change as { value?: unknown }).value : null;
    const metadata =
      value && typeof value === 'object' ? (value as { metadata?: unknown }).metadata : null;
    const nested =
      metadata && typeof metadata === 'object'
        ? (metadata as { phone_number_id?: unknown }).phone_number_id
        : null;
    if (typeof nested === 'string') phone = nested;
  }
  const rawStatus = typeof record.status === 'string' ? record.status.toUpperCase() : '';
  const status = rawStatus === 'CONNECTED' || rawStatus === 'DISCONNECTED' ? rawStatus : null;
  return { phoneNumberId: phone, status };
}
