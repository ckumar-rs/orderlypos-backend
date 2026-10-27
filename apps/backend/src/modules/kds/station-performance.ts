/** Default ticket target when no dish on it has prep minutes. */
export const DEFAULT_PREP_MINUTES = 15;

export interface StationSample {
  stationId: string | null;
  stationName: string;
  createdAt: Date;
  readyAt: Date | null;
  /** Longest configured prep on the ticket. Null when none is set. */
  prepMinutes: number | null;
  wasDelayed: boolean;
}

export interface StationPerformanceRow {
  stationId: string;
  stationName: string;
  ticketsReady: number;
  /** Mean minutes from ticket open to ready. Null when nothing was ready. */
  avgMinutesToReady: number | null;
  /** Share of decided tickets that were marked delayed, 0–100. Null when none are decided. */
  delayRate: number | null;
  /** Ready tickets in the window, per hour. */
  throughputPerHour: number;
  /** Share of ready tickets that met the prep target, 0–100. Null when nothing was ready. */
  slaCompliance: number | null;
}

function round1(value: number) {
  return Math.round(value * 10) / 10;
}

export function prepTargetMinutes(prepMinutes: number | null) {
  return prepMinutes != null && prepMinutes > 0 ? prepMinutes : DEFAULT_PREP_MINUTES;
}

export function metPrepTarget(sample: StationSample) {
  if (!sample.readyAt) return false;
  const minutes = (sample.readyAt.getTime() - sample.createdAt.getTime()) / 60_000;
  return minutes <= prepTargetMinutes(sample.prepMinutes);
}

/**
 * Station numbers for one window.
 * Ready metrics use tickets whose ready time falls in [start, end).
 * Delay rate uses tickets opened in that window that are either ready or were delayed.
 * `hours` is the elapsed length of the window, used for throughput.
 */
export function stationPerformance(
  samples: StationSample[],
  start: Date,
  end: Date,
  hours: number,
): StationPerformanceRow[] {
  const span = Math.max(hours, 1 / 60);
  const byStation = new Map<
    string,
    {
      name: string;
      readyMinutes: number;
      ready: number;
      onTime: number;
      decided: number;
      delayed: number;
    }
  >();
  const bucket = (sample: StationSample) => {
    const key = sample.stationId ?? 'unassigned';
    const row = byStation.get(key) ?? {
      name: sample.stationName,
      readyMinutes: 0,
      ready: 0,
      onTime: 0,
      decided: 0,
      delayed: 0,
    };
    byStation.set(key, row);
    return row;
  };

  for (const sample of samples) {
    const openedHere = sample.createdAt >= start && sample.createdAt < end;
    const readyHere = sample.readyAt != null && sample.readyAt >= start && sample.readyAt < end;
    if (openedHere && (sample.wasDelayed || sample.readyAt)) {
      const row = bucket(sample);
      row.decided += 1;
      if (sample.wasDelayed) row.delayed += 1;
    }
    if (readyHere && sample.readyAt) {
      const row = bucket(sample);
      row.ready += 1;
      row.readyMinutes += (sample.readyAt.getTime() - sample.createdAt.getTime()) / 60_000;
      if (metPrepTarget(sample)) row.onTime += 1;
    }
  }

  return [...byStation.entries()]
    .map(([stationId, row]) => ({
      stationId,
      stationName: row.name,
      ticketsReady: row.ready,
      avgMinutesToReady: row.ready > 0 ? round1(row.readyMinutes / row.ready) : null,
      delayRate: row.decided > 0 ? round1((row.delayed / row.decided) * 100) : null,
      throughputPerHour: round1(row.ready / span),
      slaCompliance: row.ready > 0 ? round1((row.onTime / row.ready) * 100) : null,
    }))
    .sort((a, b) => a.stationName.localeCompare(b.stationName));
}

/** Local calendar day containing `now`, or the YYYY-MM-DD the caller asked for. */
export function reportWindow(date: string | undefined, now: Date) {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
    const [year, month, day] = date.split('-').map(Number);
    start.setFullYear(year, month - 1, day);
    start.setHours(0, 0, 0, 0);
  }
  const next = new Date(start);
  next.setDate(next.getDate() + 1);
  const elapsedEnd = now < start ? start : now < next ? now : next;
  const hours = Math.max((elapsedEnd.getTime() - start.getTime()) / 3_600_000, 1 / 60);
  return { start, end: next, hours };
}
