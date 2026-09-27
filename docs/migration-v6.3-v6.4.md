# Migrating from v6.3 to v6.4

v6.4 makes interval recovery safer during restarts and deploys. Public methods keep their signatures; `shutdown()` is new.

## Interval re-registration

Calling `setInterval()` for a stored task no longer pushes its next run back on every boot:

| Stored task | Next run |
|---|---|
| New, or not claimed with a different `delay` | `now + delay` |
| Not claimed, same `delay` | Earlier of stored `executeAt` and `now + delay` |
| Claimed (running on some instance) | Unchanged until `ready()` or `zombieTime` |

A rolling deploy can no longer start a second copy of a handler that is still running. The trade-off: after an unclean kill, recovery waits the full `zombieTime` (15 minutes by default), not `delay`. Use `shutdown()` to avoid that wait.

## Graceful shutdown

```js
process.on('SIGTERM', async () => {
  await jobs.shutdown({ timeout: 10000 }); // wait for handlers, hand back unfinished claims
  process.exit(0);
});
```

`destroy()` still returns immediately. It now hands back tasks this instance claimed but had not started. Repeated `shutdown()` calls share the first attempt and timeout. If it times out, unfinished runs are reported through `onError` (or `console.error`); interval claims are handed back, while one-shots are abandoned to preserve at-most-once behavior. Keep one-shot handlers idempotent, or set `timeout` above their longest runtime.

## Stale `ready()` calls

JoSk skips a late `ready()` write when a newer same-uid run starts in the same process. Built-in adapters also fence writes after recovery by another instance. Custom adapters without claim-lease or equivalent update fencing remain compatible, but a late handler on another process can overwrite the newer schedule.

Shutdown still waits for the latest superseded handler of each task; older superseded handlers are not tracked, so a handler that never calls `ready()` does not accumulate entries. If one remains unfinished at timeout, shutdown returns `false`, but does not hand its obsolete claim back or change the newer run's schedule.

## Rollout

- Upgrade all instances. A v6.3 peer still resets claimed intervals to `now + delay` on boot.
- The first registration after upgrading may keep a stale claim marker once, preserving the stored next run; the next `ready()` clears it.

## Redis Cluster

- `RedisAdapter` now throws when given a cluster client without `useHashTags: true`. That setup failed on every Lua call with `CROSSSLOT` before.
- With `redis@4`, v6.3 sent scripts to a random master and ~4% of calls failed with `MOVED`. v6.4 routes them by key.

## TypeScript

Declarations no longer import `redis` or `mongodb`, so projects with `skipLibCheck: false` compile without unused drivers. `adapter.client` and `adapter.db` keep your driver's full type.

## Custom adapters

Optional, recommended: return `claimLeaseId: lock.leaseId` on claimed tasks and make `update()` match the stored lease, update the schedule, and clear it atomically. JoSk already suppresses late updates from superseded same-process runs. Adapters that ignore the field keep working, but need equivalent storage fencing for cross-instance protection. See [adapter-api.md](adapter-api.md).
