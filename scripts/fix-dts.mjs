// tsc rewrites relative ".ts" imports to ".js" in the JavaScript it emits but not in the .d.ts files; do the same there
// so every consumer's TypeScript (any module resolution) finds the declarations.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';

const dir = new URL('../dist/', import.meta.url);
for (const f of readdirSync(dir).filter((n) => n.endsWith('.d.ts'))) {
  const p = new URL(f, dir);
  const src = readFileSync(p, 'utf8');
  const out = src.replace(/(from\s+['"]\.{1,2}\/[^'"]+?)\.ts(['"])/g, '$1.js$2').replace(/(import\(['"]\.{1,2}\/[^'"]+?)\.ts(['"]\))/g, '$1.js$2');
  if (out !== src) writeFileSync(p, out);
}
