import { createHash } from 'node:crypto';
import { retailerIdForMenuItem } from './catalog';

export interface CatalogCartLine {
  retailerId: string;
  quantity: number;
  submittedPrice: number | null;
  currency: string | null;
}

export interface CatalogInbound {
  providerEventId: string;
  phoneNumberId: string;
  eventType: 'ORDER' | 'TEXT' | 'VOICE' | 'PROMPT' | 'STATUS' | 'OTHER';
  from: string | null;
  name: string | null;
  text: string | null;
  mediaId: string | null;
  catalogId: string | null;
  items: CatalogCartLine[];
}

export interface CatalogMenuMatch {
  retailerId: string;
  menuItemId: string;
  name: string;
  isActive: boolean;
  soldByWeight: boolean;
  requiresModifier: boolean;
}

export type CatalogCartPlan =
  | {
      ok: true;
      items: { menuItemId: string; quantity: number; modifierIds: [] }[];
    }
  | { ok: false; reason: string };

export function requestIdForMessage(messageId: string): string {
  return createHash('sha256').update(messageId).digest('hex').slice(0, 40);
}

export function menuItemIdFromRetailer(retailerId: string): string | null {
  return retailerId.startsWith('item_') && retailerId.length > 'item_'.length
    ? retailerId.slice('item_'.length)
    : null;
}

export function catalogBrowseReply(): string {
  return 'Browse the menu and add dishes to your cart.';
}

export function catalogOrderReply(input: {
  orderNumber: string;
  total: number;
  currency: string;
  upiVpa: string | null;
}): string {
  const amount = `${input.total.toFixed(2)} ${input.currency}`;
  const accepted = `Order ${input.orderNumber} is in. The counter will accept it before the kitchen starts. The total is ${amount}.`;
  if (!input.upiVpa) return accepted;
  return `${accepted} Scan the UPI QR with PhonePe, WhatsApp, or any UPI app to pay ${input.upiVpa}. The cashier confirms that payment.`;
}

export function planCatalogCart(
  lines: CatalogCartLine[],
  menu: CatalogMenuMatch[],
): CatalogCartPlan {
  const merged = new Map<string, number>();
  for (const line of lines) {
    const quantity = Math.floor(line.quantity);
    if (!line.retailerId || quantity < 1) continue;
    merged.set(line.retailerId, (merged.get(line.retailerId) ?? 0) + quantity);
  }
  if (merged.size === 0) return { ok: false, reason: 'The cart has no dishes.' };
  if (merged.size > 30) return { ok: false, reason: 'The cart has too many dishes.' };
  const byRetailer = new Map(menu.map((item) => [item.retailerId, item]));
  const problems: string[] = [];
  const items: { menuItemId: string; quantity: number; modifierIds: [] }[] = [];
  for (const [retailerId, quantity] of merged) {
    if (quantity > 50) {
      problems.push(`${retailerId} has too many.`);
      continue;
    }
    const match = byRetailer.get(retailerId);
    if (!match) {
      problems.push(`${retailerId} is not on this menu.`);
      continue;
    }
    if (!match.isActive) problems.push(`${match.name} is off.`);
    else if (match.soldByWeight) problems.push(`${match.name} is sold by weight.`);
    else if (match.requiresModifier) problems.push(`${match.name} needs a choice that WhatsApp did not send.`);
    else items.push({ menuItemId: match.menuItemId, quantity, modifierIds: [] });
  }
  if (problems.length > 0) return { ok: false, reason: problems.join(' ').slice(0, 300) };
  return { ok: true, items };
}

function textOf(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function phoneOf(value: unknown): string | null {
  const metadata = value && typeof value === 'object' ? (value as { metadata?: unknown }).metadata : null;
  const phone =
    metadata && typeof metadata === 'object'
      ? (metadata as { phone_number_id?: unknown }).phone_number_id
      : null;
  return textOf(phone);
}

function namesOf(value: unknown): Map<string, string> {
  const names = new Map<string, string>();
  const contacts = value && typeof value === 'object' ? (value as { contacts?: unknown }).contacts : null;
  if (!Array.isArray(contacts)) return names;
  for (const contact of contacts) {
    if (!contact || typeof contact !== 'object') continue;
    const waId = textOf((contact as { wa_id?: unknown }).wa_id);
    const profile = (contact as { profile?: unknown }).profile;
    const name =
      profile && typeof profile === 'object' ? textOf((profile as { name?: unknown }).name) : null;
    if (waId && name) names.set(waId, name);
  }
  return names;
}

function cartLine(raw: unknown): CatalogCartLine | null {
  if (!raw || typeof raw !== 'object') return null;
  const retailerId = textOf((raw as { product_retailer_id?: unknown }).product_retailer_id);
  const quantity = Number((raw as { quantity?: unknown }).quantity);
  if (!retailerId || !Number.isFinite(quantity)) return null;
  const priceRaw = (raw as { item_price?: unknown }).item_price;
  const submittedPrice = typeof priceRaw === 'number' || typeof priceRaw === 'string' ? Number(priceRaw) : null;
  return {
    retailerId,
    quantity,
    submittedPrice: submittedPrice != null && Number.isFinite(submittedPrice) ? submittedPrice : null,
    currency: textOf((raw as { currency?: unknown }).currency),
  };
}

function parseMessage(phoneNumberId: string, names: Map<string, string>, raw: unknown): CatalogInbound | null {
  if (!raw || typeof raw !== 'object') return null;
  const providerEventId = textOf((raw as { id?: unknown }).id);
  const from = textOf((raw as { from?: unknown }).from);
  if (!providerEventId) return null;
  const type = textOf((raw as { type?: unknown }).type);
  const name = from ? names.get(from) ?? null : null;
  if (type === 'order') {
    const order = (raw as { order?: unknown }).order;
    const catalogId = order && typeof order === 'object' ? textOf((order as { catalog_id?: unknown }).catalog_id) : null;
    const text = order && typeof order === 'object' ? textOf((order as { text?: unknown }).text) : null;
    const productItems = order && typeof order === 'object' ? (order as { product_items?: unknown }).product_items : null;
    const items = Array.isArray(productItems)
      ? productItems.map(cartLine).filter((line): line is CatalogCartLine => line != null)
      : [];
    return { providerEventId, phoneNumberId, eventType: 'ORDER', from, name, text, mediaId: null, catalogId, items };
  }
  if (type === 'text') {
    const textBody = (raw as { text?: unknown }).text;
    const text = textBody && typeof textBody === 'object' ? textOf((textBody as { body?: unknown }).body) : null;
    return { providerEventId, phoneNumberId, eventType: 'TEXT', from, name, text, mediaId: null, catalogId: null, items: [] };
  }
  if (type === 'audio' || type === 'voice') {
    const audio = (raw as { audio?: unknown }).audio ?? (raw as { voice?: unknown }).voice;
    const mediaId = audio && typeof audio === 'object' ? textOf((audio as { id?: unknown }).id) : null;
    return { providerEventId, phoneNumberId, eventType: 'VOICE', from, name, text: null, mediaId, catalogId: null, items: [] };
  }
  if (from) {
    return {
      providerEventId,
      phoneNumberId,
      eventType: 'PROMPT',
      from,
      name,
      text: null,
      mediaId: null,
      catalogId: null,
      items: [],
    };
  }
  return {
    providerEventId,
    phoneNumberId,
    eventType: 'OTHER',
    from: null,
    name: null,
    text: null,
    mediaId: null,
    catalogId: null,
    items: [],
  };
}

function parseStatus(phoneNumberId: string, raw: unknown): CatalogInbound | null {
  if (!raw || typeof raw !== 'object') return null;
  const id = textOf((raw as { id?: unknown }).id);
  const status = textOf((raw as { status?: unknown }).status);
  if (!id || !status) return null;
  return {
    providerEventId: `status:${id}:${status}`,
    phoneNumberId,
    eventType: 'STATUS',
    from: textOf((raw as { recipient_id?: unknown }).recipient_id),
    name: null,
    text: status,
    mediaId: null,
    catalogId: null,
    items: [],
  };
}

export function parseCloudWebhook(body: unknown): CatalogInbound[] {
  if (!body || typeof body !== 'object') return [];
  const entries = (body as { entry?: unknown }).entry;
  if (!Array.isArray(entries)) return [];
  const out: CatalogInbound[] = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const changes = (entry as { changes?: unknown }).changes;
    if (!Array.isArray(changes)) continue;
    for (const change of changes) {
      if (!change || typeof change !== 'object') continue;
      const value = (change as { value?: unknown }).value;
      const phoneNumberId = phoneOf(value);
      if (!phoneNumberId) continue;
      const names = namesOf(value);
      const messages = (value as { messages?: unknown }).messages;
      if (Array.isArray(messages)) {
        for (const message of messages) {
          const parsed = parseMessage(phoneNumberId, names, message);
          if (parsed) out.push(parsed);
        }
      }
      const statuses = (value as { statuses?: unknown }).statuses;
      if (Array.isArray(statuses)) {
        for (const status of statuses) {
          const parsed = parseStatus(phoneNumberId, status);
          if (parsed) out.push(parsed);
        }
      }
    }
  }
  const seen = new Set<string>();
  return out.filter((event) => {
    if (seen.has(event.providerEventId)) return false;
    seen.add(event.providerEventId);
    return true;
  });
}

export function retailerMatches(menuItemId: string): string {
  return retailerIdForMenuItem(menuItemId);
}
