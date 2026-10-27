export interface HistoryLine {
  orderId: string;
  menuItemId: string;
  name: string;
  quantity: number;
}

export interface DishSuggestion {
  menuItemId: string;
  name: string;
  reason: string;
}

/**
 * Personal favorites, then dishes that show up on the same bills as the guest's top dish.
 */
export function recommendDishes(lines: HistoryLine[], limit = 8): DishSuggestion[] {
  const byOrder = new Map<string, Map<string, { name: string; quantity: number }>>();
  for (const line of lines) {
    const order = byOrder.get(line.orderId) ?? new Map();
    const current = order.get(line.menuItemId) ?? { name: line.name, quantity: 0 };
    current.quantity += line.quantity;
    current.name = line.name;
    order.set(line.menuItemId, current);
    byOrder.set(line.orderId, order);
  }

  const totals = new Map<string, { name: string; quantity: number }>();
  const together = new Map<string, number>();
  for (const order of byOrder.values()) {
    for (const [id, row] of order) {
      const total = totals.get(id) ?? { name: row.name, quantity: 0 };
      total.quantity += row.quantity;
      total.name = row.name;
      totals.set(id, total);
    }
    const ids = [...order.keys()];
    for (const left of ids) {
      for (const right of ids) {
        if (left === right) continue;
        const key = `${left}|${right}`;
        together.set(key, (together.get(key) ?? 0) + 1);
      }
    }
  }

  const ranked = [...totals.entries()].sort(
    (a, b) => b[1].quantity - a[1].quantity || a[1].name.localeCompare(b[1].name),
  );
  const out: DishSuggestion[] = [];
  const seen = new Set<string>();
  const push = (id: string, reason: string) => {
    if (seen.has(id) || out.length >= limit) return;
    const row = totals.get(id);
    if (!row) return;
    seen.add(id);
    out.push({ menuItemId: id, name: row.name, reason });
  };

  for (const [id] of ranked.slice(0, 4)) push(id, 'Ordered often');
  const top = ranked[0]?.[0];
  if (top) {
    const companions = [...together.entries()]
      .filter(([key]) => key.startsWith(`${top}|`))
      .sort((a, b) => b[1] - a[1]);
    for (const [key] of companions) push(key.split('|')[1], 'Often ordered with a favorite');
  }
  return out;
}
