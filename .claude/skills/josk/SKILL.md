---
name: josk
description: "JoSk task/CRON scheduler for horizontally scaled Node.js and Bun apps — synchronizes scheduled work so each tick runs once across the cluster. Trigger when the user is writing or reviewing recurring jobs, cron-style tasks, `setInterval`/`setTimeout` work, or periodic background jobs (email queues, SMS sends, sync, polling, cleanup) in a multi-instance / cluster / Kubernetes / PM2 / Meteor.js topology, the `josk` NPM package, or the Meteor `ostrio:cron-jobs` Atmosphere package. Also trigger when the user mentions JoSk by name, asks about `RedisAdapter` / `MongoAdapter` / `PostgresAdapter`, talks about exactly-once / at-most-once execution, zombie-task recovery, scheduler leases, `zombieTime` / `execute` / `concurrency`, or compares JoSk to Agenda, Bree, node-cron, Bull, or BullMQ. Covers the full public API (`new JoSk`, `setInterval`, `setTimeout`, `setImmediate`, `clearInterval`, `clearTimeout`, `destroy`, `ping`, the three built-in adapters, and the custom-adapter contract)."
---

# JoSk — distributed task scheduler for Node.js & Bun

JoSk runs one copy of each scheduled task across a cluster of Node.js / Bun processes, even when those processes live on different hosts or data centers. It mimics `setInterval` / `setTimeout` / `setImmediate` from Node's standard library, but the schedule is held in an external store (Redis, MongoDB, or PostgreSQL) and a lease + atomic claim guarantees no two instances run the same tick.

Use this skill when the user is writing, reviewing, debugging, or designing scheduled work and any of the following apply:

- The app runs more than one process / pod / container that shares the same code (cluster, autoscaling group, Meteor scale-out, Kubernetes Deployment, ECS service, PM2 cluster, Cloud Run with min-instances > 1, etc.) and a periodic job must not fan out N×.
- The user is reaching for `setInterval`, `setTimeout`, `node-cron`, `agenda`, `bree`, or `bull` and the deployment is or will become horizontally scaled.
- The user mentions JoSk by name, or any of its adapters / options / error messages (`__JobTasks__`, `josk_tasks`, `josk:{prefix}:schedule`, "task is missing", "zombie", "lease", "ownerId").
- The user is operating a Meteor.js app and using or about to use `ostrio:cron-jobs`.
- The user is choosing between Redis vs MongoDB vs PostgreSQL for scheduler state, or writing a custom adapter.

## Source of truth

The reference files in `references/` capture the full library behavior. Read the file that matches the user's question rather than guessing from memory — JoSk's defaults and semantics have changed between v4, v5, and v6, and the API differs subtly per adapter:

- `references/api.md` — full public-API reference: every constructor option, every method, return shapes, hook signatures, types.
- `references/adapters.md` — Redis / MongoDB / PostgreSQL adapter setup, prerequisites, cluster guidelines, prefix mapping, custom-adapter contract.
- `references/patterns.md` — recipes: `ready()` callback styles, async/await, CRON via `cron-parser`, passing arguments, concurrency, autoClear, graceful shutdown, dynamic next-tick scheduling.
- `references/meteor.md` — Meteor.js integration via the `ostrio:cron-jobs` Atmosphere package.
- `references/troubleshooting.md` — execution semantics, zombie tasks, jitter / accuracy, storage cleanup, monitoring, v4→v5 and v5→v6 migration notes, KeyDB/replica caveats.

Pull these in lazily — if the user only asks "which adapter should I use?", read `adapters.md`, not everything.

## Mental model in one breath

```
new JoSk({ adapter: new <Redis|Mongo|Postgres>Adapter({ ... }), ... })
   .setInterval | setTimeout | setImmediate (handler, [delay], uid)
```

- The **adapter** owns the schedule and the lease lock. Required.
- Each task has an app-wide unique **`uid`** string. Reusing a `uid` overwrites or no-ops; pick stable, descriptive ids (`'email-queue-1m'`, not `'task1'`).
- The **handler** either accepts a `ready` callback, returns a Promise, or is a zero-arg sync function — JoSk auto-completes the trivial cases and waits on Promises. Only call `ready()` yourself when you have callback-style async work that finishes after the function returns.
- Calling `setInterval` / `setTimeout` / `setImmediate` returns a `Promise<string>` timer id. Pass it (or a `Promise<string>`) to `clearInterval` / `clearTimeout` to cancel — the clear methods accept either a string or the original Promise.

## Required scaffolding for any new JoSk integration

When the user is wiring JoSk into an app for the first time, four things need to be in place. If any are missing, name them:

1. **A storage choice** (Redis, MongoDB, PostgreSQL, or a custom adapter). See "Pick the adapter" below.
2. **A connected client** for that storage, created before `new JoSk(...)`. JoSk does not manage the connection.
3. **An `onError` hook** on the `JoSk` constructor (very strongly recommended). Without it, runtime exceptions inside handlers and "task is missing" notices go to `console.error` / `_debug` and are easy to lose. Hook signature: `(title: string, details: { description, error, uid, task? }) => void | Promise<void>`.
4. **A shutdown path** that calls `jobs.destroy()` before the process exits. Required when running tests; strongly recommended for graceful shutdown in production so the running lease releases cleanly. See `references/patterns.md`.

## Pick the adapter

Use this decision order, not "whichever they already have running":

- **PostgreSQL** is the safest default for multi-DC / multi-region setups or when exactly-once across geographies matters. Lock acquisition uses server-side `CURRENT_TIMESTAMP`, so it tolerates client-clock skew, and `FOR UPDATE SKIP LOCKED` gives clean claims. Use `pg.Pool`. Recommend Postgres if the user mentions clock skew, multi-region, or "exactly-once" with strict guarantees.
- **Redis** (or KeyDB / Valkey) is the fastest for high-frequency scheduling and is the default in single-region single-writer topologies. The adapter uses a sorted set + hash + Lua scripts. Reject active-active / multi-master Redis topologies for exactly-once correctness — flag it for the user if they describe one.
- **MongoDB** is the most convenient when the app already runs Mongo (especially Meteor.js, where `MongoInternals.defaultRemoteCollectionDriver().mongo.db` is one line away). Tested **only** against the official `mongodb` driver — do not recommend Mongoose's client, DocumentDB, or CosmosDB without warning the user that adapter behavior is unverified there.

Once chosen, read `references/adapters.md` for the constructor shape, prerequisite NPM package (`redis` / `mongodb` / `pg`), and per-adapter caveats (KeyDB hash-tag routing, Mongo lock-collection naming, Postgres migration DDL window).

## Pick the right scheduling method

Three methods, three different guarantees. The right one is determined by what the user can tolerate if a process dies mid-handler:

| Method | Guarantee across the cluster | Use when |
|---|---|---|
| `setInterval(fn, delayMs, uid)` | At-least-once per tick (retries via `zombieTime`) | Idempotent recurring jobs — polling, sync, cleanup, email queue drain. The handler must be safe to run twice. |
| `setTimeout(fn, delayMs, uid)` | At-most-once across the cluster | One-shot deferred work where a duplicate would be worse than a miss (charging a card, sending a one-time notice). The task is removed *before* the handler runs. |
| `setImmediate(fn, uid)` | Exactly-once across the cluster | One-shot fire-now work that must happen on exactly one node (kicking off a migration, claiming a leader role). |

If the user is unsure: ask whether duplicate executions or missed executions are worse for that specific task, and map to the table.

`zombieTime` (default 15 minutes) is the deadline for `setInterval` handlers to call `ready()` / resolve their Promise before the task is re-claimed as a "zombie". Keep it above the slowest legitimate handler runtime plus a safety margin. Don't go below 60s.

## Picking `execute` and `concurrency`

These two options control throughput inside a single JoSk instance. Their defaults are usually correct; tune deliberately.

- `execute: 'batch'` (default) drains all currently due tasks under one storage lease — best throughput, fewest round-trips.
- `execute: 'one'` claims one task per lease — smaller bursts, tighter fairness across instances, useful when handlers contend on a shared downstream resource.
- `concurrency: Infinity` (default) matches Node's `setInterval` semantics: every handler that comes due runs in parallel.
- `concurrency: <integer>` caps parallel handlers inside the instance. Use this when handlers share a connection pool, hit a rate-limited API, or each consume significant CPU/memory.

## Handler shape — what to write

The handler is the function the user passes to `setInterval` / `setTimeout` / `setImmediate`. JoSk supports three styles and auto-completes the ones that don't need explicit signaling:

```js
// 1) async / Promise-returning — preferred. JoSk awaits and auto-calls ready().
jobs.setInterval(async () => {
  await drainEmailQueue();
}, 60_000, 'email-queue-1m');

// 2) sync, no-arg — JoSk auto-calls ready() after the function returns.
jobs.setInterval(() => {
  cheapWork();
}, 60_000, 'sync-1m');

// 3) callback style — declare `ready`, call it when done. Required for
//    callback-API work that completes after the function returns.
jobs.setInterval((ready) => {
  legacyApi.fetch((err, data) => {
    if (err) { ready(); return; }      // always call ready(), even on error
    process(data);
    ready();
  });
}, 60_000, 'legacy-cb-1m');
```

Subtle points the user will hit:

- **Call `ready()` exactly once per execution.** Calling it twice throws (or invokes the optional ready-completion callback with an error). Don't call it and also `return` a Promise — pick one.
- **Calling `ready(nextDateOrMs)` on an interval reschedules that single next run.** This is how dynamic / CRON schedules work — recompute the next fire time inside the handler and pass it in. See `references/patterns.md` for the CRON recipe with `cron-parser@^5`.
- **`ready()` returns `Promise<boolean>`.** Awaiting it is rarely needed, but lets you observe whether the storage write succeeded.
- **For long-running handlers, set `zombieTime` higher than the handler's worst-case runtime.** Otherwise another instance will re-claim it and run a second copy.

## The full public API at a glance

Detailed signatures, options, and types live in `references/api.md`. Quick map:

- `new JoSk(opts)` — `opts.adapter` is required; common options: `onError`, `onExecuted`, `autoClear`, `zombieTime`, `execute`, `concurrency`, `lockOwnerId`, `minRevolvingDelay`, `maxRevolvingDelay`, `debug`.
- `jobs.setInterval(fn, delay, uid)` → `Promise<string>` timer id.
- `jobs.setTimeout(fn, delay, uid)` → `Promise<string>` timer id.
- `jobs.setImmediate(fn, uid)` → `Promise<string>` timer id.
- `jobs.clearInterval(timerId)` → `Promise<boolean>` (accepts the string or the original `Promise<string>`).
- `jobs.clearTimeout(timerId)` → `Promise<boolean>` (accepts either form).
- `jobs.destroy()` → `boolean`. Stops the internal poll loop. Idempotent. Only `clearTimeout` / `clearInterval` remain useful afterwards.
- `jobs.ping()` → `Promise<{ status, code, statusCode, error? }>`. Healthcheck for the adapter connection.

Adapter constructors:

- `new RedisAdapter({ client, prefix?, resetOnInit? })` — `client` is an already-connected `redis` client (v4+).
- `new MongoAdapter({ db, prefix?, lockCollectionName?, resetOnInit? })` — `db` is a Mongo `Db` from the official `mongodb` driver.
- `new PostgresAdapter({ client, prefix?, resetOnInit? })` — `client` is a `pg.Pool` (recommended) or `pg.Client`.

Custom adapters implement the `JoSkAdapter` interface (`acquireLock`, `releaseLock`, `remove`, `add`, `update`, `iterate`, `ping`, optional `ready`). The contract is in `references/adapters.md` under "Custom adapter".

## Common red flags to call out

When reviewing or writing code that uses JoSk, flag these proactively:

- **No `onError` hook.** Silent task failures are the most common production gotcha. Suggest adding it.
- **Same `uid` reused for different tasks** (e.g. `'task1'` in two places). Tasks collide in storage. Make `uid` descriptive and unique.
- **Long-running handler with default `zombieTime`.** If the handler can run >15 minutes, raise `zombieTime` or split the work.
- **`resetOnInit: true` in a clustered deployment.** It deletes the current-prefix state on every startup. Fine for dev/test, dangerous in production. Confirm intent.
- **Replica reads / multi-writer Redis / Mongo secondaries.** JoSk must read from the primary and see writes immediately. Read replicas break lease ownership.
- **Tasks shorter than ~2 seconds.** Storage round-trip + revolving delay can overlap. Recommend ≥2s intervals; tighten `minRevolvingDelay` / `maxRevolvingDelay` only if the user accepts more storage I/O.
- **Mongo "Mongo-compatible" stores (CosmosDB, DocumentDB).** The MongoAdapter is tested only against the official driver — call this out before recommending JoSk for those backends.
- **KeyDB active-replication / multi-master.** Conflict resolution can cause duplicate task claims. Recommend a single writable primary.

## Quick install reminder

```sh
npm install josk
# plus exactly one of:
npm install redis          # for RedisAdapter
npm install mongodb        # for MongoAdapter
npm install pg             # for PostgresAdapter
# Bun:
bun add josk
```

Meteor / Atmosphere users: `meteor add ostrio:cron-jobs` — same API, different import path. See `references/meteor.md`.

JoSk requires Node ≥ 14.20.0 or Bun ≥ 1.1.0. It is server-only — never recommend importing it in client/browser code.
