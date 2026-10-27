import { round2 } from '../orders/pricing';

export function channelUnitPrice(
  basePrice: number,
  markupPercent: number,
  override?: number | null,
) {
  if (override != null && override >= 0) return round2(override);
  if (!markupPercent) return round2(basePrice);
  return round2(basePrice * (1 + markupPercent / 100));
}

export function scalePrice(price: number, fromBase: number, toBase: number) {
  if (!(fromBase > 0) || fromBase === toBase) return round2(price);
  return round2(price * (toBase / fromBase));
}

export function inDateRange(
  today: string,
  start: string | null | undefined,
  end: string | null | undefined,
) {
  if (start && today < start) return false;
  if (end && today > end) return false;
  return true;
}

export function menuSetIsLive(
  set: {
    isActive: boolean;
    isForced: boolean;
    daysOfWeek: number[];
    startMinute: number | null;
    endMinute: number | null;
    startsOn?: string | null;
    endsOn?: string | null;
  },
  day: number,
  minute: number,
  today?: string,
) {
  if (!set.isActive) return false;
  if (set.isForced) return true;
  if (today && !inDateRange(today, set.startsOn, set.endsOn)) return false;
  if (set.daysOfWeek.length > 0 && !set.daysOfWeek.includes(day)) return false;
  if (set.startMinute != null && set.endMinute != null) {
    return minute >= set.startMinute && minute < set.endMinute;
  }
  return true;
}

/** A seasonal dish or a daily availability window can take the dish off the card. */
export function itemIsListed(
  item: {
    isSeasonal?: boolean;
    seasonStart?: string | null;
    seasonEnd?: string | null;
    availableFrom?: string | null;
    availableTo?: string | null;
  },
  today: string,
  minute: number,
) {
  if (item.isSeasonal && !inDateRange(today, item.seasonStart, item.seasonEnd)) return false;
  if (item.availableFrom && item.availableTo) {
    const [fromH, fromM] = item.availableFrom.split(':').map(Number);
    const [toH, toM] = item.availableTo.split(':').map(Number);
    const from = fromH * 60 + fromM;
    const to = toH * 60 + toM;
    if (minute < from || minute >= to) return false;
  }
  return true;
}

export interface PriceRule {
  isActive: boolean;
  menuItemId: string | null;
  categoryId: string | null;
  percent: number;
  daysOfWeek: number[];
  startMinute: number | null;
  endMinute: number | null;
  stockBelow: number | null;
  ingredientId: string | null;
  demandQty: number | null;
  demandHours: number | null;
}

/** Applies every matching percent, then keeps the price between 10% and 300% of the base. */
export function applyPriceRules(
  base: number,
  rules: PriceRule[],
  ctx: {
    itemId: string;
    categoryId: string;
    categoryIds: Set<string>;
    day: number;
    minute: number;
    stockByIngredient: Map<string, number>;
    soldByHours: Map<number, number>;
  },
): number {
  let price = base;
  for (const rule of rules) {
    if (!rule.isActive) continue;
    if (rule.menuItemId && rule.menuItemId !== ctx.itemId) continue;
    if (!rule.menuItemId && rule.categoryId && !ctx.categoryIds.has(rule.categoryId)) continue;
    if (rule.daysOfWeek.length > 0 && !rule.daysOfWeek.includes(ctx.day)) continue;
    if (rule.startMinute != null && rule.endMinute != null) {
      if (ctx.minute < rule.startMinute || ctx.minute >= rule.endMinute) continue;
    }
    if (rule.stockBelow != null) {
      const stock = rule.ingredientId ? ctx.stockByIngredient.get(rule.ingredientId) : undefined;
      if (stock == null || stock >= rule.stockBelow) continue;
    }
    if (rule.demandQty != null) {
      const sold = ctx.soldByHours.get(rule.demandHours ?? 1) ?? 0;
      if (sold < rule.demandQty) continue;
    }
    price = round2(price * (1 + rule.percent / 100));
  }
  return Math.min(round2(base * 3), Math.max(round2(base * 0.1), price));
}

export type LiveMenuFilter =
  | { kind: 'all' }
  | { kind: 'forced'; ids: Set<string> }
  | { kind: 'scheduled'; liveIds: Set<string>; assigned: Set<string> };

export function liveMenuFilter(
  sets: {
    isActive: boolean;
    isForced: boolean;
    daysOfWeek: number[];
    startMinute: number | null;
    endMinute: number | null;
    startsOn?: string | null;
    endsOn?: string | null;
    items: { menuItemId: string }[];
  }[],
  day: number,
  minute: number,
  today?: string,
): LiveMenuFilter {
  if (sets.length === 0) return { kind: 'all' };
  const assigned = new Set(sets.flatMap((set) => set.items.map((item) => item.menuItemId)));
  const forced = sets.find((set) => set.isActive && set.isForced);
  if (forced) {
    return { kind: 'forced', ids: new Set(forced.items.map((item) => item.menuItemId)) };
  }
  const liveIds = new Set<string>();
  for (const set of sets) {
    if (!menuSetIsLive(set, day, minute, today)) continue;
    for (const item of set.items) liveIds.add(item.menuItemId);
  }
  return { kind: 'scheduled', liveIds, assigned };
}

export function isOnLiveMenu(itemId: string, filter: LiveMenuFilter) {
  if (filter.kind === 'all') return true;
  if (filter.kind === 'forced') return filter.ids.has(itemId);
  if (!filter.assigned.has(itemId)) return true;
  return filter.liveIds.has(itemId);
}

export function descendantIds(
  rows: { id: string; parentId: string | null }[],
  rootId: string,
): Set<string> {
  const ids = new Set<string>([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (row.parentId && ids.has(row.parentId) && !ids.has(row.id)) {
        ids.add(row.id);
        grew = true;
      }
    }
  }
  return ids;
}

export function wouldCreateCycle(
  rows: { id: string; parentId: string | null }[],
  id: string,
  parentId: string,
) {
  if (id === parentId) return true;
  return descendantIds(rows, id).has(parentId);
}
