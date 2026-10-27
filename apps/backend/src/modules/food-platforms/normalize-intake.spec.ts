import { IntakePayloadError, normalizeIntake } from './normalize-intake';

describe('normalizeIntake', () => {
  it('reads a flat order', () => {
    const order = normalizeIntake({
      order_id: 'SW-88',
      outlet_id: 'aba-hyd',
      customer_name: 'Meera Iyer',
      phone: '98450 12345',
      address: '12 Lake View Apartments, Banjara Hills',
      pincode: '500 034',
      items: [{ name: 'Paneer Tikka', quantity: '2', instructions: 'less spice' }],
    });

    expect(order.externalOrderId).toBe('SW-88');
    expect(order.outletId).toBe('aba-hyd');
    expect(order.customerName).toBe('Meera Iyer');
    expect(order.phone).toBe('98450 12345');
    expect(order.address).toContain('Lake View');
    expect(order.pincode).toBe('500034');
    expect(order.items).toEqual([
      {
        name: 'Paneer Tikka',
        quantity: 2,
        menuItemId: undefined,
        note: 'less spice',
      },
    ]);
  });

  it('reads a nested platform payload and ignores the platform item id', () => {
    const order = normalizeIntake({
      order: {
        order_id: 'Z-1001',
        restaurant_id: '991',
        customer_details: { name: 'Arjun Mehta', phone_number: '+919845098765' },
        customer_address: {
          address: '4 Road No. 12, Jubilee Hills',
          pincode: '500033',
        },
        order_instructions: 'Leave at the door',
      },
      order_items: [
        { item_name: 'Butter Chicken', item_quantity: 1, id: 'platform-item-9' },
      ],
    });

    expect(order.externalOrderId).toBe('Z-1001');
    expect(order.outletId).toBe('991');
    expect(order.customerName).toBe('Arjun Mehta');
    expect(order.phone).toBe('+919845098765');
    expect(order.pincode).toBe('500033');
    expect(order.instructions).toBe('Leave at the door');
    expect(order.items[0]).toMatchObject({
      name: 'Butter Chicken',
      quantity: 1,
      menuItemId: undefined,
    });
  });

  it('keeps an explicit menu item id and substitutes a missing phone', () => {
    const order = normalizeIntake({
      orderId: 'abc',
      items: [{ name: 'Chai', menu_item_id: 'aba-item-chai' }],
    });
    expect(order.items[0].menuItemId).toBe('aba-item-chai');
    expect(order.items[0].quantity).toBe(1);
    expect(order.phone).toBe('Not shared');
    expect(order.address).toBe('Address shared on the platform app');
    expect(order.pincode).toBeNull();
  });

  it('rejects an order with no items or no id', () => {
    expect(() => normalizeIntake({ order_id: '1' })).toThrow(IntakePayloadError);
    expect(() => normalizeIntake({ items: [{ name: 'Chai' }] })).toThrow(
      IntakePayloadError,
    );
    expect(() => normalizeIntake([])).toThrow(IntakePayloadError);
  });
});
