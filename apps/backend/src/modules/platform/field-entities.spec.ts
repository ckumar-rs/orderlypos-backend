import { canReadFields, canWriteFieldValue, isFieldEntity } from './field-entities';

describe('field entities', () => {
  it('accepts the records that have a field editor', () => {
    expect(isFieldEntity('MENU_ITEM')).toBe(true);
    expect(isFieldEntity('EMPLOYEE')).toBe(true);
    expect(isFieldEntity('INVOICE')).toBe(false);
  });

  it('lets settings list definitions and the record owner read a value', () => {
    expect(canReadFields(['settings.manage'], 'ORDER', false)).toBe(true);
    expect(canReadFields(['settings.manage'], 'ORDER', true)).toBe(false);
    expect(canReadFields(['orders.create'], 'ORDER', true)).toBe(true);
    expect(canReadFields(['customers.manage'], 'TABLE', true)).toBe(false);
  });

  it('lets only the record owner save a value', () => {
    expect(canWriteFieldValue(['inventory.manage'], 'SUPPLIER')).toBe(true);
    expect(canWriteFieldValue(['settings.manage'], 'SUPPLIER')).toBe(false);
    expect(canWriteFieldValue(['staff.manage'], 'EMPLOYEE')).toBe(true);
    expect(canWriteFieldValue(['tables.view'], 'TABLE')).toBe(false);
  });
});
