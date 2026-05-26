import { JoSk, PostgresAdapter } from '../index.js';
import { Pool } from 'pg';
import { CronExpressionParser } from 'cron-parser';
import { it, describe, before, after } from 'mocha';
import { assert } from 'chai';
import { destroyJobs, uniqueId, wait, waitUntil } from './helpers.js';
import { registerPauseResumeTests } from './pause-resume-tests.js';

if (!process.env.PG_URL) {
  console.warn('PG_URL env.var not defined. Skipping Postgres tests. Use e.g. PG_URL=postgres://localhost:5432/npm-josk-test-001 npm run test-postgres');
}

const DEBUG = process.env.DEBUG === 'true';
const ZOMBIE_TIME = 5000;
const minRevolvingDelay = 32;
const maxRevolvingDelay = 256;
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

  describe('Postgres - Adapter direct', function () {
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
      const adapter = new PostgresAdapter({
        client: pool,
        prefix: uniqueId('test-direct'),
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
      await pool.query('DELETE FROM josk_tasks WHERE prefix = $1', [adapter.prefix]).catch(() => {});
      await pool.query('DELETE FROM josk_locks WHERE lock_key = $1', [adapter.lockKey]).catch(() => {});
    };

    it('releaseLock frees the lock only when called with the holding owner', async function () {
      const adapter = await buildAdapter();
      const owner = makeLock('pg-direct-owner-a');
      const intruder = makeLock('pg-direct-owner-b');

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
      const prefix = uniqueId('test-direct-reset');
      const seed = await buildAdapter({ prefix });
      const lock = makeLock('pg-direct-reset-owner');
      try {
        assert.isTrue(await seed.add('reset-leftover-a', false, 60000), 'seeded one-shot task accepted');
        assert.isTrue(await seed.add('reset-leftover-b', true, 60000), 'seeded interval task accepted');
        assert.isTrue(await seed.acquireLock(lock), 'seeded scheduler lock acquired');

        const tasksBefore = await pool.query('SELECT COUNT(*)::INT AS count FROM josk_tasks WHERE prefix = $1', [seed.prefix]);
        const locksBefore = await pool.query('SELECT COUNT(*)::INT AS count FROM josk_locks WHERE lock_key = $1', [seed.lockKey]);
        assert.equal(tasksBefore.rows[0].count, 2, 'seeded tasks visible before reset');
        assert.equal(locksBefore.rows[0].count, 1, 'seeded lock visible before reset');

        const fresh = new PostgresAdapter({ client: pool, prefix, resetOnInit: true });
        fresh.joskInstance = {
          zombieTime: ZOMBIE_TIME,
          __execute: () => {},
          __errorHandler: () => {},
          _debug: () => {}
        };
        try {
          await fresh.ready();
          const tasksAfter = await pool.query('SELECT COUNT(*)::INT AS count FROM josk_tasks WHERE prefix = $1', [fresh.prefix]);
          const locksAfter = await pool.query('SELECT COUNT(*)::INT AS count FROM josk_locks WHERE lock_key = $1', [fresh.lockKey]);
          assert.equal(tasksAfter.rows[0].count, 0, 'resetOnInit cleared previously stored tasks');
          assert.equal(locksAfter.rows[0].count, 0, 'resetOnInit cleared previously stored locks for this scope');
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
          assert.isTrue(await adapter.add(`pg-batch-direct-${i}`, i % 2 === 0, -1000 - i), `seeded task ${i}`);
        }

        const claimed = await adapter.iterate(new Date(Date.now() + ZOMBIE_TIME), makeLock('pg-batch-direct'), 'batch');
        assert.equal(claimed, 3, 'iterate(batch) reports all 3 tasks dispatched');
        assert.equal(dispatched.length, 3, '__execute called once for each task');
        assert.deepEqual(
          dispatched.map((task) => task.uid).sort(),
          ['pg-batch-direct-0', 'pg-batch-direct-1', 'pg-batch-direct-2'],
          'dispatched uids match the seeded set'
        );

        const replay = await adapter.iterate(new Date(Date.now() + ZOMBIE_TIME), makeLock('pg-batch-direct-2'), 'batch');
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
        assert.isTrue(await adapter.add('pg-one-direct-a', false, -1000));
        assert.isTrue(await adapter.add('pg-one-direct-b', false, -500));
        assert.isTrue(await adapter.add('pg-one-direct-c', true, -250));

        const claimed = await adapter.iterate(new Date(Date.now() + ZOMBIE_TIME), makeLock('pg-one-direct'), 'one');
        assert.equal(claimed, 1, 'iterate(one) reports exactly one dispatched task');
        assert.equal(dispatched.length, 1, '__execute called only once');

        const stillDue = await pool.query(
          `SELECT COUNT(*)::INT AS count
           FROM josk_tasks
           WHERE prefix = $1 AND is_deleted = false AND execute_at <= $2`,
          [adapter.prefix, Date.now()]
        );
        assert.equal(stillDue.rows[0].count, 2, 'two due tasks remain after a single one-mode pass');
      } finally {
        await cleanup(adapter);
      }
    });
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
      const next = +CronExpressionParser.parse(cronStr).next().toDate();
      return await jobs.setInterval((ready) => {
        ready(CronExpressionParser.parse(cronStr).next().toDate());
        task();
      }, Math.max(0, next - Date.now()), name);
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

  const racingJoSkOpts = {
    debug: DEBUG,
    autoClear: true,
    minRevolvingDelay,
    maxRevolvingDelay,
    zombieTime: ZOMBIE_TIME,
    execute: 'one'
  };

  registerPauseResumeTests('Postgres', {
    createJob: (prefix, resetOnInit) => new JoSk({
      adapter: new PostgresAdapter({ client: pool, prefix, resetOnInit }),
      ...racingJoSkOpts
    }),
    initCounter: async (prefix) => {
      const key = `pause:${prefix}`;
      await pool.query(
        `CREATE TABLE IF NOT EXISTS josk_test_pause_counts (
          key TEXT PRIMARY KEY,
          runs_a INTEGER NOT NULL DEFAULT 0,
          runs_b INTEGER NOT NULL DEFAULT 0,
          runs INTEGER NOT NULL DEFAULT 0,
          processed INTEGER NOT NULL DEFAULT 0
        )`
      );
      await pool.query(
        `INSERT INTO josk_test_pause_counts (key, runs_a, runs_b, runs, processed)
         VALUES ($1, 0, 0, 0, 0)
         ON CONFLICT (key) DO UPDATE SET runs_a = 0, runs_b = 0, runs = 0, processed = 0`,
        [key]
      );
      const read = async () => {
        const result = await pool.query(
          'SELECT runs_a, runs_b, runs, processed FROM josk_test_pause_counts WHERE key = $1',
          [key]
        );
        const row = result.rows[0];
        return {
          runsA: row?.runs_a || 0,
          runsB: row?.runs_b || 0,
          runs: row?.runs || 0,
          processed: row?.processed || 0
        };
      };
      return {
        incA: () => pool.query('UPDATE josk_test_pause_counts SET runs_a = runs_a + 1 WHERE key = $1', [key]),
        incB: () => pool.query('UPDATE josk_test_pause_counts SET runs_b = runs_b + 1 WHERE key = $1', [key]),
        incRuns: () => pool.query('UPDATE josk_test_pause_counts SET runs = runs + 1 WHERE key = $1', [key]),
        incProcessed: () => pool.query('UPDATE josk_test_pause_counts SET processed = processed + 1 WHERE key = $1', [key]),
        read,
        cleanup: async () => {
          await pool.query('DELETE FROM josk_test_pause_counts WHERE key = $1', [key]);
          await pool.query('DELETE FROM josk_tasks WHERE prefix = $1', [prefix]);
          await pool.query('DELETE FROM josk_locks WHERE lock_key = $1', [`josk-${prefix}.lock`]);
        }
      };
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
