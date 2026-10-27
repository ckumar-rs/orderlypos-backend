import { recommendDishes } from './recommend';

describe('recommendDishes', () => {
  it('ranks a favorite and a dish that only shows up beside it', () => {
    const lines = [
      { orderId: '1', menuItemId: 'dosa', name: 'Dosa', quantity: 2 },
      { orderId: '1', menuItemId: 'chai', name: 'Chai', quantity: 1 },
      { orderId: '2', menuItemId: 'dosa', name: 'Dosa', quantity: 2 },
      { orderId: '3', menuItemId: 'idli', name: 'Idli', quantity: 2 },
      { orderId: '4', menuItemId: 'vada', name: 'Vada', quantity: 2 },
      { orderId: '5', menuItemId: 'pongal', name: 'Pongal', quantity: 2 },
    ];
    const suggestions = recommendDishes(lines);
    expect(suggestions[0]).toMatchObject({ menuItemId: 'dosa', reason: 'Ordered often' });
    expect(suggestions.find((row) => row.menuItemId === 'chai')?.reason).toBe(
      'Often ordered with a favorite',
    );
  });
});
