# Operations

Storage layout per `prefix` and answers to common operational questions. For queries that find claims near their recovery deadline, see [monitoring](monitoring.md).

## Prefix mapping

`prefix` isolates scheduler state. Instances with the same prefix share one queue. Default: `default`.

| Adapter | Storage layout for `prefix: 'app'` | Notes |
|---|---|---|
| Redis | Default keys: `josk:app:schedule`, `josk:app:tasks`, `josk:app:lock`. With `useHashTags: true`: `josk:{app}:schedule`, `josk:{app}:tasks`, `josk:{app}:lock`. | Hash tags keep all keys on the same Cluster slot. Prefix must match `/^[A-Za-z0-9_\-:.]+$/` — special characters (notably `{` and `}`) are rejected to protect Cluster routing. |
| MongoDB | Collection `__JobTasks__app`; lock collection `__JobTasks__.lock` (shared across prefixes, scoped by `uniqueName` field) | Override the lock collection with `lockCollectionName`. Keep collection names short. MongoDB 4.4+ limits a namespace to 255 bytes including the database name. |
| PostgreSQL | Rows in `josk_tasks` filtered by `prefix='app'`; lock row in `josk_locks` with `lock_key='josk-app.lock'` | Table names are fixed. Use prefix for tenant/environment isolation. |

## Operational FAQ

### How do I monitor stuck tasks?

An interval that never calls `ready()` becomes claimable again after `zombieTime`. This recovery does not fire `onError`. The `'One of your tasks is missing'` error means this instance claimed a task it has no handler for. Past-due tasks show backlog, not stuck work. To find claims near their recovery deadline, see [monitoring](monitoring.md).

### How do I handle storage restarts?

JoSk catches adapter errors while polling and retries on the next poll. Locks held by crashed nodes expire on their own (Redis: `SET PX`, Mongo: TTL index, Postgres: `locked_until` against server time).

Adapter initialisation (Mongo index setup, the Postgres schema migration, the Redis reset when `resetOnInit` is set) is retried at most every 5 seconds until it succeeds. While it fails, `set*` calls reject, polls report to `onError`, and `ping()` returns 500. Tasks registered before the failure are kept in memory and start running once storage is reachable; a rejected `set*` call has to be repeated.

### `one` vs `batch` execute mode?

Use `batch` for throughput; it claims due tasks in chunks. Use `one` for smaller bursts per instance, fairer spread across instances, or when handlers contend on the same downstream resource.

### Jitter: Why is my interval running every `delay + maxRevolvingDelay` ms?

JoSk polls every `minRevolvingDelay` to `maxRevolvingDelay` ms, so the effective interval is `delay` plus poll latency. Lower `maxRevolvingDelay` for tighter intervals at the cost of more storage reads.

### What about clock skew between nodes?

Redis uses relative `PX` TTLs. Postgres computes lease expiry from `CURRENT_TIMESTAMP`, so node clock skew does not change lock lifetime. Mongo stores app-generated dates; keep Mongo app nodes time-synchronized.
