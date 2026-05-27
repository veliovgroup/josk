# JoSk Custom Adapter API

JoSk supports 3rd party storage adapters. Built-in adapters cover MongoDB, Redis, PostgreSQL. Custom adapters should follow same contract.

## Create Adapter

Start from [`blank-example.js`](https://github.com/veliovgroup/josk/blob/master/adapters/blank-example.js).

## Design Rules

- Keep second-layer scheduler lock. Use owner-bound lease token. Never release foreign lease.
- Claim due tasks atomically in storage. Do not `find all due -> update later`.
- `iterate()` should claim and execute `one` or `batch` depending on `executeMode`.
- `ready()` optional but recommended. Use it to finish schema/index/init work before first storage op.
- Prefer storage-server time over client time when comparing lease expirations. Mixed client clocks across a cluster will cause incorrect lock ownership otherwise. See `adapters/postgres.js` (`CURRENT_TIMESTAMP` in `acquireLock`) for a reference pattern.
- Call `joskInstance.__execute(task)` fire-and-forget (do not `await`). JoSk handles internal concurrency and error wrapping.

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
- async `Adapter#releaseLock(lock) - {Promise<void>}`
  - same `lock` object
- async `Adapter#remove(uid) - {Promise<boolean>}`
  - `{string} uid`
- async `Adapter#add(uid, isInterval, delay) - {Promise<boolean|void>}`
  - `{string} uid`
  - `{boolean} isInterval`
  - `{number} delay`
- async `Adapter#update(task, nextExecuteAt) - {Promise<boolean>}`
  - `{object} task`
  - `{Date} nextExecuteAt`
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
  isDeleted: Boolean
})
```

### `executeAt` convention

`executeAt` carries the **pre-claim** value — the moment the task was due to fire. Storage is updated to a post-claim park time (`nextExecuteAt`, typically `now + zombieTime`), but the task object handed back to JoSk reports the original due time. This lets handlers reason about scheduling drift and matches the semantics of all built-in adapters.

## Recommended Storage Pattern

1. Acquire scheduler lease with owner-bound token.
2. Atomically claim next due task by moving `executeAt` to `nextExecuteAt`.
3. Return pre-claim task payload.
4. Call `this.joskInstance.__execute(task)`.
5. Release scheduler lease only if owner token still matches.

Global lock alone is not enough for duplicate prevention. Atomic task claim is required.
