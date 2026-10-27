import { csvCell, toCsv } from './csv';

describe('csv', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('x\ny')).toBe('"x\ny"');
  });

  it('neutralises spreadsheet formulas in text', () => {
    expect(csvCell('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('-5 off')).toBe("'-5 off");
  });

  it('leaves real numbers alone, including negatives', () => {
    expect(csvCell(-5)).toBe('-5');
    expect(csvCell(12.5)).toBe('12.5');
    expect(csvCell(null)).toBe('');
  });

  it('writes a header row, CRLF lines and a BOM', () => {
    expect(toCsv(['A', 'B'], [[1, 'x']])).toBe('﻿A,B\r\n1,x\r\n');
  });
});
