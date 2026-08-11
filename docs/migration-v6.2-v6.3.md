# Migrating from v6.2 to v6.3

v6.3 separates scheduler lease lifetime from stuck-task recovery time. Public methods and task execution guarantees remain unchanged.

## Scheduler lease

Scheduler locks now expire after `lockLeaseTime`, not `zombieTime`. Default is `min(zombieTime, 30000)`, floored at `2 * maxRevolvingDelay + 1000` milliseconds. This limits cluster-wide stalls after an instance dies while holding a lock.

`zombieTime` still controls when a claimed interval task becomes eligible for recovery. Keep it longer than maximum handler runtime.

Most apps need no configuration change. Set an explicit lease only when storage latency or unusually slow claim batches exceed default:

```js
const jobs = new JoSk({
  adapter,
  zombieTime: 900000,
  lockLeaseTime: 60000,
});
```

## Custom adapters

Use expiry carried by `lock.expireAt` or `lock.expiresAtMs`. Do not substitute `joskInstance.zombieTime`. Keep lock release owner-bound with `ownerId` and `leaseId`.

Redis batch claiming stops before lease expiry and resumes remaining due tasks on next scheduler revolution.

PostgreSQL derives `locked_until` from database `CURRENT_TIMESTAMP` plus relative lease duration. App-node clock skew no longer changes PostgreSQL lease lifetime.
