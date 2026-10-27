import {
  canTransitionKot,
  KOT_NEXT_STATUS,
  KOT_STARTED_STATUSES,
  KOT_TERMINAL_STATUSES,
  KOT_TRANSITIONS,
  kitchenProgress,
  type KotStatusDto,
} from '@nodedr-restaurant/types';

const ALL: KotStatusDto[] = [
  'NEW',
  'ACCEPTED',
  'PREPARING',
  'READY',
  'SERVED',
  'CANCELLED',
  'REJECTED',
];

describe('kitchen ticket state machine', () => {
  it('walks the normal path one step at a time', () => {
    const path: KotStatusDto[] = ['NEW'];
    for (
      let next: KotStatusDto | undefined = KOT_NEXT_STATUS.NEW;
      next;
      next = KOT_NEXT_STATUS[next]
    ) {
      expect(canTransitionKot(path[path.length - 1], next)).toBe(true);
      path.push(next);
    }
    expect(path).toEqual(['NEW', 'ACCEPTED', 'PREPARING', 'READY', 'SERVED']);
  });

  it('never skips a step forward', () => {
    expect(canTransitionKot('NEW', 'PREPARING')).toBe(false);
    expect(canTransitionKot('NEW', 'READY')).toBe(false);
    expect(canTransitionKot('ACCEPTED', 'READY')).toBe(false);
    expect(canTransitionKot('PREPARING', 'ACCEPTED')).toBe(false);
    expect(canTransitionKot('SERVED', 'READY')).toBe(false);
  });

  it('recalls a bumped or served ticket back to the pass', () => {
    expect(canTransitionKot('READY', 'PREPARING')).toBe(true);
    expect(canTransitionKot('SERVED', 'PREPARING')).toBe(true);
  });

  it('has no way out of a withdrawn ticket', () => {
    for (const from of KOT_TERMINAL_STATUSES.filter((status) => status !== 'SERVED')) {
      expect(KOT_TRANSITIONS[from]).toHaveLength(0);
      for (const to of ALL) expect(canTransitionKot(from, to)).toBe(false);
    }
  });

  it('allows the kitchen to decline only food it has not served', () => {
    expect(canTransitionKot('NEW', 'REJECTED')).toBe(true);
    expect(canTransitionKot('ACCEPTED', 'REJECTED')).toBe(true);
    expect(canTransitionKot('PREPARING', 'REJECTED')).toBe(true);
    expect(canTransitionKot('READY', 'REJECTED')).toBe(false);
    expect(canTransitionKot('SERVED', 'REJECTED')).toBe(false);
  });

  it('flags the states where cooking has begun', () => {
    expect(KOT_STARTED_STATUSES).toEqual(['PREPARING', 'READY', 'SERVED']);
  });

  it('every transition target is a known status', () => {
    for (const from of ALL)
      for (const to of KOT_TRANSITIONS[from]) expect(ALL).toContain(to);
  });
});

describe('kitchenProgress', () => {
  it('is the least advanced live ticket', () => {
    expect(kitchenProgress(['READY', 'PREPARING'])).toBe('PREPARING');
    expect(kitchenProgress(['SERVED', 'NEW'])).toBe('NEW');
    expect(kitchenProgress(['SERVED', 'SERVED'])).toBe('SERVED');
  });
  it('ignores withdrawn tickets and is null when none are left', () => {
    expect(kitchenProgress(['CANCELLED', 'REJECTED', 'READY'])).toBe('READY');
    expect(kitchenProgress(['CANCELLED', 'REJECTED'])).toBeNull();
    expect(kitchenProgress([])).toBeNull();
  });
});
