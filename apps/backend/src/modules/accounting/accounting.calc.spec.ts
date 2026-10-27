import { expectedCash, gstSummary } from './accounting.calc';

describe('accounting maths', () => {
  it('backs tax out of tax-inclusive lines, grouped by rate', () => {
    const r = gstSummary([
      { lineTotal: 105, taxRatePercent: 5, factor: 1 },
      { lineTotal: 210, taxRatePercent: 5, factor: 1 },
      { lineTotal: 118, taxRatePercent: 18, factor: 1 },
    ]);
    expect(r.rows).toEqual([
      { ratePercent: 5, taxableValue: 300, tax: 15, total: 315 },
      { ratePercent: 18, taxableValue: 100, tax: 18, total: 118 },
    ]);
    expect(r.totalTax).toBe(33);
    expect(r.totalTaxable).toBe(400);
  });

  it('scales tax down when a discount reduced what was charged', () => {
    const r = gstSummary([
      { lineTotal: 200, taxRatePercent: 0, factor: 0.5 },
      { lineTotal: 105, taxRatePercent: 5, factor: 0.5 },
    ]);
    expect(r.rows.find((x) => x.ratePercent === 5)).toEqual({
      ratePercent: 5,
      taxableValue: 50,
      tax: 2.5,
      total: 52.5,
    });
    expect(r.rows.find((x) => x.ratePercent === 0)?.tax).toBe(0);
  });

  it('computes expected cash', () => {
    expect(expectedCash(1000, 5200, 200, 800)).toBe(5200);
  });
});
