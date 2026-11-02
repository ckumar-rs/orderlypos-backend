import { gstRequirements, planGstBilling, supplyKind } from './gst-billing';

const bill = {
  orderNumber: '12',
  billedAt: '2026-10-30T12:00:00.000Z',
  guestName: 'Meera',
  guestState: '36',
  subtotal: 118,
  discountAmount: 0,
  loyaltyDiscountAmount: 0,
  lines: [
    { name: 'Paneer tikka', hsnCode: '2106', quantity: 1, lineTotal: 118, taxRatePercent: 18 },
  ],
  refunds: [{ amount: 20, createdAt: '2026-10-30T13:00:00.000Z' }],
};

describe('gst billing documents', () => {
  it('splits an intra-state tax-inclusive bill into CGST and SGST', () => {
    const plan = planGstBilling('36', [bill]);
    expect(supplyKind('36', '36')).toBe('INTRA');
    expect(plan.documents[0]).toMatchObject({
      kind: 'TAX_INVOICE',
      supply: 'INTRA',
      taxable: 100,
      tax: 18,
      cgst: 9,
      sgst: 9,
      igst: 0,
      total: 118,
    });
    expect(plan.hsn[0]).toMatchObject({ code: '2106', taxable: 100, tax: 18 });
    expect(plan.creditNotes[0]).toMatchObject({
      orderNumber: '12',
      amount: 20,
      createdAt: '2026-10-30T13:00:00.000Z',
      cgst: 1.53,
      sgst: 1.52,
      igst: 0,
    });
    const chandigarh = planGstBilling('04', [{ ...bill, guestState: null }]);
    expect(chandigarh.documents[0].utgst).toBe(9);
    expect(chandigarh.documents[0].sgst).toBe(0);
  });

  it('uses IGST when the guest state differs and a bill of supply when tax is zero', () => {
    const plan = planGstBilling('36', [
      { ...bill, guestState: '07', lines: [{ ...bill.lines[0], taxRatePercent: 0, hsnCode: null, lineTotal: 80 }] },
    ]);
    expect(plan.documents[0].supply).toBe('INTER');
    expect(plan.documents[0].kind).toBe('BILL_OF_SUPPLY');
    expect(plan.documents[0].igst).toBe(0);
    expect(plan.hsn[0].code).toBe('Missing');
  });

  it('lists the branch facts a return still needs', () => {
    const rows = gstRequirements({ gstin: '36AAAAA0000A1Z5', stateCode: '', missingHsn: 2, lineCount: 4 });
    expect(rows.find((row) => row.id === 'gstin')?.done).toBe(true);
    expect(rows.find((row) => row.id === 'state')?.done).toBe(true);
    expect(rows.find((row) => row.id === 'hsn')?.done).toBe(false);
    expect(rows.find((row) => row.id === 'b2b')?.done).toBe(false);
  });
});
