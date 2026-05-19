---
name: josk
description: "Guides JoSk integration for horizontally scaled Node.js and Bun apps — cluster-wide scheduling via Redis, MongoDB, or PostgreSQL so each tick runs on one instance. Use when writing or reviewing recurring jobs, cron-style tasks, `setInterval`/`setTimeout`/`setImmediate` work, periodic background jobs (queues, sync, polling, cleanup), multi-instance / Kubernetes / PM2 / Meteor deployments, the `josk` npm package, or `ostrio:cron-jobs`. Also when the user names JoSk, `RedisAdapter`, `MongoAdapter`, `PostgresAdapter`, at-least-once / at-most-once semantics, zombie recovery, leases, `zombieTime`, `execute`, `concurrency`, or comparisons to Agenda, Bree, node-cron, Bull, or BullMQ."
---

# JoSk

Distributed `setInterval` / `setTimeout` / `setImmediate` for Node ≥20.9 and Bun ≥1.1.
Server-only. Schedule in Redis, MongoDB, or PostgreSQL; lease + atomic claim limit duplicate ticks.

## Quick start

1. Connect storage client (JoSk does not open connections).
2. Read the matching file under [references/](references/) — do not guess v4/v5/v6 semantics.
3. Wire `onError`, unique per-task `uid`, and `destroy()` on shutdown.

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
// shutdown: await jobs.destroy();
```

## Reference map

Read `references/` lazily — do not guess v4/v5/v6 semantics from memory.

| Question | Read |
|---|---|
| Options, methods, hooks, types | [references/api.md](references/api.md) |
| Adapter setup, cluster rules, custom adapter | [references/adapters.md](references/adapters.md) |
| Handlers, CRON, concurrency, shutdown | [references/patterns.md](references/patterns.md) |
| Meteor / `ostrio:cron-jobs` | [references/meteor.md](references/meteor.md) |
| Zombies, jitter, migrations, KeyDB | [references/troubleshooting.md](references/troubleshooting.md) |

## Mental model

- **`adapter`** required — `RedisAdapter`, `MongoAdapter`, `PostgresAdapter`, or custom ([adapters.md](references/adapters.md)).
- **`uid`** — app-wide unique string per logical task; reuse collides in storage.
- **Handler** — async/Promise preferred; sync zero-arg; or `(ready) =>` for callback APIs ([patterns.md](references/patterns.md)).
- **`set*` → `Promise<string>`** — pass string or that Promise to `clear*`.

## New integration checklist

- [ ] Storage + connected client
- [ ] `onError` hook
- [ ] `jobs.destroy()` on shutdown ([patterns.md](references/patterns.md))
- [ ] Adapter choice (below)

## Pick the adapter

| Adapter | Choose when |
|---|---|
| **PostgreSQL** | Multi-DC, clock skew, strict single-claim; `SKIP LOCKED` |
| **Redis / KeyDB / Valkey** | Single-region, high frequency; single writable primary only |
| **MongoDB** | App already on Mongo (Meteor: `MongoInternals…mongo.db`); official `mongodb` driver |

## Pick the scheduling method

| Method | Guarantee | Use when |
|---|---|---|
| `setInterval(fn, delay, uid)` | At-least-once per tick | Idempotent recurring work |
| `setTimeout(fn, delay, uid)` | At-most-once | One-shot; duplicate worse than miss; removed before handler |
| `setImmediate(fn, uid)` | At-most-once | One-shot fire-now; same as `setTimeout` with delay 0 |

If unsure: ask whether duplicate or missed run is worse, then map to the table.

`zombieTime` (default 15 min): max interval handler runtime before re-claim. Keep ≥ slowest handler + margin; not below 60s.

## Throughput

- `execute: 'batch'` (default) — all due tasks per lease; `'one'` — one task per lease
- `concurrency: Infinity` (default) — parallel handlers; set integer to cap pool/API/CPU

## Red flags

Call out proactively when reviewing JoSk usage:

- Missing `onError`
- Reused `uid` across different tasks
- Default `zombieTime` with handlers >15 min
- `resetOnInit: true` in production cluster
- Replica reads / multi-writer Redis
- Intervals <~2s (storage + jitter overlap)
- MongoAdapter on CosmosDB/DocumentDB/Mongoose without warning
- KeyDB active-replication / multi-master

## Install

```sh
npm install josk redis   # or mongodb / pg
bun add josk
meteor add ostrio:cron-jobs   # see references/meteor.md
```
