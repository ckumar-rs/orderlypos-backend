// Minimal RFC 4180 CSV writer. Cells that start with a formula character are
// prefixed with an apostrophe so a spreadsheet never executes user-entered
// text (e.g. a customer named "=HYPERLINK(...)") as a formula.

const FORMULA_START = /^[=+\-@\t\r]/;

export type CsvValue = string | number | boolean | Date | null | undefined;

export function csvCell(value: CsvValue): string {
  if (value == null) return '';
  let s: string;
  if (value instanceof Date) s = value.toISOString();
  else if (typeof value === 'string')
    s = FORMULA_START.test(value) ? `'${value}` : value;
  else s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(columns: string[], rows: CsvValue[][]): string {
  const lines = [columns, ...rows].map((r) => r.map(csvCell).join(','));
  // BOM so Excel opens UTF-8 (₹, accents) correctly.
  return '﻿' + lines.join('\r\n') + '\r\n';
}
