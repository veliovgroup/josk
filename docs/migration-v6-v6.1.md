# Migration guide (v6 → v6.1)

`v6.1.0` adds `RedisAdapter({ useHashTags: true })` for Redis Cluster / KeyDB Cluster slot routing.

- Default Redis keys are unchanged: `josk:prefix:schedule`, `josk:prefix:tasks`, `josk:prefix:lock`.
- Opt-in hash-tag keys are new: `josk:{prefix}:schedule`, `josk:{prefix}:tasks`, `josk:{prefix}:lock`.
- Do not enable `useHashTags` against existing Redis data without either migrating keys or starting from empty adapter state.

## When to enable `useHashTags`

Use `useHashTags: true` when JoSk runs against **Redis Cluster** or **KeyDB Cluster**, so Lua scripts that touch `schedule`, `tasks`, and `lock` keys stay in one hash slot. Standalone Redis / single-primary KeyDB can keep the default (`false`).

## Key migration (optional)

If you already have data under `josk:prefix:*` and must move to hash-tagged keys without losing tasks:

1. Stop all JoSk instances.
2. `RENAME` (or copy) `josk:prefix:schedule`, `josk:prefix:tasks`, and `josk:prefix:lock` to the `josk:{prefix}:*` names.
3. Scan and rename legacy per-task keys `josk:prefix:task:*` → `josk:{prefix}:task:*` if any remain.
4. Deploy with `useHashTags: true` and verify with `ping()` before resuming traffic.

Alternatively, run once with `resetOnInit: true` on an empty cluster only if losing in-flight schedule state is acceptable.
