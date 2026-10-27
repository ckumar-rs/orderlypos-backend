export interface AnomalyResult {
  flagged: boolean;
  latest: number;
  mean: number;
  zScore: number | null;
}

/**
 * The last point is today. Earlier points are the baseline.
 * A flat baseline flags a different latest value. Otherwise |z| of 2 or more is unusual.
 */
export function anomaly(series: number[]): AnomalyResult | null {
  if (series.length < 6) return null;
  const latest = series[series.length - 1];
  const history = series.slice(0, -1);
  const mean = history.reduce((sum, value) => sum + value, 0) / history.length;
  const variance =
    history.reduce((sum, value) => sum + (value - mean) ** 2, 0) / history.length;
  const sd = Math.sqrt(variance);
  if (sd === 0) {
    return { flagged: latest !== mean, latest, mean, zScore: null };
  }
  const zScore = Math.round(((latest - mean) / sd) * 10) / 10;
  return { flagged: Math.abs(zScore) >= 2, latest, mean: Math.round(mean * 100) / 100, zScore };
}
