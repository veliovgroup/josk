# Migration guide (v5 → v6)

`v6.0.0` reworked storage adapters around owner-bound lease tokens, added atomic due-task claiming, and raised the runtime floor.

- **Breaking (6.0.0 to 6.4.0):** `package.json` declared `node@>=20.9.0` or `bun@>=1.1.0`. From 6.5.0, `engines.node` is `>=14.21.3`, the lowest version the test suite ran on (see [tested runtimes](testing.md#tested-runtimes) for the tested matrix). The code needed no change; only the declaration was too strict. Node 12 fails to parse `?.`.
- `RedisAdapter` accepts both `redis@^4` and `redis@^5` clients.
- `RedisAdapter` stores tasks in a sorted set (`josk:prefix:schedule`) plus hash (`josk:prefix:tasks`). v6 does not read the v5 `josk:prefix:task:*` keys; they are scanned and removed only when `resetOnInit: true`. To migrate a running cluster, plan a brief downtime: stop all instances, run one with `resetOnInit: true`, then redeploy.
- New adapter: `PostgresAdapter`.
- `PostgresAdapter` uses composite `(prefix, uid)` primary key. The adapter auto-migrates the table on startup, but the migration runs DDL — use a low-traffic deployment window.
- `MongoAdapter` previously defaulted the prefix to `''`, producing the collection `__JobTasks__`. v6 defaults to `'default'`, producing `__JobTasks__default`; an empty `prefix` also falls back to `'default'`. If you used the implicit empty prefix in v4/v5, stop all instances, then rename the collection: `db.__JobTasks__.renameCollection('__JobTasks__default')`.
- JoSk 5 and 6 must not share a lock collection unless JoSk 6 is 6.5.0 or newer and the collection does not carry the 6.0.0 to 6.4.0 index names. Otherwise each startup replaces the other's unique index and locks can be held twice. Set `lockCollectionName` on the JoSk 6 side.
- JoSk 5 and 6 on the same `prefix` (the task collection `__JobTasks__<prefix>`) also require JoSk 6.5.0 or newer. Older 6.x versions drop the unique `uid` index on a startup race and can store duplicate task documents. See [MongoDB guide](mongodb.md#sharing-the-lock-collection-between-josk-5-and-6).
- Lock release now checks lease ownership; a JoSk instance can no longer release a foreign lease. **If you have custom adapters, follow the [adapter API contract](adapter-api.md).**
- If you use `cron-parser` — bump to `^5` and switch from `parser.parseExpression(...)` to `CronExpressionParser.parse(...)`.
- v6 also added `concurrency` (default `Infinity`), Bun runtime support (≥1.1.0), and auto-`ready()` for sync handlers declared with `func.length === 0`.
