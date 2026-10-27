import {
  applyPriceRules,
  channelUnitPrice,
  descendantIds,
  isOnLiveMenu,
  itemIsListed,
  liveMenuFilter,
  wouldCreateCycle,
} from './menu-rules';

describe('channelUnitPrice', () => {
  it('uses an override when present', () => {
    expect(channelUnitPrice(100, 20, 150)).toBe(150);
  });
  it('applies markup when there is no override', () => {
    expect(channelUnitPrice(100, 20)).toBe(120);
  });
});

describe('liveMenuFilter', () => {
  const breakfast = {
    isActive: true,
    isForced: false,
    daysOfWeek: [1],
    startMinute: 7 * 60,
    endMinute: 11 * 60,
    items: [{ menuItemId: 'idli' }],
  };

  it('shows every dish when no sets exist', () => {
    expect(isOnLiveMenu('idli', liveMenuFilter([], 1, 8 * 60))).toBe(true);
  });

  it('hides a set dish outside its window and keeps unassigned dishes', () => {
    const filter = liveMenuFilter([breakfast], 1, 15 * 60);
    expect(isOnLiveMenu('idli', filter)).toBe(false);
    expect(isOnLiveMenu('biryani', filter)).toBe(true);
  });

  it('pins a forced set', () => {
    const filter = liveMenuFilter(
      [{ ...breakfast, isForced: true }],
      1,
      15 * 60,
    );
    expect(isOnLiveMenu('idli', filter)).toBe(true);
    expect(isOnLiveMenu('biryani', filter)).toBe(false);
  });

  it('hides a holiday set outside its dates', () => {
    const filter = liveMenuFilter(
      [{ ...breakfast, startsOn: '2026-12-24', endsOn: '2026-12-26' }],
      1,
      8 * 60,
      '2026-11-01',
    );
    expect(isOnLiveMenu('idli', filter)).toBe(false);
  });
});

describe('item listing and price rules', () => {
  it('hides a seasonal dish outside its dates and a dish before its daily window', () => {
    expect(itemIsListed({ isSeasonal: true, seasonStart: '2026-06-01', seasonEnd: '2026-08-31' }, '2026-07-01', 600)).toBe(true);
    expect(itemIsListed({ isSeasonal: true, seasonStart: '2026-06-01', seasonEnd: '2026-08-31' }, '2026-12-01', 600)).toBe(false);
    expect(itemIsListed({ availableFrom: '11:00', availableTo: '15:00' }, '2026-07-01', 10 * 60)).toBe(false);
    expect(itemIsListed({ availableFrom: '11:00', availableTo: '15:00' }, '2026-07-01', 12 * 60)).toBe(true);
  });

  it('changes the menu price for a time window, low stock, or recent demand', () => {
    const base = {
      isActive: true,
      menuItemId: 'biryani',
      categoryId: null,
      percent: -20,
      daysOfWeek: [1],
      startMinute: 16 * 60,
      endMinute: 19 * 60,
      stockBelow: null,
      ingredientId: null,
      demandQty: null,
      demandHours: null,
    };
    const ctx = {
      itemId: 'biryani',
      categoryId: 'mains',
      categoryIds: new Set(['mains']),
      day: 1,
      minute: 17 * 60,
      stockByIngredient: new Map([['rice', 1]]),
      soldByHours: new Map([[2, 12]]),
    };
    expect(applyPriceRules(200, [base], ctx)).toBe(160);
    expect(applyPriceRules(200, [base], { ...ctx, minute: 12 * 60 })).toBe(200);
    expect(
      applyPriceRules(200, [{ ...base, percent: 10, startMinute: null, endMinute: null, daysOfWeek: [], stockBelow: 2, ingredientId: 'rice' }], ctx),
    ).toBe(220);
    expect(
      applyPriceRules(200, [{ ...base, percent: 15, startMinute: null, endMinute: null, daysOfWeek: [], demandQty: 10, demandHours: 2 }], ctx),
    ).toBe(230);
  });
});

describe('category tree', () => {
  const rows = [
    { id: 'bev', parentId: null },
    { id: 'hot', parentId: 'bev' },
    { id: 'espresso', parentId: 'hot' },
  ];
  it('walks descendants', () => {
    expect([...descendantIds(rows, 'bev')].sort()).toEqual([
      'bev',
      'espresso',
      'hot',
    ]);
  });
  it('refuses a cycle', () => {
    expect(wouldCreateCycle(rows, 'bev', 'espresso')).toBe(true);
    expect(wouldCreateCycle(rows, 'hot', 'bev')).toBe(false);
  });
});
