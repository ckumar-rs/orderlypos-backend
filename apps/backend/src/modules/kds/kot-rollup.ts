export type KotItemRollupStatus =
  | 'NEW'
  | 'ACCEPTED'
  | 'PREPARING'
  | 'READY'
  | 'DELAYED'
  | 'SERVED'
  | 'CANCELLED';

/** Ticket status from its lines. Cancelled lines are ignored. DELAYED counts as still cooking. */
export function rollupKotStatus(
  items: { status: string }[],
): Exclude<KotItemRollupStatus, 'DELAYED' | 'CANCELLED'> | null {
  const live = items.filter((item) => item.status !== 'CANCELLED');
  if (live.length === 0) return null;
  if (live.every((item) => item.status === 'SERVED')) return 'SERVED';
  if (live.every((item) => item.status === 'READY' || item.status === 'SERVED')) {
    return 'READY';
  }
  if (live.some((item) => item.status === 'PREPARING' || item.status === 'DELAYED')) {
    return 'PREPARING';
  }
  if (live.some((item) => item.status === 'ACCEPTED')) return 'ACCEPTED';
  return 'NEW';
}

export function snapToGrid(value: number, gridSize: number): number {
  if (!gridSize || gridSize <= 0) return Math.max(0, value);
  return Math.max(0, Math.round(value / gridSize) * gridSize);
}
