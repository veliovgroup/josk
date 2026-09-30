# JoSk adapters

Every adapter takes `prefix` (default `'default'`). Instances with the same prefix share one schedule; different prefixes are isolated (tenant, environment, test suite). Pass a connected client; JoSk never opens connections. All adapters also take `resetOnInit` (default `false`): delete this prefix's tasks and lock at startup. Never in a production cluster.

| Adapter | Pick when | Driver | Server |
|---|---|---|---|
| `RedisAdapter` | Frequent ticks, one writable Redis / KeyDB / Valkey primary | `redis@^4` or `^5` | `redis-server@>=5.0.0`; Cluster needs `useHashTags: true` |
| `MongoAdapter` | The app already runs MongoDB (including Meteor) | official `mongodb` driver | `mongod@>=4.4` |
| `PostgresAdapter` | Mixed clocks, multi-region, strict single claim | `pg@>=8.0.3` | `postgres@>=12` |

Not supported by any adapter: reads or writes through replicas, and multi-master setups (Redis active-active, KeyDB active-replication). Claims must be visible to every instance at once.

## `RedisAdapter`

```js
import { JoSk, RedisAdapter } from 'josk';
import { createClient } from 'redis';

const client = createClient({ url: 'redis://127.0.0.1:6379' });
await client.connect();

const jobs = new JoSk({
  adapter: new RedisAdapter({ client, prefix: 'app' }), // useHashTags: true on Cluster
  onError: (title, { error, uid }) => console.error(title, uid, error),
});
```

| Option | Default | Notes |
|---|---|---|
| `client` | required | Connected `createClient()` or `createCluster()` instance. |
| `prefix` | `'default'` | Must match `/^[A-Za-z0-9_\-:.]+$/`; `{` and `}` would break Cluster routing. |
| `useHashTags` | `false` | Keys become `josk:{prefix}:*` so they share one Cluster slot. Required for a cluster client (the constructor throws without it). Existing untagged keys are not migrated. |

Keys for `prefix: 'app'`: `josk:app:schedule` (sorted set of due times), `josk:app:tasks` (hash of task payloads), `josk:app:lock` (scheduler lease). KeyDB and Valkey work the same in standalone mode. More: [Redis guide](https://github.com/veliovgroup/josk/blob/master/docs/redis.md).

With `mail-time`: set `useHashTags` on both `RedisQueue` and `RedisAdapter`, and install the `mail-time` skill (`npx skills add veliovgroup/mail-time`).

## `MongoAdapter`

```js
import { JoSk, MongoAdapter } from 'josk';
import { MongoClient } from 'mongodb';

const client = new MongoClient('mongodb://127.0.0.1:27017');
const jobs = new JoSk({
  adapter: new MongoAdapter({ db: client.db('joskdb'), prefix: 'app' }),
  onError: (title, { error, uid }) => console.error(title, uid, error),
});
```

| Option | Default | Notes |
|---|---|---|
| `db` | required | `Db` from `MongoClient#db()`, official driver only. |
| `prefix` | `'default'` | Task collection `__JobTasks__<prefix>`. `''` is treated as `'default'`; v4/v5 data lives in `__JobTasks__`, see "Upgrades" in [troubleshooting.md](troubleshooting.md). |
| `lockCollectionName` | `'__JobTasks__.lock'` | Lock collection shared by all prefixes. Give JoSk 6 its own name while JoSk 5 services still use the default. |

Indexes are created on first start and never dropped. On a replica set use `writeConcern: { w: 'majority', j: true }`, `readConcern: { level: 'majority' }`, `readPreference: 'primary'`. Cosmos DB, DocumentDB, and Mongoose wrappers are untested. MongoDB 4.4+ limits the namespace (database plus collection name) to 255 bytes. More: [MongoDB guide](https://github.com/veliovgroup/josk/blob/master/docs/mongodb.md).

## `PostgresAdapter`

```js
import { JoSk, PostgresAdapter } from 'josk';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: 'postgres://user:pass@localhost:5432/joskdb' });
const jobs = new JoSk({
  adapter: new PostgresAdapter({ client: pool, prefix: 'app' }),
  onError: (title, { error, uid }) => console.error(title, uid, error),
});
```

| Option | Default | Notes |
|---|---|---|
| `client` | required | `pg.Pool` (recommended) or a connected `pg.Client`. |
| `prefix` | `'default'` | Stored in `josk_tasks.prefix` and `josk_locks.lock_key` (`josk-<prefix>.lock`). |

Creates and migrates `josk_tasks` (primary key `(prefix, uid)`), `josk_locks`, and `josk_meta` in the client's current database and schema on first start, inside one transaction under an advisory lock; deploy schema-changing upgrades in a quiet window. Lease expiry compares against `CURRENT_TIMESTAMP`, so app-clock skew does not matter. Both `execute` modes claim with `FOR UPDATE SKIP LOCKED`. Works behind PgBouncer in transaction mode.

## Cleanup (development and tests)

```sh
redis-cli --scan --pattern "josk:app:*" | xargs redis-cli DEL      # josk:{app}:* with useHashTags
```

```js
db.getCollection('__JobTasks__app').deleteMany({});
```

```sql
DELETE FROM josk_tasks WHERE prefix = 'app';
DELETE FROM josk_locks WHERE lock_key = 'josk-app.lock';
```

## Custom adapter

Implement `JoSkAdapter` (exported type). Full contract and rules: [adapter-api.md](https://github.com/veliovgroup/josk/blob/master/docs/adapter-api.md); template: [blank-example.js](https://github.com/veliovgroup/josk/blob/master/adapters/blank-example.js).

```ts
interface JoSkAdapter {
  joskInstance?: JoSk;                                   // set by JoSk
  ready?(): Promise<void>;                               // optional init barrier, retried on failure
  ping(): Promise<JoSkPingResult>;
  acquireLock(lock: JoSkLock): Promise<boolean>;         // owner-bound lease, TTL from lock.leaseMs
  releaseLock(lock: JoSkLock): Promise<void>;            // only when ownerId and leaseId match
  add(uid: string, isInterval: boolean, delay: number): Promise<boolean | void>;
  remove(uid: string): Promise<boolean>;
  update(task: JoSkTask, nextExecuteAt: Date): Promise<boolean>;
  iterate(nextExecuteAt: Date, lock: JoSkLock, executeMode: 'one' | 'batch'): Promise<number | void>;
}
```

Rules that keep single execution:

- Claim due tasks atomically (Lua, `FOR UPDATE SKIP LOCKED`, `findOneAndUpdate`), moving `executeAt` to `nextExecuteAt` in the same write and storing `lock.leaseId` as `claimLeaseId`. A global lock alone is not enough.
- In `iterate()`, call `this.joskInstance.__execute(task)` for each claimed task without awaiting. `task` is `{ uid, delay, executeAt (pre-claim), isInterval, isDeleted, claimLeaseId }`.
- `update()` must match `task.claimLeaseId` when present, write the schedule, and clear the lease in one write.
- `add()` keeps an unclaimed interval's earlier `executeAt` when `delay` is unchanged, and never shortens an active claim.
- Compare lease expiry with storage-server time where possible.
