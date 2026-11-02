import { CatalogCartPlan, planCatalogCart, CatalogMenuMatch } from './catalog-order';

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  double: 2,
  ek: 1,
  do: 2,
  teen: 3,
  char: 4,
  paanch: 5,
  panch: 5,
  che: 6,
  saat: 7,
  aath: 8,
  nau: 9,
  das: 10,
};

const FILLERS = new Set([
  'and',
  'please',
  'of',
  'with',
  'the',
  'some',
  'also',
  'plus',
  'then',
  'um',
  'uh',
  'me',
  'for',
  'i',
  'want',
  'like',
  'plate',
  'plates',
  'portion',
  'piece',
  'pieces',
  'order',
]);

export function normalizeSpeech(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function quantityToken(word: string | undefined): number | null {
  if (!word) return null;
  const packed = /^(\d+)x$/.exec(word);
  if (packed) {
    const amount = Number(packed[1]);
    return amount >= 1 && amount <= 50 ? amount : null;
  }
  if (/^\d+$/.test(word)) {
    const amount = Number(word);
    return amount >= 1 && amount <= 50 ? amount : null;
  }
  return NUMBER_WORDS[word] ?? null;
}

function quantityBeside(words: string[], used: boolean[], start: number, length: number): number {
  let cursor = start - 1;
  while (cursor >= 0 && !used[cursor] && FILLERS.has(words[cursor])) cursor -= 1;
  const before = cursor >= 0 && !used[cursor] ? quantityToken(words[cursor]) : null;
  if (before != null) return before;
  const after = start + length;
  if (after < words.length && !used[after]) return quantityToken(words[after]) ?? 1;
  return 1;
}

export function planSpokenOrder(
  transcript: string,
  menu: CatalogMenuMatch[],
): CatalogCartPlan {
  const words = normalizeSpeech(transcript);
  if (words.length === 0) return { ok: false, reason: 'The voice note had no words.' };
  const dishes = menu
    .map((item) => ({ item, tokens: normalizeSpeech(item.name) }))
    .filter((dish) => dish.tokens.length > 0)
    .sort(
      (left, right) =>
        right.tokens.length - left.tokens.length ||
        right.item.name.length - left.item.name.length ||
        left.item.menuItemId.localeCompare(right.item.menuItemId),
    );
  const used = new Array<boolean>(words.length).fill(false);
  const counts = new Map<string, number>();
  for (const dish of dishes) {
    for (let index = 0; index <= words.length - dish.tokens.length; index += 1) {
      if (used.slice(index, index + dish.tokens.length).some(Boolean)) continue;
      const same = dish.tokens.every((token, offset) => words[index + offset] === token);
      if (!same) continue;
      const quantity = quantityBeside(words, used, index, dish.tokens.length);
      for (let mark = index; mark < index + dish.tokens.length; mark += 1) used[mark] = true;
      counts.set(dish.item.retailerId, (counts.get(dish.item.retailerId) ?? 0) + quantity);
    }
  }
  if (counts.size === 0) return { ok: false, reason: 'No dish on this menu matched that voice note.' };
  return planCatalogCart(
    [...counts.entries()].map(([retailerId, quantity]) => ({
      retailerId,
      quantity,
      submittedPrice: null,
      currency: null,
    })),
    menu,
  );
}

export function transcriptFromWhisper(status: number, body: unknown): string {
  if (status < 200 || status >= 300) throw new Error(`Speech returned ${status}`);
  const text = body && typeof body === 'object' ? (body as { text?: unknown }).text : null;
  if (typeof text !== 'string' || !text.trim()) throw new Error('Speech returned no words');
  return text.trim();
}

export function voiceFilename(mime: string): string {
  const kind = mime.toLowerCase();
  if (kind.includes('mpeg') || kind.includes('mp3')) return 'voice.mp3';
  if (kind.includes('mp4') || kind.includes('m4a')) return 'voice.m4a';
  if (kind.includes('wav')) return 'voice.wav';
  return 'voice.ogg';
}
