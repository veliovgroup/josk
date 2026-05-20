# JoSk patterns & recipes

Working code for the situations users hit most often. Each pattern shows the canonical solution, the failure mode it avoids, and any tuning knob worth knowing.

## CRON schedules via `cron-parser`

JoSk does not parse CRON expressions itself. The recommended pairing is the `cron-parser` package — v5 renamed the entrypoint to `CronExpressionParser.parse()`.

```js
import { JoSk, RedisAdapter } from 'josk';
import { CronExpressionParser } from 'cron-parser';
import { createClient } from 'redis';

const jobsCron = new JoSk({
  adapter: new RedisAdapter({
    client: await createClient({ url: 'redis://127.0.0.1:6379' }).connect(),
    prefix: 'cron-scheduler',
  }),
  // CRON resolves to seconds; relax revolving delays for fewer storage reads.
  minRevolvingDelay: 512,
  maxRevolvingDelay: 1000,
});

const setCron = async (uniqueName, cronExpr, task) => {
  const next = CronExpressionParser.parse(cronExpr).next().toDate();
  // Guard against clock skew: the parsed "next" can land in the recent past.
  const initialDelay = Math.max(0, +next - Date.now());

  return jobsCron.setInterval((ready) => {
    const upcoming = CronExpressionParser.parse(cronExpr).next().toDate();
    ready(upcoming);     // schedule the *next* tick at the parsed CRON time
    task();              // and run the user's work
  }, initialDelay, uniqueName);
};

await setCron('hourly-report', '0 * * * *', () => {
  console.log('top of the hour', new Date());
});
```

**Why this shape:** `setInterval` reschedules itself to `now + delay` by default. CRON ticks are not uniform (e.g. `0 0 * * MON-FRI`). Calling `ready(nextDate)` overrides the default and pins the next tick to the parsed CRON time.

If you only need the first scheduling to honor CRON and re-runs at a fixed interval, just compute the initial `delay` and skip the `ready(date)` recompute.

## Handler styles — pick the simplest one that fits

### Async / Promise (preferred)

```js
jobs.setInterval(async () => {
  await drainEmailQueue();         // throws bubble to onError
}, 60_000, 'email-queue-1m');
```

JoSk awaits the returned Promise and auto-calls `ready()`. Errors are caught and routed to `onError` (or `console.error` if no hook).

### Sync, no-arg

```js
jobs.setInterval(() => {
  recordHeartbeat();
}, 30_000, 'heartbeat-30s');
```

When the function declares **zero parameters** (`func.length === 0`), JoSk auto-calls `ready()` after it returns. No need to thread the callback.

### Callback style

Required when async work completes after the function returns and is not Promise-shaped.

```js
jobs.setInterval((ready) => {
  legacyApi.fetch((err, data) => {
    if (err) {
      ready();                     // ALWAYS call ready() — even on error
      return;
    }
    process(data);
    ready();                       // end of full execution
  });
}, 60_000, 'legacy-1m');
```

If you forget `ready()`, the task will appear stuck for `zombieTime`, then be re-claimed and may run again.

### Mixing async/await with callback APIs

`process.nextTick` (or a wrapping async IIFE) lets you keep callback APIs while gaining `await` ergonomics:

```js
jobs.setInterval((ready) => {
  process.nextTick(async () => {
    try {
      const result = await asyncCall();
      waitForSomethingElse(async (err, data) => {
        if (err) { ready(); return; }
        await saveCollectedData(result, [data]);
        ready();
      });
    } catch (err) {
      console.error(err);
      ready();                     // always call ready() on the error path too
    }
  });
}, 60 * 60_000, 'long-1h');
```

## Dynamic next-tick scheduling

`ready(nextExecuteAt)` on an interval handler reschedules just that next run. Use this for:

- CRON (above).
- Adaptive backoff — slow polling when there's no work, fast polling when there is.
- Workdays-only schedules — skip to "next 9am Mon–Fri".

```js
jobs.setInterval(async (ready) => {
  const found = await pickUpJob();
  if (found) {
    ready();                       // default: now + delay (fast)
  } else {
    ready(new Date(Date.now() + 5 * 60_000)); // empty queue → wait 5 min
  }
}, 5_000, 'queue-poller');
```

Note: `ready` accepts a `Date` or a numeric unix-ms timestamp `≥ Date.now()`. Past dates fall back to `now + delay`.

## Passing arguments to a task

Tasks can't take arbitrary arguments — JoSk calls them with just `ready`. Close over arguments in a wrapper:

```js
const task = (arg1, arg2, ready) => {
  // … real work …
  ready();
};

jobs.setInterval((ready) => {
  task(myVar, myLet, ready);
}, 60 * 60_000, 'taskA');

jobs.setInterval((ready) => {
  task({ otherKey: 'val' }, 'other-string', ready);
}, 60 * 60_000, 'taskB');
```

Each `uid` is independent — different closures with the same body are perfectly fine.

## Concurrency

Default is `Infinity` — every due handler runs in parallel. Cap when handlers contend on a shared resource:

```js
const jobs = new JoSk({
  adapter,
  concurrency: 4,                  // at most 4 handlers run at the same time
});
```

Throws on the constructor if `concurrency` isn't a positive integer or `Infinity`. Use a finite cap when:

- All handlers share a DB connection pool with a finite size.
- Handlers call a rate-limited external API.
- Each handler uses significant CPU or memory.

Per-instance — not per-cluster. If you need cluster-wide rate limiting, that lives in your handler logic, not in `concurrency`.

## Instance backpressure (`pause` / `resume`)

**When it applies:** Only in a **multi-instance** deployment (cluster, PM2, Kubernetes, multiple servers) where another JoSk peer can take over while this process is busy. On a **single instance**, `pause()` only stops your own revolving loop — there is no peer to pick up work, so it is usually unnecessary.

Use for **long-running** handler work (large batches, slow APIs, heavy CPU) that must **not** hold the JoSk tick open until finished. Short handlers should finish normally (or call `ready()` early) without pause/resume.

When this process is saturated (long handlers, GC pressure, batch imports), stop competing so peers claim due work:

```js
app.on('load-shed', () => jobs.pause());
app.on('load-ok', () => jobs.resume());

// or per heavy task on this pod only (use set* return value):
const reindex = await jobs.setInterval(runReindex, 3600_000, 'reindex-all');
jobs.pause(reindex);
// later:
jobs.resume(reindex);
```

- Does not cancel in-flight handlers.
- Does not remove tasks from storage.
- Per-task `pause(timerId)` reschedules claims this instance already won; use `execute: 'one'` if this instance still grabs too many tasks per lease.

### Queue claim + fast `ready()` (inside the `set*` handler)

Call `pause()` / `resume()` (global) or `pause(timerId)` / `resume(timerId)` **inside** the function passed to `setInterval` / `setTimeout` / `setImmediate` — after you have claimed work from your own queue, **before** `ready()` or before the handler returns. JoSk releases the cluster tick quickly; this instance stops competing until heavy work on **this** process is done.

Typical flow:

1. This JoSk instance wins the scheduled tick and enters the handler.
2. Pull / lock records from a 3rd-party queue (delete, flag busy, etc.).
3. `pause()` or `pause(timerId)`, then `await ready()` (callback style) or `return` after branching async work (Promise style — see below).
4. Run the long job on this instance (or in a detached branch).
5. When that work truly finishes on this instance, `resume()` or `resume(timerId)` in `finally`.

Use the **`timerId`** returned from `set*` for per-task pause (store it in closure — the handler does not receive it as an argument).

**Global pause** — this instance yields **all** scheduler competition while the batch runs:

```js
const timerId = await jobs.setInterval(async (ready) => {
  const batch = await thirdPartyQueue.claim(50);
  if (batch.length === 0) {
    await ready();
    return;
  }

  jobs.pause();
  await ready(); // release JoSk claim; next interval tick can be claimed elsewhere

  try {
    await processBatch(batch);
  } finally {
    jobs.resume();
  }
}, 5000, 'queue-poller');
```

**Per-task pause** — same pattern, but only this timer id is deferred on reclaim; other tasks on this instance keep competing:

```js
const timerId = await jobs.setInterval(async (ready) => {
  const batch = await thirdPartyQueue.claim(50);
  if (batch.length === 0) {
    await ready();
    return;
  }

  jobs.pause(timerId);
  await ready();

  try {
    await processBatch(batch);
  } finally {
    jobs.resume(timerId);
  }
}, 5000, 'queue-poller');
```

**Promise handler without `ready` in the signature** — call `ready()` explicitly before starting fire-and-forget work; otherwise JoSk auto-`ready()` when the returned Promise resolves (too early):

```js
const timerId = await jobs.setInterval(async (ready) => {
  const batch = await thirdPartyQueue.claim(50);
  if (batch.length === 0) {
    return;
  }

  jobs.pause(timerId);
  await ready();

  try {
    await processBatch(batch);
  } finally {
    jobs.resume(timerId);
  }
}, 5000, 'queue-poller');
```

**Branch off without awaiting** (work continues after handler returns) — still call `ready()` before the branch so the storage row is updated; always `resume()` in the branch `finally`:

```js
const timerId = await jobs.setInterval((ready) => {
  thirdPartyQueue.claim(50, (err, batch) => {
    if (err || !batch.length) {
      ready();
      return;
    }

    jobs.pause(timerId);
    ready();

    processBatch(batch, () => {
      jobs.resume(timerId);
    });
  });
}, 5000, 'queue-poller');
```

Guard `resume()` with `try/finally` so a failed batch does not leave the instance paused. If the process crashes after `pause()` and before `resume()`, competition stays off until restart — persist load state or call `resume()` on startup if needed.

## `execute: 'batch'` vs `'one'`

- `'batch'` (default): under one lease, drain all currently due tasks. Best throughput, fewest storage round-trips.
- `'one'`: claim one task per lease. Smaller bursts, tighter fairness across instances, useful when handlers contend on the same downstream resource and you want different instances to interleave.

Most apps want `'batch'`. Switch to `'one'` only with a reason.

## `autoClear: true` — when

A task is "missing" if it's present in storage but not in this instance's in-memory `tasks` map. This happens when:

- The codebase changed and the task is no longer registered.
- A previous deploy left orphan rows behind.
- A different app version is running against the same prefix.

`autoClear: true` removes those rows automatically. Use it during development and on apps where you're sure orphan = obsolete. Leave it `false` (default) when multiple app versions intentionally share a prefix and you don't want each to delete the others' tasks — instead handle the `'One of your tasks is missing'` message from `onError`.

## `onError` — the minimum viable hook

```js
const jobs = new JoSk({
  adapter,
  onError(reason, details) {
    // reason: short title, e.g. 'Exception during task execution'
    // details: { description, error, uid, task? }
    logger.error('[josk]', reason, {
      uid: details.uid,
      err: details.error,
      desc: details.description,
    });
  },
});
```

Without this hook, exceptions inside handlers go to `console.error` and "missing task" notices go to debug logs. In production-grade apps, route them to your real logger.

## Graceful shutdown

```js
const jobs = new JoSk({ /* … */ });

const shutdown = async () => {
  jobs.destroy();                  // stop the revolving timer
  // any of your own cleanup
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGHUP', shutdown);
process.on('uncaughtException', (err) => {
  console.error(err);
  shutdown().catch(() => process.exit(1));
});
```

`destroy()` is idempotent. After it, only `clearInterval` / `clearTimeout` remain useful — other methods send a "destroyed" notice through `onError`. Tasks held by this instance keep their lease until it expires (`zombieTime`); other live JoSk instances pick them up.

For tests, `await jobs.destroy()` is unnecessary (it's sync), but **always** call it, and close the underlying Redis / Mongo / pg client afterwards.

## Healthcheck endpoint

```js
app.get('/health/josk', async (_req, res) => {
  const r = await jobs.ping();
  res.status(r.code).json(r);
});
```

`ping()` returns `{ status, code, statusCode }` plus an optional `error`. Code is `200` on success, `500` on adapter failure.

## Adjusting timing accuracy

The effective tick happens at `delay + uniform(minRevolvingDelay, maxRevolvingDelay) + storage round-trip`. Defaults (`128`, `768`) give roughly ±0.8s + storage latency.

- **Tighten timing** at the cost of more storage I/O: lower `maxRevolvingDelay` (e.g. `256`).
- **Reduce storage load** at the cost of jitter: raise `minRevolvingDelay` / `maxRevolvingDelay`.

For sub-2-second tasks the storage round-trip dominates — JoSk recommends ≥2s intervals for predictable spacing.

## Bun runtime

JoSk runs unmodified on Bun ≥ 1.1.0. Install with `bun add josk`. The same `RedisAdapter` / `MongoAdapter` / `PostgresAdapter` and the same drivers work. Schedulers running across mixed Node and Bun processes coexist under the same `prefix` — claim and lease are storage-level operations, runtime-agnostic.

`bun build --compile` bundles JoSk like any ESM library.

## TypeScript

JoSk ships type declarations for both ESM (`index.d.ts`) and CJS (`index.d.cts`). All the public-API types are exported (see `api.md`):

```ts
import { JoSk, RedisAdapter } from 'josk';
import type { JoSkAdapter, JoSkOption, JoSkOnError } from 'josk';
import { createClient } from 'redis';

const onError: JoSkOnError = async (title, details) => {
  console.error(title, details.error, details.uid);
};

const adapter: JoSkAdapter = new RedisAdapter({
  client: await createClient({ url: process.env.REDIS_URL }).connect(),
  prefix: 'cluster-scheduler',
});

const options: JoSkOption = {
  adapter,
  execute: 'batch',
  concurrency: 16,
  onError,
};

const jobs = new JoSk(options);
```

`JoSkAdapter` is exported specifically so custom adapters can be checked against the public contract at compile time.
