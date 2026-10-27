// Pure discount rules for coupons and happy-hour promotions.

export const round2 = (n: number) =>
  Math.round((n + Number.EPSILON) * 100) / 100;

export interface CouponRule {
  kind: 'PERCENT' | 'FLAT';
  value: number;
  minOrderAmount: number;
  maxDiscount: number | null;
  validFrom: Date | null;
  validUntil: Date | null;
  usageLimit: number | null;
  usedCount: number;
  isActive: boolean;
}

export interface PromotionRule {
  kind: 'PERCENT' | 'FLAT' | 'BOGO';
  value: number;
  daysOfWeek: number[];
  startMinute: number;
  endMinute: number;
  isActive: boolean;
}

/** Discount for a given subtotal, never more than the subtotal itself. */
export function discountAmount(
  kind: 'PERCENT' | 'FLAT',
  value: number,
  subtotal: number,
  maxDiscount: number | null = null,
): number {
  let amount = kind === 'PERCENT' ? (subtotal * value) / 100 : value;
  if (maxDiscount != null) amount = Math.min(amount, maxDiscount);
  return round2(Math.min(amount, subtotal));
}

/** Returns the discount, or the reason the coupon cannot be used. */
export function evaluateCoupon(
  coupon: CouponRule,
  subtotal: number,
  now: Date,
): { ok: true; amount: number } | { ok: false; reason: string } {
  if (!coupon.isActive)
    return { ok: false, reason: 'This coupon is not active' };
  if (coupon.validFrom && now < coupon.validFrom)
    return { ok: false, reason: 'This coupon is not valid yet' };
  if (coupon.validUntil && now > coupon.validUntil)
    return { ok: false, reason: 'This coupon has expired' };
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit)
    return { ok: false, reason: 'This coupon has been fully used' };
  if (subtotal < coupon.minOrderAmount)
    return {
      ok: false,
      reason: `Minimum order for this coupon is ${coupon.minOrderAmount}`,
    };
  const amount = discountAmount(
    coupon.kind,
    coupon.value,
    subtotal,
    coupon.maxDiscount,
  );
  return amount > 0
    ? { ok: true, amount }
    : { ok: false, reason: 'This coupon gives no discount on this order' };
}

/** Is a happy-hour window open at this local day (0=Sun) and minute? */
export function promotionActive(
  p: PromotionRule,
  day: number,
  minute: number,
  allDay = false,
): boolean {
  if (!p.isActive || !p.daysOfWeek.includes(day)) return false;
  if (allDay) return true;
  return minute >= p.startMinute && minute < p.endMinute;
}

/** True when a standing rule does not apply to this bill. */
export function promotionBlocked(input: {
  minOrderAmount: number;
  scopedSubtotal: number;
  ruleCustomerId: string | null;
  billCustomerId: string | null;
  weatherCode: string | null;
  weatherText: string | null;
  bundleMenuItemId: string | null;
  lineMenuItemIds: string[];
}): boolean {
  if (input.minOrderAmount > 0 && input.scopedSubtotal < input.minOrderAmount) return true;
  if (input.ruleCustomerId && input.ruleCustomerId !== input.billCustomerId) return true;
  const weather = input.weatherCode?.trim().toLowerCase();
  if (weather && !(input.weatherText ?? '').toLowerCase().includes(weather)) return true;
  if (input.bundleMenuItemId && !input.lineMenuItemIds.includes(input.bundleMenuItemId)) return true;
  return false;
}

export const toMinutes = (hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};
export const fromMinutes = (min: number) =>
  `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
