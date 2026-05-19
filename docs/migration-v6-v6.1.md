# Migration guide (v6 → v6.1)

`v6.1.0` adds `RedisAdapter({ useHashTags: true })` for Redis Cluster / KeyDB Cluster slot routing, tightens delay validation, and isolates user hook failures from the scheduler loop.

- Default Redis keys are unchanged: `josk:prefix:schedule`, `josk:prefix:tasks`, `josk:prefix:lock`.
- Opt-in hash-tag keys are new: `josk:{prefix}:schedule`, `josk:{prefix}:tasks`, `josk:{prefix}:lock`.
- Do not enable `useHashTags` against existing Redis data without either migrating keys or starting from empty adapter state.
- `setInterval` / `setTimeout` now reject `NaN`, `Infinity`, and non-numeric delays at registration time. Code that previously passed `NaN` would silently corrupt `nextExecuteAt`; that path now throws synchronously.
- `onError` / `onExecuted` hook throws and Promise rejections are now caught and logged to `console.error` instead of propagating into the scheduler loop.

## You may already be affected (pre-v6.1 docs vs. reality)

Pre-v6.1 documentation claimed `RedisAdapter` keys were laid out as `josk:{prefix}:*` (hash-tagged). The implementation never did that — keys were always `josk:prefix:*`. Anyone who deployed JoSk v5 or v6.0 against a real **Redis Cluster** or **KeyDB Cluster** was effectively miswired: `schedule`, `tasks`, and `lock` keys may have hashed to different slots, breaking the multi-key Lua scripts that drive atomic claims. If your cluster deployment "mostly worked" it was either coincidence (prefix hashed favorably) or you were running through a proxy that hides `CROSSSLOT` errors.

If you ran v5/v6.0 on a Redis Cluster or KeyDB Cluster: opt into `useHashTags: true` and recreate scheduler state.

## When to enable `useHashTags`

Use `useHashTags: true` when JoSk runs against **Redis Cluster** or **KeyDB Cluster**, so Lua scripts that touch `schedule`, `tasks`, and `lock` keys stay in one hash slot. Standalone Redis / single-primary KeyDB can keep the default (`false`).

## Key migration

Pick the path that matches your topology.

### Standalone Redis / single-primary KeyDB

`RENAME` keeps the old data:

1. Stop all JoSk instances.
2. `RENAME josk:<prefix>:schedule josk:{<prefix>}:schedule`.
3. `RENAME josk:<prefix>:tasks    josk:{<prefix>}:tasks`.
4. `RENAME josk:<prefix>:lock     josk:{<prefix>}:lock` (or just `DEL` it — it expires on the next tick).
5. Deploy with `useHashTags: true` and verify with `ping()` before resuming traffic.

### Redis Cluster / KeyDB Cluster

`RENAME` and most multi-key commands return `CROSSSLOT` here because source and target hash to different slots — that is the whole reason you are migrating. Use `DUMP` + `RESTORE`:

1. Stop all JoSk instances.
2. For each legacy key (`josk:<prefix>:schedule`, `josk:<prefix>:tasks`, `josk:<prefix>:lock`):
   - `DUMP josk:<prefix>:<name>` on its owner node.
   - `RESTORE josk:{<prefix>}:<name> 0 <dump-bytes>` on the node that owns the new hash-tagged slot.
   - `DEL` the legacy key once the restore is verified.
3. Skip the `lock` key if you prefer — it self-expires within `zombieTime` of the first new tick.
4. Deploy with `useHashTags: true` and verify with `ping()` before resuming traffic.

### Acceptable to start fresh

If losing in-flight schedule state is acceptable (e.g. all tasks are recurring `setInterval`s that re-register on boot), skip the migration and deploy once with `resetOnInit: true` against the new key layout. Revert `resetOnInit` to `false` on the next deploy.
