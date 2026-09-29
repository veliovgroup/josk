# JoSk 3.x–5.x (legacy, Node 14.20+ / 16)

Read this file instead of `api.md` / `patterns.md` when `package.json` pins `josk` below `6.0.0` or the runtime is Node < 14.21.3. `5.0.0` is the last release that declares Node 14.20+; `6.0.0` to `6.4.0` declared Node ≥ 20.9, and `6.4.1` and later declare Node ≥ 14.21.3 / Bun ≥ 1.1. `mail-time@3.x` depends on `josk@^5` — its scheduler side is described here.

## Version ladder

| josk | Node | Construction | Notes |
|---|---|---|---|
| 3.x / 4.x | ≥ 14.20 | `new JoSk({ db, prefix })` | Mongo built in, no adapter classes |
| **5.0.0** | ≥ 14.20 | `new JoSk({ adapter: new MongoAdapter({ db }) })` | `MongoAdapter`, `RedisAdapter` — **last Node 16 release** |
| 6.0.0 to 6.4.0 | ≥ 20.9 (declared) | same | everything the rest of this skill describes |
| 6.4.1+ | ≥ 14.21.3 | same | same; tested on Node 14.21.3 and 16.20.2 with MongoDB |

## What 5.x does NOT have

Do not write any of these against 5.x — they are `undefined` and throw at runtime:

- Exports: `PostgresAdapter`. Only `JoSk`, `MongoAdapter`, `RedisAdapter` exist.
- Methods: `pause()`, `resume()`. Only `setInterval`, `setTimeout`, `setImmediate`, `clearInterval`, `clearTimeout`, `destroy`, `ping`.
- Options: `concurrency`, `execute`, `lockLeaseTime`, `useHashTags`, `resetOnInit` on `JoSk` itself (it is an **adapter** option).
- Semantics: no lease ownership check on release (any instance can release the prefix lock), no auto-`ready()` for sync zero-arg handlers, no per-task concurrency cap — every due task runs in parallel on the lease winner.

## Exports and constructor

```js
const { JoSk, MongoAdapter, RedisAdapter } = require('josk'); // CJS
// import { JoSk, MongoAdapter, RedisAdapter } from 'josk';   // ESM
```

| `JoSk` option | Default | Notes |
|---|---|---|
| `adapter` | required | instance with `acquireLock, releaseLock, remove, add, update, iterate, ping` |
| `zombieTime` | `900000` (15 min) | a claimed task older than this is re-claimed; keep ≥ slowest handler + margin |
| `minRevolvingDelay` / `maxRevolvingDelay` | `128` / `768` ms | random tick jitter between storage scans |
| `onError(title, { description, error, uid })` | none | wire it — without it errors go to `debug` output only |
| `onExecuted(uid, { uid, date, delay, timestamp })` | none | |
| `autoClear` | `false` | remove tasks found in storage but not registered in this process |
| `debug` | `false` | |

| Adapter option | `MongoAdapter` | `RedisAdapter` |
|---|---|---|
| store | `db` (connected `Db`, official driver) | `client` (connected `redis@4` client) |
| `prefix` | `''` → collection `__JobTasks__` (v6 changed the default to `'default'` → `__JobTasks__default`) | `''` |
| `lockCollectionName` | `'__JobTasks__.lock'` | same, as a key namespace |
| `resetOnInit` | `false` | `false` — when `true`, clears every stored task of this prefix at boot; never in a rolling deploy |

Methods: `setInterval(fn, delayMs, uid)`, `setTimeout(fn, delayMs, uid)`, `setImmediate(fn, uid)` → `Promise<string>`; `clearInterval(id)` / `clearTimeout(id)` accept the string or the pending Promise; `destroy()` is synchronous and stops the tick; `ping()` → `Promise<{ status }>`.

## Handler contract in 5.x

```js
jobs.setInterval(async () => { await work(); }, 60_000, 'poll-1m');       // Promise → ready() called for you
jobs.setInterval((ready) => { work(() => ready()); }, 60_000, 'poll-cb'); // callback style → you call ready()
jobs.setInterval(() => { work(); }, 60_000, 'poll-sync');                 // WRONG in 5.x: never rescheduled
```

The handler always receives `ready`. If it returns a Promise, JoSk awaits it and calls `ready()` itself. If it returns anything else, JoSk returns without calling `ready()` — a sync handler that neither returns a Promise nor calls `ready` leaves the interval task claimed until `zombieTime` (15 min by default) rescues it. Calling `ready()` twice, or returning a Promise and also calling it, throws `Resolution method is overspecified`. `ready(date | timestamp)` reschedules an interval task to that moment instead of `now + delay`.

## Rules specific to 5.x

- **Throttle inside the handler.** There is no `concurrency`; if a task must not overlap with itself, keep the work idempotent and short, or guard with your own flag.
- **Stopping for a deploy** is `destroy()` on the instance and a normal process exit; other instances keep the prefix running. There is no `pause()`.
- **Do not default the prefix by omission across a v5 → v6 upgrade.** v5 `''` and v6 `'default'` are different collections; pass `prefix: ''` explicitly if the data must survive.
- **Redis 4→5 key layout.** 5.0.0 stores tasks in a sorted set `josk:<prefix>:schedule` plus hash `josk:<prefix>:tasks`; 4.x `josk:<prefix>:task:*` keys are only cleaned by a one-time boot with `resetOnInit: true` (stop every instance first).
- `onError` receives a **title string first**, then the details object — the opposite of most Node error callbacks.

## Example — CJS Node 16, legacy empty prefix

```js
const { JoSk, MongoAdapter } = require('josk');

const jobs = new JoSk({
  adapter: new MongoAdapter({ db, prefix: '' }), // keeps the __JobTasks__ collection
  zombieTime: 120_000,
  onError(title, { error, uid }) { log('[josk]', title, uid, error); },
});

jobs.setInterval(async () => { await pollQueue(); }, 60_000, 'poll-1m');
jobs.setTimeout(async () => { await sendFollowUp(); }, 5 * 60_000, 'follow-up-once');

process.on('SIGTERM', () => { jobs.destroy(); });
```
