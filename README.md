[![npm version][badge-npm-v]][npm-url]
[![npm downloads][badge-npm-dm]][npm-url]
[![CI][badge-ci]][ci-url]
[![minified size][badge-size]][size-url]
[![Coverage][badge-cov]](#running-tests)
[![License: BSD-3-Clause][badge-license]][license-url]
[![Node.js][badge-node]][node-url]
[![TypeScript][badge-ts]][ts-url]
[![Bun][badge-bun]][bun-url]
[![Meteor.js][badge-meteor]][meteor-url]
[![zero dependencies][badge-deps]][npm-url]
[![Sponsor][badge-sponsor]][sponsor-url]
[![Donate][badge-donate]][donate-url]
<a href="https://bridge-cdn.com/?ref=github-josk-repo-top"><img src="https://bridge-cdn.com/favicon.svg" height="20"></a>
<a href="https://ostr.io/info/built-by-developers-for-developers?ref=github-josk-repo-top"><img src="https://ostr.io/apple-touch-icon-60x60.png" height="20"></a>
<a href="https://meteor-files.com/?ref=github-josk-repo-top"><img src="https://meteor-files.com/apple-touch-icon-60x60.png" height="20"></a>

# JoSk

"JoSk" is a Node.js task manager for horizontally scaled apps: clusters, multi-server setups, and multi-threaded instances on one or many machines or data centers. It works the same in a single-instance app.

"JoSk" mimics the native `setTimeout` and `setInterval` API and supports [CRON expressions](#cron). Tasks sync between all app instances through Redis, MongoDB, PostgreSQL, or a [custom adapter](https://github.com/veliovgroup/josk/blob/master/docs/adapter-api.md). Storage-level leases and atomic claims give each due tick to one instance; delivery guarantees depend on the [scheduling method](#execution-semantics).

__Note: JoSk is the server-only package.__

## ToC

- [Main features](#main-features)
- [Prerequisites](#prerequisites)
- [Install](#install) as [NPM package](https://www.npmjs.com/package/josk)
  - [Bun runtime](#bun-runtime)
  - [Agent Skill (Claude Code, Codex, Cursor, Copilot, Windsurf, …)](#agent-skill)
- [API](#api)
  - [Constructor `new JoSk()`](#new-joskopts)
  - [Initialization](#initialization): [Redis](#redis-adapter), [MongoDB](#mongodb-adapter), [PostgreSQL](#postgresql-adapter)
  - [`setInterval()`](#setintervalfunc-delay-uid), [`ready()`](#ready-argument-forms)
  - [`setTimeout()`](#settimeoutfunc-delay-uid)
  - [`setImmediate()`](#setimmediatefunc-uid)
  - [`clearInterval()`](#clearintervaltimerid), [`clearTimeout()`](#cleartimeouttimerid)
  - [`destroy()`](#destroy), [`shutdown()`](#shutdownopts), [`ping()`](#ping)
  - [`pause()`](#pause), [`resume()`](#resume)
- [Execution semantics](#execution-semantics)
- [TypeScript](#typescript)
- [Examples](#examples)
  - [CRON](#cron)
  - [Pass arguments](#pass-arguments)
  - [Clean up old tasks](#clean-up-old-tasks)
  - [MongoDB tuning](#mongodb-connection-fine-tuning)
  - [Meteor.js](https://github.com/veliovgroup/josk/blob/master/docs/meteor.md)
- [Prefix mapping](#prefix-mapping)
- [Operational FAQ](#operational-faq)
- [Migration guides](https://github.com/veliovgroup/josk/blob/master/docs/README.md#migration-guides)
- [Notes](#notes)
- [Running tests](#running-tests)
- [Why "JoSk"](#why-josk)
- [Support](#support-our-open-source-contribution)

## Main features

- 🏢 Synchronize single task across multiple servers;
- 🔏 Read locking to avoid simultaneous task executions across complex infrastructure;
- 📦 Zero dependencies, written from scratch for top performance;
- 👨‍🔬 ~99% tests coverage;
- 💪 Bulletproof design, built-in retries, and "zombie" task recovery 🧟🔫.

## Prerequisites

- `node@>=20.9.0`
- `redis-server@>=5.0.0` or a single-writer KeyDB/Valkey server for `RedisAdapter`, with `redis@^4` or `redis@^5`. CI targets selected standalone images; see [Redis Adapter](#redis-adapter) for exact coverage.
- `mongod@>=4.4` for `MongoAdapter`, with the official `mongodb` NPM package (only the official driver is tested)
- `postgres@>=12` for `PostgresAdapter`, with `pg@>=8.0.3` (`pg@7` does not connect on Node 14+)
- `bun@>=1.1.0` (optional), see [Bun runtime](#bun-runtime)

### Older releases compatibility

- `node@<20.9.0` — use `josk@^5`
- `mongod@<4.0.0` — use `josk@=1.1.0`
- `node@<14.20.0` — use `josk@=3.0.2`
- `node@<8.9.0` — use `josk@=1.1.0`

## Install:

```shell
npm install josk --save
```

```js
// ES Module Style
import { JoSk, RedisAdapter, MongoAdapter, PostgresAdapter } from 'josk';

// CommonJS
const { JoSk, RedisAdapter, MongoAdapter, PostgresAdapter } = require('josk');
```

### Bun runtime

*Since* `v6.0.0`

JoSk runs unmodified on [Bun](https://bun.sh) `>=1.1.0` with the same `mongodb`, `pg`, and `redis` drivers. Install with `bun add josk`. Node and Bun processes can share one `prefix`, since leases and claims live in storage. `npm run test:bun` runs the Jest suite under `bun:test`, see [Running tests](#running-tests).

### Agent Skill

JoSk ships an [Agent Skill](https://github.com/vercel-labs/skills) with the public API, adapter setup, execution semantics, CRON and handler patterns, and common pitfalls. It works with 50+ AI coding agents; pass `-a claude-code` to target one.

```sh
# Install the JoSk skill globally:
npx skills add veliovgroup/josk -g

# Or install the JoSk skill into the current project:
npx skills add veliovgroup/josk
```

The skill is distributed via GitHub and is not part of the npm tarball.

## API:

### `new JoSk(opts)`

- `opts.adapter` {*RedisAdapter*|*MongoAdapter*|*PostgresAdapter*} - [Required] Instance of adapter or [custom](https://github.com/veliovgroup/josk/blob/master/docs/adapter-api.md)
- `opts.debug` {*Boolean*} - [Optional] Enable debugging messages, useful during development
- `opts.autoClear` {*Boolean*} - [Optional] Remove stored tasks that have no handler registered in this instance. Such tasks appear after a task is renamed or removed from code, or when instances with different codebases share one storage. Default: `false`
- `opts.zombieTime` {*Number*} - [Optional] Interval recovery hold in milliseconds, used when a handler never calls `ready()` or its process dies. Caught handler errors go to `onError` and complete the run; they do not wait for zombie recovery. Keep it above the slowest legitimate handler runtime plus margin; below `60000` is not recommended. Default: `900000` (15 minutes)
- `opts.lockLeaseTime` {*Number*} - [Optional] Scheduler lease TTL in milliseconds. Default: `min(zombieTime, 30000)`, floored at `2 * maxRevolvingDelay + 1000`. See [v6.3 migration notes](https://github.com/veliovgroup/josk/blob/master/docs/migration-v6.2-v6.3.md)
- `opts.execute` {*String*} - [Optional] `batch` drains all due tasks under one scheduler lease; `one` claims one task per lease. Default: `batch`
- `opts.concurrency` {*Number*} - [Optional] Maximum handlers running in parallel in this instance. Use a positive integer when handlers share rate-limited resources; `Infinity` disables the cap. Default: `Infinity`
- `opts.lockOwnerId` {*String*} - [Optional] Stable owner id used as the prefix of scheduler lease tokens, for observability and for re-claiming this instance's leases after a planned restart. Default: `crypto.randomUUID()` per instance
- `opts.minRevolvingDelay` {*Number*} - [Optional] Minimum delay between scheduler polls in milliseconds. Default: `128`
- `opts.maxRevolvingDelay` {*Number*} - [Optional] Maximum delay between scheduler polls in milliseconds. Default: `768`
- `opts.onError` {*Function*} - [Optional] Informational hook, called instead of throwing exceptions. Default: `false`. Called with two arguments:
  - `title` {*String*}
  - `details` {*Object*}
  - `details.description` {*String*}
  - `details.error` {*Mix*}
  - `details.uid` {*String*} - Internal `uid`, suitable for `.clearInterval()` and `.clearTimeout()`
  - `details.task` {*Mix*} - Present only for malformed-task errors; the offending task payload
- `opts.onExecuted` {*Function*} - [Optional] Informational hook, called when a handler signals completion, including after a caught error. It does not indicate success. Default: `false`. Called with two arguments:
  - `uid` {*String*} - `uid` passed into `.setImmediate()`, `.setTimeout()`, or `setInterval()` methods
  - `details` {*Object*}
  - `details.uid` {*String*} - Internal `uid`, suitable for `.clearInterval()` and `.clearTimeout()`
  - `details.date` {*Date*} - Execution timestamp as JS {*Date*}
  - `details.delay` {*Number*} - Execution `delay` (e.g. `interval` for `.setInterval()`)
  - `details.timestamp` {*Number*} - Execution timestamp as unix {*Number*}

Hook throws and async rejections are logged and isolated from scheduler execution.

### `new RedisAdapter(opts)`

*Since* `v5.0.0`

- `opts.client` {*RedisClient*} - [*Required*] Connected client, e.g. from `await createClient().connect()` or `createCluster()`
- `opts.prefix` {*String*} - [Optional] use to create multiple named instances
- `opts.resetOnInit` {*Boolean*} - [Optional] (*__use with caution__*) Delete all tasks for this `prefix` on init. For single-instance apps that need a clean start after a crash. Default: `false`
- `opts.useHashTags` {*Boolean*} - [Optional] Use hash-tag keys (`josk:{prefix}:*`) so all adapter keys live in one slot. Required for Redis Cluster; the constructor throws for a cluster client without it. Default: `false` (`josk:prefix:*`)

### `new MongoAdapter(opts)`

*Since* `v5.0.0`

- `opts.db` {*Db*} - [*Required*] `Db` instance from `MongoClient#db()`
- `opts.prefix` {*String*} - [Optional] use to create multiple named instances
- `opts.lockCollectionName` {*String*} - [Optional] Lock collection name. Default: `__JobTasks__.lock`, shared by all JoSk instances. Use a separate name for JoSk 6 while JoSk 5 services still use the default, see [MongoDB guide](docs/mongodb.md#sharing-the-lock-collection-between-josk-5-and-6)
- `opts.resetOnInit` {*Boolean*} - [Optional] (*__use with caution__*) Delete all tasks for this `prefix` on init. For single-instance apps that need a clean start after a crash. Default: `false`

### `new PostgresAdapter(opts)`

*Since* `v6.0.0`

- `opts.client` {*Pool*|*Client*} - [*Required*] `pg` client with `.query()` method. Use `Pool` for long-running apps
- `opts.prefix` {*String*} - [Optional] Isolated scheduler namespace in the same database. Default: `default`
- `opts.resetOnInit` {*Boolean*} - [Optional] (*__use with caution__*) Delete tasks and locks for this `prefix` on init. Default: `false`

### Initialization

JoSk has no dependencies. Install the driver for your adapter: `redis`, `mongodb`, or `pg`. To use other storage, write a [custom adapter](docs/adapter-api.md).

#### Redis Adapter

`RedisAdapter` keeps due timestamps in a sorted set and task payloads in a hash, and claims due tasks with Lua scripts. It uses the Redis-compatible commands shared by Redis, [KeyDB](https://docs.keydb.dev/), and Valkey; CI targets Redis 6/7/8, `eqalpha/keydb:x86_64_v6.3.4`, and `valkey/valkey:8.1.9-alpine` in standalone mode using `redis@5`.

- Use one writable primary. Do not route JoSk reads or writes to replicas; claims must be visible to all instances at once.
- For Redis Cluster, pass `useHashTags: true`; CI tests a 3-master Redis Cluster. KeyDB/Valkey Cluster modes are not separately tested.
- Avoid KeyDB active-replication (multi-master). Its conflict resolution can let two writers claim the same task.
- For strict single-claim scheduling across data centers, use a strongly consistent store, or PostgreSQL with one write authority.

```js
import { JoSk, RedisAdapter } from 'josk';
import { createClient } from 'redis';

const redisClient = await createClient({
  url: 'redis://127.0.0.1:6379'
}).connect();

const jobs = new JoSk({
  adapter: new RedisAdapter({
    client: redisClient,
    prefix: 'app-scheduler',
    // useHashTags: true, // Redis Cluster; KeyDB/Valkey Cluster not CI-tested
  }),
  onError(reason, details) {
    // Catches exceptions thrown inside scheduled tasks
    console.log(reason, details.error);
  }
});
```

#### MongoDB Adapter

`MongoAdapter` creates two collections per `prefix`: one for tasks and one with the `.lock` suffix for scheduler locks.

```js
import { JoSk, MongoAdapter } from 'josk';
import { MongoClient } from 'mongodb';

const client = new MongoClient('mongodb://127.0.0.1:27017');
// Use a separate DB from the "main" one to avoid lock contention
const mongoDb = client.db('joskdb');
const jobs = new JoSk({
  adapter: new MongoAdapter({
    db: mongoDb,
    prefix: 'cluster-scheduler',
  }),
  onError(reason, details) {
    // Catches exceptions thrown inside scheduled tasks
    console.log(reason, details.error);
  }
});
```

#### PostgreSQL Adapter

*Since* `v6.0.0`

`PostgresAdapter` creates and migrates the `josk_tasks` and `josk_locks` tables on init, in the client's current database and schema. Table names are fixed; `prefix` isolates namespaces.

- Use `pg.Pool`. Share the app's pool, or give the scheduler a small dedicated one.
- Use one writable primary. Do not route JoSk reads or writes to replicas.
- Prefer a dedicated database or schema.
- Keep `resetOnInit: false` in clustered production.
- `execute: 'batch'` claims due tasks with `FOR UPDATE SKIP LOCKED`; `execute: 'one'` uses `LIMIT 1` per lease.

```js
import { JoSk, PostgresAdapter } from 'josk';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: 'postgres://user:pass@localhost:5432/joskdb'
});

const jobs = new JoSk({
  adapter: new PostgresAdapter({
    client: pool,
    prefix: 'cluster-scheduler',
  }),
  onError(reason, details) {
    // Catches exceptions thrown inside scheduled tasks
    console.log(reason, details.error);
  }
});
```

#### Create the first task

```js
jobs.setInterval((ready) => {
  /* ...code here... */
  ready();
}, 60 * 60000, 'task1h'); // every hour

// No need to call ready() when the handler takes no arguments and returns a Promise
jobs.setInterval(async () => {
  await asyncMethod();
}, 30 * 60000, 'asyncTask30m'); // every 30 mins
```

`uid` identifies a task across the cluster. Use a different `uid` for each schedule, even for the same function:

```js
jobs.setInterval(task, 60000, 'task-1m'); // every minute
jobs.setInterval(task, 2 * 60000, 'task-2m'); // every two minutes
```

### `setInterval(func, delay, uid)`

- `func` {*Function*} - Function to call on schedule. Receives `ready` as the first argument
- `delay` {*Number*} - Delay for the first run of a new task and interval between further executions in milliseconds
- `uid` {*String*} - Unique app-wide task id
- Returns: {*`Promise<string>`*}

The next run is scheduled when the handler calls `ready()`, so a run never overlaps the previous one:

```js
jobs.setInterval((ready) => {
  /* ...code... */
  ready();
}, 60 * 60000, 'task1h'); // every hour + handler runtime

jobs.setInterval((ready) => {
  ready(); // schedule the next run first
  /* ...code... */
}, 60 * 60000, 'task1hStrict'); // every hour, the next run may start before this one ends
```

With callback APIs, call `ready()` on every path, including errors:

```js
jobs.setInterval((ready) => {
  asyncCall((error, result) => {
    if (error) {
      ready(); // <-- Always call `ready()`, even if the call failed
      return;
    }

    waitForSomethingElse(result, () => {
      ready(); // <-- End of the full execution
    });
  });
}, 0, 'longRunningTask'); // runs again as soon as the previous run is finished
```

When the app restarts and calls `setInterval()` again for a stored task, JoSk picks the next run from the stored state. A task is *claimed* while an instance runs it and has not yet called `ready()`:

| Stored task | Next run |
|---|---|
| None, or not claimed with a different `delay` | `now + delay` |
| Not claimed, same `delay` | Earlier of the stored `executeAt` and `now + delay`. A past-due task runs on the first poll after boot |
| Claimed | Unchanged. It stays held until `ready()` or `zombieTime` expires, even if `delay` changed |

To restart an unclaimed interval's countdown, call `clearInterval()` before registering it again. `setTimeout()` and `setImmediate()` always schedule from registration time.

#### `ready()` argument forms

`ready` returns `Promise<boolean>` and accepts:

- `ready()` — schedule the next interval run at `now + delay`.
- `ready(date)` — `Date`; schedule the next interval run at that moment. A date in the past falls back to `now + delay`. Use with [CRON](#cron).
- `ready(timestamp)` — ms-epoch number; same as `ready(date)`.
- `ready(callback)` — Node-style `(error, success) => void`. It fires before the storage update; await the returned Promise to wait for persistence.

Dates and timestamps only apply to `setInterval`. `setTimeout` and `setImmediate` tasks are removed from storage before their handler runs.

Calling `ready()` twice rejects the returned Promise (or passes an error to the callback) with *"Resolution method is overspecified"*. Call it at most once per run.

When a handler takes no arguments (`async () => { … }` or `() => doSomething()`), JoSk calls `ready()` when its returned Promise settles.

### `setTimeout(func, delay, uid)`

- `func` {*Function*} - Function to call after `delay`. Receives `ready` as the first argument
- `delay` {*Number*} - Delay in milliseconds
- `uid` {*String*} - Unique app-wide task id
- Returns: {*`Promise<string>`*}

Runs at most once across the cluster. Use it where a duplicate run is worse than a missed one.

```js
jobs.setTimeout((ready) => {
  asyncCall(() => {
    /* ...code... */
    ready();
  });
}, 60000, 'taskIn1m');

jobs.setTimeout(async () => {
  await asyncMethod();
}, 60000, 'asyncTaskIn1m');
```

### `setImmediate(func, uid)`

- `func` {*Function*} - Function to execute. Receives `ready` as the first argument
- `uid`  {*String*}   - Unique app-wide task id
- Returns: {*`Promise<string>`*}

Runs once, as soon as the next scheduler poll claims it. At most once across the cluster, like `setTimeout`.

```js
jobs.setImmediate((ready) => {
  /* ...code... */
  ready();
}, 'syncTask');

jobs.setImmediate(async () => {
  await asyncMethod();
}, 'asyncTask');
```

### `clearInterval(timerId)`

- `timerId` {*String*|*`Promise<string>`*} — Timer id returned from `JoSk#setInterval()` method
- Returns: {`Promise<boolean>`} `true` when task is successfully cleared, or `false` when task was not found

```js
const timer = await jobs.setInterval(func, 34789, 'unique-taskid');
await jobs.clearInterval(timer);
```

### `clearTimeout(timerId)`

- `timerId` {*String*|*`Promise<string>`*} — Timer id returned from `JoSk#setTimeout()` method
- Returns: {`Promise<boolean>`} `true` when task is successfully cleared, or `false` when task was not found

```js
const timer = await jobs.setTimeout(func, 34789, 'unique-taskid');
await jobs.clearTimeout(timer);
```

### `destroy()`

- Returns: {*boolean*} `true` if instance successfully destroyed, `false` if instance already destroyed

Stops this instance's scheduler. After `destroy()`, only `clearTimeout()` and `clearInterval()` work; other methods report an error to `onError` (or `stdout`).

`destroy()` does not wait for running handlers. Tasks this instance claimed but had not started go back to storage. An interval killed mid-run is recovered by another instance after `zombieTime`; use [`shutdown()`](#shutdownopts) before process exit to avoid that wait.

### `shutdown(opts)`

*Since* `v6.4.0`

- `opts.timeout` {*Number*} - [Optional] Milliseconds to wait for running handlers to call `ready()`. Default: `10000`
- Returns: {*`Promise<boolean>`*} `true` if every running handler finished within `timeout`

Calls `destroy()`, waits for running handlers, then hands unfinished interval claims back to storage so another instance runs them on its next poll instead of after `zombieTime`. A handler that calls `ready()` after its claim was handed back does not change the schedule; `onExecuted` still fires because the handler ran. Repeated calls share the first shutdown attempt and timeout; when it expires, JoSk reports every unfinished handler to `onError` (or `console.error`), hands current interval claims back, and abandons one-shot tasks to preserve at-most-once behavior. The latest superseded handler of each task also counts as unfinished, but its obsolete claim is left unchanged; older superseded handlers are not tracked. Keep at-most-once handlers idempotent, or set `timeout` longer than the longest one-shot handler; keep it below your platform's termination grace period.

```js
const shutdown = async () => {
  await jobs.shutdown({ timeout: 10000 });
  process.exit(0);
};

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
```

### `ping()`

- Returns: {*`Promise<object>`*}

Checks scheduler readiness and the storage connection.

```js
const pingResult = await jobs.ping();
// OK:     { status: 'OK', code: 200, statusCode: 200 }
// Failed: { status: 'Error reason', code: 500, statusCode: 500, error: ErrorObject }
```

### `pause()`

- Signature: `pause()` or `pause(timerId)`
- Returns: {*boolean*} `true` if pause state changed, `false` if already paused for that scope

For multi-instance setups with long-running handlers only. Other instances keep running tasks while this one is paused. Single-instance apps and short handlers gain nothing.

- `pause()` — this instance stops taking the scheduler lease. Running handlers continue, and tasks stay in storage.
- `pause(timerId)` — when this instance claims that task, it reschedules it without running the handler, so another instance can run it. Pass the timer id returned by `set*`, not the bare `uid`.

```js
if (loadSheddingActive()) {
  jobs.pause(); // stop competing while saturated
}
const heavy = await jobs.setInterval(worker, 60_000, 'heavy-sync');
jobs.pause(heavy); // only skip this task on this instance
```

### `resume()`

- Signature: `resume()` or `resume(timerId)`
- Returns: {*boolean*} `true` if pause cleared, `false` if not paused

`resume()` clears the global pause; `resume(timerId)` clears a per-task pause. The instance competes again on its next poll.

```js
jobs.resume();        // global
jobs.resume(heavy);   // per timer id from set*
```

Queue-polling pattern: after winning a tick, claim rows from your own queue, call `pause()`, call `ready()`, process the rows, then `resume()` in `finally`. JoSk releases the tick quickly and this instance stops competing until local work ends. Full examples: [skills/josk/references/patterns.md](skills/josk/references/patterns.md).

## Execution semantics

| Method | Guarantee | Notes |
|---|---|---|
| `setTimeout`, `setImmediate` | **At-most-once** across the cluster | Task is removed from storage *before* the handler runs. If the process dies mid-run, the run is lost. |
| `setInterval` | **At-least-once** per tick (until cleared) | Task stays in storage while running. If `ready()` is not called within `zombieTime`, another instance may claim and run it again. Make handlers idempotent. |

`zombieTime` (default 15 minutes) is the safety net for stuck handlers. Set it above your slowest legitimate handler plus storage latency. Restarting an app does not shorten a running interval's hold. So after an unclean kill, recovery waits the full `zombieTime`, not `delay`, but a rolling deploy cannot start a second copy of a handler that is still running. Call [`shutdown()`](#shutdownopts) on `SIGTERM` to hand running claims back instead of leaving them to `zombieTime`. JoSk skips a late `ready()` write when a newer same-uid run starts in the same process. Built-in adapters also fence writes across instances; custom adapters need equivalent fencing for that guarantee. See [adapter-api.md](docs/adapter-api.md) and [monitoring and recovery](docs/monitoring.md).

- `execute: 'batch'` (default) claims all due tasks under one lease, for throughput. `execute: 'one'` claims one task per lease, for smaller bursts and fairer spread across instances.
- `concurrency` caps parallel handlers in this instance. Default `Infinity`, like Node's timers. Set a limit when handlers share DB connections or API rate limits.
- `pause()` and `pause(timerId)` are per process. Combine them with `concurrency` and `execute: 'one'` when one instance should back off during long local work.

## TypeScript

JoSk ships declarations for ESM (`index.d.ts`) and CommonJS (`index.d.cts`). They don't import `redis` or `mongodb`, so unused drivers are not needed. `RedisAdapter` and `MongoAdapter` keep your client's full type on `adapter.client` / `adapter.db`. The `JoSkAdapter` interface is exported for custom adapters.

```ts
import { JoSk, RedisAdapter } from 'josk';
import type { JoSkAdapter, JoSkOption, JoSkOnError } from 'josk';
import { createClient } from 'redis';

const onError: JoSkOnError = async (title, details) => {
  console.error(title, details.error, details.uid);
};

const adapter: JoSkAdapter = new RedisAdapter({
  client: await createClient({ url: process.env.REDIS_URL }).connect(),
  prefix: 'cluster-scheduler'
});

const options: JoSkOption = { adapter, execute: 'batch', concurrency: 16, onError };
const jobs = new JoSk(options);
```

## Examples

### CRON

Use [`cron-parser@^5`](https://www.npmjs.com/package/cron-parser) to compute each next run and pass it to `ready(date)`:

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

Errors thrown by `task` still reach `onError`. For second-level CRON expressions, raise `minRevolvingDelay` / `maxRevolvingDelay` (e.g. `512` / `1000`) to cut storage reads.

### Pass arguments

Wrap the task in a closure:

```js
const task = (arg1, arg2, ready) => {
  //... code here
  ready();
};

jobs.setInterval((ready) => task({ key: 'value' }, 'A', ready), 60 * 60000, 'taskA');
jobs.setInterval((ready) => task({ key: 'other' }, 'B', ready), 60 * 60000, 'taskB');
```

### Clean up old tasks

For development and tests.

#### Clean up Redis

```shell
redis-cli --no-auth-warning --scan --pattern "josk:default:*" | xargs redis-cli --raw --no-auth-warning DEL

# If you're using multiple JoSk instances with prefix:
redis-cli --no-auth-warning --scan --pattern "josk:prefix:*" | xargs redis-cli --raw --no-auth-warning DEL

# If useHashTags is true:
redis-cli --no-auth-warning --scan --pattern "josk:{prefix}:*" | xargs redis-cli --raw --no-auth-warning DEL
```

#### Clean up MongoDB

```js
// Run directly in MongoDB console (default prefix `default`):
db.getCollection('__JobTasks__default').deleteMany({});
// If you're using a custom prefix:
db.getCollection('__JobTasks__PrefixHere').deleteMany({});
// Lock collection (shared across prefixes by default):
db.getCollection('__JobTasks__.lock').deleteMany({});
```

#### Clean up PostgreSQL

```sql
DELETE FROM josk_tasks WHERE prefix = 'default';
DELETE FROM josk_locks WHERE lock_key = 'josk-default.lock';

-- If you're using custom prefix:
DELETE FROM josk_tasks WHERE prefix = 'cluster-scheduler';
DELETE FROM josk_locks WHERE lock_key = 'josk-cluster-scheduler.lock';
```

### MongoDB connection fine tuning

Replica-set tuning, dedicated-DB advice, the index list, and Mongo-compatible service notes: [`docs/mongodb.md`](docs/mongodb.md). Cosmos DB and DocumentDB aren't part of default CI; optional endpoint tests require configured secrets.

## Prefix mapping

`prefix` isolates scheduler state. Instances with the same prefix share one queue. Default: `default`.

| Adapter | Storage layout for `prefix: 'app'` | Notes |
|---|---|---|
| Redis | Default keys: `josk:app:schedule`, `josk:app:tasks`, `josk:app:lock`. With `useHashTags: true`: `josk:{app}:schedule`, `josk:{app}:tasks`, `josk:{app}:lock`. | Hash tags keep all keys on the same Cluster slot. Prefix must match `/^[A-Za-z0-9_\-:.]+/` — special characters (notably `{` and `}`) are rejected to protect Cluster routing. |
| MongoDB | Collection `__JobTasks__app`; lock collection `__JobTasks__.lock` (shared across prefixes, scoped by `uniqueName` field) | Override the lock collection with `lockCollectionName`. Keep collection names short — Mongo's name limit is 120 characters including database name. |
| PostgreSQL | Rows in `josk_tasks` filtered by `prefix='app'`; lock row in `josk_locks` with `lock_key='josk-app.lock'` | Table names are fixed. Use prefix for tenant/environment isolation. |

## Operational FAQ

### How do I monitor stuck tasks?

An interval that never calls `ready()` becomes claimable again after `zombieTime`. This recovery does not fire `onError`. The `'One of your tasks is missing'` error means this instance claimed a task it has no handler for. Past-due tasks show backlog, not stuck work. To find claims near their recovery deadline, see [monitoring](docs/monitoring.md).

### How do I handle storage restarts?

JoSk catches adapter errors and retries on the next poll. Locks held by crashed nodes expire on their own (Redis: `PEXPIRE`, Mongo: TTL index, Postgres: `locked_until` against server time).

### `one` vs `batch` execute mode?

Use `batch` for throughput; it claims due tasks in chunks. Use `one` for smaller bursts per instance, fairer spread across instances, or when handlers contend on the same downstream resource.

### Jitter: Why is my interval running every `delay + maxRevolvingDelay` ms?

JoSk polls every `minRevolvingDelay` to `maxRevolvingDelay` ms, so the effective interval is `delay` plus poll latency. Lower `maxRevolvingDelay` for tighter intervals at the cost of more storage reads.

### What about clock skew between nodes?

Redis uses relative `PX` TTLs. Postgres computes lease expiry from `CURRENT_TIMESTAMP`, so node clock skew does not change lock lifetime. Mongo stores app-generated dates; keep Mongo app nodes time-synchronized.

## Notes

- Use JoSk when several copies of an app run the same repeating tasks and each due tick must run once cluster-wide, not once per instance. Examples: [email](https://www.npmjs.com/package/mail-time) and SMS queues, long polling, periodic sync.
- Keep task intervals at 2 seconds or more. Shorter tasks may overlap with the storage round-trip plus poll delay.
- Accuracy is `delay ± (maxRevolvingDelay + storage latency)`: about ±0.8s plus storage latency with defaults. Tighter bounds cost more storage reads.
- Poll delays are random within `minRevolvingDelay`..`maxRevolvingDelay` so instances don't hit storage at the same moment. Defaults (`128`..`768`) suit a 3-server setup. A higher `minRevolvingDelay` reduces storage reads and writes.

## Running tests

Setup, full and targeted suites, coverage, and the Bun runner: [`docs/testing.md`](docs/testing.md). Quickstart:

```shell
REDIS_URL="…" MONGO_URL="…" PG_URL="…" npm test
```

## Why JoSk?

`JoSk` is *Job-Task* - Is randomly generated name by ["uniq" project](https://uniq.site)

## Support our open source contribution:

- Try [🌉 Bridge CDN](https://bridge-cdn.com/?ref=github-josk-repo-footer) - A SEO-focused alternative to Cloudflare. CDN, DNS, IndexNow, Prerender, SEO, Edge Computing.
- Upload and share files using [☄️ meteor-files.com](https://meteor-files.com/?ref=github-josk-repo-footer) — Continue interrupted file uploads without losing any progress. There is nothing that will stop Meteor from delivering your file to the desired destination
- Use [▲ ostr.io](https://ostr.io?ref=github-josk-repo-footer) for [Server Monitoring](https://snmp-monitoring.com), [Web Analytics](https://ostr.io/info/web-analytics?ref=github-josk-repo-footer), [WebSec](https://domain-protection.info), [Web-CRON](https://web-cron.info) and [SEO Pre-rendering](https://prerendering.com) of a website
- Star on [GitHub](https://github.com/veliovgroup/josk)
- Star on [NPM](https://www.npmjs.com/package/josk)
- Star on [Atmosphere](https://atmospherejs.com/ostrio/cron-jobs)
- [Sponsor via GitHub](https://github.com/sponsors/dr-dimitru)
- [Support via PayPal](https://paypal.me/veliovgroup)

[npm-url]: https://www.npmjs.com/package/josk
[badge-npm-v]: https://img.shields.io/npm/v/josk.svg
[badge-npm-dm]: https://img.shields.io/npm/dm/josk.svg
[badge-ci]: https://github.com/veliovgroup/josk/actions/workflows/test.yml/badge.svg?branch=master
[ci-url]: https://github.com/veliovgroup/josk/actions/workflows/test.yml
[badge-size]: https://img.shields.io/bundlephobia/minzip/josk.svg
[size-url]: https://bundlephobia.com/package/josk
[badge-cov]: https://img.shields.io/badge/coverage-~99%25-brightgreen
[badge-license]: https://img.shields.io/badge/License-BSD%203--Clause-blue.svg
[license-url]: https://opensource.org/licenses/BSD-3-Clause
[badge-node]: https://img.shields.io/node/v/josk
[node-url]: https://nodejs.org/
[badge-ts]: https://img.shields.io/badge/TypeScript-ready-blue
[ts-url]: https://github.com/veliovgroup/josk#typescript
[badge-bun]: https://img.shields.io/badge/Bun-%3E%3D1.1.0-black?logo=bun
[bun-url]: https://github.com/veliovgroup/josk#bun-runtime
[badge-meteor]: https://img.shields.io/badge/Meteor.js-ostrio%3Acron--jobs-red?logo=meteor&logoColor=white
[meteor-url]: https://packosphere.com/ostrio/cron-jobs
[badge-deps]: https://img.shields.io/badge/dependencies-0-brightgreen
[badge-sponsor]: https://img.shields.io/github/sponsors/dr-dimitru?label=Sponsor
[sponsor-url]: https://github.com/sponsors/dr-dimitru
[badge-donate]: https://img.shields.io/badge/Donate-PayPal-00457C?logo=paypal&logoColor=white
[donate-url]: https://paypal.me/veliovgroup
