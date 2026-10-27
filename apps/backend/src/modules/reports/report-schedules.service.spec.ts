import { isDue, periodFor } from './report-schedules.service';

describe('periodFor', () => {
  it('daily is yesterday', () => {
    expect(periodFor('DAILY', '2026-10-11')).toEqual({
      from: '2026-10-10',
      to: '2026-10-10',
    });
  });
  it('weekly is the previous seven days', () => {
    expect(periodFor('WEEKLY', '2026-10-12')).toEqual({
      from: '2026-10-05',
      to: '2026-10-11',
    });
  });
  it('monthly is the previous calendar month, across a year boundary', () => {
    expect(periodFor('MONTHLY', '2026-10-01')).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
    expect(periodFor('MONTHLY', '2027-01-01')).toEqual({
      from: '2026-12-01',
      to: '2026-12-31',
    });
  });
});

describe('isDue', () => {
  const s = (frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY') => ({
    frequency,
    lastSentAt: null,
  });
  it('waits until 06:00 local', () => {
    expect(isDue(s('DAILY'), '2026-10-11', 5, null)).toBe(false);
    expect(isDue(s('DAILY'), '2026-10-11', 6, null)).toBe(true);
  });
  it('never sends twice on the same local day', () => {
    expect(isDue(s('DAILY'), '2026-10-11', 9, '2026-10-11')).toBe(false);
  });
  it('weekly goes out on Mondays, monthly on the 1st', () => {
    expect(isDue(s('WEEKLY'), '2026-10-12', 7, null)).toBe(true); // Monday
    expect(isDue(s('WEEKLY'), '2026-10-13', 7, null)).toBe(false);
    expect(isDue(s('MONTHLY'), '2026-11-01', 7, null)).toBe(true);
    expect(isDue(s('MONTHLY'), '2026-11-02', 7, null)).toBe(false);
  });
});
