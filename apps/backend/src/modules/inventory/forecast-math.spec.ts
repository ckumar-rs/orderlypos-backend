import {
  dailyVelocity,
  parseModelForecast,
  projectHorizon,
  suggestedReorderQty,
  weekdayAverages,
} from './forecast-math';

describe('forecast-math', () => {
  it('averages by weekday and projects a Saturday-heavy pattern', () => {
    const daily = [
      { date: '2026-10-17', qty: 10 }, // Sat
      { date: '2026-10-18', qty: 2 }, // Sun
      { date: '2026-10-24', qty: 14 }, // Sat
    ];
    const averages = weekdayAverages(daily);
    expect(averages[6]).toBe(12);
    expect(averages[0]).toBe(2);
    expect(dailyVelocity(daily)).toBe(8.667);
    const from = new Date('2026-10-23T00:00:00');
    expect(projectHorizon(daily, 2, from)).toBe(14);
  });

  it('orders enough to cover lead + horizon minus stock', () => {
    expect(suggestedReorderQty(4, 2, 3, 7)).toBe(16);
    expect(suggestedReorderQty(50, 2, 3, 7)).toBe(0);
  });

  it('reads forecast JSON from a fenced model reply', () => {
    const parsed = parseModelForecast(
      'Here:\n```json\n{"items":[{"id":"a","qty":12}],"ingredients":[{"id":"flour","forecastQty":3,"reorderQty":8}]}\n```',
    );
    expect(parsed.items[0]).toEqual({ id: 'a', qty: 12 });
    expect(parsed.ingredients[0]).toEqual({
      id: 'flour',
      qty: 3,
      reorderQty: 8,
    });
  });
});
