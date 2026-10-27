// Customer analytics and loyalty arithmetic. No database access, so the
// profile numbers, earn caps, and staff-discount caps can be tested on their own.

export interface FavoriteLine {
  menuItemId: string;
  name: string;
  quantity: number;
}

export function favoriteProducts(lines: FavoriteLine[], limit = 5): FavoriteLine[] {
  const totals = new Map<string, FavoriteLine>();
  for (const line of lines) {
    const current = totals.get(line.menuItemId);
    if (current) {
      current.quantity += line.quantity;
    } else {
      totals.set(line.menuItemId, { ...line });
    }
  }
  return [...totals.values()]
    .sort((a, b) => b.quantity - a.quantity || a.name.localeCompare(b.name))
    .slice(0, limit);
}

export interface VisitOrder {
  total: number;
  at: Date | null;
}

export interface VisitMetrics {
  visits: number;
  spend: number;
  aov: number;
  averageDaysBetween: number | null;
  visitsPer30Days: number | null;
}

export function visitMetrics(orders: VisitOrder[], now = new Date()): VisitMetrics {
  const visits = orders.length;
  const spend = money(orders.reduce((sum, order) => sum + order.total, 0));
  const dated = orders
    .map((order) => order.at)
    .filter((at): at is Date => at instanceof Date && !Number.isNaN(at.getTime()))
    .sort((a, b) => a.getTime() - b.getTime());
  let averageDaysBetween: number | null = null;
  if (dated.length >= 2) {
    let gaps = 0;
    for (let i = 1; i < dated.length; i += 1) {
      gaps += (dated[i].getTime() - dated[i - 1].getTime()) / 86_400_000;
    }
    averageDaysBetween = money(gaps / (dated.length - 1));
  }
  let visitsPer30Days: number | null = null;
  if (dated.length >= 2) {
    const span = Math.max((now.getTime() - dated[0].getTime()) / 86_400_000, 1);
    visitsPer30Days = money((visits / span) * 30);
  }
  return {
    visits,
    spend,
    aov: visits > 0 ? money(spend / visits) : 0,
    averageDaysBetween,
    visitsPer30Days,
  };
}

export function spendForLoyalty(input: {
  lines: { menuItemId: string; lineTotal: number }[];
  eligibleMenuItemIds: string[];
  netSpend: number;
}): number {
  const lineSum = money(input.lines.reduce((sum, line) => sum + line.lineTotal, 0));
  if (lineSum <= 0 || input.netSpend <= 0) return 0;
  const ids = input.eligibleMenuItemIds;
  const base =
    ids.length === 0
      ? lineSum
      : money(
          input.lines
            .filter((line) => ids.includes(line.menuItemId))
            .reduce((sum, line) => sum + line.lineTotal, 0),
        );
  return money((base / lineSum) * input.netSpend);
}

export function earnPoints(input: {
  eligibleSpend: number;
  earnPerCurrency: number;
  multiplier: number;
  cap: number | null;
}): number {
  if (input.eligibleSpend <= 0 || input.earnPerCurrency <= 0) return 0;
  const multiplier = input.multiplier > 0 ? input.multiplier : 1;
  const raw = Math.floor((input.eligibleSpend / input.earnPerCurrency) * multiplier);
  if (input.cap != null && input.cap >= 0) return Math.min(raw, Math.floor(input.cap));
  return raw;
}

export function earnCashback(input: {
  eligibleSpend: number;
  percent: number;
  cap: number | null;
}): number {
  if (input.eligibleSpend <= 0 || input.percent <= 0) return 0;
  const raw = money((input.eligibleSpend * input.percent) / 100);
  if (input.cap != null && input.cap >= 0) return Math.min(raw, input.cap);
  return raw;
}

export interface PointLotView {
  id: string;
  pointsRemaining: number;
  expiresAt: Date | null;
  createdAt?: Date;
}

export function planExpiry(lots: PointLotView[], now: Date) {
  const expired = lots.filter(
    (lot) => lot.pointsRemaining > 0 && lot.expiresAt != null && lot.expiresAt < now,
  );
  return {
    lotIds: expired.map((lot) => lot.id),
    points: expired.reduce((sum, lot) => sum + lot.pointsRemaining, 0),
  };
}

export function planConsume(lots: PointLotView[], points: number, now: Date) {
  const live = lots
    .filter(
      (lot) =>
        lot.pointsRemaining > 0 && (lot.expiresAt == null || lot.expiresAt >= now),
    )
    .sort(
      (a, b) =>
        (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
    );
  let left = points;
  const takes: { id: string; take: number }[] = [];
  for (const lot of live) {
    if (left <= 0) break;
    const take = Math.min(lot.pointsRemaining, left);
    takes.push({ id: lot.id, take });
    left -= take;
  }
  return { takes, unlotted: left };
}

export interface EmployeePolicyView {
  userId: string | null;
  roleId: string | null;
  percent: number;
  maxAmount: number | null;
  isActive: boolean;
}

/** A named staff policy wins, then a role policy, then the restaurant percent. A cap lowers the percent so the bill discount cannot pass the amount. */
export function resolveEmployeePercent(input: {
  policies: EmployeePolicyView[];
  userId: string;
  roleId: string;
  fallbackPercent: number;
  subtotal: number;
}): number {
  const active = input.policies.filter((policy) => policy.isActive);
  const personal = active.find((policy) => policy.userId === input.userId);
  const role = active.find((policy) => !policy.userId && policy.roleId === input.roleId);
  const chosen = personal ?? role;
  const percent = chosen ? chosen.percent : input.fallbackPercent;
  if (percent <= 0) return 0;
  const cap = chosen?.maxAmount ?? null;
  if (cap != null && cap >= 0 && input.subtotal > 0) {
    const uncapped = (input.subtotal * percent) / 100;
    if (uncapped > cap) return money((cap / input.subtotal) * 100);
  }
  return percent;
}

function money(value: number) {
  return Math.round(value * 100) / 100;
}
