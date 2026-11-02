import { createHmac } from 'node:crypto';
import {
  catalogBatchRequest,
  catalogLifecycle,
  catalogPrice,
  connectionForPhone,
  itemsBatchBody,
  itemsBatchUrl,
  metaHubChallenge,
  nextCatalogAttempt,
  publicCatalogImage,
  retailerIdForMenuItem,
  verifyMetaSignature,
} from './catalog';

const item = {
  menuItemId: 'ckitem1',
  name: 'Paneer tikka',
  description: 'Tandoor paneer',
  price: 240,
  currency: 'INR',
  imageUrl: 'https://cdn.example/paneer.jpg',
  isActive: true,
  link: null,
};

describe('whatsapp catalog payloads', () => {
  it('keeps the menu item id as the retailer id', () => {
    expect(retailerIdForMenuItem('ckitem1')).toBe('item_ckitem1');
    const plan = catalogBatchRequest(item, null);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.request.data.id).toBe('item_ckitem1');
    expect(plan.request.data.price).toBe('240.00 INR');
    expect(plan.request.data.availability).toBe('in stock');
  });

  it('formats the Meta price string and stock words', () => {
    expect(catalogPrice(240, 'inr')).toBe('240.00 INR');
    expect(catalogPrice(10.5, '')).toBe('10.50 INR');
    const hidden = catalogBatchRequest({ ...item, isActive: false }, null);
    expect(hidden.ok).toBe(true);
    if (!hidden.ok) return;
    expect(hidden.request.data.availability).toBe('out of stock');
    expect(hidden.request.data.price).toBeUndefined();
  });

  it('refuses a relative upload path unless a public https base is configured', () => {
    expect(publicCatalogImage('/api/uploads/paneer.jpg', null)).toBeNull();
    expect(publicCatalogImage('/api/uploads/paneer.jpg', 'http://localhost:1995')).toBeNull();
    expect(publicCatalogImage('/api/uploads/paneer.jpg', 'https://orderlypos-ui.vercel.app/')).toBe(
      'https://orderlypos-ui.vercel.app/api/uploads/paneer.jpg',
    );
    const blocked = catalogBatchRequest({ ...item, imageUrl: '/api/uploads/paneer.jpg' }, null);
    expect(blocked).toEqual({ ok: false, reason: 'Meta needs a public https image' });
  });

  it('builds the documented items_batch request', () => {
    const plan = catalogBatchRequest(item, null);
    if (!plan.ok) throw new Error('expected a plan');
    expect(itemsBatchUrl('https://graph.facebook.com/', 'v21.0', 'cat_1')).toBe(
      'https://graph.facebook.com/v21.0/cat_1/items_batch',
    );
    expect(itemsBatchBody([plan.request])).toEqual({
      allow_upsert: true,
      item_type: 'PRODUCT_ITEM',
      requests: [plan.request],
    });
  });

  it('resolves a phone number id only to the connected restaurant', () => {
    const rows = [
      {
        phoneNumberId: '111',
        connectionStatus: 'CONNECTED',
        restaurantId: 'rest-a',
        branchId: 'branch-a',
      },
      {
        phoneNumberId: '222',
        connectionStatus: 'DISCONNECTED',
        restaurantId: 'rest-b',
        branchId: 'branch-b',
      },
    ];
    expect(connectionForPhone(rows, '111')?.restaurantId).toBe('rest-a');
    expect(connectionForPhone(rows, '222')).toBeNull();
    expect(connectionForPhone(rows, '333')).toBeNull();
    expect(connectionForPhone(rows, ' 111 ')?.branchId).toBe('branch-a');
  });

  it('checks the Meta hub challenge and the signature', () => {
    expect(
      metaHubChallenge(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'secret', 'hub.challenge': '99' },
        'secret',
      ),
    ).toBe('99');
    expect(
      metaHubChallenge(
        { 'hub.mode': 'subscribe', 'hub.verify_token': 'nope', 'hub.challenge': '99' },
        'secret',
      ),
    ).toBeNull();
    const raw = Buffer.from('{"ok":true}');
    const header = `sha256=${createHmac('sha256', 'app').update(raw).digest('hex')}`;
    expect(verifyMetaSignature(raw, header, 'app')).toBe(true);
    expect(verifyMetaSignature(raw, header, 'other')).toBe(false);
  });

  it('reads a phone number id from a Cloud API webhook without creating an order', () => {
    expect(
      catalogLifecycle({
        entry: [{ changes: [{ value: { metadata: { phone_number_id: '111' } } }] }],
      }),
    ).toEqual({ phoneNumberId: '111', status: null });
    expect(catalogLifecycle({ phone_number_id: '111', status: 'disconnected' })).toEqual({
      phoneNumberId: '111',
      status: 'DISCONNECTED',
    });
  });

  it('backs off retries and then caps the wait', () => {
    const now = new Date('2026-10-30T00:00:00.000Z');
    expect(nextCatalogAttempt(1, now).toISOString()).toBe('2026-10-30T00:02:00.000Z');
    expect(nextCatalogAttempt(40, now).toISOString()).toBe('2026-10-30T01:00:00.000Z');
  });
});
