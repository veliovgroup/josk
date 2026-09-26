const testApi = typeof globalThis.Bun === 'undefined'
  ? await import('@jest/globals')
  : await import('bun:test');
const { describe, expect, it } = testApi;

import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

describe('Meteor package declaration assets', () => {
  it('ships every declaration referenced by the root type entry', () => {
    let onUse;
    const assets = [];
    const Package = {
      describe() {},
      onUse(callback) { onUse = callback; },
      onTest() {}
    };
    runInNewContext(readFileSync('package.js', 'utf8'), { Package, process });
    onUse({
      versionsFrom() {},
      use() {},
      mainModule() {},
      addAssets(paths) { assets.push(...(Array.isArray(paths) ? paths : [paths])); }
    });

    expect(new Set(assets)).toEqual(new Set([
      'index.d.ts',
      'adapters/mongo.d.ts',
      'adapters/redis.d.ts',
      'adapters/postgres.d.ts'
    ]));
  });
});
