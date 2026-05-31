# Migration guide (v6.1 → v6.2)

`v6.2.0` adds instance-level `pause()` / `resume()` for multi-instance backpressure. The PostgreSQL adapter ships an automatic, idempotent schema migration; Redis and Mongo are unchanged.

## What changed

- **`pause()`** — this JoSk instance stops acquiring the scheduler lease on revolving ticks. Tasks stay in storage; other cluster members keep competing.
- **`pause(timerId)`** — when this instance claims that task, it reschedules via `adapter.update` without running the handler (default defer ≥2s) so another instance can take it.
- **`resume()`** / **`resume(timerId)`** — clear the matching pause scope and nudge the revolving loop.
- **PostgreSQL `delay` column widened `INTEGER` → `BIGINT`** (schema version `1` → `2`). The old `INTEGER` column capped delays/intervals at int4 (`2147483647` ms ≈ 24.85 days); longer values overflowed and the task was silently dropped on `add()`. Monthly-scale schedules now store correctly.

`timerId` is the string returned from `setInterval`, `setTimeout`, or `setImmediate` (e.g. `'poll-1msetInterval'`). **Not** the bare `uid` passed into `set*`.

## Upgrade steps

1. Bump `josk` to `^6.2.0` (or `ostrio:cron-jobs@6.2.0` on Meteor).
2. Redis/Mongo: no migration. PostgreSQL: the `delay` widening runs automatically on the first `ready()` after upgrade, guarded by an advisory lock so concurrent boots are safe. `ALTER COLUMN … TYPE BIGINT` rewrites the `josk_tasks` table under a brief lock proportional to row count (negligible — one row per scheduled task). No manual step.
3. Opt in to `pause` / `resume` only where you run **multiple JoSk instances** on the same adapter prefix and need this process to yield during saturation or long local work.

## When to use pause/resume

| Scenario | Action |
|---|---|
| Single-instance app | Skip — no peer to pick up deferred work |
| Short handlers | Skip — call `ready()` early instead |
| Pod CPU/memory saturated | `pause()` while recovering |
| One heavy task on this pod | `pause(timerId)` after `set*` |
| Long work inside a tick | `pause()` / `pause(timerId)`, `ready()`, work locally, `resume()` in `finally` |

## Breaking changes

None. `pause()` / `resume()` are additive, and the PostgreSQL `delay` widening is backward-compatible — existing rows are preserved and the migration is a no-op on fresh installs (which already create the column as `BIGINT`).

## TypeScript

`pause(timerId?: string): boolean` and `resume(timerId?: string): boolean` are on `JoSk` in `index.d.ts` / `index.d.cts`. Regenerate declarations only if you vendor JoSk from source.
