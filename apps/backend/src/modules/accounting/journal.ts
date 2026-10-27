import { BadRequestException } from '@nestjs/common';
import { round2 } from './accounting.calc';

export interface JournalDraftLine {
  accountId: string;
  debit: number;
  credit: number;
}

export function assertBalanced(lines: JournalDraftLine[]) {
  if (lines.length < 2) {
    throw new BadRequestException('A journal needs at least two lines');
  }
  const ids = new Set<string>();
  let debit = 0;
  let credit = 0;
  for (const line of lines) {
    if (!line.accountId) {
      throw new BadRequestException('Every line needs an account');
    }
    ids.add(line.accountId);
    const d = round2(Number(line.debit) || 0);
    const c = round2(Number(line.credit) || 0);
    if (d < 0 || c < 0) {
      throw new BadRequestException('Debit and credit cannot be negative');
    }
    if ((d > 0) === (c > 0)) {
      throw new BadRequestException(
        'Each line must have either a debit or a credit, not both or neither',
      );
    }
    debit = round2(debit + d);
    credit = round2(credit + c);
  }
  if (ids.size < 2) {
    throw new BadRequestException('Use at least two different accounts');
  }
  if (debit !== credit) {
    throw new BadRequestException(
      `Journal is not balanced (debit ${debit.toFixed(2)} vs credit ${credit.toFixed(2)})`,
    );
  }
  return { debit, credit };
}

export function nextJournalNumber(existing: string[], day: string) {
  const prefix = `JV-${day.replace(/-/g, '')}-`;
  let max = 0;
  for (const number of existing) {
    if (!number.startsWith(prefix)) continue;
    const n = Number(number.slice(prefix.length));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}
