# AGENTS.md

JoSk. Node task scheduler. Single execution across scaled instances (clusters, multi-server, multi-DC). Mimics setTimeout/setInterval. CRON via helper. Sync via Redis/Mongo/Postgres/custom adapter. Read locks, zombie recovery, autoClear. Zero core deps. ~99% test cov.

## Mission
Ensure exactly-once task execution in horizontally scaled Node.js. Bulletproof. High perf. Storage agnostic. Easy adapters.

## Structure
- `index.js`: core ESM (JoSk + adapters). Edit this.
- `index.cjs`: generated via `prepublishOnly: rollup index.js --file index.cjs --format cjs` (npm publish runs it). CJS bundle for "require". Never edit directly. Regenerate before publish.
- `adapters/`: postgres.js (pg Pool/tables/indexes/locks), mongo.js, redis.js, blank-example.js + .d.ts. Implement Adapter.
- `test/`: npm-*.js (mocha+chai), meteor-*.js.
- `*.d.ts`: Generated from JSDoc in `index.js` + adapters via `tsc --emitDeclarationOnly` on `prepublishOnly`. Do not edit manually.
- `docs/adapter-api.md`: full adapter contract.
- `.claude/skills/josk/`: Claude Code skill source — `SKILL.md` + `references/{api,adapters,patterns,meteor,troubleshooting}.md`. Distributable artifact: `.claude/skills/josk.skill` (zip). Install: `nxp skills add .claude/skills/josk.skill`. Keep in sync with public API: when adding/changing options, methods, adapter constructors, execution semantics, or migration notes, update the matching reference file and re-package.
- README.md, CHANGELOG.md, package.json (exports map, types, prepublishOnly now includes tsc).

## Code Style
- **Indentation:** 2 spaces.
- Use **single quotes** for strings.
- **Prefer simple ES classes** for cohesive state/services when they clarify lifecycle (e.g. a small data service with start/stop).
- Use **small pure functions** for transforms, formatting, and validation.
- **Performance**: favor O(n) single passes, avoid repeated work and heavy loops, cache derived values when dependencies are narrow.
- Always end line with semicolon `;`.
- Prefer `void 0` to `undefined` where applicable, like `return void 0`.
- Prefer functions defined as variable to "named functions" where applicable.

### JS Style Example

```js
const string = 'string value';
const object = {
  key: string,
};

const complexObject = {
  key: string,
  array: ['one', 'two', 'three'],
  date: new Date(),
  timestamp: Date.now(),
  arrayWithObjects: [{
    key: {
      keyLevel2: false,
    },
    key2: {
      array: [{
        keyLevel3: true,
      }]
    }
  }, {
    keySecondObject: {
      keyLevel2: true,
      otherKeyLevel2: 'string - lorem ipsium',
    }
  }],
};

const sayName = (name) => {
  if (!name) {
    return void 0;
  }

  return `Your name is ${name}`;
};
```

## Standards
- ESM primary. JSDoc on public API.
- Strict validation in ctors. Throw on missing adapter/client/db.
- Private: __ prefix. Use joskInstance.__errorHandler, __execute.
- Terse. No obvious comments. Exact adapter API compliance.
- Update: README (examples/prereqs), all .d.ts, tests, CHANGELOG.md, package version on change.
- Errors: onError hook preferred over throw. ready() or returned Promise controls completion.
- TS: JSDoc in source drives declarations. Adapter required in JoSkOption. Run `npm run prepublishOnly` after changes to `index.js`/adapters.
- Never edit `index.cjs` or any `.d.ts`. Always edit source, regenerate before publish.
- Follow terse response rule: drop articles/fillers. [subject] [verb] [reason]. [next].

## Testing
```sh
# Full (Redis+Mongo+PG)
REDIS_URL=redis://127.0.0.1:6379 MONGO_URL=mongodb://127.0.0.1:27017/test PG_URL=postgres://... npm test
npm run test:redis
npm run test:mongo
npm run test:postgres
npm run test:jest
npm run test:types
npm run test:coverage
```
- ~3-6min. Requires running DBs.
- Cover: set*/clear*, zombie (zombieTime), onError/onExecuted, autoClear, destroy mid-run, CRON helper, promise vs cb ready(), malformed, short delays, concurrent.
- Add test for any change. Target 99%+.

## Guidelines
- Read adapter-api.md + existing adapters + tests before edit.
- New adapter: copy blank-example, add .d.ts, test/*.js, update README/index.js/TS/CHANGELOG.
- Bug: reproduce in test. Fix + regression test.
- Feature: update docs/TS/tests first. Maintain 2s min interval, jitter note.
- Weak points: precision (±256ms+), no <2s tasks. Document. No ultra-precision.
- PR: full test suite, lint clean, update CHANGELOG.
- Use MongoDB skills only on query/index/schema. PG similar. Frontend skill never. Always read files first.

## Edit rules and flow
- Introduce changes, validate, run tests.
- Update TS definitions if absolutely necessary after introduced changes.
- Update documentation if necessary adding new features or changing old ones.
- In case of major updates — Add migration instructions to package documentation.

Update this AGENTS.md on major refactors.
