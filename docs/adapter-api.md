# JoSk Custom Adapter API

JoSk library supports 3rd party storage adapters. By default it comes with support of MongoDB and Redis drivers. This document intended for developing custom 3rd party "JoSk Adapter". 

## Create a new Adapter

Start with copy of Adapter's boilerplate [`blank-adapter.js`](https://github.com/veliovgroup/josk/blob/master/adapters/blank-example.js).

## Adapter Class API

List of required methods and its arguments

- `new Adapter(joskInstance, opts)` constructor
  - `{JoSk} joskInstance`
  - `{object} opts`
- `Adapter#acquireLock(cb) - {void 0}`
  - `{function} cb`
- `Adapter#releaseLock(cb) - {void 0}`
  - `{function} cb`
- `Adapter#clear(uid, cb) - {void 0}`
  - `{string} uid` - Unique ID of the task
  - `{function} cb`
- `Adapter#addTask(uid, cb) - {void 0}`
  - `{string} uid` - Unique ID of the task
  - `{boolean} isInterval` - true/false defining loop or one-time task
  - `{number} delay` - Delay in milliseconds
- `Adapter#getDoneCallback(task) - {function}`
  - `{object} task` - Task's object (*see its structure below*)
- `Adapter#runTasks(nextExecuteAt, cb) - {void 0}`
  - `{Date} nextExecuteAt` - Date defining time of the next execution for "zombie" tasks
  - `{function} cb`

### Task object

In order to execute the task, "adapter" must call `this.joskInstance.__execute(task)` method inside `Adapter#runTasks` method, passed task's object is expected to have the next structure:

```js
({
  uid: String, // unique task's ID
  delay: Number,
  executeAt: Number, // or Date
  isInterval: Boolean,
  isDeleted: Boolean
})
```

For inspiration take a look on [MongoDB and Redis adapters implementation](https://github.com/veliovgroup/josk/tree/master/adapters).
