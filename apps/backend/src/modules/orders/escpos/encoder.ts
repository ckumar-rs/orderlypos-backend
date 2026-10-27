// Native ESC/POS text encoder: code-page aware byte encoding, column-exact
// wrapping for 58 mm / 80 mm paper, printer-native alignment / bold / size
// commands, and an explicit state reset at the end of every job. Nothing here
// rasterises text - every glyph is printed by the printer's own font.
//
// No I/O and no randomness, so the exact bytes are asserted in unit tests.
// What it cannot assert is how a given printer model renders them: code page
// numbering and cutter support vary, so check a test print on the real unit.

import { CODEPAGES, type CodepageName } from './codepages';

export type { CodepageName } from './codepages';
export type PaperWidthMm = 58 | 80;
export type TextSize = 'normal' | 'tall' | 'wide' | 'big';
export type Align = 'left' | 'center' | 'right';

export interface PrinterProfile {
  paperWidthMm: PaperWidthMm;
  /** Printable characters per line in the normal (Font A) size. */
  columns: number;
  codepage: CodepageName;
}

// 58 mm heads print 384 dots, 80 mm heads 576 dots; Font A is 12 dots wide.
export const DEFAULT_COLUMNS: Record<PaperWidthMm, number> = { 58: 32, 80: 48 };
export const CODEPAGE_NAMES = Object.keys(CODEPAGES) as CodepageName[];

export function resolveProfile(
  opts: {
    paperWidthMm?: number | null;
    columns?: number | null;
    codepage?: string | null;
  } = {},
): PrinterProfile {
  const paperWidthMm: PaperWidthMm = opts.paperWidthMm === 58 ? 58 : 80;
  const requested = Number(opts.columns);
  const columns =
    Number.isFinite(requested) && requested >= 20 && requested <= 64
      ? Math.floor(requested)
      : DEFAULT_COLUMNS[paperWidthMm];
  const codepage = CODEPAGE_NAMES.includes(opts.codepage as CodepageName)
    ? (opts.codepage as CodepageName)
    : 'CP858';
  return { paperWidthMm, columns, codepage };
}

const ESC = 0x1b;
const GS = 0x1d;
const SIZE_BYTE: Record<TextSize, number> = {
  normal: 0x00,
  tall: 0x01,
  wide: 0x10,
  big: 0x11,
};
const ALIGN_BYTE: Record<Align, number> = { left: 0, center: 1, right: 2 };

export const CMD = {
  init: Buffer.from([ESC, 0x40]),
  fontA: Buffer.from([ESC, 0x4d, 0x00]),
  boldOn: Buffer.from([ESC, 0x45, 0x01]),
  boldOff: Buffer.from([ESC, 0x45, 0x00]),
  underlineOff: Buffer.from([ESC, 0x2d, 0x00]),
  sizeNormal: Buffer.from([GS, 0x21, 0x00]),
  alignLeft: Buffer.from([ESC, 0x61, 0x00]),
  invertOff: Buffer.from([GS, 0x42, 0x00]),
  // ESC p m t1 t2 - pulse pin 2 for 50 ms on / 500 ms off (cash drawer kick).
  openDrawer: Buffer.from([ESC, 0x70, 0x00, 0x19, 0xfa]),
  cut: Buffer.from([GS, 0x56, 0x00]),
};

// Typographic characters worth keeping legible on a single-byte code page.
const LOOKALIKES: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '…': '...',
  '•': '*',
  '₹': 'Rs.',
  ' ': ' ',
};

export class EscposWriter {
  readonly profile: PrinterProfile;
  /** Distinct characters that could not be represented and were printed as '?'. */
  readonly unsupported = new Set<string>();
  private readonly chunks: Buffer[] = [];
  private readonly reverse = new Map<string, number>();

  constructor(profile: PrinterProfile) {
    this.profile = profile;
    const high = [...CODEPAGES[profile.codepage].high];
    high.forEach((ch, i) => {
      if (ch !== '�') this.reverse.set(ch, 0x80 + i);
    });
    this.chunks.push(
      CMD.init,
      Buffer.from([ESC, 0x74, CODEPAGES[profile.codepage].escposTable]),
      CMD.fontA,
    );
  }

  /** True if `ch` (one code point) has a byte in the selected code page. */
  has(ch: string): boolean {
    const cp = ch.codePointAt(0)!;
    return (cp >= 0x20 && cp <= 0x7e) || this.reverse.has(ch);
  }

  /**
   * Maps text to printable characters of the selected code page: native
   * glyphs are kept (so Spanish names stay readable), unavailable accents are
   * reduced to their base letter, and anything else becomes '?' and is
   * recorded in `unsupported`. The result is 1 character = 1 byte.
   */
  prepare(text: string | null | undefined): string {
    let out = '';
    for (const ch of String(text ?? '')) {
      if (ch === '\t') out += ' ';
      else if (ch === '\n' || ch === '\r') out += ch === '\n' ? '\n' : '';
      else if (this.has(ch)) out += ch;
      else if (LOOKALIKES[ch] !== undefined) out += LOOKALIKES[ch];
      else {
        const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
        if (base && base !== ch && [...base].every((c) => this.has(c))) {
          out += base;
        } else if (/\p{C}/u.test(ch)) {
          // control / format characters: nothing to print
        } else {
          out += '?';
          this.unsupported.add(ch);
        }
      }
    }
    return out;
  }

  private encode(prepared: string): Buffer {
    const bytes: number[] = [];
    for (const ch of prepared) {
      const cp = ch.codePointAt(0)!;
      bytes.push(
        cp >= 0x20 && cp <= 0x7e ? cp : (this.reverse.get(ch) ?? 0x3f),
      );
    }
    return Buffer.from(bytes);
  }

  /** Characters per line at a text size (double width halves the grid). */
  columnsFor(size: TextSize = 'normal'): number {
    return size === 'wide' || size === 'big'
      ? Math.floor(this.profile.columns / 2)
      : this.profile.columns;
  }

  /** Wraps on spaces, hard-breaking words longer than the line. Never clips. */
  wrap(text: string, columns: number): string[] {
    const lines: string[] = [];
    for (const paragraph of this.prepare(text).split('\n')) {
      let line = '';
      for (const word of paragraph.split(' ').filter((w) => w.length > 0)) {
        let w = word;
        while (w.length > columns) {
          if (line) {
            lines.push(line);
            line = '';
          }
          lines.push(w.slice(0, columns));
          w = w.slice(columns);
        }
        const candidate = line ? `${line} ${w}` : w;
        if (candidate.length > columns) {
          lines.push(line);
          line = w;
        } else {
          line = candidate;
        }
      }
      lines.push(line);
    }
    return lines;
  }

  private emit(
    line: string,
    opts: { align?: Align; bold?: boolean; size?: TextSize },
  ) {
    const { align = 'left', bold = false, size = 'normal' } = opts;
    const styled = bold || size !== 'normal' || align !== 'left';
    if (styled) {
      this.chunks.push(Buffer.from([ESC, 0x61, ALIGN_BYTE[align]]));
      if (bold) this.chunks.push(CMD.boldOn);
      if (size !== 'normal') {
        this.chunks.push(Buffer.from([GS, 0x21, SIZE_BYTE[size]]));
      }
    }
    this.chunks.push(this.encode(line), Buffer.from('\n'));
    if (styled) {
      // Undo per line so a later plain line can never inherit the style.
      if (size !== 'normal') this.chunks.push(CMD.sizeNormal);
      if (bold) this.chunks.push(CMD.boldOff);
      this.chunks.push(CMD.alignLeft);
    }
  }

  /** One or more wrapped lines of text with native alignment / bold / size. */
  text(
    text: string,
    opts: { align?: Align; bold?: boolean; size?: TextSize } = {},
  ): this {
    for (const l of this.wrap(text, this.columnsFor(opts.size))) {
      this.emit(l, opts);
    }
    return this;
  }

  /**
   * Left label, right-aligned value on one line. A label too long for the
   * line wraps onto further lines; the value is never clipped.
   */
  row(
    label: string,
    value: string,
    opts: { bold?: boolean; size?: TextSize; indent?: number } = {},
  ): this {
    const cols = this.columnsFor(opts.size);
    const v = this.prepare(value);
    const indent = ' '.repeat(opts.indent ?? 0);
    const room = Math.max(1, cols - v.length - 1 - indent.length);
    const parts = this.wrap(label, room);
    const lastIdx = parts.length - 1;
    parts.forEach((part, i) => {
      const left = indent + part;
      const line =
        i === lastIdx
          ? left + ' '.repeat(Math.max(1, cols - left.length - v.length)) + v
          : left;
      this.emit(line, opts);
    });
    return this;
  }

  /**
   * Native ESC/POS QR code (GS ( k, model 2, error correction M), centred. Module size 6 prints a
   * VERI*FACTU-length URL at roughly 33 mm on 203 dpi paper, inside AEAT's 30-40 mm range.
   */
  qr(data: string, moduleSize = 6): this {
    const bytes = Buffer.from(data, 'utf8');
    const len = bytes.length + 3;
    this.chunks.push(
      Buffer.from([ESC, 0x61, 1]),
      Buffer.from([GS, 0x28, 0x6b, 0x04, 0x00, 0x31, 0x41, 0x32, 0x00]),
      Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x43, moduleSize]),
      Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x45, 0x31]),
      Buffer.from([GS, 0x28, 0x6b, len & 0xff, len >> 8, 0x31, 0x50, 0x30]),
      bytes,
      Buffer.from([GS, 0x28, 0x6b, 0x03, 0x00, 0x31, 0x51, 0x30]),
      Buffer.from('\n'),
      CMD.alignLeft,
    );
    return this;
  }

  rule(char = '-'): this {
    this.emit(char.repeat(this.profile.columns), {});
    return this;
  }

  blank(n = 1): this {
    for (let i = 0; i < n; i++) this.emit('', {});
    return this;
  }

  /**
   * Ends the job: explicit reset of bold / size / alignment / underline /
   * inverse (so nothing leaks into the next job), feed, cut and optionally
   * kick the cash drawer. If any character was printed as '?' a plain notice
   * line says so on the paper itself.
   */
  finish(opts: { cut?: boolean; drawer?: boolean } = {}): Buffer {
    if (this.unsupported.size > 0) {
      this.rule();
      this.text('(!) Some characters could not be printed and show as "?".');
    }
    this.chunks.push(
      CMD.sizeNormal,
      CMD.boldOff,
      CMD.underlineOff,
      CMD.invertOff,
      CMD.alignLeft,
      Buffer.from('\n\n\n\n'),
    );
    if (opts.cut !== false) this.chunks.push(CMD.cut);
    if (opts.drawer) this.chunks.push(CMD.openDrawer);
    return Buffer.concat(this.chunks);
  }
}
