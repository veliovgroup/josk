#!/usr/bin/env node
/**
 * Derive CommonJS declarations (`.d.cts`) from generated ESM ones (`.d.ts`).
 * A `.d.cts` file that re-exports an ES module declaration fails with TS1479
 * under `module: node16` / `node18` and in TypeScript below 5.8, so every
 * declaration gets a CJS twin with relative `.js` specifiers rewritten to `.cjs`.
 *
 * Usage: node scripts/cjs-types.mjs <file.d.ts> [<file.d.ts>...]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const relativeJsSpecifier = /((?:from\s+|import\()['"]\.{1,2}\/[^'"]+)\.js(['"])/g;

for (const file of process.argv.slice(2)) {
  const source = readFileSync(file, 'utf8');
  writeFileSync(file.replace(/\.d\.ts$/, '.d.cts'), source.replace(relativeJsSpecifier, '$1.cjs$2'));
}
