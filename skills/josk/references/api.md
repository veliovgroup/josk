# JoSk public API reference

Every public surface of the `josk` NPM package, with options, return shapes, and the subtle behaviors that aren't obvious from the type signatures. Pair this with `adapters.md` for adapter-specific options.

## Imports

```js
// ESM (Node ≥20.9.0, Bun ≥1.1.0)
import {
  JoSk,
  RedisAdapter,
  MongoAdapter,
  PostgresAdapter,
} from 'josk';

// CommonJS
const {
  JoSk,
  RedisAdapter,
  MongoAdapter,
  PostgresAdapter,
} = require('josk');

// TypeScript — interfaces and hook types exported
import type {
  JoSkAdapter,
  JoSkOption,
  JoSkOnError,
  JoSkOnExecuted,
  JoSkPingResult,
  JoSkExecuteMode,
  JoSkLock,
  JoSkTask,
  JoSkErrorDetails,
  JoSkExecutedDetails,
  JoSkReady,
  JoSkTaskHandler,
} from 'josk';
```

`josk` is server-only and ships with ESM (`index.js` + `index.d.ts`) and CJS (`index.cjs` + `index.d.cts`) entrypoints.

## `new JoSk(opts)`

Constructs and immediately starts the scheduler. The first revolving tick is scheduled inside the constructor — there is no separate `start()`.

### Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `adapter` | `JoSkAdapter` | — | **Required.** Instance of `RedisAdapter`, `MongoAdapter`, `PostgresAdapter`, or a custom adapter that implements the contract. Throws if absent or not an object. |
| `debug` | `boolean` | `false` | Emit `[DEBUG] [josk] …` logs to `console.info` during development. |
| `onError` | `JoSkOnError` | `false` | Hook called instead of `console.error` for runtime exceptions and "task is missing" notices. `(title, { description, error, uid, task? }) => void \| Promise<void>`. **Strongly recommended.** |
| `onExecuted` | `JoSkOnExecuted` | `false` | Informational hook called after each successful task run. `(uid, { uid, date, delay, timestamp }) => void \| Promise<void>`. The first `uid` argument has the `setInterval`/`setTimeout`/`setImmediate` suffix stripped; the inner one is the internal timer id. |
| `autoClear` | `boolean` | `false` | When a task is found in storage but not in this instance's in-memory `tasks` map, remove it from storage. Useful when running multiple app versions with diverging task lists; risky if processes briefly out-of-sync should not delete each other's work. |
| `zombieTime` | `number` (ms) | `900000` (15 min) | Time after which a held task is re-claimable. Sets the upper bound for handler runtime. Do not go below `60000`. |
| `execute` | `'batch' \| 'one'` | `'batch'` | `batch` drains all currently due tasks under one lease; `one` claims a single task per lease. Throws if any other string. |
| `concurrency` | `number` | `Infinity` | Cap parallel handlers inside this instance. Must be a positive integer or `Infinity`. Throws otherwise. |
| `lockOwnerId` | `string` | `'josk-<uuid>'` | Stable owner id for lease tokens. Useful so the same logical worker re-claims its leases after a planned restart, and for observability (`lockOwnerId` shows up in lease ids). |
| `minRevolvingDelay` | `number` (ms) | `128` | Lower bound of the random poll interval. |
| `maxRevolvingDelay` | `number` (ms) | `768` | Upper bound of the random poll interval. The effective per-tick delay is `delay + uniform(minRevolvingDelay, maxRevolvingDelay) + storage round-trip`. |

### Constructor errors

The constructor throws synchronously for:

- Missing `opts.adapter`
- `opts.execute` outside `{'batch','one'}`
- `opts.concurrency` that's not a positive integer or `Infinity`
- An adapter missing any of `acquireLock`, `releaseLock`, `remove`, `add`, `update`, `iterate`, `ping`

### Instance properties (read-only, mostly for tests)

`debug`, `onError`, `autoClear`, `zombieTime`, `onExecuted`, `isDestroyed`, `minRevolvingDelay`, `maxRevolvingDelay`, `execute`, `lockOwnerId`, `concurrency`, `adapter`.

## Hook signatures

### `onError(title, details)`

| Field | Type | Notes |
|---|---|---|
| `title` | `string` | Short reason, e.g. `'JoSk instance destroyed'`, `'One of your tasks is missing'`, `'Exception during task execution'`, `'[__iterate] runError:'`. |
| `details.description` | `string` | Longer human-readable description. |
| `details.error` | `unknown` | Original error, when applicable. May be `null` for informational notices like "task is missing". |
| `details.uid` | `string \| null` | Internal task id (with `setInterval`/`setTimeout`/`setImmediate` suffix). `null` when the error isn't tied to a specific task. Suitable for `clearInterval` / `clearTimeout`. |
| `details.task` | `unknown` | Present when the offending task object itself was malformed. |

The hook may be async — JoSk doesn't await it.

### `onExecuted(uid, details)`

| Field | Type | Notes |
|---|---|---|
| `uid` (1st arg) | `string` | The user-facing task id with the `setInterval`/`setTimeout`/`setImmediate` suffix stripped (matches what the user passed). |
| `details.uid` | `string` | The internal timer id (with suffix). Use this with `clearInterval` / `clearTimeout`. |
| `details.date` | `Date` | Execution wall-clock time. |
| `details.delay` | `number` | The configured `delay` (interval). |
| `details.timestamp` | `number` | Same as `+details.date`. |

## Methods

### `setInterval(handler, delay, uid)` → `Promise<string>`

Schedules a recurring task. The returned string is the internal timer id (the `uid` with `setInterval` appended). Subsequent calls with the same effective id update or no-op — pick distinct `uid`s for distinct tasks.

- `handler`: `(ready?: JoSkReady) => void | Promise<void>`. See "Handler shape" below.
- `delay`: integer milliseconds. `0` is allowed (run as fast as the storage / revolving delay permits).
- `uid`: app-wide unique string. Required.

**Execution guarantee:** at-least-once per scheduled tick. The storage row for the task stays during execution; if the handler does not signal completion within `zombieTime`, the task is re-claimed and may run again. Make recurring handlers idempotent.

### `setTimeout(handler, delay, uid)` → `Promise<string>`

Schedules a one-shot task after `delay` ms. Returns the internal timer id (`uid` + `setTimeout`).

**Execution guarantee:** at-most-once across the cluster. JoSk **removes the task from storage before invoking the handler**. If the process crashes between removal and handler completion, the run is lost. Use for "this would be worse if duplicated than if skipped" work (charges, one-time sends).

### `setImmediate(handler, uid)` → `Promise<string>`

Schedules a one-shot task to run as soon as the next revolving tick claims it. No delay argument. Internal timer id is `uid` + `setImmediate`.

**Execution guarantee:** exactly-once across the cluster.

### `clearInterval(timerId)` → `Promise<boolean>`

Cancels an interval. Accepts either:

- The string returned by `setInterval`, or
- The `Promise<string>` itself (it awaits it).

Returns `true` if the storage row was removed, `false` if it was already gone. Note: call from a different event-loop turn than the `setInterval` itself when you have a `Promise<string>` — or await the timer id first.

### `clearTimeout(timerId)` → `Promise<boolean>`

Same shape as `clearInterval`, but for `setTimeout`. Returns `true`/`false` symmetrically.

Both clear methods are safe to call after `destroy()` — they're the only public methods that remain usable on a destroyed instance.

### `destroy()` → `boolean`

Stops the internal revolving timer. Returns `true` the first time, `false` on subsequent calls. Does **not** remove tasks from storage — other live JoSk instances pick up the schedule. Methods other than `clearInterval` / `clearTimeout` on a destroyed instance trigger the `onError` hook (or a `_debug` log).

Call this before `process.exit()` for clean shutdown, especially in tests.

### `ping()` → `Promise<JoSkPingResult>`

Healthcheck. Returns `{ status, code, statusCode }` on success (status `'OK'`, code `200`) or `{ status: 'Error reason', code: 500, statusCode: 500, error }` on failure. Pair with the adapter being initialized — `ping` waits for `adapter.ready()` first.

## Handler shape

`JoSkTaskHandler = (ready: JoSkReady) => void | Promise<void>`.

The handler can be:

1. **Async / Promise-returning.** JoSk awaits the returned Promise and auto-calls `ready()` when it resolves. Errors caught by JoSk go to `onError`.
2. **Zero-arg sync.** JoSk auto-calls `ready()` after the function returns (matches the `func.length === 0` shortcut added in v6).
3. **Callback-style.** Declared `(ready) => { … ready(); }`. Required when async work completes after the function returns via callbacks rather than Promises.

`ready` itself is `(nextExecuteAt?: number | Date | JoSkReadyCallback) => Promise<boolean>`:

- Call `ready()` with no args to mark the run complete and reschedule the next tick at `now + delay` (for intervals).
- Call `ready(dateOrMs)` on an interval handler to override the next fire time — this is the hook used for CRON schedules.
- Call `ready(callback)` to receive `(error: Error | undefined, success: boolean)` after the storage write — rarely needed.
- Calling `ready` more than once throws `Resolution method is overspecified`. If a callback was passed, it's invoked with the error instead.

`ready` returns a `Promise<boolean>` that resolves once the storage update has been written. Awaiting it is optional.

## Types (exported)

```ts
type JoSkExecuteMode = 'batch' | 'one';

type JoSkPingResult = {
  status: string;
  code: number;
  statusCode: number;
  error?: unknown;
};

type JoSkLock = {
  ownerId: string;
  leaseId: string;     // includes ownerId prefix + counter + uuid
  expireAt: Date;
  expiresAtMs: number;
};

type JoSkTask = {
  uid: string;         // includes the setInterval/setTimeout/setImmediate suffix
  delay: number;
  isInterval: boolean;
  isDeleted: boolean;
  executeAt?: number | Date;
};

type JoSkErrorDetails = {
  description: string;
  error: unknown;
  uid: string | null;
  task?: unknown;
};

type JoSkExecutedDetails = {
  uid: string;         // internal id with suffix
  date: Date;
  delay: number;
  timestamp: number;
};

type JoSkOnError = (title: string, details: JoSkErrorDetails) => void | Promise<void>;
type JoSkOnExecuted = (uid: string, details: JoSkExecutedDetails) => void | Promise<void>;

type JoSkReadyCallback = (error: Error | undefined, success: boolean) => void;
type JoSkReady = (nextExecuteAt?: number | Date | JoSkReadyCallback) => Promise<boolean>;
type JoSkTaskHandler = (ready: JoSkReady) => void | Promise<void>;

type JoSkOption = {
  adapter: JoSkAdapter;
  debug?: boolean;
  onError?: JoSkOnError;
  autoClear?: boolean;
  zombieTime?: number;
  onExecuted?: JoSkOnExecuted;
  minRevolvingDelay?: number;
  maxRevolvingDelay?: number;
  execute?: JoSkExecuteMode;
  lockOwnerId?: string;
  concurrency?: number;
};

interface JoSkAdapter {
  joskInstance?: JoSk;
  acquireLock(lock: JoSkLock): Promise<boolean>;
  releaseLock(lock: JoSkLock): Promise<void>;
  remove(uid: string): Promise<boolean>;
  add(uid: string, isInterval: boolean, delay: number): Promise<boolean | void>;
  update(task: JoSkTask, nextExecuteAt: Date): Promise<boolean>;
  iterate(nextExecuteAt: Date, lock: JoSkLock, executeMode: JoSkExecuteMode): Promise<number | void>;
  ping(): Promise<JoSkPingResult>;
  ready?(): Promise<void>;
}
```

## Return-value semantics quick-reference

| Call | Resolves to | Notes |
|---|---|---|
| `setInterval` / `setTimeout` / `setImmediate` | `string` timer id | Empty string `''` if called on a destroyed instance. |
| `clearInterval` / `clearTimeout` | `boolean` | `false` if the task was not present. |
| `destroy` | `boolean` | `false` on subsequent calls (idempotent). |
| `ping` | `JoSkPingResult` | `code: 200` on success. |

## Input validation errors (thrown)

| Method | Throws when |
|---|---|
| `setInterval` | first arg is not a function, `delay < 0`, `uid` is not a string |
| `setTimeout` | same as above |
| `setImmediate` | first arg is not a function, `uid` is not a string |

These are thrown synchronously *before* the returned Promise.
