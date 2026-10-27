import { rollupKotStatus, snapToGrid } from './kot-rollup';

describe('rollupKotStatus', () => {
  it('is ready only when every live line is ready or served', () => {
    expect(
      rollupKotStatus([{ status: 'READY' }, { status: 'READY' }, { status: 'CANCELLED' }]),
    ).toBe('READY');
    expect(rollupKotStatus([{ status: 'READY' }, { status: 'PREPARING' }])).toBe(
      'PREPARING',
    );
  });

  it('treats a delayed line as still cooking', () => {
    expect(rollupKotStatus([{ status: 'READY' }, { status: 'DELAYED' }])).toBe(
      'PREPARING',
    );
  });

  it('returns null when nothing is left', () => {
    expect(rollupKotStatus([{ status: 'CANCELLED' }])).toBeNull();
  });
});

describe('snapToGrid', () => {
  it('snaps to the stored grid size', () => {
    expect(snapToGrid(47, 20)).toBe(40);
    expect(snapToGrid(53, 20)).toBe(60);
  });
});
