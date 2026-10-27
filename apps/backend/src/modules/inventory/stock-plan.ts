// Pure planning for "what inventory does selling these lines move?". No
// database access, so every rule is unit-testable: recipe vs direct tracking,
// untracked items, combo expansion and unmapped (misconfigured) items.

export type InventoryTrackingMode = 'NONE' | 'RECIPE' | 'DIRECT';

export interface PlanItem {
  id: string;
  name: string;
  isCombo: boolean;
  tracking: InventoryTrackingMode;
  stockIngredientId: string | null;
  stockQuantityPerSale: number;
  recipe: { ingredientId: string; quantity: number }[];
}

export interface PlanCombo {
  comboItemId: string;
  componentItemId: string;
  quantity: number;
}

export type SkipReason = 'NO_RECIPE' | 'NO_STOCK_ITEM' | 'UNKNOWN_ITEM';

export interface StockPlan {
  /** ingredientId -> total quantity (ingredient units) to move for the lines. */
  needs: Map<string, number>;
  /** Tracked items that could not be mapped to stock: surfaced, never silent. */
  skipped: { menuItemId: string; name: string; reason: SkipReason }[];
}

const r3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;

export function planStockUsage(
  lines: { menuItemId: string; quantity: number }[],
  items: ReadonlyMap<string, PlanItem>,
  combos: readonly PlanCombo[],
): StockPlan {
  const componentsByCombo = new Map<string, PlanCombo[]>();
  for (const c of combos) {
    const list = componentsByCombo.get(c.comboItemId) ?? [];
    list.push(c);
    componentsByCombo.set(c.comboItemId, list);
  }

  // Effective units sold per leaf item (combos expanded into components).
  const units = new Map<string, number>();
  const add = (id: string, q: number) =>
    units.set(id, (units.get(id) ?? 0) + q);
  for (const line of lines) {
    if (line.quantity <= 0) continue;
    const item = items.get(line.menuItemId);
    if (item?.isCombo) {
      for (const c of componentsByCombo.get(item.id) ?? []) {
        add(c.componentItemId, c.quantity * line.quantity);
      }
    } else {
      add(line.menuItemId, line.quantity);
    }
  }

  const needs = new Map<string, number>();
  const skipped: StockPlan['skipped'] = [];
  const need = (ingredientId: string, q: number) =>
    needs.set(ingredientId, r3((needs.get(ingredientId) ?? 0) + q));

  for (const [id, sold] of units) {
    const item = items.get(id);
    if (!item) {
      skipped.push({ menuItemId: id, name: id, reason: 'UNKNOWN_ITEM' });
      continue;
    }
    if (item.tracking === 'NONE') continue;
    if (item.tracking === 'DIRECT') {
      if (!item.stockIngredientId || item.stockQuantityPerSale <= 0) {
        skipped.push({
          menuItemId: id,
          name: item.name,
          reason: 'NO_STOCK_ITEM',
        });
        continue;
      }
      need(item.stockIngredientId, item.stockQuantityPerSale * sold);
      continue;
    }
    if (item.recipe.length === 0) {
      skipped.push({ menuItemId: id, name: item.name, reason: 'NO_RECIPE' });
      continue;
    }
    for (const line of item.recipe)
      need(line.ingredientId, line.quantity * sold);
  }
  return { needs, skipped };
}
