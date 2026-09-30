---
name: josk
description: "Guides code that uses JoSk (npm `josk`, Meteor `ostrio:cron-jobs`), the cluster-safe setInterval/setTimeout/CRON scheduler for Node.js and Bun backed by Redis, KeyDB, Valkey, MongoDB, or PostgreSQL. Use when a task mentions josk or ostrio:cron-jobs, schedules recurring or one-shot jobs across several app instances, needs a distributed cron or job lock, picks or configures a JoSk adapter, tunes zombieTime, concurrency, or pause/resume, adds graceful shutdown for scheduled jobs, or debugs duplicate, missing, or late JoSk runs."
license: BSD-3-Clause
metadata:
  author: veliovgroup
  josk-version: "6.5"
---

# JoSk

Distributed `setInterval` / `setTimeout` / `setImmediate` for Node >= 14.21.3 and Bun >= 1.1. Server-only. Tasks live in Redis, MongoDB, or PostgreSQL; a lease plus an atomic claim gives each due tick to one instance.

## Version gate

If `package.json` pins `josk` below `6.0.0`, or the runtime is Node < 14.21.3, read [references/legacy-v5.md](references/legacy-v5.md) instead of the rest. Everything else here describes 6.x and uses exports, methods, and options that 5.x lacks (`PostgresAdapter`, `pause()`/`resume()`, `shutdown()`, `concurrency`, `execute`, `lockLeaseTime`, `useHashTags`, auto-`ready()` for sync handlers).

## Quick start

JoSk does not open connections; pass a connected client. Wire `onError`, and `await jobs.shutdown()` on process exit.

```js
import { JoSk, RedisAdapter } from 'josk';
import { createClient } from 'redis';

const client = createClient({ url: process.env.REDIS_URL });
await client.connect();

const jobs = new JoSk({
  adapter: new RedisAdapter({ client }),
  onError: (title, { error, uid }) => console.error(title, uid, error),
});

await jobs.setInterval(async () => { /* idempotent work */ }, 60_000, 'poll-1m');
// jobs.pause() / jobs.resume() / await jobs.shutdown({ timeout: 10_000 })
```

## Reference map

Read lazily; do not guess semantics from memory.

| Question | Read |
|---|---|
| Options, methods, hooks, handler shape, types | [references/api.md](references/api.md) |
| Choosing and configuring an adapter, storage layout, custom adapter | [references/adapters.md](references/adapters.md) |
| CRON, handler styles, concurrency, pause/resume, shutdown, healthcheck | [references/patterns.md](references/patterns.md) |
| Meteor / `ostrio:cron-jobs` | [references/meteor.md](references/meteor.md) |
| Zombies, jitter, duplicate or missing runs, upgrades | [references/troubleshooting.md](references/troubleshooting.md) |
| `josk` below `6.0.0`, or Node < 14.21.3 | [references/legacy-v5.md](references/legacy-v5.md) |
| Email queue on JoSk (`mail-time`) | `mail-time` skill: `npx skills add veliovgroup/mail-time` |

## Pick the scheduling method

| Method | Guarantee | Use when |
|---|---|---|
| `setInterval(fn, delay, uid)` | At-least-once per tick | Idempotent recurring work |
| `setTimeout(fn, delay, uid)` | At-most-once | One-shot; a duplicate is worse than a miss; removed from storage before the handler runs |
| `setImmediate(fn, uid)` | At-most-once | One-shot on the next poll; `setTimeout` with delay 0 |

## Rules

- `adapter` is required: `RedisAdapter`, `MongoAdapter`, `PostgresAdapter`, or custom.
- `uid` is an app-wide unique string per logical task. Two registrations with one `uid` overwrite each other.
- Prefer async handlers. Sync zero-arg handlers also work. Use `(ready) =>` only for callback APIs, and call `ready()` on every path.
- `set*` return `Promise<string>`; pass that string (or the Promise) to `clear*`.
- Register every handler on every instance; a claimed task without a handler on that instance is reported as missing.

Flag when reviewing JoSk usage:

- Missing `onError`, or no `shutdown()` on exit
- Reused `uid` across different tasks
- Default `zombieTime` (15 min) with handlers that can run longer
- `resetOnInit: true` in a production cluster
- Replica reads, multi-master Redis or KeyDB, or Cluster without `useHashTags: true`
- Intervals below ~2 s
- `MongoAdapter` on Cosmos DB, DocumentDB, or Mongoose without a warning that they are untested
