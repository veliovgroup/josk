if (!process.env.MONGO_URL) {
  throw new Error('MONGO_URL env.var is not defined! Please run test with MONGO_URL, like `MONGO_URL=mongodb://127.0.0.1:27017/dbname npm test`');
}

const ZOMBIE_TIME = 8000;
const RANDOM_GAP  = 256;

const MongoClient = require('mongodb').MongoClient;
const JoSk        = require('../index.js');
const mongoAddr   = (process.env.MONGO_URL || '');
const dbName      = mongoAddr.split('/').pop().replace(/\/$/, '');

const { assert }       = require('chai');
const { it, describe } = require('mocha');
const timestamps       = {};
const callbacks        = {};

const testInterval = (interval, job) => {
  it(`setInterval ${interval}`, function (done) {
    let taskId;
    taskId = job.setInterval((ready) => ready(), interval, `taskInterval-${interval}`);
    callbacks[taskId] = done;
    timestamps[taskId] = [];
  });
};

const testTimeout = (delay, job) => {
  it(`setTimeout ${delay}`, function (done) {
    let taskId;
    taskId = job.setTimeout((ready) => ready(), delay, `taskTimeout-${delay}`);
    callbacks[taskId] = done;
    timestamps[taskId] = [+new Date()];
  });
};

describe('Has JoSk Object', () => {
  it('JoSk is Constructor', () => {
    assert.isFunction(JoSk, 'JoSk is Constructor');
  });
});

describe('JoSk Instance', function () {
  this.slow(82500);
  this.timeout(85000);

  (async function() {
    const client = await MongoClient.connect(mongoAddr);
    const db = client.db(dbName);

    const job = new JoSk({
      db: db,
      prefix: 'testCase',
      zombieTime: ZOMBIE_TIME,
      onError(message, details) {
        console.error('[onError Hook]', message, details.uid);
        if (message === 'One of your tasks is missing') {
          job.clearInterval(details.uid);
        }
      },
      onExecuted(uid, details) {
        if (!!~details.uid.indexOf('taskInterval') && timestamps[details.uid].length < 2) {
          timestamps[details.uid].push(details.timestamp);
        }

        if (!!~details.uid.indexOf('taskTimeout') && timestamps[details.uid].length === 1) {
          timestamps[details.uid].push(details.timestamp);
        }

        if ((!!~details.uid.indexOf('taskInterval') || !!~details.uid.indexOf('taskTimeout')) && timestamps[details.uid].length === 2) {
          if (!!~details.uid.indexOf('taskInterval')) {
            job.clearInterval(details.uid);
          }

          const actual   = timestamps[details.uid][1] - timestamps[details.uid][0];
          const expected = +new Date() - timestamps[details.uid][0];
          const time     = expected - actual;

          // console.log(details.uid, {actual, expected, time, emit: actual - expected});

          assert.equal(time < RANDOM_GAP && time > -RANDOM_GAP, true, 'setInterval has expected execution periods');
          callbacks[details.uid]();
        }
      }
    });

    describe('JoSk Instance', function () {
      it('Check JoSk instance properties', function () {
        assert.instanceOf(job, JoSk, 'job is instance of JoSk');
        assert.equal(job.prefix, 'testCase', 'job has prefix');
        assert.instanceOf(job.onError, Function, 'job has onError');
        assert.equal(job.autoClear, false, 'job has autoClear');
        assert.equal(job.zombieTime, ZOMBIE_TIME, 'job has zombieTime');
        assert.instanceOf(job.onExecuted, Function, 'job has onExecuted');
        assert.equal(job.resetOnInit, false, 'job has resetOnInit');
        assert.instanceOf(job.tasks, Object, 'job has tasks');
      });
    });

    describe('setInterval', function () {
      this.slow(30000);
      this.timeout(32000);

      testInterval(768, job);
      testInterval(2000, job);
      testInterval(5000, job);
      testInterval(7000, job);
    });

    describe('setTimeout', function () {
      this.slow(14000);
      this.timeout(16000);

      testTimeout(768, job);
      testTimeout(2000, job);
      testTimeout(5000, job);
      testTimeout(7000, job);
    });

    describe('setImmediate', function () {
      this.slow(RANDOM_GAP * 3);
      this.timeout(RANDOM_GAP * 4);

      it('setImmediate - Execution time', function (done) {
        let time = +new Date();
        job.setImmediate((ready) => {
          // console.log("IMMEDIATE", +new Date() - time, ((RANDOM_GAP * 2) + 1), +new Date() - time < ((RANDOM_GAP * 2) + 1));
          assert.equal(+new Date() - time < ((RANDOM_GAP * 2) + 1), true, 'setImmediate - executed within appropriate time');
          ready();
          done();
        }, 'taskImmediate-0');
      });
    });


    describe('zombieTime (stuck task recovery)', function () {
      this.slow(11000);
      this.timeout(13000);

      it('setInterval', function (done) {
        let time = +new Date();
        let i = 0;
        const taskId = job.setInterval((ready) => {
          i++;
          if (i === 1) {
            time = +new Date() - time;
            assert.equal(time < 2500 + RANDOM_GAP && time > 2500 - RANDOM_GAP, true, 'setInterval - first run within appropriate interval');
            time = +new Date();
          } else if (i === 2) {
            time = +new Date() - time;

            // console.log('taskInterval-zombie-2500', time, time < ZOMBIE_TIME + RANDOM_GAP, ZOMBIE_TIME + RANDOM_GAP);
            assert.equal(time < (ZOMBIE_TIME + RANDOM_GAP), true, 'setInterval - recovered within appropriate zombieTime time-frame');
            job.clearInterval(taskId);
            done();
          }
        }, 2500, 'taskInterval-zombie-2500');
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
        }, 1500, 'taskTimeout-abort-1500');

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
        }, 1500, 'taskInterval-abort-1500');

        setTimeout(() => {
          job.clearInterval(taskId);
        }, 600);

        setTimeout(() => {
          assert.equal(check, false, 'setInterval - is cleared and never executed');
          done();
        }, 1800);
      });
    });
  })();
});
