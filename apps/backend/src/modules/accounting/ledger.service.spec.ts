import { parseStatement } from './ledger.service';

describe('parseStatement', () => {
  it('reads a signed amount column', () => {
    const { rows } = parseStatement(
      'Date,Description,Amount\n2026-10-02,Milk supplier,-1200.50\n2026-10-03,UPI settlement,"4,500.00"',
    );
    expect(rows).toEqual([
      {
        postedOn: '2026-10-02',
        description: 'Milk supplier',
        reference: '',
        amount: -1200.5,
      },
      {
        postedOn: '2026-10-03',
        description: 'UPI settlement',
        reference: '',
        amount: 4500,
      },
    ]);
  });

  it('reads debit/credit columns and dd/mm/yyyy dates', () => {
    const { rows } = parseStatement(
      'Txn Date,Narration,Ref No,Withdrawal,Deposit\n05/10/2026,Rent,UTR1,15000,\n06/10/2026,Cash deposit,,,2000',
    );
    expect(rows.map((r) => [r.postedOn, r.amount, r.reference])).toEqual([
      ['2026-10-05', -15000, 'UTR1'],
      ['2026-10-06', 2000, ''],
    ]);
  });

  it('skips unreadable rows and reports their line numbers', () => {
    const { rows, skipped } = parseStatement(
      'Date,Description,Amount\nnot a date,x,5\n2026-10-01,ok,5',
    );
    expect(rows).toHaveLength(1);
    expect(skipped).toEqual([2]);
  });

  it('rejects a statement without the needed columns', () => {
    expect(() => parseStatement('a,b\n1,2')).toThrow();
  });
});
