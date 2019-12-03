if (!process.env.MONGO_URL) {
  throw new Error('MONGO_URL env.var is not defined! Please run test with MONGO_URL, like `MONGO_URL=mongodb://127.0.0.1:27017/dbname npm test`');
}

const ZOMBIE_TIME       = 8000;
const minRevolvingDelay = 32;
const maxRevolvingDelay = 256;
const RANDOM_GAP        = (maxRevolvingDelay - minRevolvingDelay) + 1024;

const MongoClient = require('mongodb').MongoClient;
const JoSk        = require('../index.js');
const mongoAddr   = (process.env.MONGO_URL || '');
const dbName      = mongoAddr.split('/').pop().replace(/\/$/, '');

const { assert }       = require('chai');
const { it, describe } = require('mocha');
const timestamps       = {};
const callbacks        = {};
const revolutions      = {};

const testInterval = function (interval, job) {
  it(`setInterval ${interval}`, function (done) {
    const taskId = job.setInterval((ready) => ready(), interval, `taskInterval-${interval}-${Math.random().toString(36).substring(2, 15)}`);
    callbacks[taskId] = done;
    timestamps[taskId] = [Date.now() + interval];
    revolutions[taskId] = 0;
  });
};

const testTimeout = function (delay, job) {
  it(`setTimeout ${delay}`, function (done) {
    const taskId = job.setTimeout((ready) => ready(), delay, `taskTimeout-${delay}-${Math.random().toString(36).substring(2, 15)}`);
    callbacks[taskId] = done;
    timestamps[taskId] = [Date.now() + delay];
    revolutions[taskId] = 0;
  });
};

describe('Has JoSk Object', function () {
  it('JoSk is Constructor', function () {
    assert.isFunction(JoSk, 'JoSk is Constructor');
  });
});

describe('JoSk Instance', async function () {
  this.slow(42500);
  this.timeout(85000);

  const client = await MongoClient.connect(mongoAddr, {
    j: true,
    w: 'majority',
    wtimeout: 30000,
    poolSize: 15,
    // readConcern: {
    //   level: 'majority'
    // },
    readPreference: 'primary',
    // reconnectTries: 60,
    socketTimeoutMS: 720000,
    useNewUrlParser: true,
    useUnifiedTopology: true,
    connectTimeoutMS: 120000,
    // reconnectInterval: 3072,
    connectWithNoPrimary: false,
    appname: 'josk-test-suite'
  });
  const db = client.db(dbName);

  const job = new JoSk({
    db: db,
    autoClear: false,
    prefix: 'testCaseNPM',
    zombieTime: ZOMBIE_TIME,
    minRevolvingDelay,
    maxRevolvingDelay,
    onError(message, details) {
      console.info('[onError Hook] (this is purely informational message)', message, details);
      if (message === 'One of your tasks is missing') {
        // By the way same can be achieved with `autoClear: true`
        // option passed to `new JoSk({/*...*/})`
        job.clearInterval(details.uid);
      }
    },
    onExecuted(uid, task) {
      if (!timestamps[task.uid]) {
        return;
      }

      ++revolutions[task.uid];
      if (timestamps[task.uid].length < 2) {
        timestamps[task.uid].push(task.timestamp);
      } else {
        timestamps[task.uid][1] = task.timestamp;
      }

      if ((task.uid.includes('taskInterval') || task.uid.includes('taskTimeout')) && timestamps[task.uid].length === 2) {
        const now      = Date.now();
        const expected = timestamps[task.uid][0];
        const _from    = expected - RANDOM_GAP;
        const _to      = expected + RANDOM_GAP;
        const diff     = now - expected;

        // console.log(task.uid, {diff, revs: revolutions[task.uid], delay: task.delay});

        if (task.uid.includes('taskInterval')) {
          if (revolutions[task.uid] >= 2) {
            job.clearInterval(task.uid);
            assert.equal(revolutions[task.uid], 2, 'Interval second run');
            callbacks[task.uid]();
          } else {
            timestamps[task.uid][0] = now + task.delay;
            assert.equal(revolutions[task.uid], 1, 'Interval first run');
          }
        } else {
          assert.equal(revolutions[task.uid], 1, 'Timeout single run');
          callbacks[task.uid]();
        }
        assert.equal(_from < now && now < _to, true, 'Scheduled task has expected execution period');
        assert.equal(diff < RANDOM_GAP, true, 'Time execution difference less than random gap');
      }
    }
  });

  describe('JoSk Instance', function () {
    it('Check JoSk instance properties', function () {
      assert.instanceOf(job, JoSk, 'job is instance of JoSk');
      assert.equal(job.prefix, 'testCaseNPM', 'job has prefix');
      assert.instanceOf(job.onError, Function, 'job has onError');
      assert.equal(job.autoClear, false, 'job has autoClear');
      assert.equal(job.zombieTime, ZOMBIE_TIME, 'job has zombieTime');
      assert.instanceOf(job.onExecuted, Function, 'job has onExecuted');
      assert.equal(job.resetOnInit, false, 'job has resetOnInit');
      assert.equal(job.minRevolvingDelay, minRevolvingDelay, 'job has minRevolvingDelay');
      assert.equal(job.maxRevolvingDelay, maxRevolvingDelay, 'job has maxRevolvingDelay');
      assert.instanceOf(job.tasks, Object, 'job has tasks');
    });
  });

  describe('setInterval', function () {
    this.slow(30000);
    this.timeout(62000);

    testInterval(1024, job);
    testInterval(1032, job);
    testInterval(1040, job);
    testInterval(1048, job);
    testInterval(1056, job);
    testInterval(1064, job);
    testInterval(1072, job);
    testInterval(1080, job);
    testInterval(1088, job);
    testInterval(1096, job);
    testInterval(1104, job);
  });

  describe('setTimeout', function () {
    this.slow(14000);
    this.timeout(26000);

    testTimeout(1024, job);
    testTimeout(1032, job);
    testTimeout(1040, job);
    testTimeout(1048, job);
    testTimeout(1056, job);
    testTimeout(1064, job);
    testTimeout(1072, job);
    testTimeout(1080, job);
    testTimeout(1088, job);
    testTimeout(1096, job);
    testTimeout(1104, job);
  });

  describe('setImmediate', function () {
    this.slow(RANDOM_GAP * 3);
    this.timeout(RANDOM_GAP * 4);

    it('setImmediate - Execution time', function (done) {
      const time = Date.now();
      job.setImmediate((ready) => {
        // console.log('IMMEDIATE', Date.now() - time, ((RANDOM_GAP * 2) + 1), Date.now() - time < ((RANDOM_GAP * 2) + 1));
        assert.equal(Date.now() - time < ((RANDOM_GAP * 2) + 1), true, 'setImmediate - executed within appropriate time');
        ready();
        done();
      }, 'taskImmediate-0');
    });
  });

  describe('zombieTime (stuck task recovery)', function () {
    this.slow(18500);
    this.timeout(26000);

    it('setInterval', function (done) {
      let time = Date.now();
      let i = 0;
      const taskId = job.setInterval(() => {
        i++;
        if (i === 1) {
          const _time = Date.now() - time;
          assert.equal(_time < 2500 + RANDOM_GAP, true, 'setInterval - first run within appropriate interval');
          time = Date.now();
        } else if (i === 2) {
          job.clearInterval(taskId);
          const _time = Date.now() - time;

          // console.log('taskInterval-zombie-2500', _time, _time < (ZOMBIE_TIME + RANDOM_GAP), ZOMBIE_TIME + RANDOM_GAP);
          assert.equal(_time < (ZOMBIE_TIME + RANDOM_GAP), true, 'setInterval - recovered within appropriate zombieTime time-frame');
          done();
        }
      }, 2500, 'taskInterval-zombie-2500');
    });

    it('setTimeout', function (done) {
      const time = Date.now();
      const taskId = job.setInterval(() => {
        job.clearInterval(taskId);
        const _time = Date.now() - time;

        // console.log('taskTimeout-zombie-2500', _time, _time < (ZOMBIE_TIME + RANDOM_GAP), ZOMBIE_TIME + RANDOM_GAP);
        assert.equal(_time < (ZOMBIE_TIME + RANDOM_GAP), true, 'setTimeout - recovered within appropriate zombieTime time-frame (which is actually the first run as it\'s Timeout)');
        done();
      }, 2500, 'taskTimeout-zombie-2500');
    });
  });

  describe('Cancel (abort) current timers', function () {
    this.slow(4000);
    this.timeout(5000);

    it('setTimeout', function (done) {
      let check = false;
      const taskId = job.setTimeout((ready) => {
        check = true;
        ready();
        throw new Error('[Cancel (abort) current timers] [setTimeout] This shouldn\'t be executed');
      }, 1200, 'taskTimeout-abort-1500');

      setTimeout(() => {
        job.clearTimeout(taskId);
      }, 600);

      setTimeout(() => {
        assert.equal(check, false, 'setTimeout - is cleared and never executed');
        done();
      }, 1800);
    });

    it('setInterval', function (done) {
      let check = false;
      const taskId = job.setInterval((ready) => {
        check = true;
        ready();
        throw new Error('[Cancel (abort) current timers] [setInterval] This shouldn\'t be executed');
      }, 1200, 'taskInterval-abort-1500');

      setTimeout(() => {
        job.clearInterval(taskId);
      }, 600);

      setTimeout(() => {
        assert.equal(check, false, 'setInterval - is cleared and never executed');
        done();
      }, 1800);
    });
  });
});
