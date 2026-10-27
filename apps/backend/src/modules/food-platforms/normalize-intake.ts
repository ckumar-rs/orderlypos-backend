export class IntakePayloadError extends Error {}

export interface NormalizedIntakeItem {
  name: string;
  quantity: number;
  menuItemId?: string;
  note?: string;
}

export interface NormalizedIntake {
  externalOrderId: string;
  outletId: string | null;
  customerName: string | null;
  phone: string;
  address: string;
  pincode: string | null;
  instructions: string | null;
  items: NormalizedIntakeItem[];
}

const ORDER_KEYS = ['order', 'data', 'payload', 'order_details'] as const;
const CUSTOMER_KEYS = [
  'customer',
  'customer_details',
  'customerDetails',
  'customer_address',
  'delivery_address',
] as const;
const ITEM_KEYS = ['items', 'order_items', 'orderItems', 'dishes', 'cart'] as const;
const ORDER_ID_KEYS = [
  'order_id',
  'orderId',
  'external_order_id',
  'externalOrderId',
] as const;
const OUTLET_KEYS = [
  'outlet_id',
  'outletId',
  'restaurant_id',
  'restaurantId',
  'res_id',
  'store_id',
] as const;
const ADDRESS_KEYS = [
  'full_address',
  'delivery_address',
  'address',
  'address_line',
  'address_line1',
  'formatted_address',
] as const;
const PHONE_KEYS = [
  'phone',
  'phone_number',
  'mobile',
  'mobile_number',
  'contact_number',
  'customer_phone',
] as const;
const PINCODE_KEYS = ['pincode', 'pin_code', 'postal_code', 'zip', 'zipcode'] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim().replace(/\s+/g, ' ');
    return trimmed || null;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

function pick(records: Record<string, unknown>[], keys: readonly string[]): string | null {
  for (const record of records) {
    for (const key of keys) {
      const text = asText(record[key]);
      if (text) return text;
    }
  }
  return null;
}

function children(
  records: Record<string, unknown>[],
  keys: readonly string[],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const record of records) {
    for (const key of keys) {
      const child = asRecord(record[key]);
      if (child) out.push(child);
    }
  }
  return out;
}

function firstItems(records: Record<string, unknown>[]): unknown[] | null {
  for (const record of records) {
    for (const key of ITEM_KEYS) {
      const value = record[key];
      if (Array.isArray(value) && value.length > 0) return value;
    }
  }
  return null;
}

function readQuantity(item: Record<string, unknown>, name: string): number {
  const raw = item.quantity ?? item.qty ?? item.item_quantity ?? item.count;
  if (raw == null || raw === '') return 1;
  const n = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isFinite(n) || n < 1) {
    throw new IntakePayloadError(`"${name}" needs a quantity of at least 1`);
  }
  if (n > 99) {
    throw new IntakePayloadError(`"${name}" quantity cannot be more than 99`);
  }
  return Math.round(n);
}

/**
 * Accepts the loose JSON a Zomato or Swiggy relay is likely to forward:
 * a flat order, or one nested under `order` / `customer_details`.
 * Dish names are kept as sent so the caller can match the menu.
 */
export function normalizeIntake(body: unknown): NormalizedIntake {
  const root = asRecord(body);
  if (!root) throw new IntakePayloadError('Expected an order object');

  const orderRecords = [root, ...children([root], ORDER_KEYS)];
  const customerRecords = children(orderRecords, CUSTOMER_KEYS);
  const allRecords = [...orderRecords, ...customerRecords];

  const externalOrderId =
    pick(orderRecords, ORDER_ID_KEYS) ?? pick(orderRecords, ['id']);
  if (!externalOrderId || externalOrderId.length > 80) {
    throw new IntakePayloadError('The order needs an order id (80 characters or fewer)');
  }
  if (/[\u0000-\u001f]/.test(externalOrderId)) {
    throw new IntakePayloadError('The order id contains invalid characters');
  }

  const rawItems = firstItems(orderRecords);
  if (!rawItems) throw new IntakePayloadError('The order has no items');

  const items: NormalizedIntakeItem[] = rawItems.map((raw) => {
    const item = asRecord(raw);
    if (!item) throw new IntakePayloadError('Each item must be an object');
    const name =
      asText(item.name) ??
      asText(item.item_name) ??
      asText(item.itemName) ??
      asText(item.title) ??
      asText(item.dish_name);
    if (!name) throw new IntakePayloadError('Each item needs a name');
    const note =
      asText(item.special_instructions) ??
      asText(item.instructions) ??
      asText(item.note);
    return {
      name,
      quantity: readQuantity(item, name),
      menuItemId: asText(item.menuItemId) ?? asText(item.menu_item_id) ?? undefined,
      note: note ? note.slice(0, 200) : undefined,
    };
  });

  const customerName =
    pick(allRecords, ['customer_name', 'customerName']) ??
    pick(customerRecords, ['name']);
  const phoneRaw = pick(allRecords, PHONE_KEYS);
  const digits = phoneRaw?.replace(/\D/g, '') ?? '';
  const phone =
    phoneRaw && digits.length >= 6 ? phoneRaw.slice(0, 20) : 'Not shared';

  let address = pick(allRecords, ADDRESS_KEYS);
  if (!address) address = 'Address shared on the platform app';
  else if (address.length < 5) address = `${address} (platform)`;
  address = address.slice(0, 300);

  const pincodeRaw = pick(allRecords, PINCODE_KEYS)?.replace(/\s/g, '') ?? null;
  const pincode =
    pincodeRaw && pincodeRaw.length >= 3 && pincodeRaw.length <= 12
      ? pincodeRaw
      : null;

  const instructions = pick(orderRecords, [
    'order_instructions',
    'cooking_instructions',
    'special_instructions',
    'instructions',
    'note',
  ]);

  return {
    externalOrderId,
    outletId: pick(orderRecords, OUTLET_KEYS)?.slice(0, 80) ?? null,
    customerName: customerName ? customerName.slice(0, 60) : null,
    phone,
    address,
    pincode,
    instructions: instructions ? instructions.slice(0, 300) : null,
    items,
  };
}
