[![npm version](https://img.shields.io/npm/v/josk.svg)](https://www.npmjs.com/package/josk)
[![npm downloads](https://img.shields.io/npm/dm/josk.svg)](https://www.npmjs.com/package/josk)
[![Test](https://github.com/veliovgroup/josk/actions/workflows/test.yml/badge.svg?branch=master)](https://github.com/veliovgroup/josk/actions/workflows/test.yml)
[![Coverage](https://img.shields.io/badge/coverage-~99%25-brightgreen)](#running-tests)
[![License: BSD-3-Clause](https://img.shields.io/badge/License-BSD%203--Clause-blue.svg)](https://opensource.org/licenses/BSD-3-Clause)
[![Node.js](https://img.shields.io/node/v/josk)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-ready-blue)](https://github.com/veliovgroup/josk#typescript)
[![Bun](https://img.shields.io/badge/Bun-%3E%3D1.1.0-black?logo=bun)](https://github.com/veliovgroup/josk#bun-runtime)
[![zero dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](https://www.npmjs.com/package/josk)
[![support](https://img.shields.io/badge/support-GitHub-white)](https://github.com/sponsors/dr-dimitru)
[![support](https://img.shields.io/badge/support-PayPal-white)](https://paypal.me/veliovgroup)
<a href="https://ostr.io/info/built-by-developers-for-developers?ref=github-josk-repo-top"><img src="https://ostr.io/apple-touch-icon-60x60.png" height="20"></a>
<a href="https://meteor-files.com/?ref=github-josk-repo-top"><img src="https://meteor-files.com/apple-touch-icon-60x60.png" height="20"></a>

# JoSk

"JoSk" is a Node.js task manager for horizontally scaled apps and apps that would need to scale horizontally quickly at some point of growth.

"JoSk" mimics the native API of `setTimeout` and `setInterval` and supports [CRON expressions](https://github.com/veliovgroup/josk?tab=readme-ov-file#cron). All queued tasks are synced between all running application instances via Redis, MongoDB, or a [custom adapter](https://github.com/veliovgroup/josk/blob/master/docs/adapter-api.md).

The "JoSk" package is made for a variety of horizontally scaled apps, such as clusters, multi-servers, and multi-threaded Node.js instances, that are running either on the same or different machines or even different data centers. "JoSk" uses storage-level leases and atomic task claims so each due tick is claimed by one instance; delivery guarantees depend on the scheduling method.

"JoSk" is not just for multi-instance apps. It seamlessly integrates with single-instance applications as well, showcasing its versatility and adaptability.

__Note: JoSk is the server-only package.__

## ToC

- [Main features](https://github.com/veliovgroup/josk?tab=readme-ov-file#main-features)
- [Prerequisites](https://github.com/veliovgroup/josk?tab=readme-ov-file#prerequisites)
- [Install](https://github.com/veliovgroup/josk?tab=readme-ov-file#install) as [NPM package](https://www.npmjs.com/package/josk)
  - [Bun runtime](https://github.com/veliovgroup/josk?tab=readme-ov-file#bun-runtime)
  - [Agent Skill (Claude Code, Codex, Cursor, Copilot, Windsurf, …)](https://github.com/veliovgroup/josk?tab=readme-ov-file#agent-skill)
- [API](https://github.com/veliovgroup/josk?tab=readme-ov-file#api)
  - [Constructor `new JoSk()`](https://github.com/veliovgroup/josk?tab=readme-ov-file#initialization)
    - [`RedisAdapter`](https://github.com/veliovgroup/josk?tab=readme-ov-file#redis-adapter)
    - [`MongoAdapter`](https://github.com/veliovgroup/josk?tab=readme-ov-file#mongodb-adapter)
    - [`PostgresAdapter`](#postgresql-adapter)
  - [`JoSk#setInterval()`](https://github.com/veliovgroup/josk?tab=readme-ov-file#setintervalfunc-delay-uid)
  - [`JoSk#setTimeout()`](https://github.com/veliovgroup/josk?tab=readme-ov-file#settimeoutfunc-delay-uid)
  - [`JoSk#setImmediate()`](https://github.com/veliovgroup/josk?tab=readme-ov-file#setimmediatefunc-uid)
  - [`JoSk#clearInterval()`](https://github.com/veliovgroup/josk?tab=readme-ov-file#clearintervaltimer)
  - [`JoSk#clearTimeout()`](https://github.com/veliovgroup/josk?tab=readme-ov-file#cleartimeouttimer)
  - [`JoSk#destroy()`](https://github.com/veliovgroup/josk?tab=readme-ov-file#destroy)
  - [`JoSk#ping()`](https://github.com/veliovgroup/josk?tab=readme-ov-file#ping)
- [Execution semantics](https://github.com/veliovgroup/josk?tab=readme-ov-file#execution-semantics)
- [TypeScript](https://github.com/veliovgroup/josk?tab=readme-ov-file#typescript)
- [Examples](https://github.com/veliovgroup/josk?tab=readme-ov-file#examples)
  - [CRON usage](https://github.com/veliovgroup/josk?tab=readme-ov-file#cron)
  - [Passing arguments](https://github.com/veliovgroup/josk?tab=readme-ov-file#pass-arguments)
  - [Clean up old tasks](https://github.com/veliovgroup/josk?tab=readme-ov-file#clean-up-old-tasks)
  - [MongoDB connection options](https://github.com/veliovgroup/josk?tab=readme-ov-file#mongodb-connection-fine-tuning)
  - [Meteor.js](https://github.com/veliovgroup/josk/blob/master/docs/meteor.md)
- [Prefix mapping per adapter](https://github.com/veliovgroup/josk?tab=readme-ov-file#prefix-mapping)
- [Operational FAQ](https://github.com/veliovgroup/josk?tab=readme-ov-file#operational-faq)
- [Migration guide (v4 → v5)](docs/migration-v4-v5.md)
- [Migration guide (v5 → v6)](docs/migration-v5-v6.md)
- [Migration guide (v6 → v6.1)](docs/migration-v6-v6.1.md)
- [Important notes](https://github.com/veliovgroup/josk?tab=readme-ov-file#notes)
- [~99% tests coverage](https://github.com/veliovgroup/josk?tab=readme-ov-file#running-tests)
- [Why it's named "JoSk"](https://github.com/veliovgroup/josk?tab=readme-ov-file#why-josk)
- [Support Section](https://github.com/veliovgroup/josk?tab=readme-ov-file#support-our-open-source-contribution)

## Main features

- 🏢 Synchronize single task across multiple servers;
- 🔏 Read locking to avoid simultaneous task executions across complex infrastructure;
- 📦 Zero dependencies, written from scratch for top performance;
- 👨‍🔬 ~99% tests coverage;
- 💪 Bulletproof design, built-in retries, and "zombie" task recovery 🧟🔫.

## Prerequisites

- `redis-server@>=5.0.0` or KeyDB — for RedisAdapter (requires `redis` NPM package, both `redis@^4` and `redis@^5` are supported). KeyDB and Valkey are supported with the same single-writer topology.
- `mongod@>=4.0.0` — for MongoAdapter (requires the official `mongodb` NPM package; the adapter is tested only against the official driver)
- `postgres@>=12` — for PostgresAdapter (requires `pg@>=8.0.3` NPM package; `pg@7` does not connect on Node 14+)
- `node@>=20.9.0` — Node.js version
- `bun@>=1.1.0` — optional, runs the same package and the same Jest suite under [Bun](https://bun.sh) via `bun:test` (see [Bun runtime](#bun-runtime) section)

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

JoSk runs unmodified on [Bun](https://bun.sh) `>=1.1.0`. The package is pure ESM, has no Node-only globals beyond `node:crypto.randomUUID()` (which Bun ships natively), and the official `mongodb`, `pg`, and `redis` drivers all work under Bun. Install with `bun add josk` and import the same way:

```js
import { JoSk, RedisAdapter, MongoAdapter, PostgresAdapter } from 'josk';
```

The full Jest test suite (`test/jest/`) doubles as the Bun test suite — `npm run test:bun` runs every core and adapter test under Bun's `bun:test` runner. See [Running Tests](#running-tests).

Notes:

- Use the same adapter packages as on Node (`mongodb`, `pg`, `redis`).
- Schedulers running across mixed Node and Bun processes coexist under the same prefix; lease acquisition and task claiming are storage-level operations and runtime-agnostic.
- Bun's standalone executables (`bun build --compile`) bundle JoSk like any ESM library.

### Agent Skill

JoSk ships an [Agent Skill](https://inference.sh/blog/skills/agent-skills-overview) — the open, cross-tool standard for teaching AI coding agents about a library. The source lives in [`skills/josk/`](skills/josk/) and follows the standard `SKILL.md` + `references/` layout, so it installs into 50+ supported agents from one command via the [`npx skills` CLI](https://github.com/vercel-labs/skills).

Install into every supported agent on your machine in one go:

```shell
npx skills add veliovgroup/josk
```

Detected and supported agents include Claude Code, Codex CLI, Cursor, Windsurf, GitHub Copilot, Cline, Continue, Roo Code, OpenCode, Goose, Aider, Gemini CLI, Kimi CLI, Tabnine, Qwen Code, Antigravity, Replit, Devin, and many others. The CLI auto-detects which are installed and drops the skill into each agent's native skills directory (`.claude/skills/`, `.cursor/skills/`, `.codex/skills/`, …). No per-agent format conversion — the same `SKILL.md` is read by every host.

Once installed, the agent loads the full public API, adapter setup, execution semantics, CRON and handler patterns, Meteor integration, and the operational FAQ as context whenever you write or review JoSk-related code. Triggers include: JoSk by name, scheduled / recurring jobs, cron-style tasks, `setInterval` / `setTimeout` / `setImmediate` work in clustered Node.js or Bun deployments, the `RedisAdapter` / `MongoAdapter` / `PostgresAdapter`, the Meteor `ostrio:cron-jobs` package, method-specific at-least-once / at-most-once execution, zombie-task recovery, or scheduler tuning (`zombieTime`, `execute`, `concurrency`).

Alternative install paths:

```shell
# From a local clone of this repo (offline / pre-publish)
npx skills add ./skills/josk

# Browse and pick interactively first
npx skills add veliovgroup/josk --list
```

The skill source is **not** shipped in the npm tarball — it's distributed via GitHub and consumed only by AI tooling.

## API:

Constructor options for *JoSk*, *RedisAdapter*, *MongoAdapter*, *PostgresAdapter*

### `new JoSk(opts)`

- `opts.adapter` {*RedisAdapter*|*MongoAdapter*|*PostgresAdapter*} - [Required] Instance of adapter or [custom](https://github.com/veliovgroup/josk/blob/master/docs/adapter-api.md)
- `opts.debug` {*Boolean*} - [Optional] Enable debugging messages, useful during development
- `opts.autoClear` {*Boolean*} - [Optional] Remove (*Clear*) obsolete tasks (*any tasks which are not found in the instance memory (runtime), but exists in the database*). Obsolete tasks may appear in cases when it wasn't cleared from the database on process shutdown, and/or was removed/renamed in the app. Obsolete tasks may appear if multiple app instances running different codebase within the same database, and the task may not exist on one of the instances. Default: `false`
- `opts.zombieTime` {*Number*} - [Optional] time in milliseconds, after this time - task will be interpreted as "*zombie*". This parameter allows to rescue task from "*zombie* mode" in case when: `ready()` wasn't called, exception during runtime was thrown, or caused by bad logic. While `resetOnInit` option helps to make sure tasks are `done` on startup, `zombieTime` option helps to solve same issue, but during runtime. Default value is `900000` (*15 minutes*). It's not recommended to set this value to below `60000` (*one minute*)
- `opts.execute` {*String*} - [Optional] due-task execution mode. Use `one` to claim and run one task per scheduler lease, or `batch` to drain all currently due tasks under same lease. Default: `batch`
- `opts.concurrency` {*Number*} - [Optional] maximum number of task handlers that can run in parallel. Use a positive integer to cap parallelism (useful when handlers share rate-limited resources like the same DB the adapter uses); use `Infinity` to disable throttling. Default: `Infinity`
- `opts.lockOwnerId` {*String*} - [Optional] stable owner id for scheduler lease tokens. Useful for observability (lease IDs include this prefix) and for re-claiming this instance's leases after a planned restart. Default: auto-generated per `JoSk` instance via `crypto.randomUUID()`
- `opts.minRevolvingDelay` {*Number*} - [Optional] Minimum revolving delay — the minimum delay between tasks executions in milliseconds. Default: `128`
- `opts.maxRevolvingDelay` {*Number*} - [Optional] Maximum revolving delay — the maximum delay between tasks executions in milliseconds. Default: `768`
- `opts.onError` {*Function*} - [Optional] Informational hook, called instead of throwing exceptions. Default: `false`. Called with two arguments:
  - `title` {*String*}
  - `details` {*Object*}
  - `details.description` {*String*}
  - `details.error` {*Mix*}
  - `details.uid` {*String*} - Internal `uid`, suitable for `.clearInterval()` and `.clearTimeout()`
- `opts.onExecuted` {*Function*} - [Optional] Informational hook, called when task is finished. Default: `false`. Called with two arguments:
  - `uid` {*String*} - `uid` passed into `.setImmediate()`, `.setTimeout()`, or `setInterval()` methods
  - `details` {*Object*}
  - `details.uid` {*String*} - Internal `uid`, suitable for `.clearInterval()` and `.clearTimeout()`
  - `details.date` {*Date*} - Execution timestamp as JS {*Date*}
  - `details.delay` {*Number*} - Execution `delay` (e.g. `interval` for `.setInterval()`)
  - `details.timestamp` {*Number*} - Execution timestamp as unix {*Number*}

Hook throws and async rejections are logged and isolated from scheduler execution.

### `new RedisAdapter(opts)`

*Since* `v5.0.0`

- `opts.client` {*RedisClient*} - [*Required*] `RedisClient` instance, like one returned from `await redis.createClient().connect()` method
- `opts.prefix` {*String*} - [Optional] use to create multiple named instances
- `opts.resetOnInit` {*Boolean*} - [Optional] (*__use with caution__*) make sure all old tasks are completed during initialization. Useful for single-instance apps to clean up unfinished that occurred due to intermediate shutdown, reboot, or exception. Default: `false`
- `opts.useHashTags` {*Boolean*} - [Optional] use Redis Cluster hash-tag keys (`josk:{prefix}:*`) so all adapter keys live in same slot. Default: `false`, preserving existing standalone keys (`josk:prefix:*`)

### `new MongoAdapter(opts)`

*Since* `v5.0.0`

- `opts.db` {*Db*} - [*Required*] Mongo's `Db` instance, like one returned from `MongoClient#db()` method
- `opts.prefix` {*String*} - [Optional] use to create multiple named instances
- `opts.lockCollectionName` {*String*} - [Optional] By default all JoSk instances use the same `__JobTasks__.lock` collection for locking
- `opts.resetOnInit` {*Boolean*} - [Optional] (*__use with caution__*) make sure all old tasks are completed during initialization. Useful for single-instance apps to clean up unfinished that occurred due to intermediate shutdown, reboot, or exception. Default: `false`

### `new PostgresAdapter(opts)`

*Since* `v6.0.0`

- `opts.client` {*Pool*|*Client*} - [*Required*] `pg` client with `.query()` method. `Pool` is recommended for long-running applications
- `opts.prefix` {*String*} - [Optional] use to create multiple isolated scheduler namespaces in same database. Default: `default`
- `opts.resetOnInit` {*Boolean*} - [Optional] (*__use with caution__*) deletes tasks and locks for current `prefix` during initialization. Useful for local development and single-instance startup recovery. Default: `false`

### Initialization

JoSk is storage-agnostic (since `v4.0.0`). Shipped with Redis, MongoDB, and PostgreSQL adapters. Extend via [custom adapter](docs/adapter-api.md)

#### Redis Adapter

JoSk has no dependencies, hence make sure `redis` NPM package is installed in order to support Redis Storage Adapter. `RedisAdapter` stores due timestamps in sorted set and task payloads in hash, then claims due work atomically via Lua scripts. `RedisAdapter` is compatible with Redis-like databases with Lua + sorted-set support, and was well-tested with [Redis](https://redis.io/) and [KeyDB](https://docs.keydb.dev/)

KeyDB guidelines:

- Use a single writable KeyDB primary. For Redis Cluster or KeyDB Cluster, pass `useHashTags: true` so adapter keys use one hash slot: `josk:{prefix}:schedule`, `josk:{prefix}:tasks`, `josk:{prefix}:lock`.
- Do not route JoSk reads or writes to replicas. Scheduler correctness depends on immediate visibility of lock and task-claim writes.
- Avoid KeyDB active-replication/multi-master mode for scheduler correctness. Conflict resolution and eventual convergence can allow duplicate task claims across writers.
- For multi-DC strict single-claim scheduling, use a strongly consistent storage topology, or prefer PostgreSQL with one write authority.

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
    // useHashTags: true, // Enable for Redis Cluster / KeyDB Cluster
  }),
  onError(reason, details) {
    // Use onError hook to catch runtime exceptions
    // thrown inside scheduled tasks
    console.log(reason, details.error);
  }
});
```

#### MongoDB Adapter

JoSk has no dependencies, hence make sure `mongodb` NPM package is installed in order to support MongoDB Storage Adapter. Note: this package will add two new MongoDB collections per each `new JoSk()`. One collection for tasks and second for "Read Locking" with `.lock` suffix

```js
import { JoSk, MongoAdapter } from 'josk';
import { MongoClient } from 'mongodb';

const client = new MongoClient('mongodb://127.0.0.1:27017');
// To avoid "DB locks" — it's a good idea to use separate DB from the "main" DB
const mongoDb = client.db('joskdb');
const jobs = new JoSk({
  adapter: new MongoAdapter({
    db: mongoDb,
    prefix: 'cluster-scheduler',
  }),
  onError(reason, details) {
    // Use onError hook to catch runtime exceptions
    // thrown inside scheduled tasks
    console.log(reason, details.error);
  }
});
```

#### PostgreSQL Adapter

*Since* `v6.0.0`

JoSk has no dependencies, hence make sure `pg` NPM package (`npm i pg`) is installed. PostgreSQL `>=12` is recommended. Adapter auto-creates and migrates `josk_tasks` and `josk_locks` tables on init, using current database/schema from the provided client.

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
    // Use onError hook to catch runtime exceptions
    // thrown inside scheduled tasks
    console.log(reason, details.error);
  }
});
```

PostgreSQL guidelines:

- Use `pg.Pool` for application runtime. Share same pool when scheduler tasks also use PostgreSQL, or use a small dedicated pool when you want scheduler isolation.
- Use one writable primary endpoint. Do not route JoSk reads or writes to read replicas; task claims must be immediately visible across app instances.
- Use same `prefix` on instances that must share one schedule. Use different `prefix` values for isolated tenants, environments, or test suites.
- Prefer a dedicated database or schema when possible. Adapter creates `josk_tasks` and `josk_locks`; table names are fixed, isolation is by `prefix`.
- Keep `resetOnInit: false` in clustered production. `true` deletes current-prefix tasks and lock rows during adapter initialization.
- `execute: 'batch'` is default. It claims due tasks in batches using `FOR UPDATE SKIP LOCKED`, then iterates returned task list in memory. Best for draining backlogs with fewer DB round-trips.
- `execute: 'one'` claims one due task per scheduler lease with `LIMIT 1`. Useful when you want smaller execution bursts or tighter fairness between instances.
- Tune `minRevolvingDelay` and `maxRevolvingDelay` with pool capacity and task runtime. Lower delays poll more often and increase database writes.

#### Create the first task

After JoSk initialized simply call `JoSk#setInterval` to create recurring task

```js
const jobs = new JoSk({ /*...*/ });

jobs.setInterval((ready) => {
  /* ...code here... */
  ready();
}, 60 * 60000, 'task1h'); // every hour

jobs.setInterval((ready) => {
  /* ...code here... */
  asyncCall(() => {
    /* ...more code here...*/
    ready();
  });
}, 15 * 60000, 'asyncTask15m'); // every 15 mins

/**
 * no need to call ready() inside async function
 */
jobs.setInterval(async () => {
  try {
    await asyncMethod();
  } catch (err) {
    console.log(err)
  }
}, 30 * 60000, 'asyncAwaitTask30m'); // every 30 mins

/**
 * no need to call ready() when call returns Promise
 */
jobs.setInterval(() => {
  return asyncMethod(); // <-- returns Promise
}, 2 * 60 * 60000, 'asyncAwaitTask2h'); // every two hours
```

Note: This library relies on job ID. Always use different `uid`, even for the same task:

```js
const task = function (ready) {
  //... code here
  ready();
};

jobs.setInterval(task, 60000, 'task-1m'); // every minute
jobs.setInterval(task, 2 * 60000, 'task-2m'); // every two minutes
```

### `setInterval(func, delay, uid)`

- `func` {*Function*} - Function to call on schedule
- `delay` {*Number*} - Delay for the first run and interval between further executions in milliseconds
- `uid` {*String*} - Unique app-wide task id
- Returns: {*`Promise<string>`*}

*Set task into interval execution loop.* `ready()` *callback is passed as the first argument into a task function.*

In the example below, the next task __will not be scheduled__ until the current is ready:

```js
jobs.setInterval(function (ready) {
  /* ...run sync code... */
  ready();
}, 60 * 60000, 'syncTask1h'); // will execute every hour + time to execute the task

jobs.setInterval(async function () {
  try {
    await asyncMethod();
  } catch (err) {
    console.log(err)
  }
}, 60 * 60000, 'asyncAwaitTask1h'); // will execute every hour + time to execute the task
```

In the example below, the next task __will not wait__ for the current task to finish:

```js
jobs.setInterval(function (ready) {
  ready();
  /* ...run sync code... */
}, 60 * 60000, 'syncTask1h'); // will execute every hour

jobs.setInterval(async function () {
  /* ...task re-scheduled instantly here... */
  process.nextTick(async () => {
    await asyncMethod();
  });
}, 60 * 60000, 'asyncAwaitTask1h'); // will execute every hour
```

In the next example, a long running task is executed in a loop without delay after the full execution:

```js
jobs.setInterval(function (ready) {
  asyncCall((error, result) => {
    if (error) {
      ready(); // <-- Always run `ready()`, even if call was unsuccessful
    } else {
      anotherCall(result.data, ['param'], (error, response) => {
        if (error) {
          ready(); // <-- Always run `ready()`, even if call was unsuccessful
          return;
        }

        waitForSomethingElse(response, () => {
          ready(); // <-- End of the full execution
        });
      });
    }
  });
}, 0, 'longRunningAsyncTask'); // run in a loop as soon as previous run is finished
```

Same task combining `await`/`async` and callbacks

```js
jobs.setInterval(function (ready) {
  process.nextTick(async () => {
    try {
      const result = await asyncCall();
      const response = await anotherCall(result.data, ['param']);

      waitForSomethingElse(response, () => {
        ready(); // <-- End of the full execution
      });
    } catch (err) {
      console.log(err)
      ready(); // <-- Always run `ready()`, even if call was unsuccessful
    }
  });
}, 0, 'longRunningAsyncTask'); // run in a loop as soon as previous run is finished
```

#### `ready()` — argument forms

`ready` is the function passed as the first argument to every task handler. It is a `Promise<boolean>`-returning function and accepts several optional argument shapes:

- `ready()` — schedule the next interval run at `now + delay` (default).
- `ready(date)` — `Date` instance; schedule the next interval run at that exact wall-clock moment. Only honored for `setInterval`; `setTimeout`/`setImmediate` are at-most-once and have already been removed before the handler ran. This is the building block for CRON expressions — pair with [`cron-parser`](https://www.npmjs.com/package/cron-parser).
- `ready(timestamp)` — numeric ms-epoch; same as above.
- `ready(callback)` — Node-style callback `(error, success) => void`. Useful for non-async handlers that prefer not to use the returned `Promise`.

Calling `ready()` twice throws (or invokes the callback with `error`) — *"Resolution method is overspecified"*. Either return a `Promise` from the handler **or** call `ready()` once, never both.

For zero-arity handlers (`async function () { … }` or `() => doSomething()`), JoSk auto-calls `ready()` for you when the returned Promise settles. You only need to call `ready()` manually when the handler accepts it as an argument.

```js
import parser from 'cron-parser';

const intervalCron = (job, cronExpr, uid) => {
  const next = () => parser.parseExpression(cronExpr).next().toDate();
  return jobs.setInterval(function (ready) {
    job();
    ready(next()); // schedule the next run at the cron's next fire time
  }, +next() - Date.now(), uid);
};

intervalCron(() => sendReport(), '0 9 * * *', 'daily-report-9am');
```

### `setTimeout(func, delay, uid)`

- `func` {*Function*} - Function to call after `delay`
- `delay` {*Number*} - Delay in milliseconds
- `uid` {*String*} - Unique app-wide task id
- Returns: {*`Promise<string>`*}

*Run a task after delay in ms.* `setTimeout` *is useful for cluster work where duplicate execution is worse than a missed run.* `ready()` *callback is passed as the first argument into a task function.*

```js
jobs.setTimeout(function (ready) {
  /* ...run sync code... */
  ready();
}, 60000, 'syncTaskIn1m'); // will run at most once across the cluster in a minute

jobs.setTimeout(function (ready) {
  asyncCall(function () {
    /* ...run async code... */
    ready();
  });
}, 60000, 'asyncTaskIn1m'); // will run at most once across the cluster in a minute

jobs.setTimeout(async function () {
  try {
    /* ...code here... */
    await asyncMethod();
    /* ...more code here...*/
  } catch (err) {
    console.log(err)
  }
}, 60000, 'asyncAwaitTaskIn1m'); // will run at most once across the cluster in a minute
```

### `setImmediate(func, uid)`

- `func` {*Function*} - Function to execute
- `uid`  {*String*}   - Unique app-wide task id
- Returns: {*`Promise<string>`*}

*Run a one-shot task as soon as the next scheduler tick claims it.* `setImmediate` *is useful for cluster work where duplicate execution is worse than a missed run.* `ready()` *is passed as the first argument into the task function.*

```js
jobs.setImmediate(function (ready) {
  //...run sync code
  ready();
}, 'syncTask'); // will run at most once across the cluster

jobs.setImmediate(function (ready) {
  asyncCall(function () {
    //...run more async code
    ready();
  });
}, 'asyncTask'); // will run at most once across the cluster

jobs.setImmediate(async function () {
  try {
    /* ...code here... */
    await asyncMethod();
  } catch (err) {
    console.log(err)
  }
}, 'asyncTask'); // will run at most once across the cluster
```

### `clearInterval(timerId)`

- `timerId` {*String*|*`Promise<string>`*} — Timer id returned from `JoSk#setInterval()` method
- Returns: {`Promise<boolean>`} `true` when task is successfully cleared, or `false` when task was not found

*Cancel current interval timer.*

```js
const timer = await jobs.setInterval(func, 34789, 'unique-taskid');
await jobs.clearInterval(timer);
```

### `clearTimeout(timerId)`

- `timerId` {*String*|*`Promise<string>`*} — Timer id returned from `JoSk#setTimeout()` method
- Returns: {`Promise<boolean>`} `true` when task is successfully cleared, or `false` when task was not found

*Cancel current timeout timer.*

```js
const timer = await jobs.setTimeout(func, 34789, 'unique-taskid');
await jobs.clearTimeout(timer);
```

### `destroy()`

- Returns: {*boolean*} `true` if instance successfully destroyed, `false` if instance already destroyed

*Destroy JoSk instance*. This method shouldn't be called in normal circumstances. Stop internal interval timer. After JoSk is destroyed — calling public methods would end up logged to `stdout` or if `onError` hook was passed to JoSk it would receive an error. Only permitted methods are `clearTimeout` and `clearInterval`.

```js
// EXAMPLE: DESTROY JoSk INSTANCE UPON SERVER PROCESS TERMINATION
const jobs = new JoSk({ /* ... */ });

const cleanUpBeforeTermination = function () {
  /* ...CLEAN UP AND STOP OTHER THINGS HERE... */
  jobs.destroy();
  process.exit(1);
};

process.stdin.resume();
process.on('uncaughtException', cleanUpBeforeTermination);
process.on('exit', cleanUpBeforeTermination);
process.on('SIGHUP', cleanUpBeforeTermination);
```

### `ping()`

- Returns: {*`Promise<object>`*}

*Ping JoSk instance*. Check scheduler readiness and its connection to the "storage adapter"

```js
const jobs = new JoSk({ /* ... */ });

const pingResult = await jobs.ping();
console.log(pingResult)
/**
In case of the successful response
{
  status: 'OK',
  code: 200,
  statusCode: 200,
}

Failed response
{
  status: 'Error reason',
  code: 500,
  statusCode: 500,
  error: ErrorObject
}
*/
```

## Execution semantics

Different scheduling methods have different at-least-once / at-most-once guarantees. Pick the one that matches your tolerance for missed or duplicated runs.

| Method | Guarantee | Notes |
|---|---|---|
| `setImmediate(func, uid)` | **At-most-once** across the cluster | Task is removed from storage *before* the handler runs. If the process dies between removal and completion, the run is lost. |
| `setTimeout(func, delay, uid)` | **At-most-once** across the cluster | Task is removed from storage *before* the handler runs. If the process dies between removal and completion, the run is lost. |
| `setInterval(func, delay, uid)` | **At-least-once** per scheduled tick (until cleared) | Storage row stays during execution. If `ready()` is not called within `zombieTime`, the task is re-claimed and may run again. Make your handler idempotent. |

`zombieTime` is the safety net for stuck handlers. Choose it long enough to cover your slowest legitimate handler, plus storage round-trip overhead. Default `900000` ms (15 minutes).

`execute` controls how the scheduler drains the work queue under a single lease:

- `batch` (default) claims due tasks in batches under one lease — best throughput.
- `one` claims a single due task per lease — smaller bursts, tighter fairness across instances.

`concurrency` caps how many handlers run in parallel inside this JoSk instance. Default is unbounded (`Infinity`), which matches `setInterval`/`setTimeout` semantics from Node's standard library. Set a finite cap if handlers share resources (DB connections, external API rate limits).

## TypeScript

JoSk ships with TypeScript declarations for both ESM (`index.d.ts`) and CommonJS (`index.d.cts`). The `JoSkAdapter` interface is exported so custom adapters can be type-checked against the public contract.

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

Use cases and usage examples

### CRON

Use JoSk to invoke synchronized tasks by CRON schedule, and the [`cron-parser` package](https://www.npmjs.com/package/cron-parser) to parse CRON expressions. The example below uses `cron-parser@^5` (v5 renamed the entrypoint to the `CronExpressionParser.parse()` static method).

```js
import { CronExpressionParser } from 'cron-parser';

const jobsCron = new JoSk({
  adapter: new RedisAdapter({
    client: await createClient({ url: 'redis://127.0.0.1:6379' }).connect(),
    prefix: 'cron-scheduler'
  }),
  minRevolvingDelay: 512, // Adjust revolving delays to higher values
  maxRevolvingDelay: 1000, // as CRON schedule defined to seconds
});

// CRON HELPER FUNCTION
const setCron = async (uniqueName, cronTask, task) => {
  const next = CronExpressionParser.parse(cronTask).next().toDate();
  // Guard against clock skew: parsed "next" can land in the recent past.
  const initialDelay = Math.max(0, +next - Date.now());

  return await jobsCron.setInterval(function (ready) {
    const upcoming = CronExpressionParser.parse(cronTask).next().toDate();
    ready(upcoming);
    task();
  }, initialDelay, uniqueName);
};

setCron('Run every two seconds cron', '*/2 * * * * *', function () {
  console.log(new Date());
});
```

### Pass arguments

Passing arguments can be done via wrapper function

```js
const jobs = new JoSk({ /* ... */ });
const myVar = { key: 'value' };
let myLet = 'Some top level or env.variable (can get changed during runtime)';

const task = function (arg1, arg2, ready) {
  //... code here
  ready();
};

jobs.setInterval((ready) => {
  task(myVar, myLet, ready);
}, 60 * 60000, 'taskA');

jobs.setInterval((ready) => {
  task({ otherKey: 'Another Value' }, 'Some other string', ready);
}, 60 * 60000, 'taskB');
```

### Async/Await with ready() callback

For long-running async tasks, or with callback-apis it might be needed to call `ready()` explicitly. Wrap task's body into `process.nextTick` to enjoy `await`/`async` combined with classic callback-apis

```js
jobs.setInterval((ready) => {
  process.nextTick(async () => {
    try {
      const result = await asyncCall();
      waitForSomethingElse(async (error, data) => {
        if (error) {
          ready(); // <-- Always run `ready()`, even if call was unsuccessful
          return;
        }

        await saveCollectedData(result, [data]);
        ready(); // <-- End of the full execution
      });
    } catch (err) {
      console.log(err)
      ready(); // <-- Always run `ready()`, even if call was unsuccessful
    }
  });
}, 60 * 60000, 'longRunningTask1h'); // once every hour
```

### Clean up old tasks

During development and tests you may want to clean up Adapter's Storage

#### Clean up Redis

To clean up old tasks via Redis CLI use the next query pattern:

```shell
redis-cli --no-auth-warning --scan --pattern "josk:default:*" | xargs redis-cli --raw --no-auth-warning DEL

# If you're using multiple JoSk instances with prefix:
redis-cli --no-auth-warning --scan --pattern "josk:prefix:*" | xargs redis-cli --raw --no-auth-warning DEL

# If useHashTags is true:
redis-cli --no-auth-warning --scan --pattern "josk:{prefix}:*" | xargs redis-cli --raw --no-auth-warning DEL
```

#### Clean up MongoDB

To clean up old tasks via MongoDB use the next query pattern:

```js
// Run directly in MongoDB console:
db.getCollection('__JobTasks__').remove({});
// If you're using multiple JoSk instances with prefix:
db.getCollection('__JobTasks__PrefixHere').remove({});
```

#### Clean up PostgreSQL

To clean up old tasks and lock for current prefix via PostgreSQL:

```sql
DELETE FROM josk_tasks WHERE prefix = 'default';
DELETE FROM josk_locks WHERE lock_key = 'josk-default.lock';

-- If you're using custom prefix:
DELETE FROM josk_tasks WHERE prefix = 'cluster-scheduler';
DELETE FROM josk_locks WHERE lock_key = 'josk-cluster-scheduler.lock';
```

### MongoDB connection fine tuning

```js
// Recommended MongoDB connection options
// When used with ReplicaSet
const options = {
  writeConcern: {
    j: true,
    w: 'majority',
    wtimeout: 30000
  },
  readConcern: {
    level: 'majority'
  },
  readPreference: 'primary'
};

MongoClient.connect('mongodb://url', options, (error, client) => {
  // To avoid "DB locks" — it's a good idea to use separate DB from "main" application DB
  const db = client.db('dbName');
  const jobs = new JoSk({
    adapter: new MongoAdapter({
      db: db,
    })
  });
});
```

## Prefix mapping

`prefix` isolates scheduler state per adapter. Same prefix = same shared queue; different prefixes = isolated namespaces. The default value is `default` across all adapters.

| Adapter | Storage layout for `prefix: 'app'` | Notes |
|---|---|---|
| Redis | Default keys: `josk:app:schedule`, `josk:app:tasks`, `josk:app:lock`. With `useHashTags: true`: `josk:{app}:schedule`, `josk:{app}:tasks`, `josk:{app}:lock`. | Hash tags keep all keys on the same Cluster slot. Prefix must match `/^[A-Za-z0-9_\-:.]+/` — special characters (notably `{` and `}`) are rejected to protect Cluster routing. |
| MongoDB | Collection `__JobTasks__app`; lock collection `__JobTasks__.lock` (shared across prefixes, scoped by `uniqueName` field) | Override the lock collection with `lockCollectionName`. Keep collection names short — Mongo's name limit is 120 characters including database name. |
| PostgreSQL | Rows in `josk_tasks` filtered by `prefix='app'`; lock row in `josk_locks` with `lock_key='josk-app.lock'` | Table names are fixed. Use prefix for tenant/environment isolation. |

## Operational FAQ

### How do I monitor stuck tasks?

Set a long-running task to throw or skip `ready()` past `zombieTime`. The `onError` hook fires with `'One of your tasks is missing'` (only if `autoClear: false`). For active observability, query the storage directly: Redis `HLEN josk:prefix:tasks` (or `HLEN josk:{prefix}:tasks` with `useHashTags: true`), Mongo `db.__JobTasks__<prefix>.countDocuments({ executeAt: { $lt: new Date() } })`, Postgres `SELECT COUNT(*) FROM josk_tasks WHERE prefix='<prefix>' AND execute_at < (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::BIGINT`.

### How do I handle storage restarts?

JoSk swallows adapter errors and retries on the next tick. The scheduler self-recovers once the connection is healthy. Locks held by crashed nodes self-expire (Redis: PEXPIRE, Mongo: TTL index, Postgres: `locked_until` compared against server time on next claim).

### `one` vs `batch` execute mode?

Use `batch` for normal throughput — it claims due tasks in chunks and reduces storage round-trips. Switch to `one` if you need smaller execution bursts per instance, finer fairness between cluster members, or if your handlers contend on the same downstream resource.

### Jitter: Why is my interval running every `delay + maxRevolvingDelay` ms?

JoSk polls between `minRevolvingDelay` and `maxRevolvingDelay`. The effective interval is `delay + (poll latency)`. Lower `maxRevolvingDelay` for tighter intervals at the cost of more storage reads.

### What about clock skew between nodes?

Lease tokens use storage-server time where possible (Redis `PX` TTL, Postgres `CURRENT_TIMESTAMP`, Mongo TTL index). JS clocks are used only for relative scheduling within a single process. It's recommended to ensure NTP is healthy on the database host — that single clock anchors lease ownership across the cluster.

## Notes

- This package is perfect when you have multiple horizontally scaled servers for load-balancing, durability, an array of micro-services or any other solution with multiple running copies of code running repeating tasks that need one cluster-wide claim per due tick, not one claim per server/instance;
- Recommended floor — unique tasks shorter than ~2 seconds may overlap with the storage round-trip plus revolving delay; tasks ≥2s have stable execution gaps. Example tasks: [Email](https://www.npmjs.com/package/mail-time), SMS queue, Long-polling requests, Periodic application logic operations or Periodic data fetch, sync, etc.
- Accuracy — Delay of each task depends on storage round-trip and jitter window. Trusted execution range is `task_delay ± (maxRevolvingDelay + Storage_Request_Delay)`. With default `minRevolvingDelay: 128` / `maxRevolvingDelay: 768`, expect ±0.8s + storage latency. Tighten the bounds for stricter timing at the cost of more storage reads.
- Use `opts.minRevolvingDelay` and `opts.maxRevolvingDelay` to set the range for *random* delays between executions. Revolving range acts as a safety control to make sure different servers __not__ picking the same task at the same time. Default values (`128` and `768`) are the best for 3-server setup (*the most common topology*). Tune these options to match needs of your project. Higher `opts.minRevolvingDelay` will reduce storage read/writes;
- This package implements scheduler locking via Redis key, MongoDB `.lock` collection, or PostgreSQL `josk_locks` table. Task claims are adapter-level atomic operations.

## Running Tests

1. Clone this package
2. In Terminal (*Console*) go to directory where package is cloned
3. Then run:

```shell
# Before running tests make sure NODE_ENV === development
# Install NPM dependencies
npm install --save-dev

# Before running full tests you need MongoDB, Redis, and PostgreSQL servers.
# Required URLs:
# - REDIS_URL: Redis connection string
# - MONGO_URL: MongoDB connection string
# - PG_URL: PostgreSQL connection string
REDIS_URL="redis://127.0.0.1:6379" MONGO_URL="mongodb://127.0.0.1:27017/npm-josk-test-001" PG_URL="postgres://postgres:postgres@localhost:5432/npm-josk-test-001" npm test

# Run Jest suite for core plus live adapter contract tests
REDIS_URL="redis://127.0.0.1:6379" MONGO_URL="mongodb://127.0.0.1:27017/npm-josk-test-001" PG_URL="postgres://localhost:5432/josk-tests" npm run test:jest

# Run the same Jest suite under Bun (bun:test)
REDIS_URL="redis://127.0.0.1:6379" MONGO_URL="mongodb://127.0.0.1:27017/npm-josk-test-001" PG_URL="postgres://localhost:5432/josk-tests" npm run test:bun

# Coverage report (Jest only — Mocha suites add to coverage when run separately)
npm run test:coverage

# TypeScript declaration smoke test
npm run test:types

# If previous run has errors — add "debug" to output extra logs
DEBUG=true REDIS_URL="redis://127.0.0.1:6379" MONGO_URL="mongodb://127.0.0.1:27017/npm-josk-test-001" PG_URL="postgres://postgres:postgres@localhost:5432/npm-josk-test-001" npm test

# Be patient, tests are taking around 6 mins
```

### Run Redis tests only

Run Redis-related tests only

```shell
# Before running Redis tests you need to have Redis server installed and running
REDIS_URL="redis://127.0.0.1:6379" npm run test:redis

# Be patient, tests are taking around 3 mins
```

### Run MongoDB tests only

Run MongoDB-related tests only

```shell
# Before running Mongo tests you need to have MongoDB server installed and running
MONGO_URL="mongodb://127.0.0.1:27017/npm-josk-test" npm run test:mongo

# Be patient, tests are taking around 3 mins
```

### Run PostgreSQL tests only

```shell
# Before running, have PostgreSQL server running and create DB, e.g. npm-josk-test
# PG_URL is required for PostgreSQL tests.
# Install pg if not: npm install --save-dev pg
PG_URL="postgres://postgres:postgres@localhost:5432/npm-josk-test" npm run test:postgres

# Be patient, tests are taking around 3 mins
```

## Why JoSk?

`JoSk` is *Job-Task* - Is randomly generated name by ["uniq" project](https://uniq.site)

## Support our open source contribution:

- Upload and share files using [☄️ meteor-files.com](https://meteor-files.com/?ref=github-josk-repo-footer) — Continue interrupted file uploads without losing any progress. There is nothing that will stop Meteor from delivering your file to the desired destination
- Use [▲ ostr.io](https://ostr.io?ref=github-josk-repo-footer) for [Server Monitoring](https://snmp-monitoring.com), [Web Analytics](https://ostr.io/info/web-analytics?ref=github-josk-repo-footer), [WebSec](https://domain-protection.info), [Web-CRON](https://web-cron.info) and [SEO Pre-rendering](https://prerendering.com) of a website
- Star on [GitHub](https://github.com/veliovgroup/josk)
- Star on [NPM](https://www.npmjs.com/package/josk)
- Star on [Atmosphere](https://atmospherejs.com/ostrio/cron-jobs)
- [Sponsor via GitHub](https://github.com/sponsors/dr-dimitru)
- [Support via PayPal](https://paypal.me/veliovgroup)
