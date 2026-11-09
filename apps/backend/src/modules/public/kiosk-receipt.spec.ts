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
    expect(text).toContain('This order is not paid. Pay at the counter.');
    expect(text.split('\n')).not.toContain('PAID RECEIPT');
  });

  it('uses the unpaid hint from settings', () => {
    const text = kioskReceiptText({
      restaurant: 'ABA',
      orderNumber: 'K-1',
      lines,
      total: '80.00',
      paid: false,
      unpaidHint: 'This order is not paid. Pay by UPI or Cash at the counter.',
    });
    expect(text).toContain('Pay by UPI or Cash at the counter.');
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
