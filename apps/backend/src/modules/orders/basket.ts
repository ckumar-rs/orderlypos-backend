export interface BasketLine {
  menuItemId: string;
  quantity: number;
  modifierIds?: string[];
}

/** Stable identity of a basket, so a retry can be told apart from a different order. */
export function basketFingerprint(items: BasketLine[]): string {
  return items
    .map(
      (item) =>
        `${item.menuItemId}:${item.quantity}:${[...(item.modifierIds ?? [])].sort().join('.')}`,
    )
    .sort()
    .join('|');
}

export function sameBasket(left: BasketLine[], right: BasketLine[]): boolean {
  return basketFingerprint(left) === basketFingerprint(right);
}
