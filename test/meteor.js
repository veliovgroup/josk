import { Meteor } from 'meteor/meteor';
import JoSk       from 'meteor/ostrio:cron-jobs';
import { assert } from 'meteor/practicalmeteor:chai';

const ZOMBIE_TIME       = 8000;
const minRevolvingDelay = 32;
const maxRevolvingDelay = 256;
const RANDOM_GAP        = (maxRevolvingDelay - minRevolvingDelay) + 1024;

const db          = Meteor.users.rawDatabase();
const timestamps  = {};
const callbacks   = {};
const revolutions = {};

describe('Has JoSk Object', () => {
  it('JoSk is Constructor', () => {
    assert.isFunction(JoSk, 'JoSk is Constructor');
  });
});

const cron = new JoSk({
  db: db,
  prefix: 'testCaseMeteor',
  zombieTime: ZOMBIE_TIME,
  minRevolvingDelay,
  maxRevolvingDelay,
  onError(message, details) {
    // console.error('[onError Hook]', message, details.uid);
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

const testInterval = (interval) => {
  it(`setInterval ${interval}`, function (done) {
    const taskId = cron.setInterval((ready) => ready(), interval, `taskInterval-${interval}-${Math.random().toString(36).substring(2, 15)}`);
    callbacks[taskId] = done;
    timestamps[taskId] = [Date.now() + interval];
    revolutions[taskId] = 0;
  });
};

const testTimeout = (delay) => {
  it(`setTimeout ${delay}`, function (done) {
    const taskId = cron.setTimeout((ready) => ready(), delay, `taskTimeout-${delay}-${Math.random().toString(36).substring(2, 15)}`);
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
  this.slow(30000);
  this.timeout(32000);

  testInterval(1000);
  testInterval(1001);
  testInterval(1002);
  testInterval(1003);
  testInterval(1004);
  testInterval(1005);
  testInterval(1006);
  testInterval(1007);
  testInterval(1008);
  testInterval(1009);
});

describe('setTimeout', function () {
  this.slow(14000);
  this.timeout(16000);

  testTimeout(1000);
  testTimeout(1001);
  testTimeout(1002);
  testTimeout(1003);
  testTimeout(1004);
  testTimeout(1005);
  testTimeout(1006);
  testTimeout(1007);
  testTimeout(1008);
  testTimeout(1009);
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


describe('zombieTime (stuck task recovery)', function () {
  this.slow(10500);
  this.timeout(18000);

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
    const taskId = cron.setInterval(() => {
      cron.clearInterval(taskId);
      const _time = Date.now() - time;

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
    const taskId = cron.setTimeout((ready) => {
      check = true;
      ready();
      throw new Error('[Cancel (abort) current timers] [setTimeout] This shouldn\'t be executed');
    }, 1200, 'taskTimeout-abort-1500');

    setTimeout(() => {
      cron.clearTimeout(taskId);
    }, 600);

    setTimeout(() => {
      assert.equal(check, false, 'setTimeout - is cleared and never executed');
      done();
    }, 1800);
  });

  it('setInterval', function (done) {
    let check = false;
    const taskId = cron.setInterval((ready) => {
      check = true;
      ready();
      throw new Error('[Cancel (abort) current timers] [setInterval] This shouldn\'t be executed');
    }, 1200, 'taskInterval-abort-1500');

    setTimeout(() => {
      cron.clearInterval(taskId);
    }, 600);

    setTimeout(() => {
      assert.equal(check, false, 'setInterval - is cleared and never executed');
      done();
    }, 1800);
  });
});
