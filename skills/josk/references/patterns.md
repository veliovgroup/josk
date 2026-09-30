# JoSk patterns

## CRON

JoSk has no CRON parser. Compute the next run with `cron-parser` and pass it to `ready(date)`. `cron-parser@5` needs Node 18+; on older Node use `cron-parser@4` and `parser.parseExpression(expr)`.

```js
import { CronExpressionParser } from 'cron-parser';

const setCron = (uid, cronExpr, task) => {
  const nextRun = () => CronExpressionParser.parse(cronExpr).next().toDate();

  return jobs.setInterval(async (ready) => {
    try {
      await task();
    } finally {
      await ready(nextRun()); // schedule the next run even if the task fails
    }
  }, Math.max(0, +nextRun() - Date.now()), uid);
};

await setCron('daily-report', '0 9 * * *', () => sendReport());
```

Errors thrown by `task` still reach `onError`. For second-level expressions, raise `minRevolvingDelay` / `maxRevolvingDelay` (for example `512` / `1000`) to cut storage reads.

## Handler styles

```js
// Async (preferred): ready() is called when the Promise settles, errors go to onError
jobs.setInterval(async () => { await drainQueue(); }, 60_000, 'queue-1m');

// Sync with no parameters: ready() is called after return
jobs.setInterval(() => { recordHeartbeat(); }, 30_000, 'heartbeat-30s');

// Callback API: call ready() exactly once on every path
jobs.setInterval((ready) => {
  legacyApi.fetch((error, data) => {
    if (error) { ready(); return; }
    save(data);
    ready();
  });
}, 60_000, 'legacy-1m');
```

## Adaptive next run

`ready(date)` on an interval sets only the next run:

```js
jobs.setInterval(async (ready) => {
  const found = await pickUpJob();
  ready(found ? undefined : new Date(Date.now() + 5 * 60_000)); // idle: wait 5 min
}, 5_000, 'queue-poller');
```

## Arguments

Handlers receive only `ready`. Close over arguments, one `uid` per schedule:

```js
const sync = (region, ready) => { /* ... */ ready(); };
jobs.setInterval((ready) => sync('eu', ready), 60 * 60_000, 'sync-eu');
jobs.setInterval((ready) => sync('us', ready), 60 * 60_000, 'sync-us');
```

## Concurrency

`concurrency` caps handlers running at once in this process (default `Infinity`). Set it when handlers share a connection pool, a rate-limited API, or heavy CPU. It is per process; cluster-wide limits belong in the handler.

## Backpressure with `pause()` / `resume()`

For multi-instance setups with long handlers. Stop competing while this process is busy so peers claim the work:

```js
app.on('load-shed', () => jobs.pause());
app.on('load-ok', () => jobs.resume());

// only one heavy task on this instance
const reindex = await jobs.setInterval(runReindex, 3600_000, 'reindex-all');
jobs.pause(reindex);
jobs.resume(reindex);
```

Inside a handler, claim work from your own queue, pause, release the tick with `ready()`, then resume when the local work ends:

```js
await jobs.setInterval(async (ready) => {
  const batch = await queue.claim(50);
  if (batch.length === 0) {
    await ready();
    return;
  }

  jobs.pause();
  await ready();
  try {
    await processBatch(batch);
  } finally {
    jobs.resume();
  }
}, 5000, 'queue-poller');
```

Per-task variant: `jobs.pause(timerId)` / `jobs.resume(timerId)` in the same places. The handler does not receive its timer id; it is `uid + 'setInterval'`, so define it as a constant before registering rather than reading the `await jobs.setInterval()` result inside the handler (a past-due stored task can run before that resolves). `resume()` in `finally`; a process that crashes while paused stays paused until restart.

## `autoClear`

`'One of your tasks is missing'` means this instance claimed a task it has no handler for: renamed or removed code, or instances with different code on one prefix. `autoClear: true` deletes such tasks. Leave it `false` when instances with different task sets intentionally share a prefix.

## Graceful shutdown

```js
const shutdown = async () => {
  await jobs.shutdown({ timeout: 10_000 }); // wait for handlers, hand back unfinished claims
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

In tests, `jobs.destroy()` (sync) then close the driver client.

## Healthcheck

```js
app.get('/health/josk', async (_req, res) => {
  const result = await jobs.ping();
  res.status(result.code).json(result);
});
```
