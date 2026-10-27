import { chainIds, chainLoops, normalizeActions } from './automation-plan';

describe('automation plan', () => {
  it('keeps a known action and falls back to a notification', () => {
    expect(normalizeActions(['EMAIL', 'TASK', 'PRINT'])).toEqual(['EMAIL', 'TASK']);
    expect(normalizeActions([])).toEqual(['NOTIFY']);
  });

  it('follows a chain and stops when a rule points back', () => {
    const next = new Map([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'a'],
    ]);
    expect(chainIds('a', (id) => next.get(id) ?? null)).toEqual(['b', 'c']);
    expect(chainIds('a', () => 'a')).toEqual([]);
    expect(chainLoops('a', (id) => next.get(id) ?? null)).toBe(true);
    expect(chainLoops('a', (id) => (id === 'a' ? 'b' : null))).toBe(false);
  });
});
