import { buildUpiUri } from './upi';

describe('UPI payment link', () => {
  it('matches the till QR link, with the amount and payee filled in', () => {
    expect(
      buildUpiUri({
        vpa: 'store@upi',
        name: 'Orderly POS',
        amount: 240,
        note: 'Order 12',
        ref: 'ckorder1',
      }),
    ).toBe('upi://pay?pa=store%40upi&pn=Orderly%20POS&am=240.00&cu=INR&tn=Order%2012&tr=ckorder1');
  });
});
