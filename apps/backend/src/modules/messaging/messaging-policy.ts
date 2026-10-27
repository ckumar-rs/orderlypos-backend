const STOP = /^(stop|stopall|unsubscribe|cancel|end|quit)$/i;

export function isOptOutText(value: string | null | undefined) {
  return STOP.test((value ?? '').trim());
}

export function blocksOptOut(purpose: string) {
  return purpose === 'CAMPAIGN' || purpose === 'RESERVATION' || purpose === 'AUTOMATION';
}

/** Three tries, then stop. The wait doubles each time, in minutes. */
export function retryPlan(attempts: number) {
  if (attempts >= 3) return { retry: false, waitMinutes: 0 };
  return { retry: true, waitMinutes: 2 ** attempts };
}

export function overRateLimit(sentInWindow: number, limit = 30) {
  return sentInWindow >= limit;
}

export function receiptState(status: string | null | undefined) {
  const value = (status ?? '').toLowerCase();
  if (value.includes('deliver') || value === 'read' || value === 'sent') return 'delivered' as const;
  if (value.includes('fail') || value.includes('undeliver') || value.includes('bounce')) return 'failed' as const;
  return 'ignore' as const;
}

export function renderTemplate(template: string, values: Record<string, string>) {
  return template.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (match, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match,
  );
}
