export type RfmLabelRule = {
  name: string;
  minR: number;
  maxR: number;
  minF: number;
  maxF: number;
  minM: number;
  maxM: number;
};

export type PaidOrderAgg = {
  lastPaidAt: Date;
  firstPaidAt: Date;
  orderCount: number;
  spend: number;
};

/** Best-first quintiles 1–5 from this branch's distribution. Ties share a score. */
export function assignQuintiles(values: number[], invert: boolean): number[] {
  const n = values.length;
  if (n === 0) return [];
  const indexed = values.map((v, i) => ({ v, i }));
  indexed.sort((a, b) => (invert ? a.v - b.v : b.v - a.v));
  const scores = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j < n && indexed[j].v === indexed[i].v) j += 1;
    const mid = (i + j - 1) / 2;
    const score = n === 1 ? 3 : 5 - Math.round((mid / (n - 1)) * 4);
    for (let k = i; k < j; k += 1) scores[indexed[k].i] = score;
    i = j;
  }
  return scores;
}

export function recencyDays(lastPaidAt: Date, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - lastPaidAt.getTime()) / 86_400_000));
}

export function estimateClv(input: {
  orderCount: number;
  totalSpend: number;
  firstPaidAt: Date;
  lastPaidAt: Date;
  now: Date;
  horizonMonths: number;
  marginPercent: number;
}): number {
  if (input.orderCount <= 0 || input.totalSpend <= 0) return 0;
  const aov = input.totalSpend / input.orderCount;
  const spanMs = Math.max(0, input.lastPaidAt.getTime() - input.firstPaidAt.getTime());
  const monthsActive = Math.max(1, spanMs / (30.44 * 86_400_000) + 1 / 30.44);
  const monthlyFreq = input.orderCount / monthsActive;
  const margin = Math.max(0, input.marginPercent) / 100;
  return Math.round(aov * monthlyFreq * input.horizonMonths * margin * 100) / 100;
}

export function matchRfmLabel(
  r: number,
  f: number,
  m: number,
  labels: RfmLabelRule[],
): string | null {
  const hit = labels.find(
    (label) =>
      r >= label.minR &&
      r <= label.maxR &&
      f >= label.minF &&
      f <= label.maxF &&
      m >= label.minM &&
      m <= label.maxM,
  );
  return hit?.name ?? null;
}

export function rfmScoreString(r: number, f: number, m: number): string {
  return `${r}${f}${m}`;
}
