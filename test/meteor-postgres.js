import { JoSk, PostgresAdapter } from '../index.js';
import { Pool } from 'pg';
import { assert } from 'chai';
import { destroyJobs, uniqueId, wait, waitUntil } from './helpers.js';
import { registerMeteorPauseResumeTests } from './meteor-pause-resume.js';

if (!process.env.PG_URL) {
  console.warn('PG_URL env.var not defined. Skipping Meteor Postgres tests.');
}

const DEBUG = process.env.DEBUG === 'true' ? true : false;
const ZOMBIE_TIME = 5000;
const minRevolvingDelay = 32;
const maxRevolvingDelay = 128;
const describePostgres = process.env.PG_URL ? describe : describe.skip;

let pool;
let jobs;

describePostgres('Postgres - JoSk', function () {
  this.timeout(30000);

  before(async function () {
    pool = new Pool({ connectionString: process.env.PG_URL });

    try {
      await pool.query('DELETE FROM josk_tasks WHERE prefix LIKE $1', ['meteor-test%']);
      await pool.query('DELETE FROM josk_locks WHERE lock_key LIKE $1', ['josk-meteor-test%']);
    } catch (error) {
      // Tables may not exist before PostgresAdapter initialization.
    }

    jobs = new JoSk({
      adapter: new PostgresAdapter({
        client: pool,
        prefix: 'meteor-test',
        resetOnInit: true
      }),
      debug: DEBUG,
      zombieTime: ZOMBIE_TIME,
      minRevolvingDelay,
      maxRevolvingDelay,
      autoClear: true
    });

    await jobs.ping();
  });

  after(async function () {
    destroyJobs(jobs);
    if (pool) {
      await pool.query('DELETE FROM josk_tasks WHERE prefix LIKE $1', ['meteor-test%']).catch(() => {});
      await pool.query('DELETE FROM josk_locks WHERE lock_key LIKE $1', ['josk-meteor-test%']).catch(() => {});
      await pool.end();
    }
  });

  it('Check JoSk instance properties', function () {
    assert.instanceOf(jobs, JoSk, 'jobs is instance of JoSk');
    assert.instanceOf(jobs.adapter, PostgresAdapter, 'JoSk#adapter is instance of PostgresAdapter');
    assert.equal(jobs.adapter.prefix, 'meteor-test', 'JoSk#adapter has .prefix');
    assert.equal(jobs.adapter.resetOnInit, true, 'JoSk#adapter has .resetOnInit');
    assert.equal(jobs.autoClear, true, 'JoSk# has .autoClear');
    assert.equal(jobs.zombieTime, ZOMBIE_TIME, 'JoSk# has .zombieTime');
    assert.equal(jobs.minRevolvingDelay, minRevolvingDelay, 'JoSk# has .minRevolvingDelay');
    assert.equal(jobs.maxRevolvingDelay, maxRevolvingDelay, 'JoSk# has .maxRevolvingDelay');
    assert.equal(jobs.execute, 'batch', 'JoSk# has default .execute');
    assert.isString(jobs.lockOwnerId, 'JoSk# has .lockOwnerId');
  });

  it('ping', async function () {
    const pingRes = await jobs.ping();
    assert.isObject(pingRes, 'ping response is Object');
    assert.equal(pingRes.status, 'OK', 'ping.status');
    assert.equal(pingRes.code, 200, 'ping.code');
    assert.equal(pingRes.statusCode, 200, 'ping.statusCode');
    assert.isUndefined(pingRes.error, 'ping.error is undefined');
  });

  it('setTimeout executes', async function () {
    let ran = false;
    await jobs.setTimeout((ready) => {
      ran = true;
      ready();
    }, 256, uniqueId('meteor-pg-timeout'));

    await waitUntil(() => ran, {
      timeout: 2500,
      message: 'Meteor Postgres timeout did not run'
    });
  });

  it('setImmediate executes only once across equal instances', async function () {
    const prefix = uniqueId('meteor-test-racing-immediate');
    const key = uniqueId('meteor-pg-race-immediate');
    const racingJobs = [];

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

    const getCount = async () => {
      const result = await pool.query('SELECT count_runs FROM josk_test_counts WHERE key = $1', [key]);
      return (result.rows[0] && result.rows[0].count_runs) || 0;
    };

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
        return jobInstance.setImmediate(async (ready) => {
          await pool.query('UPDATE josk_test_counts SET count_runs = count_runs + 1 WHERE key = $1', [key]);
          ready();
        }, 'countRacingImmediate');
      }));

      await waitUntil(async () => await getCount() >= 1, {
        timeout: 2500,
        message: 'Meteor Postgres cluster task did not run'
      });
      await wait(512);

      assert.equal(await getCount(), 1, 'task was executed only once');
    } finally {
      destroyJobs(racingJobs);
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

  registerMeteorPauseResumeTests('Postgres', {
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
          runsA: (row && row.runs_a) || 0,
          runsB: (row && row.runs_b) || 0,
          runs: (row && row.runs) || 0,
          processed: (row && row.processed) || 0
        };
      };
      return {
        key,
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
});
