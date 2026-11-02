import {
  catalogOrderReply,
  menuItemIdFromRetailer,
  parseCloudWebhook,
  planCatalogCart,
  requestIdForMessage,
} from './catalog-order';

const orderWebhook = {
  object: 'whatsapp_business_account',
  entry: [
    {
      changes: [
        {
          value: {
            metadata: { phone_number_id: '106540352242922' },
            contacts: [{ profile: { name: 'Meera' }, wa_id: '919876543210' }],
            messages: [
              {
                from: '919876543210',
                id: 'wamid.ORDER1',
                type: 'order',
                order: {
                  catalog_id: 'cat_1',
                  product_items: [
                    { product_retailer_id: 'item_ck1', quantity: '2', item_price: 1, currency: 'INR' },
                    { product_retailer_id: 'item_ck1', quantity: 1, item_price: 999, currency: 'INR' },
                  ],
                },
              },
            ],
          },
        },
      ],
    },
  ],
};

const dish = {
  retailerId: 'item_ck1',
  menuItemId: 'ck1',
  name: 'Paneer tikka',
  isActive: true,
  soldByWeight: false,
  requiresModifier: false,
};

describe('whatsapp catalog orders', () => {
  it('reads a Cloud API cart and ignores the price Meta sent', () => {
    const [event] = parseCloudWebhook(orderWebhook);
    expect(event.phoneNumberId).toBe('106540352242922');
    expect(event.from).toBe('919876543210');
    expect(event.name).toBe('Meera');
    expect(event.items[0].submittedPrice).toBe(1);
    const plan = planCatalogCart(event.items, [dish]);
    expect(plan).toEqual({
      ok: true,
      items: [{ menuItemId: 'ck1', quantity: 3, modifierIds: [] }],
    });
    expect(JSON.stringify(plan)).not.toContain('999');
    expect(menuItemIdFromRetailer('item_ck1')).toBe('ck1');
  });

  it('refuses a dish that is off, weighed, or needs a choice', () => {
    expect(planCatalogCart([{ retailerId: 'item_missing', quantity: 1, submittedPrice: 10, currency: 'INR' }], [])).toEqual({
      ok: false,
      reason: 'item_missing is not on this menu.',
    });
    expect(planCatalogCart([{ retailerId: 'item_ck1', quantity: 1, submittedPrice: null, currency: null }], [{ ...dish, requiresModifier: true }]).ok).toBe(false);
    expect(planCatalogCart([{ retailerId: 'item_ck1', quantity: 1, submittedPrice: null, currency: null }], [{ ...dish, soldByWeight: true }]).ok).toBe(false);
    expect(planCatalogCart([{ retailerId: 'item_ck1', quantity: 1, submittedPrice: null, currency: null }], [{ ...dish, isActive: false }]).ok).toBe(false);
  });

  it('reads a text message and a delivery status without creating an order shape', () => {
    const events = parseCloudWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '111' },
                messages: [{ from: '9198', id: 'wamid.HI', type: 'text', text: { body: 'Hi' } }],
                statuses: [{ id: 'wamid.HI', status: 'delivered', recipient_id: '9198' }],
              },
            },
          ],
        },
      ],
    });
    expect(events.map((event) => event.eventType)).toEqual(['TEXT', 'STATUS']);
    const voice = parseCloudWebhook({
      entry: [
        {
          changes: [
            {
              value: {
                metadata: { phone_number_id: '111' },
                contacts: [{ profile: { name: 'Meera' }, wa_id: '9198' }],
                messages: [{ from: '9198', id: 'wamid.VOICE', type: 'audio', audio: { id: 'media_1', voice: true } }],
              },
            },
          ],
        },
      ],
    });
    expect(voice[0].eventType).toBe('VOICE');
    expect(voice[0].mediaId).toBe('media_1');
    expect(voice[0].name).toBe('Meera');
    expect(events[1].providerEventId).toBe('status:wamid.HI:delivered');
  });

  it('keeps the order reply from saying the payment is finished', () => {
    const reply = catalogOrderReply({ orderNumber: '12', total: 240, currency: 'INR', upiVpa: 'store@upi' });
    expect(reply).toContain('Order 12');
    expect(reply).toContain('240.00 INR');
    expect(reply).toContain('store@upi');
    expect(reply.toLowerCase()).not.toMatch(/\bpaid\b/);
    expect(requestIdForMessage('wamid.ORDER1')).toHaveLength(40);
  });
});
