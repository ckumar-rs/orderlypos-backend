import { EscposWriter, resolveProfile } from './encoder';
import { readJob } from './read-job';

const p80 = resolveProfile({ paperWidthMm: 80 });
const p58 = resolveProfile({ paperWidthMm: 58 });

describe('printer profile', () => {
  it('derives printable columns from paper width', () => {
    expect(p58.columns).toBe(32);
    expect(p80.columns).toBe(48);
    expect(resolveProfile({ paperWidthMm: 80, columns: 42 }).columns).toBe(42);
  });

  it('ignores nonsense settings instead of breaking the grid', () => {
    const p = resolveProfile({ paperWidthMm: 70, columns: 5, codepage: 'X' });
    expect(p).toEqual({ paperWidthMm: 80, columns: 48, codepage: 'CP858' });
  });
});

describe('EscposWriter', () => {
  it('starts with init + code page select + Font A', () => {
    const out = new EscposWriter(p80).finish();
    expect(out.subarray(0, 8).toString('hex')).toBe(
      '1b40' + '1b7413' + '1b4d00',
    );
    const cp437 = new EscposWriter(
      resolveProfile({ codepage: 'CP437' }),
    ).finish();
    expect(cp437.subarray(2, 5).toString('hex')).toBe('1b7400');
  });

  it('encodes Spanish text natively in CP858, never as ?', () => {
    const w = new EscposWriter(p80);
    w.text('Café Ñandú ¿Qué? ¡Sí! Piña €5');
    const out = w.finish();
    expect(w.unsupported.size).toBe(0);
    // é=82 Ñ=A5 ú=A3 ¿=A8 ¡=AD í=A1 ñ=A4 €=D5 in CP858
    expect(out.includes(Buffer.from([0x43, 0x61, 0x66, 0x82]))).toBe(true);
    expect(out.includes(Buffer.from([0xa5, 0x61, 0x6e, 0x64, 0xa3]))).toBe(
      true,
    );
    expect(out.includes(0xd5)).toBe(true);
    expect(readJob(out).text).toContain('Café Ñandú ¿Qué? ¡Sí! Piña €5');
    expect(out.includes(0x3f)).toBe(true); // only the literal '?' in the sentence
  });

  it('reduces accents the code page lacks to the base letter without a ?', () => {
    const w = new EscposWriter(resolveProfile({ codepage: 'CP437' }));
    w.text('Őrült Çsárdás');
    const text = readJob(w.finish(), 'CP437').text;
    expect(w.unsupported.size).toBe(0);
    expect(text).toContain('Orült Çsárdás');
  });

  it('reports unprintable scripts explicitly and says so on the paper', () => {
    const w = new EscposWriter(p80);
    w.text('宮保雞丁 Kung Pao');
    const out = w.finish();
    expect([...w.unsupported].sort()).toEqual(['丁', '保', '宮', '雞'].sort());
    const { text } = readJob(out);
    expect(text).toContain('???? Kung Pao');
    expect(text).toContain('Some characters could not be printed');
  });

  it('wraps to 32 columns on 58 mm and 48 on 80 mm without clipping', () => {
    const long =
      'Pizza Quattro Stagioni con extra de queso y champiñones salteados';
    for (const [profile, cols] of [
      [p58, 32],
      [p80, 48],
    ] as const) {
      const w = new EscposWriter(profile);
      w.text(long);
      const { lines } = readJob(w.finish());
      const body = lines.slice(
        0,
        lines.indexOf('') > -1 ? lines.indexOf('') : undefined,
      );
      expect(body.length).toBeGreaterThan(1);
      body.forEach((l) => expect(l.length).toBeLessThanOrEqual(cols));
      expect(body.join(' ')).toBe(long);
    }
  });

  it('hard-breaks a single word longer than the line', () => {
    const w = new EscposWriter(p58);
    w.text('A'.repeat(70));
    const { lines } = readJob(w.finish());
    expect(lines.slice(0, 3).map((l) => l.length)).toEqual([32, 32, 6]);
  });

  it('halves the grid for double-width text', () => {
    const w = new EscposWriter(p58);
    w.text('X'.repeat(40), { size: 'wide' });
    const { lines } = readJob(w.finish());
    expect(lines.slice(0, 3).map((l) => l.length)).toEqual([16, 16, 8]);
  });

  it('right-aligns a value and keeps long totals whole', () => {
    const w = new EscposWriter(p58);
    w.row('Subtotal', '€12.50');
    w.row('Pizza Quattro Stagioni especial de la casa', '€1234567.89');
    const { lines } = readJob(w.finish());
    expect(lines[0]).toBe('Subtotal' + ' '.repeat(32 - 8 - 6) + '€12.50');
    expect(lines[0]).toHaveLength(32);
    const second = lines.slice(1, 4);
    expect(second[second.length - 1].endsWith('€1234567.89')).toBe(true);
    second.forEach((l) => expect(l.length).toBeLessThanOrEqual(32));
    expect(second.join(' ')).toContain('Pizza Quattro Stagioni');
  });

  it('uses native alignment, bold and size commands around styled lines only', () => {
    const w = new EscposWriter(p80);
    w.text('Plain');
    w.text('BIG', { align: 'center', bold: true, size: 'big' });
    w.text('Plain again');
    const { commands } = readJob(w.finish());
    const body = commands.slice(3); // after init, codepage, font
    expect(body.slice(0, 5)).toEqual([
      '1b6101', // center
      '1b4501', // bold on
      '1d2111', // double width+height
      '1d2100', // size reset right after the line
      '1b4500', // bold off
    ]);
    expect(body[5]).toBe('1b6100'); // align left restored
  });

  it('resets bold, size, underline, inverse and alignment before the cut', () => {
    const w = new EscposWriter(p80);
    w.text('Styled', { bold: true, size: 'tall', align: 'right' });
    const out = w.finish();
    const { commands } = readJob(out);
    const tail = commands.slice(-6);
    expect(tail).toEqual([
      '1d2100',
      '1b4500',
      '1b2d00',
      '1d4200',
      '1b6100',
      '1d5600',
    ]);
    expect(out.subarray(-3).toString('hex')).toBe('1d5600'); // ends with the cut
  });

  it('can end with the drawer pulse after the cut', () => {
    const out = new EscposWriter(p80).finish({ drawer: true });
    expect(out.subarray(-8).toString('hex')).toBe('1d56001b700019fa');
  });
});
