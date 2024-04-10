# JoSk usage within Meteor.js

NPM `josk` package can be used in Meteor environment just perfectly fine since it's server-only Node.js package.

If Meteor.js packages are preferred in your project/environment follow this document to install JoSk as `ostrio:cron-jobs` [Atmosphere](https://atmospherejs.com/ostrio/cron-jobs) or  [Packosphere](https://packosphere.com/ostrio/cron-jobs) package

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
  adapter: new MongoAdapter({
    db: db: MongoInternals.defaultRemoteCollectionDriver().mongo.db,
    prefix: 'cluster-scheduler',
  }),
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
import JoSk from 'meteor/ostrio:cron-jobs';
import parser from 'cron-parser';

const jobsCron = new JoSk({
  adapter: new MongoAdapter({
    db: db: MongoInternals.defaultRemoteCollectionDriver().mongo.db,
    prefix: 'cron-scheduler',
  }),
  minRevolvingDelay: 512, // Adjust revolving delays to higher values
  maxRevolvingDelay: 1000, // as CRON schedule defined to seconds
});

// CREATE HELPER FUNCTION
const setCron = async (uniqueName, cronTask, task) => {
  const nextTimestamp = +parser.parseExpression(cronTask).next().toDate();

  return await jobsCron.setInterval(function (ready) {
    ready(parser.parseExpression(cronTask).next().toDate());
    task();
  }, nextTimestamp - Date.now(), uniqueName);
};

// SCHEDULE A TASK
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

# With local MongoDB, debug and custom port
DEBUG=true MONGO_URL="mongodb://127.0.0.1:27017/meteor-josk-test-001" REDIS_URL="redis://127.0.0.1:6379" meteor test-packages ./ --driver-package=meteortesting:mocha --port 8888

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
