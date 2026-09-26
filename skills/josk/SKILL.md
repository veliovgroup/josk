---
name: josk
description: "Use when integrating, comparing, or debugging JoSk distributed scheduling in Node.js/Bun, including recurring or multi-instance jobs, Redis/KeyDB/MongoDB/PostgreSQL adapters, or legacy JoSk 5.x on Node 14/16."
---

# JoSk

Distributed `setInterval` / `setTimeout` / `setImmediate` for Node ≥20.9 and Bun ≥1.1.
Server-only. Schedule in Redis, MongoDB, or PostgreSQL; lease + atomic claim limit duplicate ticks.

## Version gate — check first

If `package.json` pins `josk` below `6.0.0`, or the runtime is Node < 20.9 (Node 14/16 hosts), stop here and read [references/legacy-v5.md](references/legacy-v5.md). Everything else in this skill describes 6.x and names exports, methods, and options that do not exist in 5.x (`PostgresAdapter`, `pause()`/`resume()`, `concurrency`, `execute`, `lockLeaseTime`, `useHashTags`, auto-`ready()` for sync handlers).

## Quick start

JoSk does not open connections — pass a connected client. Always wire `onError` and `await jobs.shutdown()` on process exit. Read [references/](references/) lazily; do not guess v4/v5/v6 semantics from memory.

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

| Question | Read |
|---|---|
| Options, methods, hooks, types | [references/api.md](references/api.md) |
| Adapter setup, cluster rules, custom adapter | [references/adapters.md](references/adapters.md) |
| Handlers, CRON, concurrency, shutdown | [references/patterns.md](references/patterns.md) |
| Meteor / `ostrio:cron-jobs` | [references/meteor.md](references/meteor.md) |
| Zombies, jitter, migrations, KeyDB / Valkey | [references/troubleshooting.md](references/troubleshooting.md) |
| `josk@5` and older on Node 14/16 | [references/legacy-v5.md](references/legacy-v5.md) |
| Email queue on JoSk (`mail-time`) | **REQUIRED** `mail-time` skill (`npx skills add veliovgroup/mail-time`) |

## Mental model

- **`adapter`** required — `RedisAdapter`, `MongoAdapter`, `PostgresAdapter`, or custom ([adapters.md](references/adapters.md)).
- **`uid`** — app-wide unique string per logical task; reuse collides in storage.
- **Handler** — async/Promise preferred; sync zero-arg; or `(ready) =>` for callback APIs ([patterns.md](references/patterns.md)).
- **`set*` → `Promise<string>`** — pass string or that Promise to `clear*`.

## Pick the adapter

| Adapter | Choose when |
|---|---|
| **PostgreSQL** | Multi-DC, clock skew, strict single-claim; `SKIP LOCKED` |
| **Redis / KeyDB / Valkey** | Single-region, high frequency; one writable primary; Cluster / Valkey Cluster needs `useHashTags: true`. Engines + MailTime pairing: [adapters.md](references/adapters.md) |
| **MongoDB** | App already on Mongo (Meteor: `MongoInternals…mongo.db`); official `mongodb` driver |

## Pick the scheduling method

| Method | Guarantee | Use when |
|---|---|---|
| `setInterval(fn, delay, uid)` | At-least-once per tick | Idempotent recurring work |
| `setTimeout(fn, delay, uid)` | At-most-once | One-shot; duplicate worse than miss; removed before handler |
| `setImmediate(fn, uid)` | At-most-once | One-shot fire-now; same as `setTimeout` with delay 0 |

`zombieTime` (default 15 min): max interval handler runtime before re-claim. Keep ≥ slowest handler + margin; not below 60s.
`lockLeaseTime` (default min(zombieTime, 30s), floor 2 * maxRevolvingDelay + 1000): TTL of the per-cycle scheduler lease — an uncleanly-dead holder frees the prefix after this, not after `zombieTime`.

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
- Redis / KeyDB / Valkey Cluster without `useHashTags: true`
- MailTime Redis Cluster with `useHashTags` on only JoSk or only `RedisQueue`
- Intervals <~2s (storage + jitter overlap)
- MongoAdapter on CosmosDB/DocumentDB/Mongoose without warning
- KeyDB active-replication / Redis active-active / multi-master
