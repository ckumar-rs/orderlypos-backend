// Table choice and reservation forecasts, kept free of the database so the
// ranking and the cover numbers can be tested on their own.

export interface TableCandidate {
  id: string;
  capacity: number;
  floorName: string;
  seating: string;
  status: string;
}

export interface TableHold {
  id: string;
  tableId: string | null;
  reservedAt: Date;
  durationMinutes: number;
  status: string;
}

const HOLDING = new Set(['RESERVED', 'CONFIRMED', 'ARRIVED']);

export function rangesOverlap(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart < bEnd && bStart < aEnd;
}

/** Smallest free table that fits, on the requested floor area when one is named. */
export function pickTable(input: {
  guests: number;
  start: Date;
  durationMinutes: number;
  area?: string | null;
  tables: TableCandidate[];
  holds: TableHold[];
  now?: Date;
  ignoreReservationId?: string;
}): { tableId: string; floorName: string; seating: string } | null {
  const start = input.start.getTime();
  const end = start + input.durationMinutes * 60_000;
  const now = (input.now ?? new Date()).getTime();
  const soon = start < now + 2 * 60 * 60_000;
  const blocked = new Set<string>();
  for (const hold of input.holds) {
    if (!hold.tableId || !HOLDING.has(hold.status)) continue;
    if (input.ignoreReservationId && hold.id === input.ignoreReservationId) continue;
    const holdStart = hold.reservedAt.getTime();
    const holdEnd = holdStart + hold.durationMinutes * 60_000;
    if (rangesOverlap(start, end, holdStart, holdEnd)) blocked.add(hold.tableId);
  }
  const fitting = input.tables.filter((table) => {
    if (table.capacity < input.guests) return false;
    if (blocked.has(table.id)) return false;
    if (soon && (table.status === 'OCCUPIED' || table.status === 'DIRTY')) return false;
    return true;
  });
  const area = input.area?.trim().toUpperCase() ?? '';
  const pool = area
    ? fitting.filter((table) => table.seating.toUpperCase() === area)
    : fitting;
  if (pool.length === 0) return null;
  pool.sort((a, b) => {
    const slack = a.capacity - input.guests - (b.capacity - input.guests);
    if (slack !== 0) return slack;
    const floor = a.floorName.localeCompare(b.floorName);
    if (floor !== 0) return floor;
    return a.id.localeCompare(b.id);
  });
  return { tableId: pool[0].id, floorName: pool[0].floorName, seating: pool[0].seating };
}

export interface ForecastReservation {
  day: string;
  weekday: number;
  guests: number;
  status: string;
}

export interface DayForecast {
  day: string;
  expectedCovers: number;
  bookedCovers: number;
  expectedNoShows: number;
  tableDemand: number;
  tableSupply: number;
}

export function reservationForecast(input: {
  history: ForecastReservation[];
  upcoming: ForecastReservation[];
  days: { day: string; weekday: number }[];
  tableSupply: number;
}): DayForecast[] {
  const daily = new Map<string, { weekday: number; covers: number; noShowCovers: number }>();
  for (const row of input.history) {
    if (row.status === 'CANCELLED') continue;
    const bucket = daily.get(row.day) ?? { weekday: row.weekday, covers: 0, noShowCovers: 0 };
    bucket.covers += row.guests;
    if (row.status === 'NO_SHOW') bucket.noShowCovers += row.guests;
    daily.set(row.day, bucket);
  }
  const byWeekday = new Map<number, number[]>();
  let covers = 0;
  let noShowCovers = 0;
  for (const bucket of daily.values()) {
    covers += bucket.covers;
    noShowCovers += bucket.noShowCovers;
    const list = byWeekday.get(bucket.weekday) ?? [];
    list.push(bucket.covers);
    byWeekday.set(bucket.weekday, list);
  }
  const noShowRate = covers > 0 ? noShowCovers / covers : 0;
  return input.days.map(({ day, weekday }) => {
    const samples = byWeekday.get(weekday) ?? [];
    const historical =
      samples.length > 0
        ? Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length)
        : 0;
    const sameDay = input.upcoming.filter((row) => row.day === day && row.status !== 'CANCELLED');
    const bookedCovers = sameDay.reduce((sum, row) => sum + row.guests, 0);
    const stillOpen = sameDay
      .filter((row) => row.status === 'RESERVED' || row.status === 'CONFIRMED')
      .reduce((sum, row) => sum + row.guests, 0);
    return {
      day,
      expectedCovers: historical > 0 ? historical : bookedCovers,
      bookedCovers,
      expectedNoShows: Math.round(stillOpen * noShowRate),
      tableDemand: sameDay.length,
      tableSupply: input.tableSupply,
    };
  });
}

export function collectNoShow(input: {
  fee: number;
  deposit: number;
  depositHeld: boolean;
  depositOnHouse: boolean;
  wallet: number;
}) {
  const fromDeposit = input.depositHeld ? Math.min(Math.max(input.deposit, 0), Math.max(input.fee, 0)) : 0;
  let rest = money(Math.max(input.fee, 0) - fromDeposit);
  const fromWallet = money(Math.min(Math.max(input.wallet, 0), rest));
  rest = money(rest - fromWallet);
  return {
    fromDeposit,
    fromWallet,
    fromHouse: rest,
    forfeitHouseCredit: fromDeposit > 0 && input.depositOnHouse,
  };
}

function money(value: number) {
  return Math.round(value * 100) / 100;
}
