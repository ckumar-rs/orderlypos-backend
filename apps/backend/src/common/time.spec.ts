import {
  addDaysToDate,
  localDate,
  localMinuteAndDay,
  zonedDayStart,
  zonedRange,
} from './time';

describe('timezone day boundaries', () => {
  it('starts an IST day at 18:30 UTC the evening before', () => {
    expect(zonedDayStart('2026-10-04', 'Asia/Kolkata').toISOString()).toBe(
      '2026-10-03T18:30:00.000Z',
    );
  });

  it('puts a late-evening IST sale on its own local day', () => {
    const sale = new Date('2026-10-04T17:00:00Z'); // 22:30 IST on the 4th
    const r = zonedRange('2026-10-04', '2026-10-04', 'Asia/Kolkata');
    expect(sale >= r.gte && sale < r.lt).toBe(true);
    const lateNight = new Date('2026-10-04T19:00:00Z'); // 00:30 IST on the 5th
    expect(lateNight >= r.gte && lateNight < r.lt).toBe(false);
  });

  it('handles daylight saving (New York spring-forward day is 23h)', () => {
    const r = zonedRange('2026-03-08', '2026-03-08', 'America/New_York');
    expect((r.lt.getTime() - r.gte.getTime()) / 3_600_000).toBe(23);
  });

  it('works for UTC and adds days across month ends', () => {
    expect(zonedDayStart('2026-10-04', 'UTC').toISOString()).toBe(
      '2026-10-04T00:00:00.000Z',
    );
    expect(addDaysToDate('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('reports the local date and minute-of-day', () => {
    const t = new Date('2026-10-04T17:00:00Z'); // Sunday 22:30 IST
    expect(localDate(t, 'Asia/Kolkata')).toBe('2026-10-04');
    expect(localMinuteAndDay(t, 'Asia/Kolkata')).toEqual({
      minute: 22 * 60 + 30,
      day: 0,
    });
  });
});
