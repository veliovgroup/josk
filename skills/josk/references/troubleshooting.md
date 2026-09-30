# JoSk troubleshooting

## Zombie recovery

An interval whose handler never calls `ready()` (crash, hang, forgotten callback) is claimable again after `zombieTime` (default 15 min) and then runs again on whichever instance wins the claim. Restarting the app does not shorten a running claim. Keep `zombieTime` above the slowest handler plus margin, and call `await jobs.shutdown({ timeout })` on `SIGTERM` so running claims are handed back instead of waiting out `zombieTime`. If a handler routinely hits `zombieTime`, split the work or move it off the scheduler.

## Timing

A run starts at `executeAt + uniform(minRevolvingDelay, maxRevolvingDelay) + storage round-trip`: with defaults, up to about 0.8 s late, never early. Lower `maxRevolvingDelay` (for example `256`) for tighter timing at the cost of more storage reads. Intervals below about 2 s overlap with the round-trip. For wall-clock cadence use the CRON pattern in [patterns.md](patterns.md).

## Storage outages

Adapter errors during a poll are reported to `onError` and retried on the next poll. Locks held by crashed nodes expire on their own (Redis `SET PX`, Mongo TTL index, Postgres `locked_until` against server time). If storage is unreachable while the adapter initialises, JoSk retries initialisation at most every 5 s; meanwhile `set*` reject and `ping()` returns 500. Tasks registered before the outage start once storage is back; repeat rejected `set*` calls.

Clock skew: Redis and Postgres leases use relative TTLs or server time. Mongo stores app-generated dates, so keep Mongo app nodes time-synchronized, or use `PostgresAdapter` when clocks may diverge.

## A task runs twice

1. It is a `setInterval` whose handler exceeds `zombieTime`. Shorten the handler or raise `zombieTime`.
2. The handler declares `ready` but never calls it on some path. Call it, or drop the parameter and return a Promise.
3. Two prefixes store the same `uid`; each prefix is a separate schedule.
4. Multi-master Redis, or Mongo reads from a secondary. Use one writable primary, or `PostgresAdapter`.

## A task never runs, or runs late

1. Two `setInterval` calls share a `uid`; the second overwrites the first. (`setInterval` and `setTimeout` ids do not collide.)
2. The handler is registered on an instance that is down, and no other instance has it: `onError('One of your tasks is missing')`. Register handlers on every instance, or set `autoClear: true` for obsolete tasks.
3. A `setTimeout` / `setImmediate` crashed mid-run. That is at-most-once; use an idempotent `setInterval` when a miss is worse than a duplicate.
4. `josk` 6.3 or older reset every interval to `now + delay` on each boot, so frequent restarts postponed runs indefinitely. Upgrade.
5. `PostgresAdapter` before 6.2 dropped delays above about 24.85 days (`INTEGER` column). Upgrade.

## Redis Cluster errors

`CROSSSLOT`: the adapter needs `useHashTags: true` on a cluster client. `MOVED` with `redis@4` on `josk` 6.3 or older: upgrade to 6.4+.

## MongoAdapter fails at startup

Since 6.5.0 `MongoAdapter` never drops an index. Startup fails with `duplicate "uid" documents` or `index "..." is not a plain unique index` when the collection holds duplicates or a conflicting index on the same keys. Dedupe or fix the index, then restart: [MongoDB guide](https://github.com/veliovgroup/josk/blob/master/docs/mongodb.md). On a replica set use `w: 'majority'`, or a claim that reached only the primary can vanish on failover.

## PostgresAdapter connection errors

`Connection terminated due to connection timeout` with `pg@7`: use `pg@>=8.0.3`. The `Cannot find module 'pg-native'` log is a harmless optional binding.

## Upgrades

Guides: [v4 to v5](https://github.com/veliovgroup/josk/blob/master/docs/migration-v4-v5.md), [v5 to v6](https://github.com/veliovgroup/josk/blob/master/docs/migration-v5-v6.md), [v6 to v6.1](https://github.com/veliovgroup/josk/blob/master/docs/migration-v6-v6.1.md), [v6.1 to v6.2](https://github.com/veliovgroup/josk/blob/master/docs/migration-v6.1-v6.2.md), [v6.2 to v6.3](https://github.com/veliovgroup/josk/blob/master/docs/migration-v6.2-v6.3.md), [v6.3 to v6.4](https://github.com/veliovgroup/josk/blob/master/docs/migration-v6.3-v6.4.md), [v6.4 to v6.5](https://github.com/veliovgroup/josk/blob/master/docs/migration-v6.4-v6.5.md).

`MongoAdapter` data from v4/v5 with the default prefix lives in `__JobTasks__`; v6 reads `__JobTasks__default`, and `prefix: ''` does not select the old collection. Stop every instance, then run `db.__JobTasks__.renameCollection('__JobTasks__default')`.
