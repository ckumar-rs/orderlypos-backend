import {
  computePpvLine,
  computeYieldRow,
  periodBounds,
  prepYieldPct,
  scalePrepInputs,
} from './inventory-depth';

describe('computeYieldRow', () => {
  it('matches books when closing is opening + receipts − theoretical', () => {
    const row = computeYieldRow({
      opening: 10,
      receipts: 5,
      reversals: 0,
      theoretical: 8,
      productionOut: 0,
      waste: 0,
      closing: 7,
      costPerUnit: 20,
    });
    expect(row.actualUsage).toBe(8);
    expect(row.unexplained).toBe(0);
    expect(row.yieldPct).toBe(100);
    expect(row.wastePct).toBe(0);
    expect(row.yieldLoss).toBe(0);
  });

  it('treats a short physical count as unexplained (theft / yield loss)', () => {
    const row = computeYieldRow({
      opening: 10,
      receipts: 5,
      reversals: 0,
      theoretical: 8,
      productionOut: 0,
      waste: 0,
      closing: 6,
      costPerUnit: 20,
    });
    expect(row.actualUsage).toBe(9);
    expect(row.unexplained).toBe(1);
    expect(row.yieldLoss).toBe(1);
    expect(row.unexplainedPct).toBe(11.11);
    expect(row.yieldPct).toBe(88.89);
    expect(row.unexplainedCost).toBe(20);
  });

  it('does not double-count recorded waste as unexplained', () => {
    const row = computeYieldRow({
      opening: 10,
      receipts: 5,
      reversals: 0,
      theoretical: 8,
      productionOut: 0,
      waste: 1,
      closing: 6,
      costPerUnit: 10,
    });
    expect(row.actualUsage).toBe(9);
    expect(row.explained).toBe(9);
    expect(row.unexplained).toBe(0);
    expect(row.wastePct).toBe(11.11);
    expect(row.wasteCost).toBe(10);
  });
});

describe('computePpvLine', () => {
  it('compares GRN actual to PO and quote', () => {
    const line = computePpvLine(10, 12, 10, 11);
    expect(line.varianceVsPo).toBe(20);
    expect(line.pctVsPo).toBe(20);
    expect(line.varianceVsQuote).toBe(10);
    expect(line.pctVsQuote).toBe(9.09);
  });

  it('leaves variance null when there is no PO or quote', () => {
    const line = computePpvLine(4, 15);
    expect(line.varianceVsPo).toBeNull();
    expect(line.varianceVsQuote).toBeNull();
  });
});

describe('scalePrepInputs', () => {
  it('scales raw inputs by the batch multiplier', () => {
    const scaled = scalePrepInputs(
      5,
      [
        { ingredientId: 'tomato', quantity: 10 },
        { ingredientId: 'onion', quantity: 2 },
      ],
      2,
    );
    expect(scaled.theoreticalOutput).toBe(10);
    expect(scaled.inputs).toEqual([
      { ingredientId: 'tomato', quantity: 20 },
      { ingredientId: 'onion', quantity: 4 },
    ]);
    expect(prepYieldPct(10, 8)).toBe(80);
  });
});

describe('periodBounds', () => {
  it('rejects an inverted range', () => {
    expect(() => periodBounds('2026-10-20', '2026-10-01')).toThrow(/from/);
  });
});
