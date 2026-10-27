export const UNIT_NAMES = ['KG', 'G', 'L', 'ML', 'PIECE', 'DOZEN', 'PACK', 'BOX'] as const;
export type StockUnit = (typeof UNIT_NAMES)[number];

export interface ConversionRow {
  fromUnit: string;
  toUnit: string;
  factor: number;
}

/** Directions that are the same in every kitchen. Pack and box sizes are stored per branch. */
export const BUILTIN_CONVERSIONS: ConversionRow[] = [
  { fromUnit: 'KG', toUnit: 'G', factor: 1000 },
  { fromUnit: 'L', toUnit: 'ML', factor: 1000 },
  { fromUnit: 'DOZEN', toUnit: 'PIECE', factor: 12 },
];

const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;

function edges(custom: readonly ConversionRow[]) {
  const rows = [...BUILTIN_CONVERSIONS, ...custom];
  const out: ConversionRow[] = [];
  for (const row of rows) {
    if (!(row.factor > 0) || row.fromUnit === row.toUnit) continue;
    out.push(row);
    out.push({ fromUnit: row.toUnit, toUnit: row.fromUnit, factor: 1 / row.factor });
  }
  return out;
}

/** Quantity in `toUnit`. Null when no chain of conversions connects the two units. */
export function convertQuantity(
  quantity: number,
  fromUnit: string,
  toUnit: string,
  custom: readonly ConversionRow[] = [],
): number | null {
  if (fromUnit === toUnit) return round3(quantity);
  const graph = edges(custom);
  const seen = new Set<string>([fromUnit]);
  const queue: { unit: string; factor: number }[] = [{ unit: fromUnit, factor: 1 }];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of graph) {
      if (edge.fromUnit !== current.unit || seen.has(edge.toUnit)) continue;
      const factor = current.factor * edge.factor;
      if (edge.toUnit === toUnit) return round3(quantity * factor);
      seen.add(edge.toUnit);
      queue.push({ unit: edge.toUnit, factor });
    }
  }
  return null;
}
