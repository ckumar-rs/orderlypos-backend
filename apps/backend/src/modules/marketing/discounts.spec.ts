import {
  discountAmount,
  evaluateCoupon,
  promotionActive,
  promotionBlocked,
  type CouponRule,
} from './discounts';

const base: CouponRule = {
  kind: 'PERCENT',
  value: 10,
  minOrderAmount: 0,
  maxDiscount: null,
  validFrom: null,
  validUntil: null,
  usageLimit: null,
  usedCount: 0,
  isActive: true,
};
const now = new Date('2026-10-04T12:00:00Z');

describe('discounts', () => {
  it('caps a percent discount and never exceeds the subtotal', () => {
    expect(discountAmount('PERCENT', 10, 500)).toBe(50);
    expect(discountAmount('PERCENT', 50, 500, 100)).toBe(100);
    expect(discountAmount('FLAT', 900, 500)).toBe(500);
  });

  it('accepts a valid coupon', () => {
    expect(evaluateCoupon(base, 500, now)).toEqual({ ok: true, amount: 50 });
  });

  it.each([
    [{ isActive: false }, /not active/],
    [{ validFrom: new Date('2026-11-01') }, /not valid yet/],
    [{ validUntil: new Date('2026-09-01') }, /expired/],
    [{ usageLimit: 5, usedCount: 5 }, /fully used/],
    [{ minOrderAmount: 1000 }, /Minimum order/],
  ])('rejects an unusable coupon %#', (patch, reason) => {
    const r = evaluateCoupon({ ...base, ...patch }, 500, now);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(reason);
  });

  it('matches a happy-hour window by local day and minute (end exclusive)', () => {
    const p = {
      kind: 'PERCENT' as const,
      value: 20,
      daysOfWeek: [1, 2],
      startMinute: 960,
      endMinute: 1080,
      isActive: true,
    };
    expect(promotionActive(p, 1, 960)).toBe(true);
    expect(promotionActive(p, 1, 1079)).toBe(true);
    expect(promotionActive(p, 1, 1080)).toBe(false);
    expect(promotionActive(p, 0, 1000)).toBe(false);
    expect(promotionActive({ ...p, isActive: false }, 1, 1000)).toBe(false);
    expect(promotionActive(p, 0, 1000, true)).toBe(false);
    expect(promotionActive(p, 1, 0, true)).toBe(true);
  });

  it('blocks a rule that misses spend, customer, weather, or the bundle dish', () => {
    const open = {
      minOrderAmount: 0,
      scopedSubtotal: 400,
      ruleCustomerId: null,
      billCustomerId: null,
      weatherCode: null,
      weatherText: null,
      bundleMenuItemId: null,
      lineMenuItemIds: ['naan'],
    };
    expect(promotionBlocked(open)).toBe(false);
    expect(promotionBlocked({ ...open, minOrderAmount: 500 })).toBe(true);
    expect(promotionBlocked({ ...open, ruleCustomerId: 'c1', billCustomerId: 'c2' })).toBe(true);
    expect(promotionBlocked({ ...open, ruleCustomerId: 'c1', billCustomerId: 'c1' })).toBe(false);
    expect(promotionBlocked({ ...open, weatherCode: 'rain' })).toBe(true);
    expect(promotionBlocked({ ...open, weatherCode: 'rain', weatherText: 'Light rain' })).toBe(false);
    expect(promotionBlocked({ ...open, bundleMenuItemId: 'lassi' })).toBe(true);
    expect(promotionBlocked({ ...open, bundleMenuItemId: 'naan' })).toBe(false);
  });
});
