[![support](https://img.shields.io/badge/support-GitHub-white)](https://github.com/sponsors/dr-dimitru)
[![support](https://img.shields.io/badge/support-PayPal-white)](https://paypal.me/veliovgroup)
<a href="https://ostr.io/info/built-by-developers-for-developers?ref=github-josk-repo-top"><img src="https://ostr.io/apple-touch-icon-60x60.png" height="20"></a>
<a href="https://meteor-files.com/?ref=github-josk-repo-top"><img src="https://meteor-files.com/apple-touch-icon-60x60.png" height="20"></a>

# JoSk

"JoSk" is a Node.js task manager for horizontally scaled apps and apps that would need to scale horizontally quickly at some point of growth.

"JoSk" mimics the native API of `setTimeout` and `setInterval` and supports [CRON expressions](https://github.com/veliovgroup/josk?tab=readme-ov-file#cron). All queued tasks are synced between all running application instances via Redis, MongoDB, or a [custom adapter](https://github.com/veliovgroup/josk/blob/master/docs/adapter-api.md).

The "JoSk" package is made for a variety of horizontally scaled apps, such as clusters, multi-servers, and multi-threaded Node.js instances, that are running either on the same or different machines or even different data centers. "JoSk ensures that the only single execution of each task occurs across all running instances of the application.

"JoSk" is not just for multi-instance apps. It seamlessly integrates with single-instance applications as well, showcasing its versatility and adaptability.

__Note: JoSk is the server-only package.__

## ToC

- [Main features](https://github.com/veliovgroup/josk?tab=readme-ov-file#main-features)
- [Prerequisites](https://github.com/veliovgroup/josk?tab=readme-ov-file#prerequisites)
- [Install](https://github.com/veliovgroup/josk?tab=readme-ov-file#install) as [NPM package](https://www.npmjs.com/package/josk)
- [API](https://github.com/veliovgroup/josk?tab=readme-ov-file#api)
  - [Constructor `new JoSk()`](https://github.com/veliovgroup/josk?tab=readme-ov-file#initialization)
    - [`RedisAdapter`](https://github.com/veliovgroup/josk?tab=readme-ov-file#redis-adapter)
    - [`MongoAdapter`](https://github.com/veliovgroup/josk?tab=readme-ov-file#mongodb-adapter)
  - [`JoSk#setInterval()`](https://github.com/veliovgroup/josk?tab=readme-ov-file#setintervalfunc-delay-uid)
  - [`JoSk#setTimeout()`](https://github.com/veliovgroup/josk?tab=readme-ov-file#settimeoutfunc-delay-uid)
  - [`JoSk#setImmediate()`](https://github.com/veliovgroup/josk?tab=readme-ov-file#setimmediatefunc-uid)
  - [`JoSk#clearInterval()`](https://github.com/veliovgroup/josk?tab=readme-ov-file#clearintervaltimer)
  - [`JoSk#clearTimeout()`](https://github.com/veliovgroup/josk?tab=readme-ov-file#cleartimeouttimer)
  - [`JoSk#destroy()`](https://github.com/veliovgroup/josk?tab=readme-ov-file#destroy)
  - [`JoSk#ping()`](https://github.com/veliovgroup/josk?tab=readme-ov-file#ping)
- [Examples](https://github.com/veliovgroup/josk?tab=readme-ov-file#examples)
  - [CRON usage](https://github.com/veliovgroup/josk?tab=readme-ov-file#cron)
  - [Passing arguments](https://github.com/veliovgroup/josk?tab=readme-ov-file#pass-arguments)
  - [Clean up stale tasks](https://github.com/veliovgroup/josk?tab=readme-ov-file#clean-up-old-tasks)
  - [MongoDB connection options](https://github.com/veliovgroup/josk?tab=readme-ov-file#mongodb-connection-fine-tuning)
  - [Meteor.js](https://github.com/veliovgroup/josk/blob/master/docs/meteor.md)
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

- `redis-server@>=5.0.0` — Redis Server Version (*if used with RedisAdapter*)
- `mongod@>=4.0.0` — MongoDB Server Version (*if used with MongoAdapter*)
- `node@>=14.20.0` — Node.js version

### Older releases compatibility

- `mongod@<4.0.0` — use `josk@=1.1.0`
- `node@<14.20.0` — use `josk@=3.0.2`
- `node@<8.9.0` — use `josk@=1.1.0`

## Install:

```shell
npm install josk --save
```

```js
// ES Module Style
import { JoSk, RedisAdapter, MongoAdapter } from 'josk';

// CommonJS
const { JoSk, RedisAdapter, MongoAdapter } = require('josk');
```

## API:

Constructor options for *JoSK*, *MongoAdapter*, and *RedisAdapter*

### `new JoSk(opts)`

- `opts.adapter` {*RedisAdapter*|*MongoAdapter*} - [Required] Instance of `RedisAdapter` or `MongoAdapter` or [custom adapter](https://github.com/veliovgroup/josk/blob/master/docs/adapter-api.md)
- `opts.debug` {*Boolean*} - [Optional] Enable debugging messages, useful during development
- `opts.autoClear` {*Boolean*} - [Optional] Remove (*Clear*) obsolete tasks (*any tasks which are not found in the instance memory (runtime), but exists in the database*). Obsolete tasks may appear in cases when it wasn't cleared from the database on process shutdown, and/or was removed/renamed in the app. Obsolete tasks may appear if multiple app instances running different codebase within the same database, and the task may not exist on one of the instances. Default: `false`
- `opts.zombieTime` {*Number*} - [Optional] time in milliseconds, after this time - task will be interpreted as "*zombie*". This parameter allows to rescue task from "*zombie* mode" in case when: `ready()` wasn't called, exception during runtime was thrown, or caused by bad logic. While `resetOnInit` option helps to make sure tasks are `done` on startup, `zombieTime` option helps to solve same issue, but during runtime. Default value is `900000` (*15 minutes*). It's not recommended to set this value to below `60000` (*one minute*)
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

### `new RedisAdapter(opts)`

*Since* `v5.0.0`

- `opts.client` {*RedisClient*} - [*Required*] `RedisClient` instance, like one returned from `await redis.createClient().connect()` method
- `opts.prefix` {*String*} - [Optional] use to create multiple named instances
- `opts.resetOnInit` {*Boolean*} - [Optional] (*__use with caution__*) make sure all old tasks are completed during initialization. Useful for single-instance apps to clean up unfinished that occurred due to intermediate shutdown, reboot, or exception. Default: `false`

### `new MongoAdapter(opts)`

*Since* `v5.0.0`

- `opts.db` {*Db*} - [*Required*] Mongo's `Db` instance, like one returned from `MongoClient#db()` method
- `opts.prefix` {*String*} - [Optional] use to create multiple named instances
- `opts.lockCollectionName` {*String*} - [Optional] By default all JoSk instances use the same `__JobTasks__.lock` collection for locking
- `opts.resetOnInit` {*Boolean*} - [Optional] (*__use with caution__*) make sure all old tasks are completed during initialization. Useful for single-instance apps to clean up unfinished that occurred due to intermediate shutdown, reboot, or exception. Default: `false`

### Initialization

JoSk is storage-agnostic (since `v4.0.0`). It's shipped with Redis and MongoDB "adapters" out of the box, with option to extend its capabilities by creating and passing a [custom adapter](https://github.com/veliovgroup/josk/blob/master/docs/adapter-api.md)

#### Redis Adapter

JoSk has no dependencies, hence make sure `redis` NPM package is installed in order to support Redis Storage Adapter. `RedisAdapter` utilize basic set of commands `SET`, `GET`, `DEL`, `EXISTS`, `HSET`, `HGETALL`, and `SCAN`. `RedisAdapter` is compatible with all Redis-alike databases, and was well-tested with [Redis](https://redis.io/) and [KeyDB](https://docs.keydb.dev/)

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

### `setTimeout(func, delay, uid)`

- `func` {*Function*} - Function to call after `delay`
- `delay` {*Number*} - Delay in milliseconds
- `uid` {*String*} - Unique app-wide task id
- Returns: {*`Promise<string>`*}

*Run a task after delay in ms.* `setTimeout` *is useful for cluster - when you need to make sure task executed only once.* `ready()` *callback is passed as the first argument into a task function.*

```js
jobs.setTimeout(function (ready) {
  /* ...run sync code... */
  ready();
}, 60000, 'syncTaskIn1m'); // will run only once across the cluster in a minute

jobs.setTimeout(function (ready) {
  asyncCall(function () {
    /* ...run async code... */
    ready();
  });
}, 60000, 'asyncTaskIn1m'); // will run only once across the cluster in a minute

jobs.setTimeout(async function () {
  try {
    /* ...code here... */
    await asyncMethod();
    /* ...more code here...*/
  } catch (err) {
    console.log(err)
  }
}, 60000, 'asyncAwaitTaskIn1m'); // will run only once across the cluster in a minute
```

### `setImmediate(func, uid)`

- `func` {*Function*} - Function to execute
- `uid`  {*String*}   - Unique app-wide task id
- Returns: {*`Promise<string>`*}

*Immediate execute the function, and only once.* `setImmediate` *is useful for cluster - when you need to execute function immediately and only once across all servers.* `ready()` *is passed as the first argument into the task function.*

```js
jobs.setImmediate(function (ready) {
  //...run sync code
  ready();
}, 'syncTask'); // will run immediately and only once across the cluster

jobs.setImmediate(function (ready) {
  asyncCall(function () {
    //...run more async code
    ready();
  });
}, 'asyncTask'); // will run immediately and only once across the cluster

jobs.setImmediate(async function () {
  try {
    /* ...code here... */
    await asyncMethod();
  } catch (err) {
    console.log(err)
  }
}, 'asyncTask'); // will run immediately and only once across the cluster
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
// EXAMPLE: DESTROY JoSk INSTANCE UPON SERVER PROCESS TERMINATION
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

## Examples

Use cases and usage examples

### CRON

Use JoSk to invoke synchronized tasks by CRON schedule, and [`cron-parser` package](https://www.npmjs.com/package/cron-parser) to parse CRON expressions. To simplify CRON scheduling — grab and use `setCron` function below:

```js
import parser from 'cron-parser';

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
  const nextTimestamp = +parser.parseExpression(cronTask).next().toDate();

  return await jobsCron.setInterval(function (ready) {
    ready(parser.parseExpression(cronTask).next().toDate());
    task();
  }, nextTimestamp - Date.now(), uniqueName);
};

setCron('Run every two seconds cron', '*/2 * * * * *', function () {
  console.log(new Date);
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
redis-cli --no-auth-warning KEYS "josk:default:*" | xargs redis-cli --raw --no-auth-warning DEL

# If you're using multiple JoSk instances with prefix:
redis-cli --no-auth-warning KEYS "josk:prefix:*" | xargs redis-cli --raw --no-auth-warning DEL
```

#### Clean up MongoDB

To clean up old tasks via MongoDB use the next query pattern:

```js
// Run directly in MongoDB console:
db.getCollection('__JobTasks__').remove({});
// If you're using multiple JoSk instances with prefix:
db.getCollection('__JobTasks__PrefixHere').remove({});
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

## Notes

- This package is perfect when you have multiple horizontally scaled servers for load-balancing, durability, an array of micro-services or any other solution with multiple running copies of code running repeating tasks that needs to run only once per application/cluster, not per server/instance;
- Limitation — task must be run not often than once per two seconds (from 2 to ∞ seconds). Example tasks: [Email](https://www.npmjs.com/package/mail-time), SMS queue, Long-polling requests, Periodical application logic operations or Periodical data fetch, sync, and etc;
- Accuracy — Delay of each task depends on storage and "de-synchronization delay". Trusted time-range of execution period is `task_delay ± (256 + Storage_Request_Delay)`. That means this package won't fit when you need to run a task with very precise delays. For other cases, if `±256 ms` delays are acceptable - this package is the great solution;
- Use `opts.minRevolvingDelay` and `opts.maxRevolvingDelay` to set the range for *random* delays between executions. Revolving range acts as a safety control to make sure different servers __not__ picking the same task at the same time. Default values (`128` and `768`) are the best for 3-server setup (*the most common topology*). Tune these options to match needs of your project. Higher `opts.minRevolvingDelay` will reduce storage read/writes;
- This package implements "Read Locking" via "RedLock" for Redis and dedicated `.lock` collection for MongoDB.

## Running Tests

1. Clone this package
2. In Terminal (*Console*) go to directory where package is cloned
3. Then run:

```shell
# Before running tests make sure NODE_ENV === development
# Install NPM dependencies
npm install --save-dev

# Before running tests you need
# to have access to MongoDB and Redis servers
REDIS_URL="redis://127.0.0.1:6379" MONGO_URL="mongodb://127.0.0.1:27017/npm-josk-test-001" npm test

# If previous run has errors — add "debug" to output extra logs
DEBUG=true REDIS_URL="redis://127.0.0.1:6379" MONGO_URL="mongodb://127.0.0.1:27017/npm-josk-test-001" npm test

# Be patient, tests are taking around 6 mins
```

### Run Redis tests only

Run Redis-related tests only

```shell
# Before running Redis tests you need to have Redis server installed and running
REDIS_URL="redis://127.0.0.1:6379" npm run test-redis

# Be patient, tests are taking around 3 mins
```

### Run MongoDB tests only

Run MongoDB-related tests only

```shell
# Before running Mongo tests you need to have MongoDB server installed and running
MONGO_URL="mongodb://127.0.0.1:27017/npm-josk-test-001" npm run test-mongo

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
