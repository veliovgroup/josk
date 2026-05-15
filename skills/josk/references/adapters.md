# JoSk adapters

Three built-in adapters plus the contract for writing custom ones. Pick by topology, not by familiarity — the adapters have meaningfully different failure modes and tuning knobs.

## Quick comparison

| Adapter | Best for | Prerequisite NPM | Server requirement | Lock mechanism | Notes |
|---|---|---|---|---|---|
| `RedisAdapter` | High-frequency scheduling, single-writer Redis/KeyDB | `redis@^4 \|\| ^5` | `redis-server@≥5.0.0` (Lua + sorted sets), or KeyDB / Valkey routed to a single slot | Owner-bound lease key with `PEXPIRE` TTL, Lua-script atomic claim | Reject active-active / multi-master topologies for exactly-once |
| `MongoAdapter` | Apps that already run MongoDB (incl. Meteor) | `mongodb` (official driver) | `mongod@≥4.0.0` | TTL-indexed `.lock` collection, atomic `findOneAndUpdate` task claim | Tested only against official driver. Other Mongo-compatible stores unverified |
| `PostgresAdapter` | Multi-region / strict exactly-once, mixed clocks | `pg` | `postgres@≥12` | `josk_locks` row with `CURRENT_TIMESTAMP`-compared expiry, `FOR UPDATE SKIP LOCKED` claim | Strongest clock-skew resistance. Auto-migrates schema on init |

## `RedisAdapter`

```js
import { JoSk, RedisAdapter } from 'josk';
import { createClient } from 'redis';

const redisClient = await createClient({
  url: 'redis://127.0.0.1:6379',
}).connect();

const jobs = new JoSk({
  adapter: new RedisAdapter({
    client: redisClient,
    prefix: 'app-scheduler',
  }),
  onError(reason, details) {
    console.error('[josk]', reason, details.error);
  },
});
```

### Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `client` | `RedisClient` | — | **Required.** Already connected `redis@^4` or `redis@^5` client. Either `RedisClientType` or `RedisClusterType`. |
| `prefix` | `string` | `'default'` | Scopes keys. Must match `/^[A-Za-z0-9_\-:.]+$/`. Special characters (notably `{` `}`) are rejected because they would break Cluster hash-tag routing. |
| `resetOnInit` | `boolean` | `false` | Deletes all keys under this prefix on init. Local-dev / single-instance recovery only. Disastrous in clustered prod. |

### Keys created (for `prefix: 'app'`)

- `josk:{app}:schedule` — sorted set of due timestamps
- `josk:{app}:tasks` — hash of task payloads
- `josk:{app}:lock` — scheduler lease key

The `{app}` braces are Redis hash tags that keep all keys on the same Cluster slot.

### Redis / KeyDB topology guidelines

- One writable primary endpoint, or a KeyDB Cluster endpoint where the prefix maps to a single hash slot.
- **Do not** route reads or writes to replicas. Lease writes must be immediately visible.
- **Do not** use Redis active-active / multi-master or KeyDB active-replication for exactly-once correctness. Conflict resolution can allow duplicate task claims across writers.
- For multi-DC exactly-once requirements, prefer `PostgresAdapter`.

## `MongoAdapter`

```js
import { JoSk, MongoAdapter } from 'josk';
import { MongoClient } from 'mongodb';

const client = new MongoClient('mongodb://127.0.0.1:27017');
// Recommend a DB separate from the app's main DB to avoid lock contention.
const db = client.db('joskdb');

const jobs = new JoSk({
  adapter: new MongoAdapter({
    db,
    prefix: 'cluster-scheduler',
  }),
  onError(reason, details) {
    console.error('[josk]', reason, details.error);
  },
});
```

### Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `db` | `Db` | — | **Required.** `Db` instance from `MongoClient#db()`. Must come from the official `mongodb` driver. |
| `prefix` | `string` | `'default'` | Appended to the tasks collection name. v4 implicitly used `''` (producing `__JobTasks__`); v5+ defaults to `'default'` (producing `__JobTasks__default`). |
| `lockCollectionName` | `string` | `'__JobTasks__.lock'` | Override only if it conflicts with an existing collection. The lock collection is shared across prefixes — isolation is by the `uniqueName` field on each lock row. |
| `resetOnInit` | `boolean` | `false` | Deletes all rows in the current-prefix tasks collection on init. |

### Collections created

- `__JobTasks__<prefix>` — task documents
- `__JobTasks__.lock` (or `lockCollectionName`) — scheduler lease documents

Mongo collection-name limit is 120 characters (including DB name). Keep prefixes short.

### Recommended Mongo connection options (replica set)

```js
const options = {
  writeConcern: { j: true, w: 'majority', wtimeout: 30000 },
  readConcern: { level: 'majority' },
  readPreference: 'primary',
};
const client = await MongoClient.connect('mongodb://…', options);
```

### What "tested only against the official driver" means

The `MongoAdapter` is verified against the official `mongodb` NPM package. CosmosDB, DocumentDB, Mongoose's wrapped client, and other Mongo-compatible stores are not tested and may behave differently for transactions, TTL indexes, or `findOneAndUpdate` atomicity. Flag this when recommending JoSk for those backends.

## `PostgresAdapter`

```js
import { JoSk, PostgresAdapter } from 'josk';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: 'postgres://user:pass@localhost:5432/joskdb',
});

const jobs = new JoSk({
  adapter: new PostgresAdapter({
    client: pool,
    prefix: 'cluster-scheduler',
  }),
  onError(reason, details) {
    console.error('[josk]', reason, details.error);
  },
});
```

### Options

| Option | Type | Default | Notes |
|---|---|---|---|
| `client` | `Pool \| Client` | — | **Required.** Any object with a `.query(text, values?) => Promise<{ rowCount, rows }>` shape. `pg.Pool` is recommended for long-running apps. |
| `prefix` | `string` | `'default'` | Used in `josk_tasks.prefix` and `josk_locks.lock_key`. Isolates schedules without separate tables. |
| `resetOnInit` | `boolean` | `false` | Deletes current-prefix rows from `josk_tasks` and the lock row from `josk_locks` on init. |

### Tables created (auto-migrated on init)

- `josk_tasks` — composite primary key `(prefix, uid)`
- `josk_locks` — one row per `lock_key` (`josk-<prefix>.lock`)
- `josk_meta` — schema-version row, gates future migrations

Migrations run DDL on startup; schedule deploys during a low-traffic window when upgrading.

### PostgreSQL guidelines

- Use `pg.Pool`. Share the app's pool when handlers also hit Postgres, or use a small dedicated pool when scheduler isolation matters.
- One writable primary endpoint. **No replica reads** — task claims must be visible immediately.
- Lock acquisition compares lease expiry against `CURRENT_TIMESTAMP`, so client clock skew across nodes does not affect lock ownership. This is the strongest cross-region adapter.
- `execute: 'batch'` (default) uses `FOR UPDATE SKIP LOCKED` to drain due tasks. `execute: 'one'` uses `LIMIT 1`.
- Tune `minRevolvingDelay` / `maxRevolvingDelay` based on pool capacity and handler runtime. Lower polling = more DB writes.

## Prefix mapping — at a glance

`prefix` isolates one JoSk schedule from another in the same storage. Same prefix = same shared queue; different prefix = isolated namespace.

| Adapter | Storage layout (for `prefix: 'app'`) |
|---|---|
| Redis | Keys `josk:{app}:schedule`, `josk:{app}:tasks`, `josk:{app}:lock`. Braces are Cluster hash tags. |
| MongoDB | Collection `__JobTasks__app`; lock collection `__JobTasks__.lock` (shared, scoped by `uniqueName` field). |
| PostgreSQL | Rows in `josk_tasks` filtered by `prefix='app'`; lock row in `josk_locks` with `lock_key='josk-app.lock'`. |

Use different prefixes for tenants, environments, or test suites.

## Cleanup recipes (dev / test)

### Redis

```sh
redis-cli --no-auth-warning --scan --pattern "josk:{default}:*" \
  | xargs redis-cli --raw --no-auth-warning DEL
```

### MongoDB

```js
db.getCollection('__JobTasks__default').remove({});
// Or for a custom prefix:
db.getCollection('__JobTasks__myPrefix').remove({});
```

### PostgreSQL

```sql
DELETE FROM josk_tasks WHERE prefix = 'default';
DELETE FROM josk_locks WHERE lock_key = 'josk-default.lock';
```

## Custom adapter

Custom adapters implement the `JoSkAdapter` interface and follow design rules tied to exactly-once correctness. Start from `adapters/blank-example.js` in the source tree.

### Interface

```ts
interface JoSkAdapter {
  joskInstance?: JoSk;                                      // JoSk sets this on construction
  acquireLock(lock: JoSkLock): Promise<boolean>;
  releaseLock(lock: JoSkLock): Promise<void>;
  remove(uid: string): Promise<boolean>;
  add(uid: string, isInterval: boolean, delay: number): Promise<boolean | void>;
  update(task: JoSkTask, nextExecuteAt: Date): Promise<boolean>;
  iterate(nextExecuteAt: Date, lock: JoSkLock, executeMode: JoSkExecuteMode): Promise<number | void>;
  ping(): Promise<JoSkPingResult>;
  ready?(): Promise<void>;                                  // optional init barrier
}
```

### Required design rules

- **Owner-bound lease tokens.** Never release a foreign lease. The lock object contains `ownerId`, `leaseId`, `expireAt`, `expiresAtMs` — `releaseLock` must check the owner before deleting.
- **Atomic due-task claim.** Do not `find all due → update later`. Use a single atomic operation (Lua, `FOR UPDATE SKIP LOCKED`, atomic `findOneAndUpdate`) to claim and return the task in one round-trip.
- **`iterate(nextExecuteAt, lock, executeMode)`** is the entry point JoSk calls each tick. Claim one task (for `executeMode === 'one'`) or as many as the lease lets you (`executeMode === 'batch'`) and call `this.joskInstance.__execute(task)` **fire-and-forget** for each — JoSk handles internal concurrency and error wrapping.
- **Storage-server time** for lease comparisons. Mixed client clocks across a cluster cause incorrect lock ownership. See `adapters/postgres.js` for the `CURRENT_TIMESTAMP` pattern.
- **`ready()`** is optional but recommended for adapters that need to create schemas, indexes, or run migrations before the first storage op.

### Task object shape (what to pass to `__execute`)

```js
{
  uid: 'taskidsetInterval',     // string, includes the setInterval/setTimeout/setImmediate suffix
  delay: 60000,                  // number, ms
  executeAt: 1731000000000,      // number or Date
  isInterval: true,              // boolean
  isDeleted: false,              // boolean
}
```

### Recommended adapter flow inside `iterate`

1. Acquire the scheduler lease (owner-bound token).
2. Atomically claim the next due task — move its `executeAt` to the supplied `nextExecuteAt` so it doesn't get claimed again by another instance during the same window.
3. Return the pre-claim task payload.
4. Call `this.joskInstance.__execute(task)` (no `await`).
5. Release the lease only if the owner token still matches.

Global lock alone is **not** enough for exactly-once. The atomic per-task claim is what prevents two instances from running the same tick.
