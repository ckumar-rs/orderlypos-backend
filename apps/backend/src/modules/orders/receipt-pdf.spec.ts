import { buildReceiptPdf } from './receipt-pdf';

function pdfWords(pdf: Buffer): string {
  return [...pdf.toString('latin1').matchAll(/<([0-9A-Fa-f]+)>/g)]
    .map((match) => Buffer.from(match[1], 'hex').toString('latin1'))
    .join('');
}

describe('paid receipt pdf', () => {
  it('is a PDF of the paid order', async () => {
    const pdf = await buildReceiptPdf({
      restaurantName: 'ABA',
      branchName: 'Main',
      address: 'Hyderabad',
      phone: null,
      gstNumber: '36AAAAA0000A1Z5',
      currency: 'INR',
      orderNumber: '12',
      createdAt: new Date('2026-10-30T12:00:00.000Z'),
      guestName: 'Meera',
      items: [{ name: 'Paneer tikka', quantity: 2, lineTotal: 480 }],
      subtotal: 480,
      discountAmount: 0,
      taxAmount: 0,
      tipAmount: 0,
      totalAmount: 480,
      payments: [{ method: 'UPI', amount: 480 }],
    });
    const words = pdfWords(pdf);
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-');
    expect(words).toContain('Order 12');
    expect(words).toContain('Paneer tikka');
    expect(words).toContain('INR 480.00');
    expect(words).toContain('Paid in full.');
    expect(words).toContain('UPI');
  });
});
