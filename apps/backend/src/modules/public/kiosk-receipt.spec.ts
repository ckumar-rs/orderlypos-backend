import { kioskReceiptText } from './kiosk-receipt';

describe('kioskReceiptText', () => {
  const lines = [{ quantity: 2, name: 'Idli', lineTotal: '80.00' }];

  it('says the receipt is not paid', () => {
    const text = kioskReceiptText({
      restaurant: 'ABA',
      orderNumber: 'K-1',
      lines,
      total: '80.00',
      paid: false,
    });
    expect(text.split('\n')).toContain('NOT PAID RECEIPT');
    expect(text).toContain('This order is not paid.');
    expect(text.split('\n')).not.toContain('PAID RECEIPT');
  });

  it('says the receipt is paid', () => {
    const text = kioskReceiptText({
      restaurant: 'ABA',
      orderNumber: 'K-1',
      lines,
      total: '80.00',
      paid: true,
    });
    expect(text.split('\n')).toContain('PAID RECEIPT');
    expect(text).toContain('This order is paid.');
    expect(text.split('\n')).not.toContain('NOT PAID RECEIPT');
  });
});
