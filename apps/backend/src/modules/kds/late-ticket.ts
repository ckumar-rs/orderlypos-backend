import { prepTargetMinutes } from './station-performance';

const STILL_COOKING = new Set(['NEW', 'ACCEPTED', 'PREPARING']);

export function longestPrep(minutes: Array<number | null | undefined>) {
  const values = minutes.filter((value): value is number => value != null && value > 0);
  return values.length > 0 ? Math.max(...values) : null;
}

/** A ticket still on the pass is late once it is older than its prep target. */
export function ticketIsLate(input: {
  status: string;
  held: boolean;
  createdAt: Date;
  prepMinutes: number | null;
  now: Date;
}) {
  if (input.held || !STILL_COOKING.has(input.status)) return false;
  const ageMs = input.now.getTime() - input.createdAt.getTime();
  return ageMs > prepTargetMinutes(input.prepMinutes) * 60_000;
}
