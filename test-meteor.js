import { Meteor }       from 'meteor/meteor';
import CRONjob          from 'meteor/ostrio:cron-jobs';
import { assert }       from 'meteor/practicalmeteor:chai';

const db          = Meteor.users.rawDatabase();
const ZOMBIE_TIME = 8000;
const RANDOM_GAP  = 256;
const timestamps  = {};
const callbacks   = {};

describe('Has CRONjob Object', () => {
  it('CRONjob is Constructor', () => {
    assert.isFunction(CRONjob, 'CRONjob is Constructor');
  });
});

const cron = new CRONjob({
  db: db,
  prefix: 'testCase',
  zombieTime: ZOMBIE_TIME,
  onError(message, details) {
    console.error('[onError Hook]', message, details.uid);
    if (message === 'One of your tasks is missing') {
      cron.clearInterval(details.uid);
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
        cron.clearInterval(details.uid);
      }

      const actual   = timestamps[details.uid][1] - timestamps[details.uid][0];
      const expected = Date.now() - timestamps[details.uid][0];
      const time     = expected - actual;

      console.log(details.uid, {actual, expected, time, emit: actual - expected});

      assert.equal(time < RANDOM_GAP && time > -RANDOM_GAP, true, 'setInterval has expected execution periods');
      callbacks[details.uid]();
    }
  }
});

const testInterval = (interval) => {
  it(`setInterval ${interval}`, function (done) {
    let taskId;
    taskId = cron.setInterval((ready) => ready(), interval, `taskInterval-${interval}`);
    callbacks[taskId] = done;
    timestamps[taskId] = [];
  });
};

const testTimeout = (delay) => {
  it(`setTimeout ${delay}`, function (done) {
    let taskId;
    taskId = cron.setTimeout((ready) => ready(), delay, `taskTimeout-${delay}`);
    callbacks[taskId] = done;
    timestamps[taskId] = [Date.now()];
  });
};

describe('CRONjob Instance', function () {
  it('Check CRONjob instance properties', function () {
    assert.instanceOf(cron, CRONjob, 'cron is instance of CRONjob');
    assert.equal(cron.prefix, 'testCase', 'cron has prefix');
    assert.instanceOf(cron.onError, Function, 'cron has onError');
    assert.equal(cron.autoClear, false, 'cron has autoClear');
    assert.equal(cron.zombieTime, ZOMBIE_TIME, 'cron has zombieTime');
    assert.instanceOf(cron.onExecuted, Function, 'cron has onExecuted');
    assert.equal(cron.resetOnInit, false, 'cron has resetOnInit');
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
    let time = Date.now();
    cron.setImmediate((ready) => {
      console.log('IMMEDIATE', Date.now() - time, ((RANDOM_GAP * 2) + 1), Date.now() - time < ((RANDOM_GAP * 2) + 1));
      assert.equal(Date.now() - time < ((RANDOM_GAP * 2) + 1), true, 'setImmediate - executed within appropriate time');
      ready();
      done();
    }, 'taskImmediate-0');
  });
});


describe('zombieTime (stuck task recovery)', function () {
  this.slow(11000);
  this.timeout(13000);

  it('setInterval', function (done) {
    let time = Date.now();
    let i = 0;
    const taskId = cron.setInterval((ready) => {
      i++;
      if (i === 1) {
        time = Date.now() - time;
        assert.equal(time < 2500 + RANDOM_GAP && time > 2500 - RANDOM_GAP, true, 'setInterval - first run within appropriate interval');
        time = Date.now();
      } else if (i === 2) {
        time = Date.now() - time;

        console.log('taskInterval-zombie-2500', time, time < ZOMBIE_TIME + RANDOM_GAP, ZOMBIE_TIME + RANDOM_GAP);
        assert.equal(time < (ZOMBIE_TIME + RANDOM_GAP), true, 'setInterval - recovered within appropriate zombieTime time-frame');
        cron.clearInterval(taskId);
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
    const taskId = cron.setTimeout((ready) => {
      check = true;
      ready();
      throw new Error('[Cancel (abort) current timers] [setTimeout] This shouldn\'t be executed');
    }, 1500, 'taskTimeout-abort-1500');

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
    }, 1500, 'taskInterval-abort-1500');

    setTimeout(() => {
      cron.clearInterval(taskId);
    }, 600);

    setTimeout(() => {
      assert.equal(check, false, 'setInterval - is cleared and never executed');
      done();
    }, 1800);
  });
});
