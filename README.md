JoSk
========
Simple package with similar API to native `setTimeout` and `setInterval` methods, but synced between all running NodeJS instances via MongoDB Collection.

Multi-instance task manager for Node.js. This package has support of cluster or multi-thread NodeJS instances. This package will help you to make sure only one process of each task is running.

__This is server-only package.__

- [Install](https://github.com/VeliovGroup/josk#install)
- [API](https://github.com/VeliovGroup/josk#api)
- [Constructor](https://github.com/VeliovGroup/josk#initialization)
- [setInterval](https://github.com/VeliovGroup/josk#setintervalfunc-delay)
- [setTimeout](https://github.com/VeliovGroup/josk#settimeoutfunc-delay)
- [setImmidiate](https://github.com/VeliovGroup/josk#setimmidiatefunc)
- [clearInterval](https://github.com/VeliovGroup/josk#clearintervaltimer)
- [clearTimeout](https://github.com/VeliovGroup/josk#cleartimeouttimer)

Install:
========
```shell
npm install josk --save
```

```js
var JoSk = require('josk');

//ES6 Style:
import JoSk from 'josk';
```

Notes:
========
This package is perfect when you have multiple servers for load-balancing, durability, array of micro-services or any other solution with multiple running copies of code when you need to run repeating tasks, and you need to run it only once per app, not per server.

Limitation - task must be run not often then once per two seconds (from 2 to ∞ seconds). Example tasks: Email, SMS queue, Long-polling requests, Periodical application logic operations or Periodical data fetch and etc.

Accuracy - Delay of each task depends from MongoDB and "de-synchronization delay". Trusted time-range of execution period is `task_delay ± (1536 + MongoDB_Connection_And_Request_Delay)`. That means this package won't fit when you need to run task with very certain delays. For other cases if `±1536 ms` delays is acceptable - this package is great solution.

API:
========
`new JoSk({opts})`:
 - `opts.db` {*Object*} - [Required] Connection to MongoDB, like returned as argument from `MongoClient.connect()`
 - `opts.prefix` {*String*} - [Optional] use to create multiple named instances
 - `opts.resetOnInit` {*Boolean*} - [Optional] make sure all old tasks is completed before set new one. Useful when you run only one instance of app, or multiple app instances on one machine, in case machine was reloaded during running task and task is unfinished
 - `opts.zombieTime` {*Number*} - [Optional] time in milliseconds, after this time - task will be interpreted as "*zombie*". This parameter allows to rescue task from "*zombie* mode" in case when `ready()` wasn't called, exception during runtime was thrown, or caused by bad logic. Where `resetOnInit` makes sure task is done on startup, but `zombieTime` doing the same function but during runtime. Default value is `900000` (*15 minutes*)

#### Initialization:
```javascript
MongoClient.connect(url, function (error, db) {
  var Job = new JoSk({db: db});
});
```

Note: This library relies on job ID, so you can not pass same job (with same ID). Always use different `uid`, even for same task:
```javascript
var task = function (ready) {
  //...some code here
  ready();
};

Job.setInterval(task, 60*60*1000, 'task-1000');
Job.setInterval(task, 60*60*2000, 'task-2000');
```

Passing arguments (*not really fancy solution, sorry*):
```javascript
var Job = new JoSk({db: db});
var globalVar = 'Some top level or env.variable (can be changed over time)';

var task = function (arg1, arg2, ready) {
  //...some code here
  ready();
};

var taskB = function (ready) {
  task(globalVar, 'b', ready);
};

var task1 = function (ready) {
  task(1, globalVar, ready);
};

Job.setInterval(taskB, 60*60*1000, 'taskB');
Job.setInterval(task1, 60*60*1000, 'task1');
```

Note: To cleanup old tasks via MongoDB use next query pattern:
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

*Set task into interval execution loop.* `ready()` *is passed as third argument into function.*

In this example, next task will not be scheduled until current is ready:
```javascript
var syncTask = function (ready) {
  //...run sync code
  ready();
};
var asyncTask = function (ready) {
  asyncCall(function () {
    //...run more async code
    ready();
  });
};

Job.setInterval(syncTask, 60*60*1000, 'syncTask');
Job.setInterval(asyncTask, 60*60*1000, 'asyncTask');
```

In this example, next task will not wait for current task to finish:
```javascript
var syncTask = function (ready) {
  ready();
  //...run sync code
};
var asyncTask = function (ready) {
  ready();
  asyncCall(function () {
    //...run more async code
  });
};

Job.setInterval(syncTask, 60*60*1000, 'syncTask');
Job.setInterval(asyncTask, 60*60*1000, 'asyncTask');
```

In this example, we're assuming to have long running task, executed in a loop without delay, but after full execution:
```javascript
var longRunningAsyncTask = function (ready) {
  asyncCall(function (error, result) {
    if(error){
      ready(); // <-- Always run `ready()`, even if call was unsuccessful
    } else {
      anotherCall(result.data, ['param'], function (error, response) {
        waitForSomethingElse(response, function () {
          ready(); // <-- End of full execution
        });
      });
    }
  });
};

Job.setInterval(longRunningAsyncTask, 0, 'longRunningAsyncTask');
```

#### `setTimeout(func, delay, uid)`

 - `func`  {*Function*} - Function to call on schedule
 - `delay` {*Number*}   - Delay in milliseconds
 - `uid`   {*String*}   - Unique app-wide task id

*Set task into timeout execution.* `setTimeout` *is useful for cluster - when you need to make sure task was executed only once.*
`ready()` *is passed as third argument into function.*

```javascript
var syncTask = function (ready) {
  //...run sync code
  ready();
};
var asyncTask = function (ready) {
  asyncCall(function () {
    //...run more async code
    ready();
  });
};

Job.setTimeout(syncTask, 60*60*1000, 'syncTask');
Job.setTimeout(asyncTask, 60*60*1000, 'asyncTask');
```

#### `setImmidiate(func, uid)`

 - `func` {*Function*} - Function to execute
 - `uid`  {*String*}   - Unique app-wide task id

*Immediate execute function, and only once.* `setImmidiate` *is useful for cluster - when you need to execute function immediately and only once across all servers.* `ready()` *is passed as third argument into function.*

```javascript
var syncTask = function (ready) {
  //...run sync code
  ready();
};
var asyncTask = function (ready) {
  asyncCall(function () {
    //...run more async code
    ready();
  });
};

Job.setImmidiate(syncTask, 'syncTask');
Job.setImmidiate(asyncTask, 'asyncTask');
```

#### `clearInterval(timer)`
*Cancel (abort) current interval timer.*

```javascript
var timer = Job.setInterval(func, 34789, 'unique-taskid');
Job.clearInterval(timer);
```

#### `clearTimeout(timer)`
*Cancel (abort) current timeout timer.*

```javascript
var timer = Job.setTimeout(func, 34789, 'unique-taskid');
Job.clearTimeout(timer);
```

#### Why JoSK?
`JoSk` is *Job-Task* - Is randomly generated name by [uniq project](https://uniq.site)