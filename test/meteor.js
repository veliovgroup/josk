import { MongoInternals } from 'meteor/mongo';
import JoSk from '../index.js';
import parser from 'cron-parser';
import { assert } from 'chai';

const ZOMBIE_TIME       = 8000;
const minRevolvingDelay = 32;
const maxRevolvingDelay = 256;
const RANDOM_GAP        = (maxRevolvingDelay - minRevolvingDelay) + 1024;

const noop        = (ready) => ((typeof ready === 'function') && ready());
const db          = MongoInternals.defaultRemoteCollectionDriver().mongo.db;
const timestamps  = {};
const callbacks   = {};
const revolutions = {};
let cron;
let createCronTask;

describe('Has JoSk Object', () => {
  it('JoSk is Constructor', () => {
    assert.isFunction(JoSk, 'JoSk is Constructor');
  });
});

before(function () {
  cron = new JoSk({
    db: db,
    prefix: 'testCaseMeteor',
    zombieTime: ZOMBIE_TIME,
    minRevolvingDelay,
    maxRevolvingDelay,
    onError(message, details) {
      console.error('[onError Hook] (this is purely informational message)', message, details);
      if (message === 'One of your tasks is missing') {
        // By the way same can be achieved with `autoClear: true`
        // option passed to `new JoSk({/*...*/})`
        cron.clearInterval(details.uid);
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
            cron.clearInterval(task.uid);
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

  createCronTask = (uniqueName, cronTask, task) => {
    const next = +parser.parseExpression(cronTask).next().toDate();
    const timeout = next - Date.now();

    return cron.setTimeout(function (done) {
      done(() => { // <- call `done()` right away
        // MAKE SURE FURTHER LOGIC EXECUTED
        // INSIDE done() CALLBACK
        if (task()) { // <-- return false to stop CRON
          createCronTask(uniqueName, cronTask, task);
        }
      });
    }, timeout, uniqueName);
  };
});

const testInterval = (interval) => {
  it(`setInterval ${interval}`, function (done) {
    const taskId = cron.setInterval(noop, interval, `taskInterval-${interval}-${Math.random().toString(36).substring(2, 15)}`);
    callbacks[taskId] = done;
    timestamps[taskId] = [Date.now() + interval];
    revolutions[taskId] = 0;
  });
};

const testTimeout = (delay) => {
  it(`setTimeout ${delay}`, function (done) {
    const taskId = cron.setTimeout(noop, delay, `taskTimeout-${delay}-${Math.random().toString(36).substring(2, 15)}`);
    callbacks[taskId] = done;
    timestamps[taskId] = [Date.now() + delay];
    revolutions[taskId] = 0;
  });
};

describe('JoSk Instance', function () {
  it('Check JoSk instance properties', function () {
    assert.instanceOf(cron, JoSk, 'cron is instance of JoSk');
    assert.equal(cron.prefix, 'testCaseMeteor', 'cron has prefix');
    assert.instanceOf(cron.onError, Function, 'cron has onError');
    assert.equal(cron.autoClear, false, 'cron has autoClear');
    assert.equal(cron.zombieTime, ZOMBIE_TIME, 'cron has zombieTime');
    assert.instanceOf(cron.onExecuted, Function, 'cron has onExecuted');
    assert.equal(cron.resetOnInit, false, 'cron has resetOnInit');
    assert.equal(cron.minRevolvingDelay, minRevolvingDelay, 'cron has minRevolvingDelay');
    assert.equal(cron.maxRevolvingDelay, maxRevolvingDelay, 'cron has maxRevolvingDelay');
    assert.instanceOf(cron.tasks, Object, 'cron has tasks');
  });
});

describe('setInterval', function () {
  this.slow(7680 * 2);
  this.timeout(8448 * 2);

  testInterval(384);
  testInterval(512);
  testInterval(640);
  testInterval(768);
  testInterval(778);
  testInterval(788);
  testInterval(789);
  testInterval(800);
  testInterval(801);
  testInterval(802);
});

describe('setTimeout', function () {
  this.slow(7680);
  this.timeout(8448);

  testTimeout(384);
  testTimeout(512);
  testTimeout(640);
  testTimeout(768);
  testTimeout(778);
  testTimeout(788);
  testTimeout(789);
  testTimeout(800);
  testTimeout(801);
  testTimeout(802);
});

describe('override settings', function () {
  this.slow(2600);
  this.timeout(4096);

  it('setTimeout', function (done) {
    const uid = cron.setTimeout(noop, 2048, 'timeoutOverride');

    setTimeout(async () => {
      const task = await cron.collection.findOne({ uid });

      assert.ok(typeof task === 'object', 'setTimeout override — record exists');
      assert.equal(task.delay, 2048, 'setTimeout override — Have correct initial delay');
      cron.setTimeout(noop, 3072, 'timeoutOverride');

      setTimeout(async () => {
        const updatedTask = await cron.collection.findOne({ uid });

        assert.equal(updatedTask.delay, 3072, 'setTimeout override — Have correct updated delay');

        process.nextTick(() => {
          cron.clearTimeout(uid);
          setTimeout(async () => {
            assert.equal(await cron.collection.findOne({ uid }), null, 'setTimeout override — Task cleared');
            done();
          }, 384);
        });
      }, 384);
    }, 384);
  });

  it('setInterval', function (done) {
    const uid = cron.setInterval(noop, 1024, 'intervalOverride');

    setTimeout(async () => {
      const task = await cron.collection.findOne({ uid });

      assert.ok(typeof task === 'object', 'setInterval override — record exists');
      assert.equal(task.delay, 1024, 'setInterval override — Have correct initial delay');
      cron.setInterval(noop, 2048, 'intervalOverride');

      setTimeout(async () => {
        const updatedTask = await cron.collection.findOne({ uid });

        assert.equal(updatedTask.delay, 2048, 'setInterval override — Have correct updated delay');

        process.nextTick(() => {
          cron.clearInterval(uid);
          setTimeout(async () => {
            assert.equal(await cron.collection.findOne({ uid }), null, 'setInterval override — Task cleared');
            done();
          }, 384);
        });
      }, 384);
    }, 384);
  });
});


describe('setImmediate', function () {
  this.slow(RANDOM_GAP * 3);
  this.timeout(RANDOM_GAP * 4);

  it('setImmediate - Execution time', function (done) {
    const time = Date.now();
    cron.setImmediate((ready) => {
      // console.log('IMMEDIATE', Date.now() - time, ((RANDOM_GAP * 2) + 1), Date.now() - time < ((RANDOM_GAP * 2) + 1));
      assert.equal(Date.now() - time < ((RANDOM_GAP * 2) + 1), true, 'setImmediate - executed within appropriate time');
      ready();
      done();
    }, 'taskImmediate-0');
  });
});

describe('CRON Usage', function () {
  this.slow(11000);
  this.timeout(14000);

  it('Test CRON intervals', function (endit) {
    let last;
    let counter = 0;
    let maxRuns = 5;
    let intervalSec = 2;

    createCronTask('My every two seconds cron', `*/${intervalSec} * * * * *`, function () {
      counter++;
      const now = Date.now();
      let duration = intervalSec * 1000;
      if (last) {
        duration = now - last;
      }
      last = Date.now();

      assert.ok(duration >= (intervalSec * 1000) - 512, `CRON interval is within appropriate delays; >= -512; ${duration}`);
      assert.ok(duration <= (intervalSec * 1000) + 512, `CRON interval is within appropriate delays; <= +512; ${duration}`);

      if (counter >= maxRuns) {
        endit();
        return false;
      }

      return true;
    });
  });
});

describe('zombieTime (stuck task recovery)', function () {
  this.slow(11000);
  this.timeout(13000);

  it('setInterval', function (done) {
    let time = Date.now();
    let i = 0;
    const taskId = cron.setInterval(() => {
      i++;
      if (i === 1) {
        time = Date.now() - time;
        assert.equal(time < 2500 + RANDOM_GAP && time > 2500 - RANDOM_GAP, true, 'setInterval - first run within appropriate interval');
        time = Date.now();
      } else if (i === 2) {
        time = Date.now() - time;

        // console.log('taskInterval-zombie-2500', time, time < ZOMBIE_TIME + RANDOM_GAP, ZOMBIE_TIME + RANDOM_GAP);
        assert.equal(time < (ZOMBIE_TIME + RANDOM_GAP), true, 'setInterval - recovered within appropriate zombieTime time-frame');
        cron.clearInterval(taskId);
        done();
      }
    }, 2500, 'taskInterval-zombie-2500');
  });

  it('setTimeout', function (done) {
    const time = Date.now();
    const taskId = cron.setTimeout(() => {
      cron.clearTimeout(taskId);
      const _time = Date.now() - time;

      assert.equal(_time < (ZOMBIE_TIME + RANDOM_GAP), true, 'setTimeout - recovered within appropriate zombieTime time-frame (which is actually the first run as it\'s Timeout)');
      done();
    }, 2500, 'taskTimeout-zombie-2500');
  });
});

describe('Clear (abort) current timers', function () {
  this.slow(2304);
  this.timeout(3072);

  it('setTimeout', function (done) {
    let check = false;
    const taskId = cron.setTimeout((ready) => {
      check = true;
      ready();
      // throw new Error('[Clear (abort) current timers] [setTimeout] This shouldn\'t be executed');
    }, 768, 'taskTimeout-clear-768');

    setTimeout(() => {
      cron.clearTimeout(taskId);
      setTimeout(() => {
        assert.equal(check, false, 'setTimeout - is cleared and never executed');
        done();
      }, 768);
    }, 384);
  });

  it('setInterval', function (done) {
    let check = false;
    const taskId = cron.setInterval((ready) => {
      check = true;
      ready();
      // throw new Error('[Clear (abort) current timers] [setInterval] This shouldn\'t be executed');
    }, 768, 'taskInterval-clear-768');

    setTimeout(() => {
      cron.clearInterval(taskId);
      setTimeout(() => {
        assert.equal(check, false, 'setInterval - is cleared and never executed');
        done();
      }, 768);
    }, 384);
  });
});

describe('Destroy (abort) current timers', function () {
  this.slow(2304);
  this.timeout(3072);

  it('setTimeout', function (done) {
    let check = false;
    const uid = cron.setTimeout(() => {
      check = true;
      // throw new Error('[Destroy JoSk instance] [destroy] [setTimeout] This shouldn\'t be executed');
    }, 768, 'taskTimeout-destroy-768');

    setTimeout(() => {
      cron.destroy();
      setTimeout(() => {
        cron.clearTimeout(uid);
        assert.equal(check, false, 'setTimeout - is destroyed/cleared and never executed');
        done();
      }, 768);
    }, 384);
  });

  it('setInterval', function (done) {
    let check1 = false;
    let check2 = false;
    let gotError = false;
    const cron2 = new JoSk({
      db: db,
      autoClear: false,
      prefix: 'testCaseMeteor2',
      zombieTime: ZOMBIE_TIME,
      minRevolvingDelay,
      maxRevolvingDelay,
      onError() {
        gotError = true;
      }
    });

    const int2uid = cron2.setInterval(() => {
      check1 = true;
      cron2.clearInterval(int2uid);
      // throw new Error('[Destroy JoSk instance] [destroy] [setInterval] This shouldn\'t be executed');
    }, 768, 'taskInterval2-destroy2-768');

    setTimeout(() => {
      cron2.destroy();
      const int2uid2 = cron2.setInterval(() => {
        check2 = true;
        cron2.clearInterval(int2uid2);
        // throw new Error('[setInterval + onError hook] [setInterval] This shouldn\'t be executed');
      }, 384, 'taskInterval2-destroy2-384');

      setTimeout(() => {
        cron2.clearInterval(int2uid);
        cron2.clearInterval(int2uid2);
        assert.equal(check1, false, 'setInterval (before .destroy()) - is destroyed/cleared and never executed');
        assert.equal(check2, false, 'setInterval (after .destroy()) - is destroyed/cleared and never executed');
        assert.equal(gotError, true, 'setInterval not possible to use after JoSk#destroy');
        done();
      }, 768);
    }, 384);
  });
});
