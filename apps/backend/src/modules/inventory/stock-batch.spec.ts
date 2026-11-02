import { batchUsableOn } from './stock-batch';

describe('batchUsableOn', () => {
  const now = new Date('2026-11-02T18:30:00.000Z');

  it('keeps a batch that expires today', () => {
    expect(batchUsableOn(new Date('2026-11-02T00:00:00.000Z'), now)).toBe(true);
  });

  it('stops a batch from yesterday', () => {
    expect(batchUsableOn(new Date('2026-11-01T00:00:00.000Z'), now)).toBe(false);
  });

  it('keeps a batch with no expiry', () => {
    expect(batchUsableOn(null, now)).toBe(true);
  });
});
