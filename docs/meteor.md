# JoSk usage within Meteor.js

NPM `josk` package can be used in Meteor environment just perfectly fine since it's server-only Node.js package. Alternatively follow this documentation to [install JoSk](https://github.com/veliovgroup/josk#install-meteor) as [`ostrio:cron-jobs` Atmosphere package](https://atmospherejs.com/ostrio/cron-jobs)

## Install

```shell
meteor add ostrio:cron-jobs
```

## Usage

```js
import JoSk from 'meteor/ostrio:cron-jobs';
```

### Initialization

```js
import { MongoInternals } from 'meteor/mongo';
import JoSk from 'meteor/ostrio:cron-jobs';
const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;
const job = new JoSk({ db });
```

Note: This library relies on job ID, so you can not pass same job (with the same ID). Always use different `uid`, even for the same task:

```js
const task = function (ready) {
  //... code here
  ready();
};

job.setInterval(task, 60 * 60 * 1000, 'task-1000'); // every minute
job.setInterval(task, 60 * 60 * 2000, 'task-2000'); // every two minutes
```

### CRON scheduler

```js
import { MongoInternals } from 'meteor/mongo';
import JoSk from 'meteor/ostrio:cron-jobs';
import parser from 'cron-parser';

const jobCron = new JoSk({
  db: MongoInternals.defaultRemoteCollectionDriver().mongo.db,
  maxRevolvingDelay: 256, // <- Speed up timer speed by lowering its max revolving delay
  zombieTime: 1024, // <- will need to call `done()` right away
  prefix: 'cron'
});

// CREATE HELPER FUNCTION
const setCron = (uniqueName, cronTask, task) => {
  const next = +parser.parseExpression(cronTask).next().toDate();
  const timeout = next - Date.now();

  return jobCron.setTimeout(function (done) {
    done(() => { // <- call `done()` right away
      // MAKE SURE FURTHER LOGIC EXECUTED
      // INSIDE done() CALLBACK
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
2. In Terminal (*Console*) go to directory where package is cloned
3. Then run:

```shell
# Default
meteor test-packages ./ --driver-package=meteortesting:mocha

# With custom port
meteor test-packages ./ --driver-package=meteortesting:mocha --port 8888

# With local MongoDB and custom port
MONGO_URL="mongodb://127.0.0.1:27017/meteor-josk-test-001" meteor test-packages ./ --driver-package=meteortesting:mocha --port 8888

# Be patient, tests are taking around 2 mins
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
const job = new JoSk({db: db});

const task = (ready) => {
  bound(() => { // <-- use "bound" inside of a task
    ready();
  });
};

job.setInterval(task, 60 * 60 * 1000, 'task');
```
