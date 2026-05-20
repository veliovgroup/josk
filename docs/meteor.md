# JoSk usage within Meteor.js

NPM `josk` package can be used in Meteor environment just perfectly fine since it's server-only Node.js package.

If Meteor.js packages are preferred in your project/environment follow this document to install JoSk as `ostrio:cron-jobs` [Atmosphere](https://atmospherejs.com/ostrio/cron-jobs) or  [Packosphere](https://packosphere.com/ostrio/cron-jobs) package

## Install

```shell
meteor add ostrio:cron-jobs
```

## Usage

```js
import { JoSk, RedisAdapter, MongoAdapter, PostgresAdapter } from 'meteor/ostrio:cron-jobs';
```

### Initialization

JoSk is storage-agnostic (since `v4.0.0`). Atmosphere package ships Redis, MongoDB, and PostgreSQL adapters. Documentation below focuses on MongoDB provided and managed by Meteor.js. For Redis and PostgreSQL adapter details follow NPM package docs; options are same, import path is different.

```js
import { MongoInternals } from 'meteor/mongo';
import { JoSk, MongoAdapter } from 'meteor/ostrio:cron-jobs';

const jobs = new JoSk({
  adapter: new MongoAdapter({
    db: MongoInternals.defaultRemoteCollectionDriver().mongo.db,
    prefix: 'cluster-scheduler',
  }),
  execute: 'batch',
  minRevolvingDelay: 128,
  maxRevolvingDelay: 768,
  onError(reason, details) {
    // Use onError hook to catch runtime exceptions
    // thrown inside scheduled tasks
    console.log(reason, details.error);
  }
});

jobs.setInterval(async () => {
  /* ...code here... */
}, 60000, 'task-1m');

// TO SUPPORT CALLBACK APIs
// CALL ready() ONCE RUN IS COMPLETE
jobs.setInterval((ready) => {
  /* ...code here... */
  asyncCall(() => {
    /* ...more code here...*/
    ready();
  });
}, 60000, 'task-1m');
```

### Options

Same JoSk options from NPM package are available in Meteor:

- `adapter` — required storage adapter instance: `MongoAdapter`, `RedisAdapter`, or `PostgresAdapter`
- `execute` — `batch` (default) drains due tasks under one lease; `one` claims one task per lease
- `zombieTime` — stuck-task retry time; default is `900000` ms
- `lockOwnerId` — optional stable owner id for scheduler lease tokens
- `minRevolvingDelay` and `maxRevolvingDelay` — polling jitter range; higher values reduce storage writes
- `autoClear` — removes storage tasks missing from current process memory
- `onError` and `onExecuted` — runtime hooks for task failures and completed executions

Adapter options:

- `MongoAdapter`: `db`, `prefix`, `lockCollectionName`, `resetOnInit`
- `RedisAdapter`: `client`, `prefix`, `resetOnInit`, `useHashTags`
- `PostgresAdapter`: `client`, `prefix`, `resetOnInit`

Keep `resetOnInit: false` in clustered production. It deletes current-prefix adapter state during initialization.

### Redis Adapter

Install Redis driver in Meteor app if Redis storage is used:

```shell
meteor npm install redis
```

```js
import { JoSk, RedisAdapter } from 'meteor/ostrio:cron-jobs';
import { createClient } from 'redis';

const redisClient = await createClient({
  url: process.env.REDIS_URL
}).connect();

const jobs = new JoSk({
  adapter: new RedisAdapter({
    client: redisClient,
    prefix: 'cluster-scheduler',
    // useHashTags: true, // Enable for Redis Cluster / KeyDB Cluster
  }),
});
```

Use one writable Redis/KeyDB primary. Do not route JoSk traffic to replicas. For Redis Cluster / KeyDB Cluster, set `useHashTags: true`.

### PostgreSQL Adapter

Install PostgreSQL driver in Meteor app if PostgreSQL storage is used:

```shell
meteor npm install pg
```

```js
import { JoSk, PostgresAdapter } from 'meteor/ostrio:cron-jobs';
import { Pool } from 'pg';

const pool = new Pool({
  connectionString: process.env.PG_URL
});

const jobs = new JoSk({
  adapter: new PostgresAdapter({
    client: pool,
    prefix: 'cluster-scheduler',
  }),
  execute: 'batch',
});
```

Use one writable PostgreSQL primary. Adapter creates `josk_tasks` and `josk_locks` tables in current database/schema. Use same `prefix` for instances sharing one schedule; use different prefixes for isolated apps, tenants, or tests.

### Guidelines

- Create JoSk only on server startup. Package is server-only.
- Use same codebase and task `uid` set on every horizontally scaled Meteor instance that shares a `prefix`.
- Always use unique `uid` per logical task. Do not reuse same `uid` for different schedules.
- Always call `ready()` for callback-style or long-running async tasks. Promise-returning handlers are also supported.
- Prefer `execute: 'batch'` for normal production throughput. Use `execute: 'one'` when smaller execution bursts or instance fairness is preferred.
- For multi-DC strict single-claim scheduling, use strongly consistent storage with one write authority.

Note: This library relies on job ID. Always use different `uid`, even for the same task:

```js
const task = function (ready) {
  //... code here
  ready();
};

jobs.setInterval(task, 60000, 'task-1m'); // every minute
jobs.setInterval(task, 2 * 60000, 'task-2m'); // every two minutes
```

### CRON scheduler

Use JoSk to invoke synchronized tasks by CRON schedule, and [`cron-parser` package](https://www.npmjs.com/package/cron-parser) to parse CRON expressions. To simplify CRON scheduling — grab and use `setCron` function below:

```js
import { MongoInternals } from 'meteor/mongo';
import { JoSk, MongoAdapter } from 'meteor/ostrio:cron-jobs';
import { CronExpressionParser } from 'cron-parser';

const jobsCron = new JoSk({
  adapter: new MongoAdapter({
    db: MongoInternals.defaultRemoteCollectionDriver().mongo.db,
    prefix: 'cron-scheduler',
  }),
  minRevolvingDelay: 512, // Adjust revolving delays to higher values
  maxRevolvingDelay: 1000, // as CRON schedule defined to seconds
});

// CREATE HELPER FUNCTION (cron-parser@^5)
const setCron = async (uniqueName, cronTask, task) => {
  const next = CronExpressionParser.parse(cronTask).next().toDate();
  const initialDelay = Math.max(0, +next - Date.now());

  return await jobsCron.setInterval(function (ready) {
    ready(CronExpressionParser.parse(cronTask).next().toDate());
    task();
  }, initialDelay, uniqueName);
};

// SCHEDULE A TASK
setCron('Run every two seconds cron', '*/2 * * * * *', function () {
  console.log(new Date);
});
```

## Running Tests

1. Clone this package
2. Make sure Redis and PostgreSQL are installed and running when testing those adapters (Meteor ships its own `mongod` for package tests — no separate MongoDB install required for the Mongo adapter suite)
3. In Terminal (*Console*) go to directory where package is cloned
4. Then run:

```shell
# Default Meteor package tests require REDIS_URL.
# Postgres tests are skipped when PG_URL is not provided.
REDIS_URL="redis://127.0.0.1:6379" PG_URL="postgres://postgres:postgres@127.0.0.1:5432/meteor-josk-test" meteor test-packages ./ --driver-package=meteortesting:mocha

# CI adapter-only runs (METEOR_TEST_SUITE in package.js): mongo | redis | postgres
# Mongo CI: omit MONGO_URL so Meteor starts its bundled mongod
METEOR_TEST_SUITE=mongo meteor test-packages ./ --driver-package=meteortesting:mocha --once
METEOR_TEST_SUITE=redis REDIS_URL="redis://127.0.0.1:6379" meteor test-packages ./ --driver-package=meteortesting:mocha --once
METEOR_TEST_SUITE=postgres PG_URL="postgres://postgres:postgres@127.0.0.1:5432/meteor-josk-test" meteor test-packages ./ --driver-package=meteortesting:mocha --once

# With custom port
REDIS_URL="redis://127.0.0.1:6379" PG_URL="postgres://postgres:postgres@127.0.0.1:5432/meteor-josk-test" meteor test-packages ./ --driver-package=meteortesting:mocha --port 8888

# With local MongoDB, Postgres, debug, and custom port
DEBUG=true MONGO_URL="mongodb://127.0.0.1:27017/meteor-josk-test" REDIS_URL="redis://127.0.0.1:6379" PG_URL="postgres://postgres:postgres@127.0.0.1:5432/meteor-josk-test" meteor test-packages ./ --driver-package=meteortesting:mocha --port 8888

# Be patient, tests are taking around 4 mins
```

Environment variables consumed by the Meteor test suite:

- `REDIS_URL` — required, e.g. `redis://127.0.0.1:6379`
- `MONGO_URL` — optional override; when omitted, `meteor test-packages` starts Meteor’s bundled `mongod` (GitHub Actions mongo adapter job relies on this; do not point it at a service container unless you intend to test an external server)
- `PG_URL` — required for the PostgreSQL adapter suite, e.g. `postgres://postgres:postgres@127.0.0.1:5432/postgres`; Postgres tests are skipped when this is unset
- `DEBUG=true` — enables verbose JoSk logging during the run

## Known Meteor Issues:

`meteor@1` and `meteor@2` known to rely on `fibers` and may cause the next exception:

```log
Error: Can't wait without a fiber
```

Can be easily solved via "bounding to Fiber":

```js
const bound = Meteor.bindEnvironment((callback) => {
  callback();
});

const db = Collection.rawDatabase();
const jobs = new JoSk({
  adapter: new MongoAdapter({
    db,
  }),
});

const task = (ready) => {
  bound(() => { // <-- use "bound" inside of a task
    ready();
  });
};

jobs.setInterval(task, 60 * 60 * 1000, 'task');
```
