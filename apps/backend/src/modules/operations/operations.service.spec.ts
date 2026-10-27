import { nextDue } from './operations.service';

describe('equipment service schedule', () => {
  it('adds the interval to the last service date', () => {
    expect(nextDue('2026-10-04', 90)).toBe('2027-01-02');
    expect(nextDue('2026-02-20', 10)).toBe('2026-03-02');
  });

  it('has no due date without a last service or an interval', () => {
    expect(nextDue(null, 30)).toBeNull();
    expect(nextDue('2026-10-04', undefined)).toBeNull();
    expect(nextDue('2026-10-04', 0)).toBeNull();
  });
});
