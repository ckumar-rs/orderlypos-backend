// Builds prisma/schema.sqlite.prisma from schema.prisma.
// Postgres enums become strings, list columns become JSON, and native
// type annotations that SQLite cannot store are removed. The running
// Postgres app keeps schema.prisma unchanged.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const sourcePath = path.join(__dirname, 'schema.prisma');
const targetPath = path.join(__dirname, 'schema.sqlite.prisma');
let text = fs.readFileSync(sourcePath, 'utf8');

const enums = new Map();
text = text.replace(/enum\s+(\w+)\s+\{([^}]+)\}/g, (_, name, body) => {
  const values = body
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, '').trim())
    .filter((line) => line && !line.startsWith('//'));
  enums.set(name, values);
  return '';
});

text = text.replace(/provider\s*=\s*"postgresql"/, 'provider = "sqlite"');
text = text.replace(/\s+@db\.\w+(\([^)]*\))?/g, '');
text = text.replace(/String\[\](\s+@default\(\[\]\))?/g, (_match, def) =>
  def ? 'Json @default("[]")' : 'Json',
);
text = text.replace(/Int\[\]/g, 'Json');

for (const [name, values] of enums) {
  const valueSet = new Set(values);
  text = text.replace(new RegExp(`\\b${name}\\b`, 'g'), 'String');
  for (const value of valueSet) {
    text = text.replace(
      new RegExp(`@default\\(${value}\\)`, 'g'),
      `@default("${value}")`,
    );
  }
}

fs.writeFileSync(targetPath, text);
console.log(`Wrote ${path.basename(targetPath)} (${enums.size} enums converted)`);
