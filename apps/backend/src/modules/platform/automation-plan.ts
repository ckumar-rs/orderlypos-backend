export const AUTOMATION_ACTIONS = [
  'NOTIFY',
  'EMAIL',
  'SMS',
  'WHATSAPP',
  'WEBHOOK',
  'TASK',
  'CHAIN',
] as const;

export type AutomationAction = (typeof AUTOMATION_ACTIONS)[number];

export function normalizeActions(input: unknown): AutomationAction[] {
  const raw = Array.isArray(input) ? input.map((item) => String(item)) : [];
  const chosen = AUTOMATION_ACTIONS.filter((action) => raw.includes(action));
  return chosen.length > 0 ? chosen : ['NOTIFY'];
}

/** Follow next-rule links, stopping at a repeat or after three steps. */
export function chainIds(startId: string, nextOf: (id: string) => string | null, limit = 3) {
  const path: string[] = [];
  const seen = new Set([startId]);
  let current = nextOf(startId);
  while (current && path.length < limit) {
    if (seen.has(current)) break;
    seen.add(current);
    path.push(current);
    current = nextOf(current);
  }
  return path;
}

export function chainLoops(startId: string, nextOf: (id: string) => string | null, limit = 8) {
  const seen = new Set([startId]);
  let current = nextOf(startId);
  let steps = 0;
  while (current && steps < limit) {
    if (seen.has(current)) return true;
    seen.add(current);
    current = nextOf(current);
    steps += 1;
  }
  return false;
}
