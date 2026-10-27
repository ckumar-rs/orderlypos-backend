const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export function servingCount(servings: number) {
  return Number.isFinite(servings) && servings >= 1 ? Math.floor(servings) : 1;
}

/** Batch cost, then the cost of one serving. Yield cost is batch cost per finished unit. */
export function recipeCost(
  lines: { quantity: number; costPerUnit: number }[],
  servings: number,
  yieldQuantity?: number | null,
) {
  const batchCost = round2(lines.reduce((sum, line) => sum + line.quantity * line.costPerUnit, 0));
  const portions = servingCount(servings);
  const perServing = round2(batchCost / portions);
  const perYield =
    yieldQuantity != null && yieldQuantity > 0 ? round2(batchCost / yieldQuantity) : null;
  return { batchCost, servings: portions, perServing, perYield };
}
