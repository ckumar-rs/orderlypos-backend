import {
  blocksOptOut,
  isOptOutText,
  overRateLimit,
  receiptState,
  renderTemplate,
  retryPlan,
} from './messaging-policy';

describe('messaging policy', () => {
  it('treats a stop word as an opt-out and keeps receipts going', () => {
    expect(isOptOutText(' STOP ')).toBe(true);
    expect(isOptOutText('see you')).toBe(false);
    expect(blocksOptOut('CAMPAIGN')).toBe(true);
    expect(blocksOptOut('RECEIPT')).toBe(false);
  });

  it('retries twice more, then stops, and caps a busy minute', () => {
    expect(retryPlan(1)).toEqual({ retry: true, waitMinutes: 2 });
    expect(retryPlan(3)).toEqual({ retry: false, waitMinutes: 0 });
    expect(overRateLimit(29)).toBe(false);
    expect(overRateLimit(30)).toBe(true);
  });

  it('reads a delivery receipt and fills a template', () => {
    expect(receiptState('delivered')).toBe('delivered');
    expect(receiptState('failed')).toBe('failed');
    expect(renderTemplate('Hi {{name}}', { name: 'Asha' })).toBe('Hi Asha');
  });
});
