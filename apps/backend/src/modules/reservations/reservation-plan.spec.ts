import { collectNoShow, pickTable, reservationForecast } from './reservation-plan';

describe('reservation planning', () => {
  const start = new Date('2026-06-01T18:00:00Z');

  it('picks the smallest free table on the requested floor area', () => {
    const choice = pickTable({
      guests: 3,
      start,
      durationMinutes: 90,
      area: 'OUTDOOR',
      now: new Date('2026-06-01T12:00:00Z'),
      tables: [
        { id: 'in', capacity: 4, floorName: 'Hall', seating: 'INDOOR', status: 'AVAILABLE' },
        { id: 'big', capacity: 8, floorName: 'Garden', seating: 'OUTDOOR', status: 'AVAILABLE' },
        { id: 'fit', capacity: 4, floorName: 'Garden', seating: 'OUTDOOR', status: 'AVAILABLE' },
      ],
      holds: [
        {
          id: 'r1',
          tableId: 'fit',
          reservedAt: new Date('2026-06-01T18:30:00Z'),
          durationMinutes: 90,
          status: 'CONFIRMED',
        },
      ],
    });
    expect(choice?.tableId).toBe('big');
  });

  it('leaves a later booking on a table that is occupied now', () => {
    const choice = pickTable({
      guests: 2,
      start: new Date('2026-06-02T18:00:00Z'),
      durationMinutes: 90,
      now: new Date('2026-06-01T18:00:00Z'),
      tables: [{ id: 'a', capacity: 2, floorName: 'Hall', seating: 'INDOOR', status: 'OCCUPIED' }],
      holds: [],
    });
    expect(choice?.tableId).toBe('a');
  });

  it('forecasts weekday covers, no-shows, and table demand', () => {
    const days = reservationForecast({
      history: [
        { day: '2026-05-25', weekday: 1, guests: 10, status: 'COMPLETED' },
        { day: '2026-05-25', weekday: 1, guests: 10, status: 'NO_SHOW' },
        { day: '2026-05-18', weekday: 1, guests: 20, status: 'COMPLETED' },
      ],
      upcoming: [
        { day: '2026-06-01', weekday: 1, guests: 8, status: 'CONFIRMED' },
        { day: '2026-06-01', weekday: 1, guests: 2, status: 'CANCELLED' },
      ],
      days: [{ day: '2026-06-01', weekday: 1 }],
      tableSupply: 6,
    });
    expect(days[0]).toMatchObject({
      expectedCovers: 20,
      bookedCovers: 8,
      expectedNoShows: 2,
      tableDemand: 1,
      tableSupply: 6,
    });
  });

  it('applies a held deposit before the wallet and the house account', () => {
    expect(
      collectNoShow({
        fee: 500,
        deposit: 200,
        depositHeld: true,
        depositOnHouse: true,
        wallet: 50,
      }),
    ).toEqual({
      fromDeposit: 200,
      fromWallet: 50,
      fromHouse: 250,
      forfeitHouseCredit: true,
    });
    expect(
      collectNoShow({
        fee: 100,
        deposit: 100,
        depositHeld: true,
        depositOnHouse: false,
        wallet: 40,
      }).forfeitHouseCredit,
    ).toBe(false);
  });
});
