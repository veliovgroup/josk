# Migrating from v6.4 to v6.5

No migration steps. Public method signatures are unchanged. Upgrade all instances; a v6.4 peer keeps working next to v6.5 on the same storage.

## Runtime floor

`engines.node` is `>=14.21.3` (v6.0 to v6.4 declared `>=20.9.0`; the code needed no change). Bun stays `>=1.1.0`. See [tested runtimes](testing.md#tested-runtimes).

## Behavior changes

- Adapter initialisation is retried. If storage is unreachable while the adapter initialises (Mongo index setup, Postgres schema migration, Redis reset with `resetOnInit`), JoSk retries at most every 5 seconds until it succeeds, and `ping()` resolves `{ status: 'Internal Server Error', code: 500, statusCode: 500, error }` in the meantime. Before, the first failure was permanent, `ping()` rejected, and an early failure could crash the process with an unhandled rejection. `set*` calls made while initialisation fails still reject.
- `pause(timerId)` hands a claimed task back due in 2 seconds. Before, it deferred by the task's own `delay`, so a 1-hour interval claimed by a paused instance waited another hour.
- `setInterval()` and `setTimeout()` round a fractional `delay` to whole milliseconds, and a fractional `lockLeaseTime` rounds up. Before, `PostgresAdapter` stored nothing for a fractional `delay`, and a fractional lease made `RedisAdapter` and `PostgresAdapter` fail every poll.
- `MongoAdapter` never drops an index on startup and adopts an existing index with the same keys. See the [MongoDB guide](mongodb.md).
- `MongoAdapter` and `PostgresAdapter` stop claiming batches 500 ms before the scheduler lease expires, as `RedisAdapter` already did. Leftover due tasks are claimed on the next poll.

## PostgreSQL

- Schema setup runs in one transaction under `pg_advisory_xact_lock` with one key shared by all prefixes. Before, each prefix used its own key, and adapters with different prefixes that started together on a fresh database failed with `23505` until restart. The transaction-scoped lock also works behind PgBouncer in transaction mode.
- Pass `pg.Pool` or a connected `pg.Client`. The adapter no longer calls `connect()` on a `pg.Client`; a pool `connect()` failure now rejects `ready()` instead of being ignored.
- Tables and indexes are checked on every boot, independent of the recorded schema version, so a dropped `josk_tasks` or `josk_locks` table is recreated.

## TypeScript

- CommonJS declarations (`index.d.cts`, `adapters/*.d.cts`) no longer import the ESM ones. Before, a `require('josk')` project on `module: node16` / `node18`, or on TypeScript below 5.8, failed with TS1479 when `skipLibCheck` was `false`.
- `RedisAdapterOption`, `MongoAdapterOption`, `PostgresAdapterOption`, `RedisClientLike`, `MongoDbLike`, and `PostgresClient` are exported from the package root. Adapter instances expose `joskInstance` in the declarations.

## Meteor

`ostrio:cron-jobs` adds its declaration files as server assets only, so they no longer ship in the client bundle.
