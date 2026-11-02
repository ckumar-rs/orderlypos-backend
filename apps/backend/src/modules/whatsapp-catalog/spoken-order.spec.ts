import { planSpokenOrder, transcriptFromWhisper } from './spoken-order';
import { CatalogMenuMatch } from './catalog-order';

const paneer: CatalogMenuMatch = {
  retailerId: 'item_ck1',
  menuItemId: 'ck1',
  name: 'Paneer tikka',
  isActive: true,
  soldByWeight: false,
  requiresModifier: false,
};

const naan: CatalogMenuMatch = {
  retailerId: 'item_ck2',
  menuItemId: 'ck2',
  name: 'Butter naan',
  isActive: true,
  soldByWeight: false,
  requiresModifier: false,
};

describe('spoken whatsapp orders', () => {
  it('reads quantities in front of the longer dish name', () => {
    const plan = planSpokenOrder('two paneer tikka and one butter naan please', [paneer, naan, { ...paneer, retailerId: 'item_short', menuItemId: 'short', name: 'Paneer' }]);
    expect(plan).toEqual({
      ok: true,
      items: [
        { menuItemId: 'ck1', quantity: 2, modifierIds: [] },
        { menuItemId: 'ck2', quantity: 1, modifierIds: [] },
      ],
    });
  });

  it('reads a number after the dish and a digit', () => {
    const plan = planSpokenOrder('butter naan two, 3 paneer tikka', [paneer, naan]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.items).toEqual([
      { menuItemId: 'ck1', quantity: 3, modifierIds: [] },
      { menuItemId: 'ck2', quantity: 2, modifierIds: [] },
    ]);
  });

  it('refuses a voice note that names nothing on the menu', () => {
    expect(planSpokenOrder('hello there', [paneer])).toEqual({
      ok: false,
      reason: 'No dish on this menu matched that voice note.',
    });
    expect(planSpokenOrder('   ', [paneer]).ok).toBe(false);
  });

  it('reads a whisper transcript and ignores a failed response', () => {
    expect(transcriptFromWhisper(200, { text: ' two paneer tikka ' })).toBe('two paneer tikka');
    expect(() => transcriptFromWhisper(401, { error: 'no' })).toThrow('Speech returned 401');
  });
});
