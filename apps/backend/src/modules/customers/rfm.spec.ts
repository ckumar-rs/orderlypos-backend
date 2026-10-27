import {
  assignQuintiles,
  estimateClv,
  matchRfmLabel,
  recencyDays,
  rfmScoreString,
} from './rfm';

describe('assignQuintiles', () => {
  it('gives the best score to the lowest value when invert is on', () => {
    expect(assignQuintiles([2, 40, 90], true)).toEqual([5, 3, 1]);
  });

  it('gives the best score to the highest value when invert is off', () => {
    expect(assignQuintiles([10, 50, 90], false)).toEqual([1, 3, 5]);
  });

  it('keeps tied values on the same score', () => {
    expect(assignQuintiles([10, 10, 10], false)).toEqual([3, 3, 3]);
  });
});

describe('estimateClv', () => {
  it('returns zero without paid history', () => {
    const now = new Date('2026-10-26');
    expect(
      estimateClv({
        orderCount: 0,
        totalSpend: 0,
        firstPaidAt: now,
        lastPaidAt: now,
        now,
        horizonMonths: 12,
        marginPercent: 100,
      }),
    ).toBe(0);
  });

  it('uses AOV, monthly frequency, horizon, and margin', () => {
    const first = new Date('2026-01-01');
    const last = new Date('2026-10-01');
    const clv = estimateClv({
      orderCount: 10,
      totalSpend: 5000,
      firstPaidAt: first,
      lastPaidAt: last,
      now: last,
      horizonMonths: 12,
      marginPercent: 50,
    });
    expect(clv).toBeGreaterThan(0);
    expect(clv).toBeLessThan(5000 * 12);
  });
});

describe('rfm helpers', () => {
  it('counts whole days since the last paid bill', () => {
    expect(
      recencyDays(new Date('2026-10-20T00:00:00Z'), new Date('2026-10-26T00:00:00Z')),
    ).toBe(6);
  });

  it('matches the first label whose R/F/M ranges contain the scores', () => {
    expect(
      matchRfmLabel(5, 5, 5, [
        { name: 'Champions', minR: 4, maxR: 5, minF: 4, maxF: 5, minM: 4, maxM: 5 },
      ]),
    ).toBe('Champions');
    expect(
      matchRfmLabel(1, 1, 1, [
        { name: 'Champions', minR: 4, maxR: 5, minF: 4, maxF: 5, minM: 4, maxM: 5 },
      ]),
    ).toBeNull();
  });

  it('joins the three scores', () => {
    expect(rfmScoreString(5, 4, 3)).toBe('543');
  });
});
