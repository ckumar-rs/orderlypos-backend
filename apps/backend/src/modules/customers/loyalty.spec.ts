import {
  earnCashback,
  earnPoints,
  favoriteProducts,
  planConsume,
  planExpiry,
  resolveEmployeePercent,
  spendForLoyalty,
  visitMetrics,
} from './loyalty';

describe('customer loyalty', () => {
  it('ranks favorite dishes by quantity', () => {
    const favorites = favoriteProducts([
      { menuItemId: 'a', name: 'Dosa', quantity: 1 },
      { menuItemId: 'b', name: 'Idli', quantity: 2 },
      { menuItemId: 'a', name: 'Dosa', quantity: 3 },
    ]);
    expect(favorites.map((row) => row.name)).toEqual(['Dosa', 'Idli']);
    expect(favorites[0].quantity).toBe(4);
  });

  it('computes AOV and days between visits', () => {
    const metrics = visitMetrics(
      [
        { total: 200, at: new Date('2026-01-01T00:00:00Z') },
        { total: 400, at: new Date('2026-01-11T00:00:00Z') },
      ],
      new Date('2026-01-31T00:00:00Z'),
    );
    expect(metrics.visits).toBe(2);
    expect(metrics.aov).toBe(300);
    expect(metrics.averageDaysBetween).toBe(10);
    expect(metrics.visitsPer30Days).toBe(2);
  });

  it('limits earn to eligible dishes, the cap, and cashback', () => {
    const spend = spendForLoyalty({
      lines: [
        { menuItemId: 'a', lineTotal: 80 },
        { menuItemId: 'b', lineTotal: 20 },
      ],
      eligibleMenuItemIds: ['a'],
      netSpend: 50,
    });
    expect(spend).toBe(40);
    expect(
      earnPoints({ eligibleSpend: spend, earnPerCurrency: 10, multiplier: 2, cap: 5 }),
    ).toBe(5);
    expect(earnCashback({ eligibleSpend: spend, percent: 10, cap: 3 })).toBe(3);
    expect(earnCashback({ eligibleSpend: spend, percent: 0, cap: null })).toBe(0);
  });

  it('expires old lots and spends the oldest live lot first', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    const lots = [
      {
        id: 'old',
        pointsRemaining: 4,
        expiresAt: new Date('2026-05-01T00:00:00Z'),
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
      {
        id: 'first',
        pointsRemaining: 3,
        expiresAt: null,
        createdAt: new Date('2026-02-01T00:00:00Z'),
      },
      {
        id: 'second',
        pointsRemaining: 5,
        expiresAt: null,
        createdAt: new Date('2026-03-01T00:00:00Z'),
      },
    ];
    expect(planExpiry(lots, now).points).toBe(4);
    expect(planConsume(lots, 4, now)).toEqual({
      takes: [
        { id: 'first', take: 3 },
        { id: 'second', take: 1 },
      ],
      unlotted: 0,
    });
  });

  it('uses a staff policy and its bill cap before the restaurant percent', () => {
    const policies = [
      { userId: 'u1', roleId: null, percent: 50, maxAmount: 25, isActive: true },
      { userId: null, roleId: 'r1', percent: 10, maxAmount: null, isActive: true },
    ];
    expect(
      resolveEmployeePercent({
        policies,
        userId: 'u1',
        roleId: 'r1',
        fallbackPercent: 5,
        subtotal: 100,
      }),
    ).toBe(25);
    expect(
      resolveEmployeePercent({
        policies,
        userId: 'other',
        roleId: 'r1',
        fallbackPercent: 5,
        subtotal: 100,
      }),
    ).toBe(10);
    expect(
      resolveEmployeePercent({
        policies,
        userId: 'other',
        roleId: 'none',
        fallbackPercent: 5,
        subtotal: 100,
      }),
    ).toBe(5);
  });
});
