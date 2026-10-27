import { CODEPAGES } from './codepages';

// Minimal ESC/POS reader for assertions: separates commands from text and
// decodes text bytes with the same code page table the encoder used.
export function readJob(
  buf: Buffer,
  codepage: keyof typeof CODEPAGES = 'CP858',
) {
  const high = [...CODEPAGES[codepage].high];
  const commands: string[] = [];
  const lines: string[] = [];
  let cur = '';
  for (let i = 0; i < buf.length;) {
    const b = buf[i];
    if (b === 0x1b) {
      const op = buf[i + 1];
      const len = op === 0x40 ? 2 : op === 0x70 ? 5 : 3;
      commands.push(buf.subarray(i, i + len).toString('hex'));
      i += len;
    } else if (b === 0x1d) {
      commands.push(buf.subarray(i, i + 3).toString('hex'));
      i += 3;
    } else if (b === 0x0a) {
      lines.push(cur);
      cur = '';
      i++;
    } else {
      cur += b < 0x80 ? String.fromCharCode(b) : high[b - 0x80];
      i++;
    }
  }
  if (cur) lines.push(cur);
  return { commands, lines, text: lines.join('\n') };
}
