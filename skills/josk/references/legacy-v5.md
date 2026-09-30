# JoSk 3.x to 5.x (legacy)

Read this instead of `api.md` / `patterns.md` when `package.json` pins `josk` below `6.0.0` or the runtime is Node < 14.21.3. `5.0.0` is the last release for Node 14.20 to 14.21.2. `mail-time@3.x` depends on `josk@^5`.

| josk | Node | Construction |
|---|---|---|
| 3.x / 4.x | >= 14.20 | `new JoSk({ adapter: MongoAdapter, db, prefix })` |
| 5.0.0 | >= 14.20 | `new JoSk({ adapter: new MongoAdapter({ db }) })`, also `RedisAdapter` |
| 6.5.0+ | >= 14.21.3 | same; everything else in this skill |

## Not in 5.x

These are `undefined` in 5.x and fail at runtime:

- Exports: `PostgresAdapter`.
- Methods: `pause()`, `resume()`, `shutdown()`.
- Options: `concurrency`, `execute`, `lockLeaseTime`, `useHashTags`.
- Semantics: no lease ownership check on release, no auto-`ready()` for sync zero-arg handlers, no concurrency cap.

## Constructor

```js
const { JoSk, MongoAdapter, RedisAdapter } = require('josk');
```

| `JoSk` option | Default | Notes |
|---|---|---|
| `adapter` | required | adapter instance |
| `zombieTime` | `900000` | claimed task older than this is re-claimed |
| `minRevolvingDelay` / `maxRevolvingDelay` | `128` / `768` | poll jitter in ms |
| `onError(title, { description, error, uid })` | none | without it errors go to `console.error` |
| `onExecuted(uid, { uid, date, delay, timestamp })` | none | |
| `autoClear` | `false` | remove stored tasks without a handler in this process |
| `debug` | `false` | |

| Adapter option | `MongoAdapter` | `RedisAdapter` |
|---|---|---|
| store | `db` (connected `Db`, official driver) | `client` (connected `redis@4` client) |
| `prefix` | `''` (collection `__JobTasks__`) | `'default'` (keys `josk:default:*`) |
| `lockCollectionName` | `'__JobTasks__.lock'` | ignored; lock key is `josk:<prefix>:lock` |
| `resetOnInit` | `false`; `true` deletes one-shot tasks and the lock row of this prefix at boot | `false`; `true` deletes every stored task of this prefix at boot |

Methods: `setInterval(fn, delayMs, uid)`, `setTimeout(fn, delayMs, uid)`, `setImmediate(fn, uid)` resolve the timer id; `clearInterval(id)` / `clearTimeout(id)` accept the string or the pending Promise; `destroy()` is sync; `ping()` resolves `{ status, code, statusCode, error? }`.

## Handlers in 5.x

```js
jobs.setInterval(async () => { await work(); }, 60_000, 'poll-1m');       // Promise: ready() called for you
jobs.setInterval((ready) => { work(() => ready()); }, 60_000, 'poll-cb'); // callback: you call ready()
jobs.setInterval(() => { work(); }, 60_000, 'poll-sync');                 // WRONG in 5.x: stuck until zombieTime
```

A handler that returns neither a Promise nor calls `ready()` leaves the task claimed until `zombieTime`. Calling `ready()` twice, or returning a Promise and also calling it, throws `Resolution method is overspecified`. `ready(date | timestamp)` reschedules an interval to that moment.

## Rules specific to 5.x

- No `concurrency`: keep handlers idempotent and short, or guard overlap yourself.
- Stopping for a deploy is `destroy()` then a normal exit; peers keep the prefix running.
- Upgrading to v6 changes the default Mongo collection (`__JobTasks__` to `__JobTasks__default`; v6 treats `prefix: ''` as `'default'`). Stop every instance and run `db.__JobTasks__.renameCollection('__JobTasks__default')` before starting v6.
- Upgrading to v6 changes the Redis layout: 5.0.0 stores one hash per task at `josk:<prefix>:task:<uid>`; v6 uses `josk:<prefix>:schedule` plus `josk:<prefix>:tasks` and never reads the old keys, so pending 5.x one-shots are not carried over. A one-time v6 boot with `resetOnInit: true` (all instances stopped) removes the old keys.

## Example (CJS, Node 16)

```js
const { JoSk, MongoAdapter } = require('josk');

const jobs = new JoSk({
  adapter: new MongoAdapter({ db }), // collection __JobTasks__
  zombieTime: 120_000,
  onError(title, { error, uid }) { console.error('[josk]', title, uid, error); },
});

jobs.setInterval(async () => { await pollQueue(); }, 60_000, 'poll-1m');
jobs.setTimeout(async () => { await sendFollowUp(); }, 5 * 60_000, 'follow-up-once');

process.on('SIGTERM', () => { jobs.destroy(); });
```
