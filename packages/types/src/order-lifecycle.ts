// The kitchen-ticket (KOT) state machine, shared by the API (which enforces
// it) and the screens (which only offer moves the API will accept).
//
// Order status (OPEN/PAID/CANCELLED), acceptance (online orders waiting for a
// yes/no) and the kitchen ticket are deliberately three separate states: an
// order can be accepted without being cooked, cooked without being paid, and
// paid before it is served.
import type { KotStatusDto } from "./orders";

export const KOT_TRANSITIONS: Record<KotStatusDto, readonly KotStatusDto[]> = {
  NEW: ["ACCEPTED", "REJECTED", "CANCELLED"],
  ACCEPTED: ["PREPARING", "REJECTED", "CANCELLED"],
  // Declining food that is already on the stove is allowed but gated: see
  // KOT_STARTED_STATUSES and the confirmStarted flag.
  PREPARING: ["READY", "REJECTED", "CANCELLED"],
  // Recall puts a bumped or served ticket back on the pass.
  READY: ["SERVED", "PREPARING", "CANCELLED"],
  SERVED: ["PREPARING"],
  CANCELLED: [],
  REJECTED: [],
};

/** Tickets the kitchen is finished with, unless a served ticket is recalled. */
export const KOT_TERMINAL_STATUSES: readonly KotStatusDto[] = ["SERVED", "CANCELLED", "REJECTED"];

/** Tickets withdrawn without being served. */
export const KOT_VOID_STATUSES: readonly KotStatusDto[] = ["CANCELLED", "REJECTED"];

/** Statuses meaning the kitchen has begun (or finished) cooking. */
export const KOT_STARTED_STATUSES: readonly KotStatusDto[] = ["PREPARING", "READY", "SERVED"];

export function canTransitionKot(from: KotStatusDto, to: KotStatusDto): boolean {
  return KOT_TRANSITIONS[from].includes(to);
}

/** The next normal step on the board, if there is one. */
export const KOT_NEXT_STATUS: Partial<Record<KotStatusDto, KotStatusDto>> = {
  NEW: "ACCEPTED",
  ACCEPTED: "PREPARING",
  PREPARING: "READY",
  READY: "SERVED",
};

const PROGRESS_RANK: Partial<Record<KotStatusDto, number>> = {
  NEW: 0,
  ACCEPTED: 1,
  PREPARING: 2,
  READY: 3,
  SERVED: 4,
};

/**
 * One kitchen status for a whole order: the least advanced live ticket, since
 * the order is only as far along as its slowest round. Withdrawn tickets are
 * ignored; null when no ticket is left (nothing sent, or all withdrawn).
 */
export function kitchenProgress(statuses: readonly KotStatusDto[]): KotStatusDto | null {
  const live = statuses.filter((s) => PROGRESS_RANK[s] !== undefined);
  if (live.length === 0) return null;
  return live.reduce((slowest, s) => (PROGRESS_RANK[s]! < PROGRESS_RANK[slowest]! ? s : slowest));
}
