# JoSk API

```js
import { JoSk, RedisAdapter, MongoAdapter, PostgresAdapter } from 'josk';
```

ESM and CJS. Server-only.

## `new JoSk(opts)`

Starts polling from the constructor; there is no `start()`.

| Option | Type | Default | Notes |
|---|---|---|---|
| `adapter` | `JoSkAdapter` | required | `RedisAdapter`, `MongoAdapter`, `PostgresAdapter`, or a custom adapter. Throws if absent or missing `acquireLock`, `releaseLock`, `remove`, `add`, `update`, `iterate`, or `ping`. |
| `onError` | `(title, details) => void` | none | Runtime errors and "task is missing" notices. Without it, errors go to `console.error`. Wire it. |
| `onExecuted` | `(uid, details) => void` | none | Called after every completed run, including runs that threw. Not a success signal. |
| `zombieTime` | ms | `900000` (15 min) | An interval whose handler has not called `ready()` within this time is claimable again. Set above the slowest handler plus margin; not below `60000`. |
| `concurrency` | integer or `Infinity` | `Infinity` | Max handlers running at once in this process. Throws on other values. |
| `execute` | `'batch'` or `'one'` | `'batch'` | `batch` claims every due task per poll (throughput). `one` claims one task per poll (fairer spread across instances). |
| `autoClear` | boolean | `false` | Delete stored tasks that have no handler in this process. Only when every instance runs the same code. |
| `lockLeaseTime` | ms | `min(zombieTime, 30000)` | TTL of the per-poll scheduler lease. Raised to at least `2 * maxRevolvingDelay + 1000`. Throws if not a positive finite number. |
| `minRevolvingDelay` / `maxRevolvingDelay` | ms | `128` / `768` | Random poll interval bounds. Lower for tighter timing, higher for fewer storage reads. |
| `lockOwnerId` | string | `'josk-<uuid>'` | Prefix of lease ids, for observability only. |
| `debug` | boolean | `false` | `console.info` diagnostics. |

### Hooks

Hooks may return a Promise; JoSk does not await them, and their errors are isolated.

`onError(title, { description, error, uid, task? })`: `uid` is the internal timer id (with the `setInterval` / `setTimeout` / `setImmediate` suffix) or `null`; `error` may be `null` for notices such as `'One of your tasks is missing'`.

`onExecuted(uid, { uid, date, delay, timestamp })`: the first `uid` is the one passed to `set*`; `details.uid` is the internal timer id, usable with `clear*`.

## Methods

### `setInterval(handler, delay, uid)` → `Promise<string>`

Recurring task; resolves the timer id (`uid` + `'setInterval'`). At-least-once per tick: the stored task stays while it runs, and a handler that does not finish within `zombieTime` is re-claimed and runs again. Make handlers idempotent.

Re-registration on boot keeps a stored task's schedule when `delay` is unchanged, so restarts do not postpone it. A task another instance is running keeps its claim. Call `clearInterval()` first to reset the countdown.

### `setTimeout(handler, delay, uid)` → `Promise<string>`

One-shot after `delay` ms; timer id is `uid` + `'setTimeout'`. At-most-once: the task is removed from storage before the handler runs, so a crash during the run loses it.

### `setImmediate(handler, uid)` → `Promise<string>`

One-shot on the next poll; timer id is `uid` + `'setImmediate'`. Same guarantee as `setTimeout`.

### `clearInterval(timerId)` / `clearTimeout(timerId)` → `Promise<boolean>`

Accept the string from `set*` or the pending Promise. Both remove any timer id, including `setImmediate` ones. `true` when the stored task was removed, `false` when it was already gone.

### `destroy()` → `boolean`

Stops polling; `true` the first time, `false` after. Does not wait for running handlers: a running interval keeps its claim until `zombieTime`. Afterwards `set*` resolve `''` and notify `onError`; `pause` / `resume` return `false`; `clear*` and `ping` still work. Prefer `shutdown()` on exit.

### `shutdown({ timeout? })` → `Promise<boolean>`

Calls `destroy()`, waits up to `timeout` ms (default `10000`) for running handlers, then hands unfinished interval claims back to storage so a peer runs them on its next poll instead of after `zombieTime`. One-shots are not handed back (at-most-once). Resolves `true` when every handler finished in time; unfinished ones are reported to `onError`. Repeated calls share the first attempt. Keep `timeout` below the platform grace period (Kubernetes default 30 s) with a few seconds of headroom for the final writes.

### `ping()` → `Promise<{ status, code, statusCode, error? }>`

Healthcheck. `200 'OK'`, `500 'Internal Server Error'` with `error` (storage unreachable or adapter initialisation failing), `503` from `MongoAdapter` on an unexpected reply. Never rejects with built-in adapters.

### `pause(timerId?)` / `resume(timerId?)` → `boolean`

Per process, for multi-instance setups with long handlers. `pause()` stops this instance from taking the scheduler lease; running handlers continue and peers keep working. `pause(timerId)` makes this instance hand that task back due in 2 s whenever it claims it, so a peer runs it. `resume()` / `resume(timerId)` clear the pause and poll immediately. `timerId` is the string returned by `set*`; a bare `uid` throws. Both return `false` when nothing changed or the instance is destroyed. Recipes: [patterns.md](patterns.md).

## Handler shape

`(ready?) => void | Promise<unknown>`:

1. Async or Promise-returning: JoSk awaits it and calls `ready()` for you. Thrown errors go to `onError`.
2. Sync with zero declared parameters: `ready()` is called after it returns.
3. Callback style `(ready) => { ... ready(); }`: you call `ready()` once, on every path including errors. A handler that declares `ready` and never calls it looks stuck until `zombieTime`.

`ready(next?)` returns `Promise<boolean>` (resolved after the storage write):

- `ready()`: next run at `now + delay`.
- `ready(date)` or `ready(timestampMs)`: next run at that moment (intervals only). A past value falls back to `now + delay`. Used for CRON.
- `ready(callback)`: Node-style `(error, success)`, called before the write.
- A second call rejects (or calls the callback) with `Resolution method is overspecified`.

## Rejections

`set*` are async and never throw synchronously. They reject when the handler is not a function, `delay` is not a finite number >= 0, or `uid` is not a string. A fractional `delay` is rounded to whole milliseconds.

They also reject while adapter initialisation is failing (Mongo index setup, Postgres schema migration, Redis reset with `resetOnInit`). JoSk retries initialisation at most every 5 s; repeat the rejected call once `ping()` returns 200.

## Types

`JoSkOption`, `JoSkShutdownOption`, `JoSkExecuteMode`, `JoSkPingResult`, `JoSkTaskHandler`, `JoSkReady`, `JoSkReadyCallback`, `JoSkOnError`, `JoSkOnExecuted`, `JoSkErrorDetails`, `JoSkExecutedDetails`, `JoSkAdapter`, `JoSkLock`, `JoSkTask`, `RedisAdapterOption`, `MongoAdapterOption`, `PostgresAdapterOption`, `RedisClientLike`, `MongoDbLike`, `PostgresClient`. Definitions: `node_modules/josk/index.d.ts`. `adapter.client` / `adapter.db` keep the driver's own type.
