export const FIELD_ENTITIES = [
  'CUSTOMER',
  'ORDER',
  'MENU_ITEM',
  'RESERVATION',
  'SUPPLIER',
  'EMPLOYEE',
  'TABLE',
] as const;

export type FieldEntity = (typeof FIELD_ENTITIES)[number];

const WRITE: Record<FieldEntity, string[]> = {
  CUSTOMER: ['customers.manage'],
  ORDER: ['orders.edit', 'orders.create'],
  MENU_ITEM: ['menu.manage'],
  RESERVATION: ['reservations.manage'],
  SUPPLIER: ['inventory.manage'],
  EMPLOYEE: ['staff.manage'],
  TABLE: ['tables.manage'],
};

export function isFieldEntity(value: string): value is FieldEntity {
  return (FIELD_ENTITIES as readonly string[]).includes(value);
}

function holds(permissions: readonly string[], keys: string[]) {
  return keys.some((key) => permissions.includes(key));
}

/** Definitions can be listed by whoever manages settings, or by whoever edits that record. */
export function canReadFields(
  permissions: readonly string[],
  entity: string,
  hasEntityId: boolean,
) {
  if (!isFieldEntity(entity)) return false;
  if (holds(permissions, WRITE[entity])) return true;
  return !hasEntityId && permissions.includes('settings.manage');
}

export function canWriteFieldValue(permissions: readonly string[], entity: string) {
  return isFieldEntity(entity) && holds(permissions, WRITE[entity]);
}
