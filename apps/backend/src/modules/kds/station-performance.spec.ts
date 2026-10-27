import { reportWindow, stationPerformance, type StationSample } from './station-performance';

function sample(partial: Partial<StationSample> & Pick<StationSample, 'createdAt'>): StationSample {
  return {
    stationId: 'grill',
    stationName: 'Grill',
    readyAt: null,
    prepMinutes: 15,
    wasDelayed: false,
    ...partial,
  };
}

describe('stationPerformance', () => {
  const start = new Date('2026-10-26T00:00:00');
  const end = new Date('2026-10-27T00:00:00');

  it('averages prep time and splits on-time tickets from delayed ones', () => {
    const rows = stationPerformance(
      [
        sample({
          createdAt: new Date('2026-10-26T10:00:00'),
          readyAt: new Date('2026-10-26T10:10:00'),
        }),
        sample({
          createdAt: new Date('2026-10-26T11:00:00'),
          readyAt: new Date('2026-10-26T11:20:00'),
          wasDelayed: true,
        }),
      ],
      start,
      end,
      8,
    );
    expect(rows).toEqual([
      {
        stationId: 'grill',
        stationName: 'Grill',
        ticketsReady: 2,
        avgMinutesToReady: 15,
        delayRate: 50,
        throughputPerHour: 0.3,
        slaCompliance: 50,
      },
    ]);
  });

  it('counts a delayed ticket that is not ready yet', () => {
    const rows = stationPerformance(
      [
        sample({
          createdAt: new Date('2026-10-26T12:00:00'),
          wasDelayed: true,
        }),
      ],
      start,
      end,
      2,
    );
    expect(rows[0].ticketsReady).toBe(0);
    expect(rows[0].delayRate).toBe(100);
    expect(rows[0].slaCompliance).toBeNull();
    expect(rows[0].throughputPerHour).toBe(0);
  });

  it('uses a 15 minute target when the dishes have no prep time', () => {
    const rows = stationPerformance(
      [
        sample({
          createdAt: new Date('2026-10-26T09:00:00'),
          readyAt: new Date('2026-10-26T09:14:00'),
          prepMinutes: null,
        }),
      ],
      start,
      end,
      1,
    );
    expect(rows[0].slaCompliance).toBe(100);
  });
});

describe('reportWindow', () => {
  it('keeps a requested calendar date on that local day', () => {
    const now = new Date(2026, 9, 26, 15, 0, 0);
    const window = reportWindow('2026-10-20', now);
    expect(window.start.getFullYear()).toBe(2026);
    expect(window.start.getMonth()).toBe(9);
    expect(window.start.getDate()).toBe(20);
    expect(window.hours).toBe(24);
  });
});
