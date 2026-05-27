#!/usr/bin/env node
/**
 * Post-process generated .d.ts files to strip JSDoc-marked @internal members.
 * Workaround for TypeScript's stripInternal not honoring JSDoc declarations
 * in JS source (microsoft/TypeScript#35216).
 *
 * Usage: node scripts/strip-internal.mjs <file> [<file>...]
 */
import { readFileSync, writeFileSync } from 'node:fs';

const stripInternals = (source) => {
  const lines = source.split('\n');
  const output = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Single-line `/** @internal [...] */` (allows additional tags like `@type`)
    if (/^\s*\/\*\*\s*@internal\b[^*]*\*\/\s*$/.test(line)) {
      // Skip this line and the next declaration line
      i++;
      // Skip blank lines
      while (i < lines.length && lines[i].trim() === '') {
        i++;
      }
      if (i < lines.length) {
        // Skip the declaration. If it ends with `{`, skip until matching `}`.
        const declLine = lines[i];
        if (declLine.trim().endsWith('{')) {
          let depth = 1;
          i++;
          while (i < lines.length && depth > 0) {
            const ch = lines[i];
            for (let j = 0; j < ch.length; j++) {
              if (ch[j] === '{') depth++;
              else if (ch[j] === '}') depth--;
            }
            i++;
          }
        } else {
          // Single-line declaration (ends with `;` or `,`)
          // Continue while the declaration spans multiple lines without terminator
          while (i < lines.length && !/[;,]\s*(\/\/.*)?$/.test(lines[i])) {
            i++;
          }
          i++;
        }
      }
      continue;
    }

    // Multi-line JSDoc block containing `@internal`
    if (/^\s*\/\*\*\s*$/.test(line)) {
      // Look ahead for the closing `*/`
      let j = i + 1;
      let hasInternal = false;
      while (j < lines.length && !/\*\//.test(lines[j])) {
        if (/@internal\b/.test(lines[j])) {
          hasInternal = true;
        }
        j++;
      }
      if (hasInternal) {
        // Skip the JSDoc block (i..j) and the following declaration
        i = j + 1;
        while (i < lines.length && lines[i].trim() === '') {
          i++;
        }
        if (i < lines.length) {
          const declLine = lines[i];
          if (declLine.trim().endsWith('{')) {
            let depth = 1;
            i++;
            while (i < lines.length && depth > 0) {
              const ch = lines[i];
              for (let k = 0; k < ch.length; k++) {
                if (ch[k] === '{') depth++;
                else if (ch[k] === '}') depth--;
              }
              i++;
            }
          } else {
            while (i < lines.length && !/[;,]\s*(\/\/.*)?$/.test(lines[i])) {
              i++;
            }
            i++;
          }
        }
        continue;
      }
    }

    output.push(line);
    i++;
  }

  return output.join('\n');
};

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('Usage: node scripts/strip-internal.mjs <file> [<file>...]');
  process.exit(1);
}

for (const file of files) {
  const source = readFileSync(file, 'utf8');
  const stripped = stripInternals(source);
  writeFileSync(file, stripped, 'utf8');
}
