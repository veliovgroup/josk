# JoSk troubleshooting & operational FAQ

The behaviors that surprise people, the migration notes that bite, and the queries that answer "is my scheduler healthy?".

## Execution semantics — the table to memorize

| Method | Guarantee | What happens on crash mid-handler |
|---|---|---|
| `setImmediate(fn, uid)` | At-most-once across the cluster | Task is removed *before* the handler runs. If the process dies between removal and completion, the run is lost. |
| `setTimeout(fn, delay, uid)` | At-most-once across the cluster | Task is removed *before* the handler runs. If the process dies between removal and completion, the run is lost. |
| `setInterval(fn, delay, uid)` | At-least-once per scheduled tick (until cleared) | Storage row stays during execution. If `ready()` isn't called within `zombieTime`, the task is re-claimed and may run again. Make handlers idempotent. |

If you see "this ran twice", that's `setInterval` + a handler that exceeded `zombieTime` or didn't call `ready()`. If you see "this didn't run", that's almost always `setTimeout` / `setImmediate` + a process crash, or a missing `setInterval` registration on the instance that holds the lease.

## "Zombie task" recovery — what actually happens

A task is a zombie when the instance that claimed it never called `ready()` and never resolved its Promise within `zombieTime` (default 15 min). After that window:

1. Another (or the same) instance acquires the scheduler lease.
2. The task becomes eligible for atomic claim again.
3. It executes a second time on whichever instance wins the claim.

Tuning:

- `zombieTime` must exceed the slowest legitimate handler runtime plus a margin. Below 60s is not recommended.
- If a handler routinely hits `zombieTime`, either the handler is too slow or `zombieTime` is too tight. Don't paper over by raising it past hours — split the work or move it off the scheduler.

## Monitoring stuck tasks

JoSk surfaces stuck tasks two ways:

1. **`onError` "One of your tasks is missing"** — fired when a task exists in storage but no in-memory handler is registered on this instance. Only fired when `autoClear: false`.
2. **Direct storage queries** — what you reach for when you want active observability without `autoClear` noise.

### Redis

```
HLEN josk:prefix:tasks
ZRANGEBYSCORE josk:prefix:schedule -inf <now-ms>

# If RedisAdapter({ useHashTags: true })
HLEN josk:{prefix}:tasks
ZRANGEBYSCORE josk:{prefix}:schedule -inf <now-ms>
```

### MongoDB

```js
db.__JobTasks__<prefix>.countDocuments({
  executeAt: { $lt: new Date() },
});
```

### PostgreSQL

```sql
SELECT COUNT(*) FROM josk_tasks
WHERE prefix = '<prefix>'
  AND execute_at < (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::BIGINT;
```

Add a small healthcheck route that calls `jobs.ping()` and exposes the adapter status to your existing monitoring.

## Jitter / accuracy

The effective tick happens at:

```
delay + uniform(minRevolvingDelay, maxRevolvingDelay) + storage round-trip
```

With defaults (`128`, `768`), expect ±0.8s + storage latency. The revolving range is intentional — it stops multiple instances from racing to claim the same lease window.

Trade-offs:

- Tighter timing → lower `maxRevolvingDelay` → more storage reads.
- Less storage load → raise both delays → looser timing.

For tasks shorter than ~2 seconds, storage round-trip dominates and runs may overlap. Prefer ≥2s for predictable spacing.

## Storage restarts

JoSk swallows adapter errors and retries on the next tick. The scheduler self-recovers once the connection is healthy. Leases held by crashed nodes self-expire:

- **Redis** — `PEXPIRE` TTL on the lock key.
- **MongoDB** — TTL index on the lock collection.
- **PostgreSQL** — `locked_until` compared against server time on the next claim.

Running `jobs.ping()` after a restart confirms readiness.

## Clock skew across nodes

Lease tokens use storage-server time where possible (`PEXPIRE` for Redis, `CURRENT_TIMESTAMP` for Postgres, TTL index for Mongo). JS clocks are used only for relative scheduling within a single process. NTP on the storage host is the single clock that anchors lease ownership across the cluster — keep it healthy.

If clocks across app nodes are wildly off and you need correctness anyway, `PostgresAdapter` is the most resistant: its `acquireLock` compares lease expiry server-side via `CURRENT_TIMESTAMP`.

## "Why does my interval drift by ~1 second?"

The effective interval is `delay + uniform(min, max) + round-trip`, not `delay` exactly. Defaults put `min=128`, `max=768`, so the upper bound is `delay + 768ms + storage latency`. To tighten: lower `maxRevolvingDelay`. To get exact wall-clock cadence (e.g. fire at the top of every minute), use the CRON pattern in `patterns.md` and call `ready(nextDate)`.

## "Why is my task running twice?"

In order of likelihood:

1. **It's a `setInterval` and the handler is exceeding `zombieTime`.** Lower the handler runtime or raise `zombieTime`.
2. **`ready()` was never called and `func.length > 0`.** Handlers that declare a `ready` parameter but never call it look stuck to JoSk. Either call it or remove the parameter so JoSk auto-completes.
3. **Two instances are using different `prefix` values that both store tasks with the same `uid`.** Each prefix is an isolated namespace — same `uid` in two prefixes runs twice. Either unify prefixes or use different `uid`s.
4. **Multi-master Redis / Mongo secondaries.** Active-active Redis can produce duplicate claims; reading the Mongo lock from a secondary can let a stale leader keep running. Switch to a single writable primary, or use `PostgresAdapter`.

## "Why is my task missing?"

In order of likelihood:

1. **The `uid` collides with another `setInterval` / `setTimeout` registration.** Internal timer ids include a suffix, so `setInterval(_, _, 'x')` and `setTimeout(_, _, 'x')` don't collide — but two `setInterval` calls with `uid: 'x'` do, and the second overwrites the first.
2. **It was registered on an instance that has since shut down**, and no other instance has the handler in memory. Result: `onError('One of your tasks is missing', …)`. Register the handler on every instance, or enable `autoClear: true` if the task is genuinely obsolete.
3. **`setTimeout` / `setImmediate` crashed before completing.** That's the at-most-once guarantee. If "miss" is unacceptable, use `setInterval` with idempotent semantics.

## Replicas / Cluster topologies — what breaks

- **Reading JoSk state from a Mongo secondary or a Redis replica.** Lease writes must be immediately visible. Use the primary.
- **Active-active Redis / KeyDB active-replication / multi-master.** Conflict resolution can allow duplicate claims. Use a single writable primary, or `PostgresAdapter`.
- **MongoDB without `w: 'majority'`.** A claim that's only on the primary can vanish on failover. Use majority writes and `readConcern: 'majority'`.
- **Postgres read replicas.** Same rule — no scheduler reads on replicas.

## Migrations

Full upgrade guides live in the repo under `docs/`:

| Upgrade | Guide |
|---|---|
| v4 → v5 | [docs/migration-v4-v5.md](https://github.com/veliovgroup/josk/blob/master/docs/migration-v4-v5.md) |
| v5 → v6 | [docs/migration-v5-v6.md](https://github.com/veliovgroup/josk/blob/master/docs/migration-v5-v6.md) |
| v6 → v6.1 | [docs/migration-v6-v6.1.md](https://github.com/veliovgroup/josk/blob/master/docs/migration-v6-v6.1.md) |

Quick hits:

- **v4 → v5:** `new JoSk({ adapter: new MongoAdapter({ db, prefix }) })` instead of `new JoSk({ db, prefix })`.
- **v5 → v6:** Node ≥20.9 or Bun ≥1.1; `PostgresAdapter`; Mongo default prefix `'default'`; lease ownership on lock release.
- **v6 → v6.1:** `RedisAdapter({ useHashTags: true })` for Redis Cluster only — default keys unchanged.

## When NOT to use JoSk

- **Single-process apps that don't need cluster correctness.** Native `setInterval` / `setTimeout` are fine and have no storage dependency.
- **Browser / client code.** JoSk is server-only.
- **Sub-2-second high-frequency work.** Storage round-trip + revolving delay are the floor; for sub-second cadence use Node's native timers and confine the work to a single process.
- **Workflow orchestration with retries, fan-out, and DAGs.** JoSk is a scheduler, not a workflow engine. Use Temporal / Inngest / BullMQ for that.
- **Mongo-compatible stores other than the official driver target.** The MongoAdapter is verified only against `mongodb`; CosmosDB / DocumentDB / Mongoose's client are unverified. Use Redis or Postgres instead, or test exhaustively before relying on it.

## Quick checklist when reviewing a JoSk integration

- `onError` hook set? Yes / no.
- Every task `uid` unique across the codebase? Yes / no.
- Handler runtime well under `zombieTime`? Yes / no.
- Single writable primary for the storage? Yes / no.
- `resetOnInit` is `false` in production? Yes / no.
- `destroy()` called on shutdown signals? Yes / no.
- Tasks ≥ 2 seconds apart? Yes / no.
- Replica reads disabled for the JoSk database? Yes / no.

Any "no" deserves at least a callout in review.
