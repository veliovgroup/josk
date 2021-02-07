[![support](https://img.shields.io/badge/support-GitHub-white)](https://github.com/sponsors/dr-dimitru)
[![support](https://img.shields.io/badge/support-PayPal-white)](https://paypal.me/veliovgroup)
<a href="https://ostr.io/info/built-by-developers-for-developers">
  <img src="https://ostr.io/apple-touch-icon-60x60.png" height="20">
</a>

# JoSk

Simple package with similar API to native `setTimeout` and `setInterval` methods, but synced between all running Node.js instances via MongoDB Collection.

Multi-instance task manager for Node.js. This package has the support of clusters, multi-server and multi-threaded Node.js instances. This package goal is to make sure that the only single process of each *task* (*job*/*cron*) is running across *multi-server* (*multi-thread*/*multi-instance*) setup.

__This is a server-only package.__

## ToC:

- [Install](https://github.com/veliovgroup/josk#install) as [NPM package](https://www.npmjs.com/package/josk)
- [Install Meteor](https://github.com/veliovgroup/josk#install-meteor) as [Atmosphere package](https://atmospherejs.com/ostrio/cron-jobs)
- [API](https://github.com/veliovgroup/josk#api)
  - [Constructor `new JoSk()`](https://github.com/veliovgroup/josk#initialization)
  - [`JoSk#setInterval()`](https://github.com/veliovgroup/josk#setintervalfunc-delay-uid)
  - [`JoSk#setTimeout()`](https://github.com/veliovgroup/josk#settimeoutfunc-delay-uid)
  - [`JoSk#setImmediate()`](https://github.com/veliovgroup/josk#setimmediatefunc-uid)
  - [`JoSk#clearInterval()`](https://github.com/veliovgroup/josk#clearintervaltimer)
  - [`JoSk#clearTimeout()`](https://github.com/veliovgroup/josk#cleartimeouttimer)
  - [`JoSk#destroy()`](https://github.com/veliovgroup/josk#destroy)
- [~90% tests coverage](https://github.com/veliovgroup/josk#running-tests)

## Main features:

- 👨‍🔬 ~90% tests coverage;
- 📦 Zero dependencies, written from scratch for top performance;
- 🏢 Synchronize single task across multiple servers;
- 🔏 Collection locking to avoid simultaneous task executions across complex infrastructure;
- 💪 Bulletproof design, built-in retries, and "zombie" task recovery 🧟🔫.

## Install:

```shell
# for node@>=8.9.0
npm install josk --save

# for node@<8.9.0
npm install josk@=1.1.0 --save
```

```js
const JoSk = require('josk');

//ES6 Style:
import JoSk from 'josk';
```

## Install Meteor:

```shell
meteor add ostrio:cron-jobs
```

```js
import JoSk from 'meteor/ostrio:cron-jobs';
```

### Known Meteor Issues:

```log
Error: Can't wait without a fiber
```

Can be easily solved via "bounding to Fiber":

```js
const bound = Meteor.bindEnvironment((callback) => {
  callback();
});

const db  = Collection.rawDatabase();
const job = new JoSk({db: db});

const task = (ready) => {
  bound(() => { // <-- use "bound" inside of a task
    ready();
  });
};

job.setInterval(task, 60 * 60 * 1000, 'task');
```

## Notes:

- This package is perfect when you have multiple servers for load-balancing, durability, an array of micro-services or any other solution with multiple running copies of code when you need to run repeating tasks, and you need to run it only once per app, not per server;
- Limitation — task must be run not often than once per two seconds (from 2 to ∞ seconds). Example tasks: Email, SMS queue, Long-polling requests, Periodical application logic operations or Periodical data fetch and etc;
- Accuracy — Delay of each task depends on MongoDB and "de-synchronization delay". Trusted time-range of execution period is `task_delay ± (256 + MongoDB_Connection_And_Request_Delay)`. That means this package won't fit when you need to run a task with very certain delays. For other cases, if `±256 ms` delays are acceptable - this package is the great solution;
- Use `opts.minRevolvingDelay` and `opts.maxRevolvingDelay` to set the range for *random* delays between executions. Revolving range acts as a safety control to make sure different servers __not__ picking the same task at the same time. Default values (`128` and `768`) are the best for 3-server setup (*the most common topology*). Tune these options to match needs of your project. Higher `opts.minRevolvingDelay` will reduce load on MongoDB;
- To avoid "DB locks" — it's recommended to use separate DB from "main" application DB (*same MongoDB server can have multiple DBs*).
- This package implements "Collection Locking" via special collection ending with `.lock` prefix;
- In total this package will add two new MongoDB collections per each `new JoSk({ prefix })` to a database it's connected.

## API:

`new JoSk({opts})`:

- `opts.db` {*Object*} - [Required] Connection to MongoDB, like returned as argument from `MongoClient.connect()`
- `opts.prefix` {*String*} - [Optional] use to create multiple named instances
- `opts.autoClear` {*Boolean*} - [Optional] Remove (*Clear*) obsolete tasks (*any tasks which are not found in the instance memory (runtime), but exists in the database*). Obsolete tasks may appear in cases when it wasn't cleared from the database on process shutdown, and/or was removed/renamed in the app. Obsolete tasks may appear if multiple app instances running different codebase within the same database, and the task may not exist on one of the instances. Default: `false`
- `opts.resetOnInit` {*Boolean*} - [Optional] make sure all old tasks is completed before set new one. Useful when you run only one instance of app, or multiple app instances on one machine, in case machine was reloaded during running task and task is unfinished
- `opts.zombieTime` {*Number*} - [Optional] time in milliseconds, after this time - task will be interpreted as "*zombie*". This parameter allows to rescue task from "*zombie* mode" in case when: `ready()` wasn't called, exception during runtime was thrown, or caused by bad logic. While `resetOnInit` option helps to make sure tasks are `done` on startup, `zombieTime` option helps to solve same issue, but during runtime. Default value is `900000` (*15 minutes*). It's not recommended to set this value to less than a minute (*60000ms*)
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

### Initialization:

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
    level: 'linearizable'
  },
  readPreference: 'primary',
  connectWithNoPrimary: false
};

MongoClient.connect('url', options, (error, client) => {
  // To avoid "DB locks" — it's a good idea to use separate DB from "main" application DB
  const db = client.db('dbName');
  const job = new JoSk({db: db});
});
```

#### Initialization in Meteor:

```js
// Meteor.users.rawDatabase() is available in most Meteor setups
// If this is not your case, you can use `rawDatabase` form any other collection
const db  = Meteor.users.rawDatabase();
const job = new JoSk({db: db});
```

Note: This library relies on job ID, so you can not pass same job (with the same ID). Always use different `uid`, even for the same task:

```js
const task = function (ready) {
  //...some code here
  ready();
};

job.setInterval(task, 60 * 60 * 1000, 'task-1000');
job.setInterval(task, 60 * 60 * 2000, 'task-2000');
```

Passing arguments (*not really fancy solution, sorry*):

```js
const job = new JoSk({db: db});
let globalVar = 'Some top level or env.variable (can be changed during runtime)';

const task = function (arg1, arg2, ready) {
  //...some code here
  ready();
};

const taskB = function (ready) {
  task(globalVar, 'b', ready);
};

const task1 = function (ready) {
  task(1, globalVar, ready);
};

job.setInterval(taskB, 60 * 60 * 1000, 'taskB');
job.setInterval(task1, 60 * 60 * 1000, 'task1');
```

Note: To clean up old tasks via MongoDB use next query pattern:

```js
// Run directly in MongoDB console:
db.getCollection('__JobTasks__').remove({});
// If you're using multiple JoSk instances with prefix:
db.getCollection('__JobTasks__PrefixHere').remove({});
```

### `setInterval(func, delay, uid)`

- `func`  {*Function*} - Function to call on schedule
- `delay` {*Number*}   - Delay for first run and interval between further executions in milliseconds
- `uid`   {*String*}   - Unique app-wide task id

*Set task into interval execution loop.* `ready()` *is passed as the first argument into task function.*

In this example, next task will not be scheduled until the current is ready:

```js
const syncTask = function (ready) {
  //...run sync code
  ready();
};
const asyncTask = function (ready) {
  asyncCall(function () {
    //...run more async code
    ready();
  });
};

job.setInterval(syncTask, 60 * 60 * 1000, 'syncTask');
job.setInterval(asyncTask, 60 * 60 * 1000, 'asyncTask');
```

In this example, next task will not wait for the current task to finish:

```js
const syncTask = function (ready) {
  ready();
  //...run sync code
};
const asyncTask = function (ready) {
  ready();
  asyncCall(function () {
    //...run more async code
  });
};

job.setInterval(syncTask, 60 * 60 * 1000, 'syncTask');
job.setInterval(asyncTask, 60 * 60 * 1000, 'asyncTask');
```

In this example, we're assuming to have long running task, executed in a loop without delay, but after full execution:

```js
const longRunningAsyncTask = function (ready) {
  asyncCall((error, result) => {
    if (error) {
      ready(); // <-- Always run `ready()`, even if call was unsuccessful
    } else {
      anotherCall(result.data, ['param'], (error, response) => {
        waitForSomethingElse(response, () => {
          ready(); // <-- End of full execution
        });
      });
    }
  });
};

job.setInterval(longRunningAsyncTask, 0, 'longRunningAsyncTask');
```

### `setTimeout(func, delay, uid)`

- `func`  {*Function*} - Function to call on schedule
- `delay` {*Number*}   - Delay in milliseconds
- `uid`   {*String*}   - Unique app-wide task id

*Set task into timeout execution.* `setTimeout` *is useful for cluster - when you need to make sure task was executed only once.* `ready()` *is passed as the first argument into task function.*

```js
const syncTask = function (ready) {
  //...run sync code
  ready();
};
const asyncTask = function (ready) {
  asyncCall(function () {
    //...run more async code
    ready();
  });
};

job.setTimeout(syncTask, 60 * 60 * 1000, 'syncTask');
job.setTimeout(asyncTask, 60 * 60 * 1000, 'asyncTask');
```

### `setImmediate(func, uid)`

- `func` {*Function*} - Function to execute
- `uid`  {*String*}   - Unique app-wide task id

*Immediate execute the function, and only once.* `setImmediate` *is useful for cluster - when you need to execute function immediately and only once across all servers.* `ready()` *is passed as the first argument into the task function.*

```js
const syncTask = function (ready) {
  //...run sync code
  ready();
};
const asyncTask = function (ready) {
  asyncCall(function () {
    //...run more async code
    ready();
  });
};

job.setImmediate(syncTask, 'syncTask');
job.setImmediate(asyncTask, 'asyncTask');
```

### `clearInterval(timer)`

*Cancel (abort) current interval timer.* Must be called in a separate event loop from `setInterval`.

```js
const timer = job.setInterval(func, 34789, 'unique-taskid');
job.clearInterval(timer);
```

### `clearTimeout(timer)`

*Cancel (abort) current timeout timer.* Should be called in a separate event loop from `setTimeout`.

```js
const timer = job.setTimeout(func, 34789, 'unique-taskid');
job.clearTimeout(timer);
```

### `destroy()`

*Destroy JoSk instance*. This method shouldn't be called in normal circumstances. Stop internal interval timer. After JoSk is destroyed — calling public methods would end up logged to `std` or if `onError` hook was passed to JoSk it would receive an error. Only permitted methods are `clearTimeout` and `clearInterval`.

```js
const job = new JoSk({db: db});

job.destroy();
```

## Running Tests

1. Clone this package
2. In Terminal (*Console*) go to directory where package is cloned
3. Then run:

```shell
# Before run tests make sure NODE_ENV === development
# Install NPM dependencies
npm install --save-dev

# Before run tests you need to have running MongoDB
MONGO_URL="mongodb://127.0.0.1:27017/npm-josk-test-001" npm test

# Be patient, tests are taking around 2 mins
```

### Running Tests in Meteor environment

```shell
# Default
meteor test-packages ./ --driver-package=meteortesting:mocha

# With custom port
meteor test-packages ./ --driver-package=meteortesting:mocha --port 8888

# With local MongoDB and custom port
MONGO_URL="mongodb://127.0.0.1:27017/meteor-josk-test-001" meteor test-packages ./ --driver-package=meteortesting:mocha --port 8888

# Be patient, tests are taking around 2 mins
```

## Why JoSk?

`JoSk` is *Job-Task* - Is randomly generated name by ["uniq" project](https://uniq.site)

## Support our open source contribution:

- [Sponsor via GitHub](https://github.com/sponsors/dr-dimitru) — support open source contributions on a regular basis
- [Support via PayPal](https://paypal.me/veliovgroup) — support open source contributions once
- Use [ostr.io](https://ostr.io) — [Monitoring](https://snmp-monitoring.com), [Analytics](https://ostr.io/info/web-analytics), [WebSec](https://domain-protection.info), [Web-CRON](https://web-cron.info) and [Pre-rendering](https://prerendering.com) for a website
