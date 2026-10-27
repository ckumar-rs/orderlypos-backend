export type AlertTier = 'PUSH' | 'EMAIL' | 'ESCALATE';

/** First sighting is a push. Still open after a day, email. Still open after two days, escalate. */
export function nextAlertTier(previous: AlertTier | null, ageHours: number): AlertTier | null {
  if (!previous) return 'PUSH';
  if (previous === 'PUSH' && ageHours >= 24) return 'EMAIL';
  if (previous === 'EMAIL' && ageHours >= 48) return 'ESCALATE';
  return null;
}
