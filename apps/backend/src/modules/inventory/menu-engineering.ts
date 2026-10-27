export type MenuClass = 'STAR' | 'PLOWHORSE' | 'PUZZLE' | 'DOG';

export interface EngineeringInput {
  id: string;
  name: string;
  sold: number;
  price: number;
  foodCost: number;
}

export interface EngineeringRow extends EngineeringInput {
  margin: number;
  contribution: number;
  menuClass: MenuClass;
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Popularity is units sold. Margin is price minus one serving's food cost. */
export function menuEngineering(rows: EngineeringInput[]): EngineeringRow[] {
  if (rows.length === 0) return [];
  const pop = median(rows.map((row) => row.sold));
  const margins = rows.map((row) => row.price - row.foodCost);
  const marginCut = median(margins);
  return rows
    .map((row) => {
      const margin = Math.round((row.price - row.foodCost) * 100) / 100;
      const highPop = row.sold >= pop;
      const highMargin = margin >= marginCut;
      const menuClass: MenuClass = highPop
        ? highMargin
          ? 'STAR'
          : 'PLOWHORSE'
        : highMargin
          ? 'PUZZLE'
          : 'DOG';
      return {
        ...row,
        margin,
        contribution: Math.round(margin * row.sold * 100) / 100,
        menuClass,
      };
    })
    .sort((a, b) => b.contribution - a.contribution);
}
