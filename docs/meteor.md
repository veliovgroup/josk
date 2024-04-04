# JoSk usage within Meteor.js

NPM `josk` package can be used in Meteor environment just perfectly fine since it's server-only Node.js package.

If Meteor.js packages are preferred in you project/environment follow this document to install JoSk as `ostrio:cron-jobs` [Atmosphere](https://atmospherejs.com/ostrio/cron-jobs) or  [Packosphere](https://packosphere.com/ostrio/cron-jobs) package

## Install

```shell
meteor add ostrio:cron-jobs
```

## Usage

```js
import { JoSk, RedisAdapter, MongoAdapter } from 'meteor/ostrio:cron-jobs';
```

### Initialization

JoSk is storage-agnostic (since `v4.0.0`). It's shipped with Redis and MongoDb "adapters" out of the box. Documentation below related to working with MongoDB provided and managed by Meteor.js. If you wish to use Redis as a driver for JoSk follow [Redis-related documentation from NPM version of the package](https://github.com/veliovgroup/josk?tab=readme-ov-file#redis-adapter). NPM section of the documentation is fully applicable to package installed from Atmosphere/Packosphere, the only difference is in how package imported

```js
import { MongoInternals } from 'meteor/mongo';
import { JoSk, MongoAdapter } from 'meteor/ostrio:cron-jobs';
const jobs = new JoSk({
  adapter: MongoAdapter,
  db: MongoInternals.defaultRemoteCollectionDriver().mongo.db,
});
```

Note: This library relies on job ID, so you can not pass same job (with the same ID). Always use different `uid`, even for the same task:

```js
const task = function (ready) {
  //... code here
  ready();
};

jobs.setInterval(task, 60 * 60 * 1000, 'task-1000'); // every minute
jobs.setInterval(task, 60 * 60 * 2000, 'task-2000'); // every two minutes
```

### CRON scheduler

```js
import { MongoInternals } from 'meteor/mongo';
import JoSk from 'meteor/ostrio:cron-jobs';
import parser from 'cron-parser';

const jobsCron = new JoSk({
  db: MongoInternals.defaultRemoteCollectionDriver().mongo.db,
  prefix: 'cron'
});

// CREATE HELPER FUNCTION
const setCron = (uniqueName, cronTask, task) => {
  const next = +parser.parseExpression(cronTask).next().toDate();
  const timeout = next - Date.now();

  return jobsCron.setTimeout(function (done) {
    done(() => {
      task(); // <- Execute task
      createCronTask(uniqueName, cronTask, task); // <- Create task for the next iteration
    });
  }, timeout, uniqueName);
};

setCron('Run every two seconds cron', '*/2 * * * * *', function () {
  console.log(new Date);
});
```

## Running Tests

1. Clone this package
2. Make sure Redis Server is installed and running
3. In Terminal (*Console*) go to directory where package is cloned
4. Then run:

```shell
# Default
REDIS_URL="redis://127.0.0.1:6379" meteor test-packages ./ --driver-package=meteortesting:mocha

# With custom port
REDIS_URL="redis://127.0.0.1:6379" meteor test-packages ./ --driver-package=meteortesting:mocha --port 8888

# With local MongoDB and custom port
MONGO_URL="mongodb://127.0.0.1:27017/meteor-josk-test-001" REDIS_URL="redis://127.0.0.1:6379" meteor test-packages ./ --driver-package=meteortesting:mocha --port 8888

# Be patient, tests are taking around 4 mins
```

## Known Meteor Issues:

`meteor@1` and `meteor@2` known to rely on `fibers` an may cause the next exception:

```log
Error: Can't wait without a fiber
```

Can be easily solved via "bounding to Fiber":

```js
const bound = Meteor.bindEnvironment((callback) => {
  callback();
});

const db  = Collection.rawDatabase();
const jobs = new JoSk({db: db});

const task = (ready) => {
  bound(() => { // <-- use "bound" inside of a task
    ready();
  });
};

jobs.setInterval(task, 60 * 60 * 1000, 'task');
```
