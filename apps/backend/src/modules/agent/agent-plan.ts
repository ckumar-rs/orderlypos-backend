export const AGENT_TOOLS = [
  'sales_today',
  'sales_month',
  'open_orders',
  'late_tickets',
  'low_stock',
  'reservations_today',
  'branch_comparison',
] as const;

export type AgentTool = (typeof AGENT_TOOLS)[number];
export type AgentScope = 'branch' | 'restaurant';

const TOOL_PERMISSION: Record<AgentTool, string[]> = {
  sales_today: ['dashboard.sales.view', 'reports.access'],
  sales_month: ['dashboard.sales.view', 'reports.access'],
  open_orders: ['orders.create'],
  late_tickets: ['kds.manage'],
  low_stock: ['inventory.manage'],
  reservations_today: ['reservations.manage'],
  branch_comparison: ['reports.access'],
};

const TOOL_LABEL: Record<AgentTool, string> = {
  sales_today: 'today’s sales',
  sales_month: 'this month’s sales',
  open_orders: 'open orders',
  late_tickets: 'kitchen tickets',
  low_stock: 'stock',
  reservations_today: 'reservations',
  branch_comparison: 'the branch comparison',
};

function mentions(question: string, words: string[]) {
  return words.some((word) => question.includes(word));
}

/** Picks the record lookups a question needs. A vague question checks the whole allowed set. */
export function toolsForQuestion(question: string, scope: AgentScope): AgentTool[] {
  const q = question.toLowerCase();
  const picked: AgentTool[] = [];
  if (mentions(q, ['sale', 'revenue', 'taking', 'money', 'sold', 'earning', 'bill total'])) {
    if (!mentions(q, ['month', 'mtd'])) picked.push('sales_today');
    if (mentions(q, ['month', 'mtd', 'this month'])) picked.push('sales_month');
    if (mentions(q, ['today', 'day']) && !picked.includes('sales_today')) picked.push('sales_today');
  }
  if (mentions(q, ['open order', 'unpaid', 'open bill', 'not paid', 'sitting'])) {
    picked.push('open_orders');
  }
  if (mentions(q, ['kitchen', 'late', 'ticket', 'kds', 'prepar'])) picked.push('late_tickets');
  if (mentions(q, ['stock', 'reorder', 'inventory', 'ingredient', 'running out'])) {
    picked.push('low_stock');
  }
  if (mentions(q, ['reserv', 'booking', 'booked'])) picked.push('reservations_today');
  if (
    scope === 'restaurant' &&
    (picked.length === 0 || mentions(q, ['branch', 'compare', 'franchise', 'other', 'each']))
  ) {
    picked.unshift('branch_comparison');
  }
  if (picked.length === 0) {
    return scope === 'restaurant'
      ? [...AGENT_TOOLS]
      : AGENT_TOOLS.filter((tool) => tool !== 'branch_comparison');
  }
  return [...new Set(picked)];
}

export function asksAboutOtherBranches(question: string) {
  const q = question.toLowerCase();
  return mentions(q, ['other branch', 'all branch', 'every branch', 'compare', 'franchise']);
}

export function asksForPrivateContact(question: string) {
  return /\b(phone|mobile|e-mail|email|address|allerg)/i.test(question);
}

export function filterTools(tools: AgentTool[], permissions: string[], scope: AgentScope) {
  const allowed: AgentTool[] = [];
  const skipped: string[] = [];
  for (const tool of tools) {
    if (tool === 'branch_comparison' && scope !== 'restaurant') continue;
    const keys = TOOL_PERMISSION[tool];
    if (keys.some((key) => permissions.includes(key))) allowed.push(tool);
    else skipped.push(`${TOOL_LABEL[tool]} — this login cannot see ${TOOL_LABEL[tool]}`);
  }
  return { allowed, skipped };
}

export interface SalesFact {
  orders: number;
  total: string;
}

export interface BranchFacts {
  branchName: string;
  salesToday?: SalesFact;
  salesMonth?: SalesFact;
  openOrders?: { orderNumber: string; type: string; total: string; table: string | null }[];
  lateTickets?: {
    ticketNumber: string;
    orderNumber: string;
    station: string;
    status: string;
    ageMinutes: number;
  }[];
  lowStock?: { name: string; stock: string; reorder: string }[];
  reservations?: { name: string; guests: number; at: string; table: string | null; status: string }[];
}

export interface ComparisonRow {
  name: string;
  orders: number;
  sales: string;
  aov: string;
  covers: number;
  noShows: number;
}

export function renderAnswer(input: {
  branches: BranchFacts[];
  comparison?: ComparisonRow[];
  skipped: string[];
  privateContact: boolean;
  otherBranchesFromBranchChat: boolean;
}): string {
  const lines: string[] = [];
  if (input.comparison) {
    lines.push('This month, by branch:');
    if (input.comparison.length === 0) lines.push('No active branches.');
    for (const row of input.comparison) {
      lines.push(
        `${row.name}: ${row.orders} orders, ${row.sales} sales, ${row.aov} average, ${row.covers} covers, ${row.noShows} no-shows.`,
      );
    }
  }
  for (const branch of input.branches) {
    lines.push(branch.branchName);
    if (branch.salesToday) {
      lines.push(`Today: ${branch.salesToday.orders} paid orders, ${branch.salesToday.total}.`);
    }
    if (branch.salesMonth) {
      lines.push(`This month: ${branch.salesMonth.orders} paid orders, ${branch.salesMonth.total}.`);
    }
    if (branch.openOrders) {
      lines.push(
        branch.openOrders.length === 0
          ? 'Open orders: none.'
          : `Open orders: ${branch.openOrders.length}. ${branch.openOrders
              .map(
                (order) =>
                  `#${order.orderNumber} ${order.type}${order.table ? ` table ${order.table}` : ''} ${order.total}`,
              )
              .join('. ')}.`,
      );
    }
    if (branch.lateTickets) {
      lines.push(
        branch.lateTickets.length === 0
          ? 'Late kitchen tickets: none.'
          : `Late kitchen tickets: ${branch.lateTickets.length}. ${branch.lateTickets
              .map(
                (ticket) =>
                  `${ticket.ticketNumber} for #${ticket.orderNumber}, ${ticket.station}, ${ticket.status}, ${ticket.ageMinutes} minutes`,
              )
              .join('. ')}.`,
      );
    }
    if (branch.lowStock) {
      lines.push(
        branch.lowStock.length === 0
          ? 'Low stock: none.'
          : `Low stock: ${branch.lowStock.length}. ${branch.lowStock
              .map((row) => `${row.name} ${row.stock} at or below ${row.reorder}`)
              .join('. ')}.`,
      );
    }
    if (branch.reservations) {
      lines.push(
        branch.reservations.length === 0
          ? 'Reservations today: none.'
          : `Reservations today: ${branch.reservations.length}. ${branch.reservations
              .map(
                (row) =>
                  `${row.name}, ${row.guests} guests, ${row.at}${row.table ? `, table ${row.table}` : ''}, ${row.status}`,
              )
              .join('. ')}.`,
      );
    }
  }
  for (const skip of input.skipped) lines.push(`Not included: ${skip}.`);
  if (input.privateContact) {
    lines.push('Phone, email, address, and allergy notes are not included.');
  }
  if (input.otherBranchesFromBranchChat) {
    lines.push('This chat is only the current branch. The restaurant agent compares the other branches.');
  }
  if (lines.length === 0) lines.push('Nothing in the records matched that question.');
  return lines.join('\n');
}

export function numbersIn(text: string): string[] {
  const normalized = text.replace(/(\d),(?=\d)/g, '$1');
  return normalized.match(/\d+(?:\.\d+)?/g) ?? [];
}

/** A phrased reply may only repeat numbers that the records already printed. */
export function replyStaysInside(reply: string, records: string) {
  const known = new Set<string>();
  for (const value of numbersIn(records)) {
    known.add(value);
    const asNumber = Number(value);
    if (Number.isFinite(asNumber)) {
      known.add(String(asNumber));
      known.add(asNumber.toFixed(2));
    }
  }
  return numbersIn(reply).every((value) => {
    if (known.has(value)) return true;
    const asNumber = Number(value);
    return Number.isFinite(asNumber) && (known.has(String(asNumber)) || known.has(asNumber.toFixed(2)));
  });
}
