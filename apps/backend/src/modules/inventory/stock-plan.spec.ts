import { planStockUsage, type PlanCombo, type PlanItem } from './stock-plan';

const item = (over: Partial<PlanItem> & { id: string }): PlanItem => ({
  name: over.id,
  isCombo: false,
  tracking: 'NONE',
  stockIngredientId: null,
  stockQuantityPerSale: 1,
  recipe: [],
  ...over,
});
const map = (...items: PlanItem[]) => new Map(items.map((i) => [i.id, i]));

describe('planStockUsage', () => {
  it('deducts recipe ingredients for the sold quantity', () => {
    const items = map(
      item({
        id: 'pizza',
        tracking: 'RECIPE',
        recipe: [
          { ingredientId: 'flour', quantity: 0.25 },
          { ingredientId: 'cheese', quantity: 0.1 },
        ],
      }),
    );
    const plan = planStockUsage(
      [{ menuItemId: 'pizza', quantity: 3 }],
      items,
      [],
    );
    expect(plan.needs.get('flour')).toBe(0.75);
    expect(plan.needs.get('cheese')).toBe(0.3);
    expect(plan.skipped).toEqual([]);
  });

  it('treats a fractional quantity as kilograms sold', () => {
    const items = map(
      item({
        id: 'biryani',
        tracking: 'RECIPE',
        recipe: [{ ingredientId: 'rice', quantity: 200 }],
      }),
    );
    const plan = planStockUsage(
      [{ menuItemId: 'biryani', quantity: 0.5 }],
      items,
      [],
    );
    expect(plan.needs.get('rice')).toBe(100);
  });

  it('deducts a direct stock item without any recipe', () => {
    const items = map(
      item({
        id: 'cola',
        tracking: 'DIRECT',
        stockIngredientId: 'cola-bottle',
        stockQuantityPerSale: 1,
      }),
      item({
        id: 'wine-glass',
        tracking: 'DIRECT',
        stockIngredientId: 'wine-bottle',
        stockQuantityPerSale: 0.2,
      }),
    );
    const plan = planStockUsage(
      [
        { menuItemId: 'cola', quantity: 4 },
        { menuItemId: 'wine-glass', quantity: 5 },
      ],
      items,
      [],
    );
    expect(plan.needs.get('cola-bottle')).toBe(4);
    expect(plan.needs.get('wine-bottle')).toBe(1);
  });

  it('never moves stock for untracked items, even if a recipe row exists', () => {
    const items = map(
      item({
        id: 'water',
        tracking: 'NONE',
        recipe: [{ ingredientId: 'x', quantity: 1 }],
      }),
    );
    const plan = planStockUsage(
      [{ menuItemId: 'water', quantity: 9 }],
      items,
      [],
    );
    expect(plan.needs.size).toBe(0);
    expect(plan.skipped).toEqual([]);
  });

  it('expands combos into component recipes and direct items', () => {
    const items = map(
      item({ id: 'meal', isCombo: true }),
      item({
        id: 'burger',
        tracking: 'RECIPE',
        recipe: [{ ingredientId: 'bun', quantity: 1 }],
      }),
      item({
        id: 'cola',
        tracking: 'DIRECT',
        stockIngredientId: 'cola-bottle',
      }),
    );
    const combos: PlanCombo[] = [
      { comboItemId: 'meal', componentItemId: 'burger', quantity: 1 },
      { comboItemId: 'meal', componentItemId: 'cola', quantity: 2 },
    ];
    const plan = planStockUsage(
      [{ menuItemId: 'meal', quantity: 3 }],
      items,
      combos,
    );
    expect(plan.needs.get('bun')).toBe(3);
    expect(plan.needs.get('cola-bottle')).toBe(6);
  });

  it('sums the same ingredient across lines, a combo and a standalone sale', () => {
    const items = map(
      item({ id: 'meal', isCombo: true }),
      item({
        id: 'cola',
        tracking: 'DIRECT',
        stockIngredientId: 'cola-bottle',
      }),
    );
    const plan = planStockUsage(
      [
        { menuItemId: 'meal', quantity: 1 },
        { menuItemId: 'cola', quantity: 2 },
      ],
      items,
      [{ comboItemId: 'meal', componentItemId: 'cola', quantity: 1 }],
    );
    expect(plan.needs.get('cola-bottle')).toBe(3);
  });

  it('reports tracked items with no mapping instead of skipping silently', () => {
    const items = map(
      item({ id: 'soup', name: 'Soup', tracking: 'RECIPE' }),
      item({ id: 'beer', name: 'Beer', tracking: 'DIRECT' }),
    );
    const plan = planStockUsage(
      [
        { menuItemId: 'soup', quantity: 1 },
        { menuItemId: 'beer', quantity: 1 },
        { menuItemId: 'ghost', quantity: 1 },
      ],
      items,
      [],
    );
    expect(plan.needs.size).toBe(0);
    expect(plan.skipped.map((s) => [s.name, s.reason])).toEqual([
      ['Soup', 'NO_RECIPE'],
      ['Beer', 'NO_STOCK_ITEM'],
      ['ghost', 'UNKNOWN_ITEM'],
    ]);
  });

  it('ignores zero or negative quantities', () => {
    const items = map(
      item({
        id: 'cola',
        tracking: 'DIRECT',
        stockIngredientId: 'cola-bottle',
      }),
    );
    expect(
      planStockUsage([{ menuItemId: 'cola', quantity: 0 }], items, []).needs
        .size,
    ).toBe(0);
  });
});
