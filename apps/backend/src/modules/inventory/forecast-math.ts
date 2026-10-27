/** Daily sold qty → mean per weekday (0=Sun). Missing weekdays stay 0. */
export function weekdayAverages(daily: { date: string; qty: number }[]) {
  const buckets = Array.from({ length: 7 }, () => ({ sum: 0, n: 0 }));
  for (const row of daily) {
    const day = new Date(`${row.date}T00:00:00`).getDay();
    if (Number.isNaN(day)) continue;
    buckets[day].sum += row.qty;
    buckets[day].n += 1;
  }
  return buckets.map((b) => (b.n > 0 ? round3(b.sum / b.n) : 0));
}

export function dailyVelocity(daily: { qty: number }[]) {
  if (daily.length === 0) return 0;
  return round3(daily.reduce((sum, row) => sum + row.qty, 0) / daily.length);
}

/** Project horizonDays using weekday averages; fall back to mean velocity. */
export function projectHorizon(
  daily: { date: string; qty: number }[],
  horizonDays: number,
  fromDate: Date,
) {
  if (horizonDays <= 0) return 0;
  const averages = weekdayAverages(daily);
  const velocity = dailyVelocity(daily);
  let total = 0;
  for (let i = 1; i <= horizonDays; i += 1) {
    const day = new Date(fromDate.getTime() + i * 86_400_000).getDay();
    const expected = averages[day] > 0 ? averages[day] : velocity;
    total += expected;
  }
  return round3(total);
}

/**
 * Qty to buy so stock covers lead time + remaining horizon, minus on-hand.
 * leadDays / coverDays come from stored settings or measured supplier lead time.
 */
export function suggestedReorderQty(
  currentStock: number,
  velocityPerDay: number,
  leadDays: number,
  coverDays: number,
) {
  const need = velocityPerDay * Math.max(0, leadDays) + velocityPerDay * Math.max(0, coverDays);
  return round3(Math.max(0, need - Math.max(0, currentStock)));
}

export function parseModelForecast(text: string): {
  items: { id: string; qty: number }[];
  ingredients: { id: string; qty: number; reorderQty?: number }[];
} {
  const json = extractJson(text);
  if (!json || typeof json !== 'object') {
    throw new Error('Model did not return JSON');
  }
  const root = json as Record<string, unknown>;
  return {
    items: asRows(root.items).map((row) => ({
      id: String(row.id ?? ''),
      qty: Number(row.qty ?? row.forecastQty ?? 0),
    })),
    ingredients: asRows(root.ingredients).map((row) => ({
      id: String(row.id ?? ''),
      qty: Number(row.qty ?? row.forecastQty ?? 0),
      reorderQty:
        row.reorderQty == null ? undefined : Number(row.reorderQty),
    })),
  };
}

function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value)
    ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object')
    : [];
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = (fenced?.[1] ?? text).trim();
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  return JSON.parse(raw.slice(start, end + 1));
}

function round3(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}
