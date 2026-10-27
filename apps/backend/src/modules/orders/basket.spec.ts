import { basketFingerprint, sameBasket } from './basket';

describe('basket fingerprint', () => {
  it('treats modifier order as the same basket', () => {
    const a = [{ menuItemId: 'dosa', quantity: 1, modifierIds: ['b', 'a'] }];
    const b = [{ menuItemId: 'dosa', quantity: 1, modifierIds: ['a', 'b'] }];
    expect(sameBasket(a, b)).toBe(true);
  });

  it('treats a different quantity as a conflict', () => {
    const a = [{ menuItemId: 'dosa', quantity: 1 }];
    const b = [{ menuItemId: 'dosa', quantity: 2 }];
    expect(basketFingerprint(a)).not.toBe(basketFingerprint(b));
  });
});
