export type DatedRevision = {
  id: string;
  effectiveFrom: Date;
  createdAt: Date;
  servings: number;
  yieldQuantity: number | null;
  foodCost: number;
  lines: unknown;
};

/** The revision in force at `at`: latest effective date that has already started. */
export function activeRevision<T extends { effectiveFrom: Date; createdAt: Date }>(
  rows: T[],
  at: Date,
): T | null {
  const due = rows.filter((row) => row.effectiveFrom.getTime() <= at.getTime());
  due.sort(
    (a, b) =>
      b.effectiveFrom.getTime() - a.effectiveFrom.getTime() ||
      b.createdAt.getTime() - a.createdAt.getTime(),
  );
  return due[0] ?? null;
}

export function revisionStockLines(lines: unknown) {
  if (!Array.isArray(lines)) return [];
  return lines.flatMap((line) => {
    if (!line || typeof line !== 'object') return [];
    const row = line as { ingredientId?: unknown; stockQuantity?: unknown; quantity?: unknown };
    if (typeof row.ingredientId !== 'string' || !row.ingredientId) return [];
    const quantity = Number(row.stockQuantity ?? row.quantity);
    if (!Number.isFinite(quantity) || quantity <= 0) return [];
    return [{ ingredientId: row.ingredientId, stockQuantity: quantity }];
  });
}

/** Cost stored on the revision, including the yield that was current when it was saved. */
export function historicalCost(row: {
  foodCost: number;
  servings: number;
  yieldQuantity: number | null;
}) {
  const servings = row.servings >= 1 ? row.servings : 1;
  const perServing = row.foodCost;
  const batch = Math.round(perServing * servings * 100) / 100;
  const perYield =
    row.yieldQuantity != null && row.yieldQuantity > 0
      ? Math.round((batch / row.yieldQuantity) * 100) / 100
      : null;
  return { perServing, batch, perYield, servings };
}
