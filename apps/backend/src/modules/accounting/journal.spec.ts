import { assertBalanced, nextJournalNumber } from './journal';

describe('journal rules', () => {
  it('accepts a balanced two-line voucher', () => {
    expect(
      assertBalanced([
        { accountId: 'cash', debit: 100, credit: 0 },
        { accountId: 'sales', debit: 0, credit: 100 },
      ]),
    ).toEqual({ debit: 100, credit: 100 });
  });

  it('rejects an unbalanced voucher', () => {
    expect(() =>
      assertBalanced([
        { accountId: 'cash', debit: 100, credit: 0 },
        { accountId: 'sales', debit: 0, credit: 90 },
      ]),
    ).toThrow(/not balanced/);
  });

  it('rejects a line with both debit and credit', () => {
    expect(() =>
      assertBalanced([
        { accountId: 'cash', debit: 50, credit: 50 },
        { accountId: 'sales', debit: 0, credit: 0 },
      ]),
    ).toThrow(/either a debit or a credit/);
  });

  it('numbers the next voucher for the day', () => {
    expect(nextJournalNumber(['JV-20261026-001', 'JV-20261026-003'], '2026-10-26')).toBe(
      'JV-20261026-004',
    );
  });
});
