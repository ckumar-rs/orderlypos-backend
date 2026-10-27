// Timezone-aware day boundaries. A "day" in a report means the restaurant's
// local calendar day, not UTC — for an IST restaurant UTC midnight lands at
// 05:30 local, which would split an evening's sales across two report days.

/** Offset (ms) of `tz` from UTC at the given instant: local wall time - UTC. */
function offsetMs(utcMs: number, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(new Date(utcMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return asUtc - Math.floor(utcMs / 1000) * 1000;
}

/** The instant a local calendar date (YYYY-MM-DD) begins in `tz`. */
export function zonedDayStart(date: string, tz: string): Date {
  const wall = Date.parse(`${date}T00:00:00Z`);
  // Two passes settle the offset correctly across DST transitions.
  const first = wall - offsetMs(wall, tz);
  return new Date(wall - offsetMs(first, tz));
}

export function addDaysToDate(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/** Half-open [from, to) range covering local dates from..to inclusive. */
export function zonedRange(from: string, to: string, tz: string) {
  return {
    gte: zonedDayStart(from, tz),
    lt: zonedDayStart(addDaysToDate(to, 1), tz),
  };
}

/** The local calendar date (YYYY-MM-DD) of an instant in `tz`. */
export function localDate(instant: Date, tz: string): string {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  return p; // en-CA formats as YYYY-MM-DD
}

/** Minutes since local midnight and ISO weekday-agnostic day index (0=Sun). */
/** Calendar date in `tz` as YYYY-MM-DD. */
export function localDateKey(instant: Date, tz: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

export function localMinuteAndDay(instant: Date, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    weekday: 'short',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return {
    minute: Number(get('hour')) * 60 + Number(get('minute')),
    day: days.indexOf(get('weekday')),
  };
}
