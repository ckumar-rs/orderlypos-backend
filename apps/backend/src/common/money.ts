// Shared rounding helpers — same discipline as modules/orders/pricing.ts
// (itself following the nodedr-pos lesson: round explicitly, never trust
// raw float arithmetic on money/quantity fields). Inventory needs a finer
// precision than money (costPerUnit is Decimal(12,4), stock quantities are
// Decimal(12,3)), so these are separate from orders/pricing.ts's round2
// rather than importing it.

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

export function round4(value: number): number {
  return Math.round((value + Number.EPSILON) * 10000) / 10000;
}
