---
name: josk
description: "JoSk task/CRON scheduler for horizontally scaled Node.js and Bun apps — synchronizes scheduled work so each tick runs once across the cluster. Trigger when the user is writing or reviewing recurring jobs, cron-style tasks, `setInterval`/`setTimeout` work, or periodic background jobs (email queues, SMS sends, sync, polling, cleanup) in a multi-instance / cluster / Kubernetes / PM2 / Meteor.js topology, the `josk` NPM package, or the Meteor `ostrio:cron-jobs` Atmosphere package. Also trigger when the user mentions JoSk by name, asks about `RedisAdapter` / `MongoAdapter` / `PostgresAdapter`, talks about exactly-once / at-most-once execution, zombie-task recovery, scheduler leases, `zombieTime` / `execute` / `concurrency`, or compares JoSk to Agenda, Bree, node-cron, Bull, or BullMQ. Covers the full public API (`new JoSk`, `setInterval`, `setTimeout`, `setImmediate`, `clearInterval`, `clearTimeout`, `destroy`, `ping`, the three built-in adapters, and the custom-adapter contract)."
---

# JoSk — distributed task scheduler for Node.js & Bun

JoSk runs one copy of each scheduled task across a cluster. Schedule lives in Redis, MongoDB, or PostgreSQL; lease + atomic claim prevents two instances running the same tick.

Use when: multi-process/pod deployment, scaled Meteor/K8s/PM2, user mentions JoSk/adapters/zombie leases, or compares to agenda/bree/node-cron/bull.

## Source of truth

Read `references/` lazily — do not guess v4/v5/v6 semantics from memory:

- `references/api.md` — constructor options, methods, hooks, types
- `references/adapters.md` — adapter setup, cluster rules, custom-adapter contract
- `references/patterns.md` — handler styles, CRON, concurrency, shutdown
- `references/meteor.md` — `ostrio:cron-jobs` / Meteor imports
- `references/troubleshooting.md` — zombies, jitter, migrations, KeyDB/replica caveats

## Mental model

```
new JoSk({ adapter: new <Redis|Mongo|Postgres>Adapter({ ... }), onError, ... })
  .setInterval | setTimeout | setImmediate (handler, [delay], uid)
```

- **`adapter`** required. **`uid`** app-wide unique string per task.
- **Handler:** async/Promise (preferred), zero-arg sync, or `(ready) =>` callback — see `references/patterns.md`.
- **Timer id:** `set*` returns `Promise<string>`; pass string or that Promise to `clear*`.

## New integration checklist

1. Storage + connected client (JoSk does not manage connections)
2. `onError` hook (strongly recommended)
3. `jobs.destroy()` on shutdown — see `references/patterns.md`
4. Pick adapter — see below + `references/adapters.md`

## Pick the adapter

- **PostgreSQL** — multi-DC, clock skew; server-time locks, `SKIP LOCKED`. Default when strict single-claim matters.
- **Redis/KeyDB/Valkey** — single-region, high frequency. Reject active-active / multi-master.
- **MongoDB** — app already on Mongo (Meteor: `MongoInternals…mongo.db`). Official `mongodb` driver only.

## Scheduling method

| Method | Guarantee | Use when |
|---|---|---|
| `setInterval(fn, delay, uid)` | At-least-once per tick | Idempotent recurring work; handler safe if run twice |
| `setTimeout(fn, delay, uid)` | At-most-once | One-shot deferred; duplicate worse than miss; removed before handler |
| `setImmediate(fn, uid)` | At-most-once | One-shot fire-now; same guarantee as `setTimeout` with delay 0 |

Duplicate vs miss worse? Map to table. `zombieTime` (default 15 min): max handler runtime before re-claim on intervals; keep ≥ slowest handler + margin, not below 60s.

## Throughput tuning

- `execute: 'batch'` (default) — all due tasks per lease; `one` — one task per lease
- `concurrency: Infinity` (default) — parallel handlers; set integer to cap pool/API/CPU use

## Red flags

- No `onError` hook
- Reused `uid` across different tasks
- Default `zombieTime` with handlers >15 min
- `resetOnInit: true` in production cluster
- Replica reads / multi-writer Redis
- Intervals <~2s (storage + jitter overlap)
- MongoAdapter on CosmosDB/DocumentDB/Mongoose without warning
- KeyDB active-replication / multi-master

Full API, adapter ctors, handler recipes: `references/api.md`, `references/adapters.md`, `references/patterns.md`.

## Install

```sh
npm install josk redis   # or mongodb / pg
bun add josk
meteor add ostrio:cron-jobs   # Meteor; see references/meteor.md
```

Node ≥ 20.9.0 or Bun ≥ 1.1.0. Server-only — never client/browser.
