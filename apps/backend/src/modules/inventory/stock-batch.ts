/** A batch dated today is still usable. A blank expiry never blocks the sale. */
export function utcDayStart(now: Date): Date {
  return new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

export function batchUsableOn(expiryDate: Date | null, now: Date): boolean {
  if (!expiryDate) return true;
  return expiryDate.toISOString().slice(0, 10) >= now.toISOString().slice(0, 10);
}
