# JoSk Custom Adapter API

JoSk library supports 3rd party storage adapters. By default JoSk shipped with MongoDB and Redis support (official `mongodb` and `redis` NPM drivers). This document intended for developers of custom 3rd party "JoSk Adapters".

## Create a new Adapter

Start with copy of Adapter's boilerplate [`blank-adapter.js`](https://github.com/veliovgroup/josk/blob/master/adapters/blank-example.js).

## Adapter Class API

List of required methods and its arguments

- `new Adapter(opts)` constructor
  - `{object} opts`
  - `{string} [opts.prefix]` — optional prefix for scope isolation; use when creating multiple JoSK instances within the single application
  - `{boolean} [opts.resetOnInit]` - optional flag to clear/drop storage records from the previous runs on initialization
  - `{mix} [opts.other]` - other options required for specific storage type
- async `Adapter#ping - {Promise<object>}`
- async `Adapter#acquireLock() - {Promise<boolean>}`
- async `Adapter#releaseLock() - {Promise<void 0>}`
- async `Adapter#remove(uid) - {Promise<boolean>}`
  - `{string} uid` - Unique ID of the task
- async `Adapter#add(uid, isInterval, delay) - {Promise<void 0>}`
  - `{string} uid` - Unique ID of the task
  - `{boolean} isInterval` - true/false defining loop or one-time task
  - `{number} delay` - Delay in milliseconds
- async `Adapter#update(task, nextExecuteAt) - {Promise<boolean>}`
  - `{object} task` - Task's object (*see its structure below*)
  - `{Date} nextExecuteAt` - Date defining time of the next execution for "interval" tasks
- async `Adapter#iterate(nextExecuteAt) - {Promise<void 0>}`
  - `{Date} nextExecuteAt` - Date defining time of the next execution for "zombie" tasks

### Task object

In order to execute the task, "adapter" must call `this.joskInstance.__execute(task)` method inside `Adapter#iterate` method, passed task's object is expected to have the next structure:

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
