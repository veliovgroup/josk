# Migration guide (v5 → v6)

`v6.0.0` reworked storage adapters around owner-bound lease tokens, added atomic due-task claiming, and raised the runtime floor.

- **Breaking:** minimum runtime is now `node@>=20.9.0` (LTS) or `bun@>=1.1.0`. Stay on `josk@^5` if you cannot upgrade Node yet.
- `RedisAdapter` accepts both `redis@^4` and `redis@^5` clients.
- New adapter: `PostgresAdapter`.
- `PostgresAdapter` uses composite `(prefix, uid)` primary key. The adapter auto-migrates the table on startup, but the migration runs DDL — use a low-traffic deployment window.
- `MongoAdapter` previously defaulted the prefix to `''`, producing the collection `__JobTasks__`. v6 defaults to `'default'`, producing `__JobTasks__default`. If you used the implicit empty prefix in v4/v5, pass `prefix: ''` explicitly to preserve the collection name, or migrate data: `db.__JobTasks__.renameCollection('__JobTasks__default')`.
- Lock release now checks lease ownership; a JoSk instance can no longer release a foreign lease. **If you have custom adapters, follow the [adapter API contract](adapter-api.md).**
- If you use `cron-parser` — bump to `^5` and switch from `parser.parseExpression(...)` to `CronExpressionParser.parse(...)`.
- v6 also added `concurrency` (default `Infinity`), Bun runtime support (≥1.1.0), and auto-`ready()` for sync handlers declared with `func.length === 0`.
