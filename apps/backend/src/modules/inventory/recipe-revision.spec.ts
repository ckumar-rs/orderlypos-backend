import { activeRevision, historicalCost, revisionStockLines } from './recipe-revision';

const at = (iso: string) => new Date(iso);

describe('recipe revisions', () => {
  const older = {
    id: 'old',
    effectiveFrom: at('2026-01-01T00:00:00Z'),
    createdAt: at('2026-01-01T00:00:00Z'),
    servings: 2,
    yieldQuantity: 1,
    foodCost: 40,
    lines: [{ ingredientId: 'rice', stockQuantity: 0.2 }],
  };
  const next = {
    ...older,
    id: 'next',
    effectiveFrom: at('2026-06-01T00:00:00Z'),
    createdAt: at('2026-05-01T00:00:00Z'),
    yieldQuantity: 1.5,
    foodCost: 30,
    lines: [{ ingredientId: 'rice', stockQuantity: 0.15 }],
  };

  it('keeps a future revision off the pass until its date', () => {
    expect(activeRevision([older, next], at('2026-03-01T00:00:00Z'))?.id).toBe('old');
    expect(activeRevision([older, next], at('2026-06-01T00:00:00Z'))?.id).toBe('next');
  });

  it('reads the stored ingredient snapshot and the yield cost', () => {
    expect(revisionStockLines(next.lines)).toEqual([{ ingredientId: 'rice', stockQuantity: 0.15 }]);
    expect(revisionStockLines([])).toEqual([]);
    expect(historicalCost(next)).toEqual({ perServing: 30, batch: 60, perYield: 40, servings: 2 });
  });
});
