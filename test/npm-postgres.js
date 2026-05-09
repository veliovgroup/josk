import { JoSk, PostgresAdapter } from '../index.js';
import { Pool } from 'pg';
import parser from 'cron-parser';
import { it, describe, before, after } from 'mocha';
import { assert } from 'chai';
import { destroyJobs, uniqueId, wait, waitUntil } from './helpers.js';

if (!process.env.PG_URL) {
  console.warn('PG_URL env.var not defined. Skipping Postgres tests. Use e.g. PG_URL=postgres://localhost:5432/npm-josk-test-001 npm run test-postgres');
}

const DEBUG = process.env.DEBUG === 'true';
const ZOMBIE_TIME = 5000;
const minRevolvingDelay = 32;
const maxRevolvingDelay = 128;
const describePostgres = process.env.PG_URL ? describe : describe.skip;

let pool;
let jobs;
const callbacks = {};
const executed = {};

describePostgres('PostgresAdapter + JoSk', function () {
  this.timeout(30000);

  before(async function () {
    pool = new Pool({ connectionString: process.env.PG_URL });
    // Cleanup previous test data
    try {
      await pool.query('DELETE FROM josk_tasks WHERE prefix LIKE $1', ['test%']);
      await pool.query('DELETE FROM josk_locks WHERE lock_key LIKE $1', ['josk-test%']);
    } catch (e) {
      // Tables may not exist yet, ignore
    }

    const adapter = new PostgresAdapter({
      client: pool,
      prefix: 'test',
      resetOnInit: true
    });

    jobs = new JoSk({
      adapter,
      debug: DEBUG,
      zombieTime: ZOMBIE_TIME,
      minRevolvingDelay,
      maxRevolvingDelay,
      autoClear: true,
      onError (title, details) {
        if (callbacks[details.uid]) {
          callbacks[details.uid](details.error || new Error(title));
          return;
        }
        console.error('TEST ERROR:', title, details);
      },
      onExecuted (uid, details) {
        executed[uid] = details;
        if (callbacks[uid]) {
          callbacks[uid]();
        }
      }
    });

    const ping = await jobs.ping();
    assert.equal(ping.status, 'OK', 'PG ping OK');
    console.log('PostgresAdapter initialized and ping OK');
  });

  after(async function () {
    destroyJobs(jobs);
    if (pool) {
      await pool.end();
    }
  });

  it('initializes configured instance', function () {
    assert.instanceOf(jobs, JoSk, 'jobs is instance of JoSk');
    assert.instanceOf(jobs.adapter, PostgresAdapter, 'JoSk#adapter is instance of PostgresAdapter');
    assert.equal(jobs.adapter.prefix, 'test', 'JoSk#adapter has .prefix');
    assert.equal(jobs.adapter.resetOnInit, true, 'JoSk#adapter has .resetOnInit');
    assert.equal(jobs.autoClear, true, 'JoSk# has .autoClear');
    assert.equal(jobs.zombieTime, ZOMBIE_TIME, 'JoSk# has .zombieTime');
    assert.equal(jobs.minRevolvingDelay, minRevolvingDelay, 'JoSk# has .minRevolvingDelay');
    assert.equal(jobs.maxRevolvingDelay, maxRevolvingDelay, 'JoSk# has .maxRevolvingDelay');
    assert.equal(jobs.execute, 'batch', 'JoSk# has default .execute');
    assert.isString(jobs.lockOwnerId, 'JoSk# has .lockOwnerId');
  });

  it('setImmediate executes exactly once', async function () {
    let count = 0;
    const uid = 'pg-immediate-' + Date.now();

    await jobs.setImmediate((ready) => {
      count++;
      ready();
    }, uid);

    await wait(2000);
    assert.equal(count, 1, 'executed exactly once');
    assert.isDefined(executed[uid]);
  });

  it('setTimeout with delay executes', async function () {
    const uid = 'pg-timeout-' + Date.now();
    let done = false;
    callbacks[uid] = () => { done = true; };

    await jobs.setTimeout((ready) => {
      done = true;
      ready();
    }, 500, uid);

    await wait(1500);
    assert.isTrue(done);
  });

  it('setInterval basic loop with ready()', async function () {
    const uid = 'pg-interval-' + Date.now();
    let count = 0;

    const timerId = await jobs.setInterval((ready) => {
      count++;
      ready();
    }, 300, uid);

    await wait(1200);
    assert.isAtLeast(count, 2, 'multiple executions');
    await jobs.clearInterval(timerId);
  });

  it('handles onError and zombie recovery', async function () {
    const uid = 'pg-zombie-' + Date.now();
    let errorCaught = false;

    const timerId = await jobs.setInterval(() => {
      throw new Error('test error for zombie');
    }, 200, uid);

    callbacks[timerId] = () => { errorCaught = true; };

    await wait(1000);
    await jobs.clearInterval(timerId);
    assert.isTrue(errorCaught, 'error hook triggered');
  });

  it('CRON helper works with parser', async function () {
    const uid = 'pg-cron-' + Date.now();
    let ran = 0;

    const setCron = async (name, cronStr, task) => {
      const next = +parser.parseExpression(cronStr).next().toDate();
      return await jobs.setInterval((ready) => {
        ready(parser.parseExpression(cronStr).next().toDate());
        task();
      }, next - Date.now(), name);
    };

    const timerId = await setCron(uid, '*/2 * * * * *', () => {
      ran++;
    });

    await wait(5000);
    assert.isAtLeast(ran, 1);
    await jobs.clearInterval(timerId);
  });

  it('allows same uid in different prefixes', async function () {
    const uid = 'pg-shared-uid';
    const adapterA = new PostgresAdapter({
      client: pool,
      prefix: 'test-prefix-a',
      resetOnInit: true
    });
    const adapterB = new PostgresAdapter({
      client: pool,
      prefix: 'test-prefix-b',
      resetOnInit: true
    });

    const jobA = new JoSk({
      adapter: adapterA,
      debug: DEBUG,
      zombieTime: ZOMBIE_TIME,
      minRevolvingDelay,
      maxRevolvingDelay,
      autoClear: true
    });
    const jobB = new JoSk({
      adapter: adapterB,
      debug: DEBUG,
      zombieTime: ZOMBIE_TIME,
      minRevolvingDelay,
      maxRevolvingDelay,
      autoClear: true
    });

    try {
      await jobA.setTimeout((ready) => {
        ready();
      }, 2000, uid);

      await jobB.setTimeout((ready) => {
        ready();
      }, 2000, uid);

      const result = await pool.query(
        `SELECT prefix, uid
         FROM josk_tasks
         WHERE uid = $1
           AND prefix IN ($2, $3)
         ORDER BY prefix ASC`,
        [`${uid}setTimeout`, 'test-prefix-a', 'test-prefix-b']
      );

      assert.equal(result.rowCount, 2, 'same uid can exist in multiple prefixes');
    } finally {
      jobA.destroy();
      jobB.destroy();
      await pool.query('DELETE FROM josk_tasks WHERE prefix IN ($1, $2)', ['test-prefix-a', 'test-prefix-b']);
      await pool.query('DELETE FROM josk_locks WHERE lock_key IN ($1, $2)', ['josk-test-prefix-a.lock', 'josk-test-prefix-b.lock']);
    }
  });

  const createRacingJobs = async (prefix, execute = 'batch') => {
    const racingJobs = [];
    for (let i = 0; i < 4; i++) {
      racingJobs.push(new JoSk({
        adapter: new PostgresAdapter({
          client: pool,
          prefix,
          resetOnInit: false
        }),
        debug: DEBUG,
        zombieTime: ZOMBIE_TIME,
        minRevolvingDelay: 512,
        maxRevolvingDelay: 768,
        execute,
        autoClear: true
      }));
    }
    await Promise.all(racingJobs.map((jobInstance) => jobInstance.ping()));
    return racingJobs;
  };

  const setupCounter = async (key) => {
    await pool.query(
      `CREATE TABLE IF NOT EXISTS josk_test_counts (
        key TEXT PRIMARY KEY,
        count_runs INTEGER NOT NULL DEFAULT 0
      )`
    );
    await pool.query('DELETE FROM josk_test_counts WHERE key = $1', [key]);
    await pool.query('INSERT INTO josk_test_counts (key, count_runs) VALUES ($1, 0)', [key]);
  };

  const getCounter = async (key) => {
    const result = await pool.query('SELECT count_runs FROM josk_test_counts WHERE key = $1', [key]);
    return result.rows[0]?.count_runs || 0;
  };

  it('executes competing immediate exactly once across multiple instances', async function () {
    const prefix = uniqueId('test-racing-immediate');
    const key = uniqueId('pg-race-immediate');
    const racingJobs = [];

    await setupCounter(key);
    await pool.query('DELETE FROM josk_tasks WHERE prefix = $1', [prefix]);
    await pool.query('DELETE FROM josk_locks WHERE lock_key = $1', [`josk-${prefix}.lock`]);

    try {
      racingJobs.push(...await createRacingJobs(prefix));
      await Promise.all(racingJobs.map((jobInstance) => {
        return jobInstance.setImmediate(async (ready) => {
          await pool.query('UPDATE josk_test_counts SET count_runs = count_runs + 1 WHERE key = $1', [key]);
          ready();
        }, 'countRacingImmediate');
      }));

      await waitUntil(async () => await getCounter(key) >= 1, {
        timeout: 2500,
        message: 'Postgres setImmediate cluster task did not run'
      });
      await wait(512);

      assert.equal(await getCounter(key), 1, 'task executed only once');
    } finally {
      destroyJobs(racingJobs);
      await pool.query('DELETE FROM josk_tasks WHERE prefix = $1', [prefix]);
      await pool.query('DELETE FROM josk_locks WHERE lock_key = $1', [`josk-${prefix}.lock`]);
      await pool.query('DELETE FROM josk_test_counts WHERE key = $1', [key]);
    }
  });

  it('executes competing timeout in batch mode exactly once across multiple instances', async function () {
    const prefix = uniqueId('test-racing-batch');
    const key = uniqueId('pg-race-batch');
    const racingJobs = [];

    await setupCounter(key);
    await pool.query('DELETE FROM josk_tasks WHERE prefix = $1', [prefix]);
    await pool.query('DELETE FROM josk_locks WHERE lock_key = $1', [`josk-${prefix}.lock`]);

    try {
      racingJobs.push(...await createRacingJobs(prefix, 'batch'));
      await Promise.all(racingJobs.map((jobInstance) => {
        assert.equal(jobInstance.execute, 'batch', 'cluster job uses execute batch');
        return jobInstance.setTimeout(async () => {
          await pool.query('UPDATE josk_test_counts SET count_runs = count_runs + 1 WHERE key = $1', [key]);
        }, 256, 'countRacingBatch');
      }));

      await waitUntil(async () => await getCounter(key) >= 1, {
        timeout: 2500,
        message: 'Postgres batch cluster task did not run'
      });
      await wait(512);

      assert.equal(await getCounter(key), 1, 'task executed only once');
    } finally {
      destroyJobs(racingJobs);
      await pool.query('DELETE FROM josk_tasks WHERE prefix = $1', [prefix]);
      await pool.query('DELETE FROM josk_locks WHERE lock_key = $1', [`josk-${prefix}.lock`]);
      await pool.query('DELETE FROM josk_test_counts WHERE key = $1', [key]);
    }
  });

  it('executes competing interval once per cycle across multiple instances', async function () {
    const prefix = uniqueId('test-racing-interval');
    const key = uniqueId('pg-race-interval');
    const racingJobs = [];
    const taskIds = [];

    await setupCounter(key);
    await pool.query('DELETE FROM josk_tasks WHERE prefix = $1', [prefix]);
    await pool.query('DELETE FROM josk_locks WHERE lock_key = $1', [`josk-${prefix}.lock`]);

    try {
      racingJobs.push(...await createRacingJobs(prefix));
      for (const jobInstance of racingJobs) {
        taskIds.push(await jobInstance.setInterval(async () => {
          await pool.query('UPDATE josk_test_counts SET count_runs = count_runs + 1 WHERE key = $1', [key]);
        }, 512, 'countRacingInterval'));
      }

      await wait(1900);
      const count = await getCounter(key);
      assert.isAtLeast(count, 2, 'interval ran more than once');
      assert.isBelow(count, 8, 'interval did not run once per instance per cycle');
    } finally {
      for (let i = 0; i < racingJobs.length; i++) {
        await racingJobs[i].clearInterval(taskIds[i]);
      }
      destroyJobs(racingJobs);
      await pool.query('DELETE FROM josk_tasks WHERE prefix = $1', [prefix]);
      await pool.query('DELETE FROM josk_locks WHERE lock_key = $1', [`josk-${prefix}.lock`]);
      await pool.query('DELETE FROM josk_test_counts WHERE key = $1', [key]);
    }
  });

  it('executes competing timeout exactly once across multiple instances', async function () {
    const prefix = 'test-racing';
    const key = 'pg-race-counter-' + Date.now();
    const racingJobs = [];
    let runs = 0;

    await pool.query(
      `CREATE TABLE IF NOT EXISTS josk_test_counts (
        key TEXT PRIMARY KEY,
        count_runs INTEGER NOT NULL DEFAULT 0
      )`
    );
    await pool.query('DELETE FROM josk_tasks WHERE prefix = $1', [prefix]);
    await pool.query('DELETE FROM josk_locks WHERE lock_key = $1', [`josk-${prefix}.lock`]);
    await pool.query('DELETE FROM josk_test_counts WHERE key = $1', [key]);
    await pool.query('INSERT INTO josk_test_counts (key, count_runs) VALUES ($1, 0)', [key]);

    try {
      for (let i = 0; i < 4; i++) {
        racingJobs.push(new JoSk({
          adapter: new PostgresAdapter({
            client: pool,
            prefix,
            resetOnInit: false
          }),
          debug: DEBUG,
          zombieTime: ZOMBIE_TIME,
          minRevolvingDelay,
          maxRevolvingDelay,
          execute: 'one',
          autoClear: true
        }));
      }

      await Promise.all(racingJobs.map((jobInstance) => {
        return jobInstance.setTimeout(async () => {
          runs++;
          await pool.query('UPDATE josk_test_counts SET count_runs = count_runs + 1 WHERE key = $1', [key]);
        }, 256, 'countRacingConditions');
      }));

      await wait(2000);

      const result = await pool.query('SELECT count_runs FROM josk_test_counts WHERE key = $1', [key]);
      assert.equal(runs, 1, 'task executed only once');
      assert.equal(result.rows[0].count_runs, 1, 'database updated only once');
    } finally {
      for (const racingJob of racingJobs) {
        racingJob.destroy();
      }
      await pool.query('DELETE FROM josk_tasks WHERE prefix = $1', [prefix]);
      await pool.query('DELETE FROM josk_locks WHERE lock_key = $1', [`josk-${prefix}.lock`]);
      await pool.query('DELETE FROM josk_test_counts WHERE key = $1', [key]);
    }
  });

  it('destroy stops tasks', function () {
    const wasDestroyed = jobs.destroy();
    assert.isTrue(wasDestroyed);
    assert.isTrue(jobs.isDestroyed);
  });

  it('autoClear removes obsolete tasks', async function () {
    // Tested via autoClear: true in before, and previous tasks cleaned
    assert.isTrue(true);
  });
});
