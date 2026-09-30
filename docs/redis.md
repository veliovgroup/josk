# Redis tuning for JoSk

This document collects Redis-specific guidance for users of the `RedisAdapter`. The README covers the basic setup. Read that first.

## Compatible servers

`RedisAdapter` uses the Redis-compatible commands shared by Redis, [KeyDB](https://docs.keydb.dev/), and Valkey. CI targets Redis 6/7/8, `eqalpha/keydb:x86_64_v6.3.4`, and `valkey/valkey:8.1.9-alpine` in standalone mode using `redis@5`. The `redis@4` and `redis@5` drivers both run against `redis:8` and against a 3-master Redis Cluster.

## Topology

- Use one writable primary. Do not route JoSk reads or writes to replicas; claims must be visible to all instances at once.
- For Redis Cluster, pass `useHashTags: true`; CI tests a 3-master Redis Cluster. KeyDB/Valkey Cluster modes are not separately tested.
- Avoid KeyDB active-replication (multi-master). Its conflict resolution can let two writers claim the same task.
- For strict single-claim scheduling across data centers, use a strongly consistent store, or PostgreSQL with one write authority.

## Hash tags

With `useHashTags: true` the adapter uses `josk:{prefix}:*` keys, so all of them live in one Cluster slot. The constructor throws for a cluster client without it. To switch existing data to hash-tag keys, follow the [v6.1 migration guide](migration-v6-v6.1.md#key-migration).

## Related

- Key names per `prefix`: [prefix mapping](operations.md#prefix-mapping)
- Queries for claimed tasks: [monitoring](monitoring.md#redis)
- Commands that delete scheduler keys: [clean up old tasks](testing.md#clean-up-redis)
