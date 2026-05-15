import { JoSk, RedisAdapter } from '../index.js';
import { createClient } from 'redis';

import { CronExpressionParser } from 'cron-parser';
import { it, describe, before, after } from 'mocha';
import { assert } from 'chai';
import { destroyJobs, quitRedisClient, uniqueId, wait, waitUntil } from './helpers.js';

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL env.var is not defined! Please run test with REDIS_URL, like `REDIS_URL=redis://127.0.0.1:6379 npm test`');
}

const DEBUG = process.env.DEBUG === 'true' ? true : false;
const minRevolvingDelay = 32;
const maxRevolvingDelay = 256;
const RANDOM_GAP = (maxRevolvingDelay - minRevolvingDelay) + 1024;

const noop = (ready) => {
  typeof ready === 'function' && ready();
};
const ZOMBIE_TIME = 8000;
const getTask = async (adapter, uid) => {
  const payload = await adapter.client.hGet(adapter.tasksKey, uid);
  return payload ? JSON.parse(payload) : null;
};
const hasTask = async (adapter, uid) => {
  return await adapter.client.hExists(adapter.tasksKey, uid);
};

const callbacks = {};
const exceptions = {};
const timestamps = {};
const revolutions = {};

let client;
let job;
let jobCron;
let jobException;
const jobRacing = {};
const racingClients = [];

const testInterval = function (interval) {
  it(`setInterval ${interval}`, function (endit) {
    process.nextTick(async () => {
      const taskId = await job.setInterval(noop, interval, `taskInterval-${interval}-${Math.random().toString(36).substring(2, 15)}`);
      callbacks[taskId] = endit;
      timestamps[taskId] = [Date.now() + interval];
      revolutions[taskId] = 0;
    });
  });
};

const testTimeout = function (delay) {
  it(`setTimeout ${delay}`, function (endit) {
    process.nextTick(async () => {
      const taskId = await job.setTimeout(noop, delay, `taskTimeout-${delay}-${Math.random().toString(36).substring(2, 15)}`);
      callbacks[taskId] = endit;
      timestamps[taskId] = [Date.now() + delay];
      revolutions[taskId] = 0;
    });
  });
};

before(async function () {
  client = await createClient({
    url: process.env.REDIS_URL
  }).connect();

  job = new JoSk({
    adapter: new RedisAdapter({
      client: client,
      prefix: 'testCaseNPM',
      resetOnInit: true
    }),
    debug: DEBUG,
    autoClear: false,
    zombieTime: ZOMBIE_TIME,
    minRevolvingDelay,
    maxRevolvingDelay,
    onError(message, details) {
      console.info('[onError Hook] (this is purely informational message)', message, details);
      if (message === 'One of your tasks is missing') {
        // By the way the same can get achieved via `autoClear: true`
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

        // console.log(task.uid, {diff, revs: revolutions[task.uid], delay: task.delay, uid, cb: callbacks[task.uid]});

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

  jobCron = new JoSk({
    adapter: new RedisAdapter({
      client: client,
      prefix: 'cron',
      resetOnInit: true
    }),
    debug: DEBUG,
    maxRevolvingDelay: 256, // <- Speed up timer speed by lowering its max revolving delay
    zombieTime: 1024, // <- will need to call `endit()` right away
    autoClear: true,
  });

  jobException = new JoSk({
    adapter: new RedisAdapter({
      client: client,
      prefix: 'testCaseNPM-exceptions',
      resetOnInit: true
    }),
    debug: DEBUG,
    autoClear: false,
    onError(error, details) {
      if (details?.uid) {
        exceptions[details.uid] = details.error;
      }
    }
  });

  let n = 0;
  while (n++ < 6) {
    jobRacing[n] = new JoSk({
      adapter: new RedisAdapter({
        client: await createClient({ url: process.env.REDIS_URL }).connect().then((racingClient) => {
          racingClients.push(racingClient);
          return racingClient;
        }),
        prefix: 'testCaseNPM-racing-conditions',
        resetOnInit: n === 1,
      }),
      debug: DEBUG,
      autoClear: false,
      minRevolvingDelay: 32,
      maxRevolvingDelay: 512,
    });
  }
});

after(async function () {
  destroyJobs(job, jobCron, jobException, Object.values(jobRacing));
  await Promise.all(racingClients.map(quitRedisClient));
  await quitRedisClient(client);
});

describe('Redis - Has JoSk Object', function () {
  it('JoSk is Constructor', function () {
    assert.isFunction(JoSk, 'JoSk is Constructor');
  });
});

describe('Redis - JoSk', function () {
  this.slow(55000);
  this.timeout(100000);
  let overloadCronTimeouts = [];
  let overloadCronIntervals = [];

  describe('Redis - Instance', function () {
    it('Check JoSk instance properties', function () {
      assert.instanceOf(job, JoSk, 'job is instance of JoSk');
      assert.instanceOf(job.adapter, RedisAdapter, 'JoSk#adapter is instance of RedisAdapter');
      assert.equal(job.adapter.prefix, 'testCaseNPM', 'JoSk#adapter has .prefix');
      assert.equal(job.adapter.resetOnInit, true, 'JoSk#adapter has .resetOnInit');
      assert.isString(job.adapter.name, 'JoSk#adapter.name is {string}');
      assert.instanceOf(job.onError, Function, 'JoSk# has .onError');
      assert.equal(job.autoClear, false, 'JoSk# has .autoClear');
      assert.equal(job.zombieTime, ZOMBIE_TIME, 'JoSk# has .zombieTime');
      assert.instanceOf(job.onExecuted, Function, 'JoSk# has .onExecuted');
      assert.equal(job.minRevolvingDelay, minRevolvingDelay, 'JoSk# has .minRevolvingDelay');
      assert.equal(job.maxRevolvingDelay, maxRevolvingDelay, 'JoSk# has .maxRevolvingDelay');
      assert.equal(job.execute, 'batch', 'JoSk# has default .execute');
      assert.isString(job.lockOwnerId, 'JoSk# has .lockOwnerId');
      assert.instanceOf(job.tasks, Object, 'JoSk# has .tasks');
    });
  });

  describe('Redis - Methods', function () {
    it('ping', async function () {
      const pingRes = await job.ping();
      assert.isObject(pingRes, 'ping response is Object');
      assert.equal(pingRes.status, 'OK', 'ping.status');
      assert.equal(pingRes.code, 200, 'ping.code');
      assert.equal(pingRes.statusCode, 200, 'ping.statusCode');
      assert.isUndefined(pingRes.error, 'ping.error is undefined');
    });
  });

  describe('Redis - Adapter direct', function () {
    this.slow(4000);
    this.timeout(8000);

    const makeLock = (ownerId, ttl = 10000) => {
      const expireAt = new Date(Date.now() + ttl);
      return {
        ownerId,
        leaseId: uniqueId(`${ownerId}-lease`),
        expireAt,
        expiresAtMs: +expireAt
      };
    };

    const buildAdapter = async (opts = {}) => {
      const adapter = new RedisAdapter({
        client,
        prefix: uniqueId('testCaseNPM-direct'),
        ...opts
      });
      adapter.joskInstance = {
        zombieTime: ZOMBIE_TIME,
        __execute: () => {},
        __errorHandler: () => {},
        _debug: () => {}
      };
      await adapter.ready();
      return adapter;
    };

    const cleanup = async (adapter) => {
      await client.del([adapter.scheduleKey, adapter.tasksKey, adapter.lockKey]).catch(() => {});
    };

    it('releaseLock frees the lock only when called with the holding owner', async function () {
      const adapter = await buildAdapter();
      const owner = makeLock('redis-direct-owner-a');
      const intruder = makeLock('redis-direct-owner-b');

      try {
        assert.isTrue(await adapter.acquireLock(owner), 'first owner acquires lock');
        assert.isFalse(await adapter.acquireLock(intruder), 'second owner is blocked while active');
        await adapter.releaseLock(intruder);
        assert.isFalse(await adapter.acquireLock(intruder), 'intruder releaseLock does not free the lock');
        await adapter.releaseLock(owner);
        assert.isTrue(await adapter.acquireLock(intruder), 'after holder releases, the next owner acquires');
      } finally {
        await adapter.releaseLock(owner);
        await adapter.releaseLock(intruder);
        await cleanup(adapter);
      }
    });

    it('resetOnInit clears previously stored tasks and locks scoped to the prefix', async function () {
      const prefix = uniqueId('testCaseNPM-direct-reset');
      const seed = await buildAdapter({ prefix });
      const lock = makeLock('redis-direct-reset-owner');
      try {
        assert.isTrue(await seed.add('reset-leftover-a', false, 60000), 'seeded one-shot task accepted');
        assert.isTrue(await seed.add('reset-leftover-b', true, 60000), 'seeded interval task accepted');
        assert.isTrue(await seed.acquireLock(lock), 'seeded scheduler lock acquired');

        assert.equal(await client.hLen(seed.tasksKey), 2, 'seeded tasks visible before reset');
        assert.equal(await client.exists(seed.lockKey), 1, 'seeded lock visible before reset');

        const fresh = new RedisAdapter({ client, prefix, resetOnInit: true });
        fresh.joskInstance = {
          zombieTime: ZOMBIE_TIME,
          __execute: () => {},
          __errorHandler: () => {},
          _debug: () => {}
        };
        try {
          await fresh.ready();
          assert.equal(await client.hLen(fresh.tasksKey), 0, 'resetOnInit cleared the tasks hash');
          assert.equal(await client.zCard(fresh.scheduleKey), 0, 'resetOnInit cleared the schedule index');
          assert.equal(await client.exists(fresh.lockKey), 0, 'resetOnInit cleared the lock key');
        } finally {
          await cleanup(fresh);
        }
      } finally {
        await cleanup(seed);
      }
    });

    it('iterate(batch) claims and dispatches every due task in a single cycle', async function () {
      const dispatched = [];
      const adapter = await buildAdapter();
      adapter.joskInstance.__execute = (task) => dispatched.push(task);

      try {
        for (let i = 0; i < 3; i++) {
          assert.isTrue(await adapter.add(`redis-batch-direct-${i}`, i % 2 === 0, -1000 - i), `seeded task ${i}`);
        }

        const claimed = await adapter.iterate(new Date(Date.now() + ZOMBIE_TIME), makeLock('redis-batch-direct'), 'batch');
        assert.equal(claimed, 3, 'iterate(batch) reports all 3 tasks dispatched');
        assert.equal(dispatched.length, 3, '__execute called once for each task');
        assert.deepEqual(
          dispatched.map((task) => task.uid).sort(),
          ['redis-batch-direct-0', 'redis-batch-direct-1', 'redis-batch-direct-2'],
          'dispatched uids match the seeded set'
        );

        const replay = await adapter.iterate(new Date(Date.now() + ZOMBIE_TIME), makeLock('redis-batch-direct-2'), 'batch');
        assert.equal(replay, 0, 'iterating again returns 0 because tasks were rescheduled into the future');
      } finally {
        await cleanup(adapter);
      }
    });

    it('iterate(one) dispatches exactly one task even when several are due', async function () {
      const dispatched = [];
      const adapter = await buildAdapter();
      adapter.joskInstance.__execute = (task) => dispatched.push(task);

      try {
        assert.isTrue(await adapter.add('redis-one-direct-a', false, -1000));
        assert.isTrue(await adapter.add('redis-one-direct-b', false, -500));
        assert.isTrue(await adapter.add('redis-one-direct-c', true, -250));

        const claimed = await adapter.iterate(new Date(Date.now() + ZOMBIE_TIME), makeLock('redis-one-direct'), 'one');
        assert.equal(claimed, 1, 'iterate(one) reports exactly one dispatched task');
        assert.equal(dispatched.length, 1, '__execute called only once');

        const stillDue = await client.zRangeByScore(adapter.scheduleKey, '-inf', String(Date.now()));
        assert.equal(stillDue.length, 2, 'two due tasks remain after a single one-mode pass');
      } finally {
        await cleanup(adapter);
      }
    });
  });

  describe('Redis - CRON usage', function () {
    this.slow(50000);
    this.timeout(60000);
    const maxRuns = 5;
    const timers = {};
    const runs = {};
    const createCronTask = async (uniqueName, cronTask, task, josk = jobCron) => {
      const next = +CronExpressionParser.parse(cronTask).next().toDate();
      const timeout = next - Date.now();

      timers[uniqueName] = await josk.setTimeout(function (ready) {
        ready(() => { // <- call `endit()` right away
          // MAKE SURE FURTHER LOGIC EXECUTED
          // INSIDE endit() CALLBACK
          if (task()) { // <-- return false to stop CRON
            createCronTask(uniqueName, cronTask, task);
          }
        });
      }, timeout, uniqueName);

      return timers[uniqueName];
    };

    it('Create multiple CRON tasks to simulate load an concurrency', async function () {
      overloadCronTimeouts.push(await createCronTask('overload CRON 1', '* * * * * *', () => {
        // -- silence
      }, jobCron));

      overloadCronTimeouts.push(await createCronTask('overload CRON 2', '*/2 * * * * *', () => {
        // -- silence
      }, jobCron));

      overloadCronTimeouts.push(await createCronTask('overload CRON 3', '*/3 * * * * *', () => {
        // -- silence
      }, jobCron));

      overloadCronTimeouts.push(await createCronTask('overload CRON 4', '*/4 * * * * *', () => {
        // -- silence
      }, jobCron));

      overloadCronTimeouts.push(await createCronTask('overload CRON 5', '* * * * * *', () => {
        // -- silence
      }, jobCron));

      overloadCronIntervals.push(await job.setInterval(() => {
        // -- silence
      }, 1024, 'overload Interval 1'));

      overloadCronIntervals.push(await job.setInterval(() => {
        // -- silence
      }, 1025, 'overload Interval 2'));

      overloadCronIntervals.push(await job.setInterval(() => {
        // -- silence
      }, 1026, 'overload Interval 3'));

      overloadCronIntervals.push(await job.setInterval(() => {
        // -- silence
      }, 1027, 'overload Interval 4'));

      overloadCronIntervals.push(await job.setInterval(() => {
        // -- silence
      }, 1028, 'overload Interval 5'));
    });

    const testCreateCronTask = (sec) =>  {
      it(`Check CRON-like task (${sec}sec) intervals`, function (endit) {
        this.slow(sec * 1000 * maxRuns);
        this.timeout((sec * 1000 * maxRuns) + 2000);

        const cronTask = `*/${sec} * * * * *`;
        let expected = +CronExpressionParser.parse(cronTask).next().toDate();
        const uniqueName = `every ${sec} seconds CRON` + Math.random();
        runs[uniqueName] = 0;

        createCronTask(uniqueName, cronTask, function runCronTask () {
          runs[uniqueName]++;

          const now = Date.now();
          const diff = expected - now;
          expected = +CronExpressionParser.parse(cronTask).next().toDate();

          assert.ok(diff < 512, `CRON task interval in correct time gaps (< 512); diff: ${diff}; sec: ${sec}; run: ${runs[uniqueName]}`);
          assert.ok(diff > -512, `CRON task interval in correct time gaps (> 512); diff: ${diff}; sec: ${sec}; run: ${runs[uniqueName]}`);
          assert.ok(runs[uniqueName] <= maxRuns, `CRON task runs only desired amount of cycles; diff: ${diff}; sec: ${sec}; run: ${runs[uniqueName]}`);

          if (runs[uniqueName] >= maxRuns) {
            assert.ok(runs[uniqueName] === maxRuns, 'CRON task correctly cleared after 5 cycles');
            endit();
            return false;
          }

          return true;
        });
      });
    };

    testCreateCronTask(1);
    testCreateCronTask(2);
    testCreateCronTask(3);
    testCreateCronTask(4);
  });

  describe('Redis - setInterval', function () {
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

  describe('Redis - setTimeout', function () {
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

  describe('Redis - override settings', function () {
    this.slow(512);
    this.timeout(1024);

    it('setTimeout', async function () {
      const uid = await job.setTimeout(noop, 2048, 'timeoutOverride');
      const task = await getTask(job.adapter, uid);

      assert.ok(typeof task === 'object', 'setTimeout override — record exists');
      assert.equal(task.delay, 2048, 'setTimeout override — Have correct initial delay');
      await job.setTimeout(noop, 3072, 'timeoutOverride');

      assert.equal((await getTask(job.adapter, uid)).delay, 3072, 'setTimeout override — Have correct updated delay');

      const isRemoved = await job.clearTimeout(uid);
      assert.isTrue(isRemoved, 'timeoutOverride task is properly removed');
      assert.equal(await hasTask(job.adapter, uid), false, 'setTimeout override — Task cleared');
    });

    it('setInterval', async function () {
      const uid = await job.setInterval(noop, 1024, 'intervalOverride');
      const task = await getTask(job.adapter, uid);

      assert.ok(typeof task === 'object', 'setInterval override — record exists');
      assert.equal(task.delay, 1024, 'setInterval override — Have correct initial delay');
      await job.setInterval(noop, 2048, 'intervalOverride');

      assert.equal((await getTask(job.adapter, uid)).delay, 2048, 'setInterval override — Have correct updated delay');

      const isRemoved = await job.clearInterval(uid);
      assert.isTrue(isRemoved, 'intervalOverride task is properly removed');
      assert.equal(await hasTask(job.adapter, uid), false, 'setInterval override — Task cleared');
    });
  });

  describe('Redis - setImmediate', function () {
    this.slow(RANDOM_GAP * 3);
    this.timeout(RANDOM_GAP * 4);

    it('setImmediate - Execution time', function (endit) {
      const time = Date.now();
      job.setImmediate((ready) => {
        assert.equal(Date.now() - time < ((RANDOM_GAP * 2) + 1), true, 'setImmediate - executed within appropriate time');
        ready();
        endit();
      }, 'taskImmediate-0');
    });
  });

  describe('Redis - zombieTime (stuck task recovery)', function () {
    this.slow(768 * 3 + RANDOM_GAP);
    this.timeout(768 * 4 + RANDOM_GAP);

    it('setInterval', function (endit) {
      let time = Date.now();
      let i = 0;
      process.nextTick(async () => {
        const taskId = await job.setInterval(async () => {
          try {
            i++;
            if (i === 1) {
              const _time = Date.now() - time;
              assert.equal(_time < 768 + RANDOM_GAP, true, 'setInterval - first run within appropriate interval');
              time = Date.now();
            } else if (i === 2) {
              const _time = Date.now() - time;

              assert.equal(_time < (ZOMBIE_TIME + RANDOM_GAP), true, 'setInterval - recovered within appropriate zombieTime time-frame');
              const isRemoved = await job.clearInterval(taskId);
              assert.isTrue(isRemoved, 'taskInterval-zombie task is properly removed');
              endit();
            }
          } catch(err) {
            endit(err);
          }
        }, 768, 'taskInterval-zombie-768');
      });
    });

    it('setTimeout', function (endit) {
      const time = Date.now();
      process.nextTick(async () => {
        const taskId = await job.setTimeout(async () => {
          try {
            const _time = Date.now() - time;

            assert.equal(_time < (ZOMBIE_TIME + RANDOM_GAP), true, 'setTimeout - recovered within appropriate zombieTime time-frame (which is actually the first run as it\'s Timeout)');
            const isRemoved = await job.clearTimeout(taskId);
            assert.isFalse(isRemoved, 'taskTimeout-zombie task is properly removed');
            endit();
          } catch (err) {
            endit(err);
          }
        }, 768, 'taskTimeout-zombie-768');
      });
    });
  });

  describe('Redis - Return Promise', function () {
    this.slow(2816);
    this.timeout(3072);

    it('setTimeout - async function', function (endit) {
      let check = false;
      process.nextTick(async () => {
        const taskId = await job.setTimeout(async () => {
          check = true;
          return true;
        }, 128, 'taskTimeout-async-func-128');

        setTimeout(async () => {
          try {
            assert.equal(check, true, 'setTimeout - was executed');
            const isRemoved = await job.clearTimeout(taskId);
            assert.isFalse(isRemoved, 'setTimeout-async task was properly removed');
            endit();
          } catch (err) {
            endit(err);
          }
        }, 768);
      });
    });

    it('setTimeout - async function returns promise', function (endit) {
      let check = false;
      process.nextTick(async () => {
        const taskId = await job.setTimeout(async () => {
          check = true;
          return wait(64);
        }, 128, 'taskTimeout-async-promise-128');

        setTimeout(async () => {
          try {
            assert.equal(check, true, 'setTimeout - was executed');
            const isRemoved = await job.clearTimeout(taskId);
            assert.isFalse(isRemoved, 'setTimeout-async-promise task was properly removed');
            endit();
          } catch (err) {
            endit(err);
          }
        }, 768);
      });
    });

    it('setTimeout - function returns promise', function (endit) {
      let check = false;
      process.nextTick(async () => {
        const taskId = await job.setTimeout(() => {
          check = true;
          return wait(64);
        }, 128, 'taskTimeout-promise-128');

        setTimeout(async () => {
          try {
            assert.equal(check, true, 'setTimeout - was executed');
            const isRemoved = await job.clearTimeout(taskId);
            assert.isFalse(isRemoved, 'setTimeout-promise task was properly removed');
            endit();
          } catch (err) {
            endit(err);
          }
        }, 768);
      });
    });


    it('setInterval - async function', function (endit) {
      const maxRuns = 3;
      let runs = 0;
      process.nextTick(async () => {
        const taskId = await job.setInterval(async () => {
          runs++;
          if (runs === maxRuns) {
            await job.clearInterval(taskId);
          }
          return true;
        }, 256, 'taskInterval-async-func-256');

        setTimeout(async () => {
          try {
            assert.equal(runs, maxRuns, `setInterval - was executed ${maxRuns} times`);
            const isRemoved = await job.clearInterval(taskId);
            assert.isFalse(isRemoved, 'setInterval-async task was properly removed');
            endit();
          } catch (err) {
            endit(err);
          }
        }, 2560);
      });
    });

    it('setInterval - async function returns promise', function (endit) {
      const maxRuns = 3;
      let runs = 0;
      process.nextTick(async () => {
        const taskId = await job.setInterval(async () => {
          runs++;
          if (runs === maxRuns) {
            await job.clearInterval(taskId);
          }
          return wait(1);
        }, 256, 'taskInterval-async-promise-256');

        setTimeout(async () => {
          try {
            assert.equal(runs, maxRuns, `setInterval - was executed ${maxRuns} times`);
            const isRemoved = await job.clearInterval(taskId);
            assert.isFalse(isRemoved, 'setInterval-async-promise task was properly removed');
            endit();
          } catch (err) {
            endit(err);
          }
        }, 2560);
      });
    });

    it('setInterval - function returns promise', function (endit) {
      const maxRuns = 3;
      let runs = 0;
      process.nextTick(async () => {
        const taskId = await job.setInterval(() => {
          runs++;
          if (runs === maxRuns) {
            return job.clearInterval(taskId);
          }
          return wait(1);
        }, 256, 'taskInterval-promise-256');

        setTimeout(async () => {
          try {
            assert.equal(runs, maxRuns, `setInterval - was executed ${maxRuns} times`);
            const isRemoved = await job.clearInterval(taskId);
            assert.isFalse(isRemoved, 'setInterval-promise task was properly removed');
            endit();
          } catch (err) {
            endit(err);
          }
        }, 2560);
      });
    });
  });

  describe('Redis - async/await exceptions', function () {
    this.slow(2816);
    this.timeout(3072);

    it('setTimeout - sync throw', function (endit) {
      const errorMessage = 'Error thrown inside sync callback';
      const taskName = 'throw-inside-sync-64';
      const taskId = `${taskName}setTimeout`;
      let check = false;

      jobException.setTimeout(function () {
        check = true;
        throw new Error(errorMessage);
      }, 64, taskName);

      setTimeout(async () => {
        try {
          const isRemoved = await jobException.clearTimeout(taskId);
          assert.isFalse(isRemoved, `${taskName} task was properly removed`);
          assert.isTrue(check, 'throw inside sync handled');
          assert.equal(exceptions[taskId].toString(), `Error: ${errorMessage}`, 'Error was correctly intercepted');
          endit();
        } catch (err) {
          endit(err);
        }
      }, 1024);
    });

    it('setTimeout - async throw', function (endit) {
      const errorMessage = 'Error thrown inside async callback';
      const taskName = 'throw-inside-async-64';
      const taskId = `${taskName}setTimeout`;
      let check = false;

      jobException.setTimeout(async function () {
        check = true;
        throw new Error(errorMessage);
      }, 64, taskName);

      setTimeout(async () => {
        try {
          const isRemoved = await jobException.clearTimeout(taskId);
          assert.isFalse(isRemoved, `${taskName} task was properly removed`);
          assert.isTrue(check, 'throw inside async handled');
          assert.equal(exceptions[taskId].toString(), `Error: ${errorMessage}`, 'Error was correctly intercepted');
          endit();
        } catch (err) {
          endit(err);
        }
      }, 1024);
    });

    it('setInterval - sync throw', async function () {
      const errorMessage = 'Error thrown inside sync callback';
      const taskName = 'throw-inside-sync-256';
      const taskId = `${taskName}setInterval`;
      const maxRuns = 3;
      let runs = 0;

      await jobException.setInterval(function () {
        runs++;
        if (runs >= maxRuns) {
          jobException.clearInterval(taskId);
        }
        throw new Error(errorMessage);
      }, 256, taskName);

      await waitUntil(() => runs >= maxRuns, {
        timeout: 5000,
        message: `${taskName} did not reach ${maxRuns} runs`
      });

      assert.equal(runs, maxRuns, `setInterval correctly scheduled after exception and executed ${maxRuns} times`);
      assert.equal(exceptions[taskId].toString(), `Error: ${errorMessage}`, 'Error was correctly intercepted');
      const isRemoved = await jobException.clearInterval(taskId);
      assert.isFalse(isRemoved, `${taskName} task was properly removed`);
    });

    it('setInterval - async throw', async function () {
      const errorMessage = 'Error thrown inside async callback';
      const taskName = 'throw-inside-async-256';
      const taskId = `${taskName}setInterval`;
      const maxRuns = 3;
      let runs = 0;

      await jobException.setInterval(async function () {
        runs++;
        if (runs >= maxRuns) {
          await jobException.clearInterval(taskId);
        }
        throw new Error(errorMessage);
      }, 256, taskName);

      await waitUntil(() => runs >= maxRuns, {
        timeout: 5000,
        message: `${taskName} did not reach ${maxRuns} runs`
      });

      assert.equal(runs, maxRuns, `setInterval correctly scheduled after exception and executed ${maxRuns} times`);
      assert.equal(exceptions[taskId].toString(), `Error: ${errorMessage}`, 'Error was correctly intercepted');
      const isRemoved = await jobException.clearInterval(taskId);
      assert.isFalse(isRemoved, `${taskName} task was properly removed`);
    });
  });

  describe('Redis - overspecified resolution', function () {
    this.slow(1152);
    this.timeout(1536);

    it('setTimeout - overspecified resolution', function (endit) {
      const taskName = 'overspecified-resolution-64';
      const taskId = `${taskName}setTimeout`;
      let error;
      let result;

      jobException.setTimeout(async function (ready) {
        await ready();
        return await ready((err, res) => {
          error = err;
          result = res;
        });
      }, 64, taskName);

      setTimeout(async () => {
        try {
          const isRemoved = await jobException.clearTimeout(taskId);
          assert.isFalse(isRemoved, `${taskName} task was properly removed`);
          assert.isFalse(result, `${taskName} ready {result} is false`);
          assert.instanceOf(error, Error, `${taskName} ready {error} is Error`);
          endit();
        } catch (err) {
          endit(err);
        }
      }, 1024);
    });
  });

  describe('Redis - racing conditions', function () {
    this.slow(6000);
    this.timeout(8000);

    const createRacingCluster = async (prefix, execute = 'batch') => {
      const racingJobs = [];
      let n = 0;
      while (n++ < 6) {
        const racingClient = await createClient({ url: process.env.REDIS_URL }).connect();
        racingClients.push(racingClient);
        racingJobs.push(new JoSk({
          adapter: new RedisAdapter({
            client: racingClient,
            prefix,
            resetOnInit: n === 1,
          }),
          debug: DEBUG,
          autoClear: true,
          minRevolvingDelay: 512,
          maxRevolvingDelay: 768,
          execute
        }));
      }

      return racingJobs;
    };

    it('setImmediate executes only once across equal instances', async function () {
      const key = uniqueId('countRacingConditionsImmediate');
      const racingJobs = await createRacingCluster(uniqueId('testCaseNPM-racing-immediate'));

      try {
        await client.set(key, 0);
        await Promise.all(racingJobs.map((jobInstance) => {
          return jobInstance.setImmediate(async (ready) => {
            await client.incr(key);
            ready();
          }, 'countRacingImmediate');
        }));

        await waitUntil(async () => {
          const rec = await client.get(key);
          return Number(rec) >= 1 && rec;
        }, {
          timeout: 2500,
          message: 'Redis setImmediate cluster task did not run'
        });
        await wait(512);

        assert.equal(await client.get(key), '1', 'setImmediate task executed only once');
      } finally {
        destroyJobs(racingJobs);
        await client.del(key);
      }
    });

    it('setTimeout execute one runs only once across equal instances', async function () {
      const key = uniqueId('countRacingConditionsTimeoutOne');
      const racingJobs = await createRacingCluster(uniqueId('testCaseNPM-racing-timeout-one'), 'one');

      try {
        await client.set(key, 0);
        await Promise.all(racingJobs.map((jobInstance) => {
          assert.equal(jobInstance.execute, 'one', 'cluster job uses execute one');
          return jobInstance.setTimeout(async () => {
            await client.incr(key);
          }, 128, 'countRacingTimeoutOne');
        }));

        await waitUntil(async () => {
          const rec = await client.get(key);
          return Number(rec) >= 1 && rec;
        }, {
          timeout: 2500,
          message: 'Redis execute one cluster task did not run'
        });
        await wait(512);

        assert.equal(await client.get(key), '1', 'execute one timeout task executed only once');
      } finally {
        destroyJobs(racingJobs);
        await client.del(key);
      }
    });

    it('setTimeout', function (endit) {
      const taskIds = {};
      const maxRuns = 1;
      const key = 'countRacingConditionsTimeout';
      let runs = 0;

      process.nextTick(async () => {
        try {
          await client.set(key, 0);
          const task = async () => {
            runs++;
            await client.incr(key);
          };

          let n = 0;
          while (n++ < 6) {
            taskIds[n] = await jobRacing[n].setTimeout(task, 256, 'countRacingConditions');
          }
        } catch (err) {
          endit(err);
        }

        setTimeout(async () => {
          try {
            assert.equal(runs, maxRuns, 'task was executed only once');
            const rec = await client.get(key);
            assert.equal(rec, maxRuns, 'database was updated only once');

            let n = 0;
            while (n++ < 6) {
              const isRemoved = await jobRacing[n].clearTimeout(taskIds[n]);
              assert.isFalse(isRemoved, `task was properly removed taskIds[${n}]`);
            }
            await client.del(key);
            endit();
          } catch (err) {
            endit(err);
          }
        }, 768);
      });
    });

    it('setInterval', function (endit) {
      const taskIds = {};
      const maxRuns = 4;
      const key = 'countRacingConditionsInterval';
      let runs = 0;

      process.nextTick(async () => {
        try {
          await client.set(key, 0);
          const task = async () => {
            runs++;
            await client.incr(key);
          };

          let n = 0;
          while (n++ < 6) {
            taskIds[n] = await jobRacing[n].setInterval(task, 768, 'countRacingConditions');
          }
        } catch (err) {
          endit(err);
        }

        setTimeout(async () => {
          try {
            assert.equal(runs, maxRuns, 'task was executed only once');
            const rec = await client.get(key);
            assert.equal(rec, maxRuns, 'database was updated only once');

            let n = 0;
            while (n++ < 6) {
              const isRemoved = await jobRacing[n].clearInterval(taskIds[n]);
              assert.isTrue((n === 1 ? isRemoved : !isRemoved), `task was properly removed taskIds[${n}]`);
            }
            await client.del(key);
            endit();
          } catch (err) {
            endit(err);
          }
        }, 3712);
      });
    });
  });

  describe('Redis - Clear (abort) current timers', function () {
    this.slow(2304);
    this.timeout(3072);

    it('setTimeout', function (endit) {
      let check = false;
      process.nextTick(async () => {
        const taskId = await job.setTimeout((ready) => {
          check = true;
          ready();
          assert.fail('setTimeout - executed after abort');
        }, 512, 'taskTimeout-clear-512');

        setTimeout(async () => {
          const isRemoved = await job.clearTimeout(taskId);
          assert.isTrue(isRemoved, 'setTimeout-clear task is properly removed');
          setTimeout(() => {
            assert.equal(check, false, 'setTimeout - is cleared and never executed');
            endit();
          }, 768);
        }, 384);
      });
    });

    it('setInterval', function (endit) {
      let check = false;
      process.nextTick(async () => {
        const taskId = await job.setInterval((ready) => {
          check = true;
          ready();
          assert.fail('setInterval - executed after abort');
        }, 512, 'taskInterval-clear-512');

        setTimeout(async () => {
          const isRemoved = await job.clearInterval(taskId);
          assert.isTrue(isRemoved, 'taskInterval-clear task is properly removed');
          setTimeout(() => {
            assert.equal(check, false, 'setInterval - is cleared and never executed');
            endit();
          }, 768);
        }, 384);
      });
    });
  });

  describe('Redis - Destroy (abort) current timers', function () {
    this.slow(2304);
    this.timeout(3072);

    it('setTimeout', function (endit) {
      let check = false;
      process.nextTick(async () => {
        const timeout1 = await job.setTimeout(() => {
          check = true;
          job.clearTimeout(timeout1);
          assert.fail('setInterval - executed after abort');
        }, 512, 'taskTimeout-destroy-512');

        setTimeout(() => {
          job.destroy();
          setTimeout(async () => {
            const isRemoved = await job.clearTimeout(timeout1);
            assert.isTrue(isRemoved, 'setTimeout-destroy task is properly removed');
            assert.equal(check, false, 'setTimeout - is destroyed/cleared and never executed');
            endit();
          }, 768);
        }, 384);
      });
    });

    it('setInterval + onError hook', function (endit) {
      let check1 = false;
      let check2 = false;
      let gotError = false;
      const job2 = new JoSk({
        adapter: new RedisAdapter({
          client: client,
          prefix: 'testCaseNPM2',
          resetOnInit: true
        }),
        debug: DEBUG,
        autoClear: false,
        zombieTime: ZOMBIE_TIME,
        minRevolvingDelay,
        maxRevolvingDelay,
        onError(error) {
          gotError = error;
        }
      });

      process.nextTick(async () => {
        const interval1 = await job2.setInterval(() => {
          check1 = true;
          job2.clearInterval(interval1);
          assert.fail('setInterval 1 - executed after destroy');
        }, 512, 'taskInterval-destroy2-512');

        setTimeout(async () => {
          job2.destroy();
          const interval2 = await job2.setInterval(() => {
            check2 = true;
            job2.clearInterval(interval2);
            assert.fail('setInterval 2 - executed after destroy');
          }, 384, 'taskInterval-destroy2-384');

          setTimeout(async () => {
            try {
              const isRemoved1 = await job2.clearInterval(interval1);
              assert.isTrue(isRemoved1, 'taskInterval-destroy1 task is properly removed');
              const isRemoved2 = await job2.clearInterval(interval2);
              assert.isFalse(isRemoved2, 'taskInterval-destroy2 task was never created');

              assert.equal(check1, false, 'setInterval (before .destroy()) - is destroyed/cleared and never executed');
              assert.equal(check2, false, 'setInterval (after .destroy()) - is destroyed/cleared and never executed');
              assert.equal(gotError, 'JoSk instance destroyed', 'setInterval not possible to use after JoSk#destroy');
              endit();
            } catch(err) {
              endit(err);
            }
          }, 768);
        }, 384);
      });
    });
  });

  describe('Redis - clean up and wrap up', function () {
    it('Disable overload CRONs', (endit) => {
      const length = overloadCronTimeouts.length;
      let cleared = 0;
      if (!length) {
        endit();
        return;
      }
      overloadCronTimeouts.forEach(async (timerId) => {
        await jobCron.clearTimeout(timerId);
        cleared++;
        if (cleared === length) {
          endit();
        }
      });
    });

    it('Disable overload Intervals', (endit) => {
      const length = overloadCronIntervals.length;
      let cleared = 0;
      if (!length) {
        endit();
        return;
      }
      overloadCronIntervals.forEach(async (timerId) => {
        const isRemoved = await job.clearInterval(timerId);
        cleared++;
        assert.equal(isRemoved, true, 'job.clearInterval.isRemoved !== true');
        if (cleared === length) {
          endit();
        }
      });
    });

    it('Check that collections are clear', async function () {
      const count = await jobCron.adapter.client.hLen(jobCron.adapter.tasksKey);
      const count2 = await job.adapter.client.hLen(job.adapter.tasksKey);
      assert.equal(count, 0, 'jobCron.count === 0');
      assert.equal(count2, 0, 'job.count === 0');
    });
  });
});
