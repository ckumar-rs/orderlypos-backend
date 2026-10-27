import { longestPrep, ticketIsLate } from './late-ticket';

describe('late kitchen tickets', () => {
  const now = new Date('2026-10-26T12:20:00.000Z');

  it('uses the longest dish prep, or 15 minutes when none is set', () => {
    expect(longestPrep([null, 8, 12])).toBe(12);
    expect(longestPrep([null, 0])).toBeNull();
    const opened = new Date('2026-10-26T12:00:00.000Z');
    expect(
      ticketIsLate({ status: 'PREPARING', held: false, createdAt: opened, prepMinutes: null, now }),
    ).toBe(true);
    expect(
      ticketIsLate({ status: 'PREPARING', held: false, createdAt: opened, prepMinutes: 30, now }),
    ).toBe(false);
  });

  it('leaves a ready, served, or held ticket alone', () => {
    const opened = new Date('2026-10-26T11:00:00.000Z');
    expect(ticketIsLate({ status: 'READY', held: false, createdAt: opened, prepMinutes: 10, now })).toBe(false);
    expect(ticketIsLate({ status: 'PREPARING', held: true, createdAt: opened, prepMinutes: 10, now })).toBe(false);
  });
});
