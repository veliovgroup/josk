JoSk
========
Simple package with similar API to native `setTimeout` and `setInterval` methods, but synced between all running NodeJS instances via MongoDB Collection.

Multi-instance task manager for Node.js. This package has the support of cluster or multi-thread NodeJS instances. This package will help you to make sure only one process of each task is running.

__This is a server-only package.__

- [Install](https://github.com/VeliovGroup/josk#install)
- [API](https://github.com/VeliovGroup/josk#api)
- [Constructor](https://github.com/VeliovGroup/josk#initialization)
- [setInterval](https://github.com/VeliovGroup/josk#setintervalfunc-delay)
- [setTimeout](https://github.com/VeliovGroup/josk#settimeoutfunc-delay)
- [setImmediate](https://github.com/VeliovGroup/josk#setimmediatefunc)
- [clearInterval](https://github.com/VeliovGroup/josk#clearintervaltimer)
- [clearTimeout](https://github.com/VeliovGroup/josk#cleartimeouttimer)
- [~90% tests coverage](https://github.com/VeliovGroup/josk#testing)

Install:
========
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

Notes:
========
This package is perfect when you have multiple servers for load-balancing, durability, an array of micro-services or any other solution with multiple running copies of code when you need to run repeating tasks, and you need to run it only once per app, not per server.

Limitation - task must be run not often than once per two seconds (from 2 to ∞ seconds). Example tasks: Email, SMS queue, Long-polling requests, Periodical application logic operations or Periodical data fetch and etc.

Accuracy - Delay of each task depends on MongoDB and "de-synchronization delay". Trusted time-range of execution period is `task_delay ± (256 + MongoDB_Connection_And_Request_Delay)`. That means this package won't fit when you need to run a task with very certain delays. For other cases, if `±256 ms` delays are acceptable - this package is the great solution.

API:
========
`new JoSk({opts})`:
 - `opts.db` {*Object*} - [Required] Connection to MongoDB, like returned as argument from `MongoClient.connect()`
 - `opts.prefix` {*String*} - [Optional] use to create multiple named instances
 - `opts.autoClear` {*Boolean*} - [Optional] Remove (*Clear*) obsolete tasks (*any tasks which are not found in the instance memory (runtime), but exists in the database*). Obsolete tasks may appear in cases when it wasn't cleared from the database on process shutdown, and/or was removed/renamed in the app. Obsolete tasks may appear if multiple app instances running different codebase within the same database, and the task may not exist on one of the instances. Default: `false`
 - `opts.resetOnInit` {*Boolean*} - [Optional] make sure all old tasks is completed before set new one. Useful when you run only one instance of app, or multiple app instances on one machine, in case machine was reloaded during running task and task is unfinished
 - `opts.zombieTime` {*Number*} - [Optional] time in milliseconds, after this time - task will be interpreted as "*zombie*". This parameter allows to rescue task from "*zombie* mode" in case when: `ready()` wasn't called, exception during runtime was thrown, or caused by bad logic. While `resetOnInit` option helps to make sure tasks are `done` on startup, `zombieTime` option helps to solve same issue, but during runtime. Default value is `900000` (*15 minutes*). It's not recommended to set this value to less than a minute (*60000ms*)
 - `opts.onError` {*Function*} - [Optional] Informational hook, called instead of throwing exceptions. Default: `false`. Called with two arguments:
     * `title` {*String*}
     * `details` {*Object*}
     * `details.description` {*String*}
     * `details.error` {*Mix*}
     * `details.uid` {*String*} - Internal `uid`, suitable for `.clearInterval()` and `.clearTimeout()`
 - `opts.onExecuted` {*Function*} - [Optional] Informational hook, called when task is finished. Default: `false`. Called with two arguments:
     * `uid` {*String*} - `uid` passed into `.setImmediate()`, `.setTimeout()`, or `setInterval()` methods
     * `details` {*Object*}
     * `details.uid` {*String*} - Internal `uid`, suitable for `.clearInterval()` and `.clearTimeout()`
     * `details.date` {*Date*} - Execution timestamp as JS *Date*
     * `details.timestamp` {*Number*} - Execution timestamp as unix *Number*

#### Initialization:
```javascript
MongoClient.connect(url, (error, client) => {
  const db = client.db('dbName');
  const job = new JoSk({db: db});
});
```

Note: This library relies on job ID, so you can not pass same job (with the same ID). Always use different `uid`, even for the same task:
```javascript
const task = function (ready) {
  //...some code here
  ready();
};

job.setInterval(task, 60 * 60 * 1000, 'task-1000');
job.setInterval(task, 60 * 60 * 2000, 'task-2000');
```

Passing arguments (*not really fancy solution, sorry*):
```javascript
const job = new JoSk({db: db});
let globalVar = 'Some top level or env.variable (can be changed over time)';

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


#### `setInterval(func, delay, uid)`

 - `func`  {*Function*} - Function to call on schedule
 - `delay` {*Number*}   - Delay for first run and interval between further executions in milliseconds
 - `uid`   {*String*}   - Unique app-wide task id

*Set task into interval execution loop.* `ready()` *is passed as the first argument into task function.*

In this example, next task will not be scheduled until the current is ready:
```javascript
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
```javascript
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
```javascript
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

#### `setTimeout(func, delay, uid)`

 - `func`  {*Function*} - Function to call on schedule
 - `delay` {*Number*}   - Delay in milliseconds
 - `uid`   {*String*}   - Unique app-wide task id

*Set task into timeout execution.* `setTimeout` *is useful for cluster - when you need to make sure task was executed only once.* `ready()` *is passed as the first argument into task function.*

```javascript
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

#### `setImmediate(func, uid)`

 - `func` {*Function*} - Function to execute
 - `uid`  {*String*}   - Unique app-wide task id

*Immediate execute the function, and only once.* `setImmediate` *is useful for cluster - when you need to execute function immediately and only once across all servers.* `ready()` *is passed as the first argument into the task function.*

```javascript
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

#### `clearInterval(timer)`
*Cancel (abort) current interval timer.* Should be called in a separate event loop from `setInterval`.

```javascript
const timer = job.setInterval(func, 34789, 'unique-taskid');
job.clearInterval(timer);
```

#### `clearTimeout(timer)`
*Cancel (abort) current timeout timer.* Should be called in a separate event loop from `setTimeout`.

```javascript
const timer = job.setTimeout(func, 34789, 'unique-taskid');
job.clearTimeout(timer);
```

Testing
======
```shell
# Before run tests make sure NODE_ENV === production
# Install NPM dependencies
npm install --save-dev

# Before run tests you need to have running MongoDB
MONGO_URL="mongodb://127.0.0.1:27017/testCollectionName" npm test

# Be patient, tests are taking around 2 mins
```

Why JoSk?
======
`JoSk` is *Job-Task* - Is randomly generated name by ["uniq" project](https://uniq.site)

Support this project:
======
This project wouldn't be possible without [ostr.io](https://ostr.io).

Using [ostr.io](https://ostr.io) you are not only [protecting domain names](https://ostr.io/info/domain-names-protection), [monitoring websites and servers](https://ostr.io/info/monitoring), using [Prerendering for better SEO](https://ostr.io/info/prerendering) of your JavaScript website, but support our Open Source activity, and great packages like this one could be available for free.