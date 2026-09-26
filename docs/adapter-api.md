# JoSk Custom Adapter API

JoSk supports 3rd party storage adapters. Built-in adapters cover MongoDB, Redis, PostgreSQL. Custom adapters should follow same contract.

## Create Adapter

Start from [`blank-example.js`](https://github.com/veliovgroup/josk/blob/master/adapters/blank-example.js).

## Design Rules

- Keep second-layer scheduler lock. Use owner-bound lease token. Never release foreign lease.
- Derive lock lifetime from the lock object itself — prefer the relative `lock.leaseMs`; use `lock.expireAt` / `lock.expiresAtMs` only as a fallback for locks minted without it. Never substitute `zombieTime` (a substituted long TTL freezes the whole prefix for up to `zombieTime` when a holder dies uncleanly), and never re-derive a duration as `expiresAtMs - Date.now()` when `leaseMs` is present — that second app-clock read is distorted by any clock step between mint and acquire.
- Claim due tasks atomically in storage. Do not `find all due -> update later`.
- Fence `update()` on the claim: atomically store and return `claimLeaseId: lock.leaseId`; `update()` must match that lease, update the schedule, and clear the lease in one write. Without a token, update unconditionally for compatibility. JoSk also suppresses a superseded run's late `ready()` write when a newer same-uid run starts in this process; cross-instance safety still needs adapter fencing. JoSk calls `update(task, now)` to hand a claim back on `destroy()` / `shutdown()`.
- `iterate()` should claim and execute `one` or `batch` depending on `executeMode`.
- `ready()` optional but recommended. Use it to finish schema/index/init work before first storage op.
- Prefer storage-server time over client time when comparing lease expirations. Mixed client clocks across a cluster will cause incorrect lock ownership otherwise. See `adapters/postgres.js` (`CURRENT_TIMESTAMP` in `acquireLock`) for a reference pattern.
- Call `joskInstance.__execute(task)` fire-and-forget (do not `await`). JoSk handles internal concurrency and error wrapping.
- `add()` for an unclaimed interval keeps the earlier stored `executeAt` when the stored task exists, is not deleted, is an interval, and has the same `delay`; otherwise schedule `now + delay`. Built-in adapters additionally preserve a claimed interval's recovery deadline on re-registration, even when `delay` changes. They use their existing stored `claimLeaseId` / `claim_lease_id` as the marker and clear it with the next `update()`. Custom adapters need not use that field, but should avoid shortening an active claim's recovery hold. Keep every stored copy of the schedule consistent (e.g. Redis hash and ZSET) in one atomic operation. See the built-in `add()` implementations for reference.

## Adapter Class API

- `new Adapter(opts)`
  - `{object} opts`
  - `{string} [opts.prefix]` scope isolation
  - `{boolean} [opts.resetOnInit]` clear previous scoped state on init
  - `{mix} [opts.other]` storage-specific options
- async `Adapter#ready() - {Promise<void>}` optional
- async `Adapter#ping() - {Promise<object>}`
- async `Adapter#acquireLock(lock) - {Promise<boolean>}`
  - `{object} lock`
  - `{string} lock.ownerId`
  - `{string} lock.leaseId`
  - `{Date} lock.expireAt`
  - `{number} lock.expiresAtMs`
  - `{number} [lock.leaseMs]` — relative lease duration; prefer over re-deriving from `expiresAtMs`
- async `Adapter#releaseLock(lock) - {Promise<void>}`
  - same `lock` object
- async `Adapter#remove(uid) - {Promise<boolean>}`
  - `{string} uid`
- async `Adapter#add(uid, isInterval, delay) - {Promise<boolean|void>}`
  - `{string} uid`
  - `{boolean} isInterval`
  - `{number} delay`
  - upsert; an unchanged unclaimed interval keeps an earlier stored `executeAt` and an active claim keeps its recovery deadline (see Design Rules)
- async `Adapter#update(task, nextExecuteAt) - {Promise<boolean>}`
  - `{object} task` claimed task; fence on `task.claimLeaseId` when present (see Design Rules)
  - `{Date} nextExecuteAt`
  - `false` when the task is gone or its lease no longer matches
- async `Adapter#iterate(nextExecuteAt, lock, executeMode) - {Promise<number|void>}`
  - `{Date} nextExecuteAt` zombie retry timestamp
  - `{object} lock` active scheduler lease
  - `{'one'|'batch'} executeMode`

## Task Object

Inside `Adapter#iterate()` call `this.joskInstance.__execute(task)` with:

```js
({
  uid: String,
  delay: Number,
  executeAt: Number, // or Date — see "executeAt convention" below
  isInterval: Boolean,
  isDeleted: Boolean,
  claimLeaseId: String // optional; `lock.leaseId` of the claim, used to fence update()
})
```

### `executeAt` convention

`executeAt` carries the **pre-claim** value — the moment the task was due to fire. Storage is updated to a post-claim park time (`nextExecuteAt`, typically `now + zombieTime`), but the task object handed back to JoSk reports the original due time. This lets handlers reason about scheduling drift and matches the semantics of all built-in adapters.

## Recommended Storage Pattern

1. Acquire scheduler lease with owner-bound token.
2. Atomically claim next due task by moving `executeAt` to `nextExecuteAt`.
3. Return pre-claim task payload with `claimLeaseId: lock.leaseId`.
4. Call `this.joskInstance.__execute(task)`.
5. Release scheduler lease only if owner token still matches.

For example, atomically persist and return the claim token:

```js
return { ...task, claimLeaseId: lock.leaseId };
```

A Mongo-style atomic `update()` filters on the token when present, updates the schedule, and clears it. Without a token, it filters by task identity only:

```js
const filter = { uid: task.uid };
if (task.claimLeaseId) filter.claimLeaseId = task.claimLeaseId;
await collection.updateOne(filter, {
  $set: { executeAt: nextExecuteAt },
  $unset: { claimLeaseId: '' }
});
```

Global lock alone is not enough for duplicate prevention. Atomic task claim is required.
