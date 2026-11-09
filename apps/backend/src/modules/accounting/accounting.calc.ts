// Pure accounting maths, separate from the database code so it can be tested.

export const round2 = (n: number) =>
  Math.round((n + Number.EPSILON) * 100) / 100;

export interface GstLine {
  /** Tax-inclusive line total as stored on the order item. */
  lineTotal: number;
  taxRatePercent: number;
}

export interface GstRow {
  ratePercent: number;
  taxableValue: number;
  tax: number;
  total: number;
}

/**
 * Groups order lines by tax rate. Inclusive mode: tax is lineTotal × r / (100 + r).
 * Exclusive mode: tax is lineTotal × r / 100 and total = taxable + tax.
 * `factor` scales every line by the share charged after discounts.
 */
export function gstSummary(
  lines: (GstLine & { factor: number })[],
  taxMode: 'INCLUSIVE' | 'EXCLUSIVE' = 'INCLUSIVE',
): {
  rows: GstRow[];
  totalTaxable: number;
  totalTax: number;
} {
  const byRate = new Map<number, { taxable: number; tax: number; total: number }>();
  for (const l of lines) {
    const charged = l.lineTotal * l.factor;
    let taxable: number;
    let tax: number;
    let total: number;
    if (taxMode === 'EXCLUSIVE') {
      taxable = charged;
      tax = (charged * l.taxRatePercent) / 100;
      total = taxable + tax;
    } else {
      tax = (charged * l.taxRatePercent) / (100 + l.taxRatePercent);
      taxable = charged - tax;
      total = charged;
    }
    const row = byRate.get(l.taxRatePercent) ?? { taxable: 0, tax: 0, total: 0 };
    row.taxable += taxable;
    row.tax += tax;
    row.total += total;
    byRate.set(l.taxRatePercent, row);
  }
  const rows = [...byRate.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([ratePercent, v]) => ({
      ratePercent,
      taxableValue: round2(v.taxable),
      tax: round2(v.tax),
      total: round2(v.total),
    }));
  return {
    rows,
    totalTaxable: round2(rows.reduce((s, r) => s + r.taxableValue, 0)),
    totalTax: round2(rows.reduce((s, r) => s + r.tax, 0)),
  };
}

/** Cash the till should hold at close of day (before bank/safe drops). */
export function expectedCash(
  openingFloat: number,
  cashSales: number,
  cashRefunds: number,
  cashExpenses: number,
): number {
  return round2(openingFloat + cashSales - cashRefunds - cashExpenses);
}

/** Counted cash kept after bank and safe drops — next day's suggested float. */
export function retainedCash(
  countedCash: number,
  bankDrop: number,
  safeDrop: number,
): number {
  return round2(Math.max(0, countedCash - bankDrop - safeDrop));
}
