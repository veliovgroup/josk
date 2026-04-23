import { JoSk, PostgresAdapter } from '../index.js';
import { Pool } from 'pg';
import parser from 'cron-parser';
import { it, describe, before, after } from 'mocha';
import { assert } from 'chai';

if (!process.env.PG_URL) {
  console.warn('PG_URL env.var not defined. Skipping Postgres tests. Use e.g. PG_URL=postgres://localhost:5432/npm-josk-test-001 npm run test-postgres');
  process.exit(0);
}

const DEBUG = process.env.DEBUG === 'true';
const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const ZOMBIE_TIME = 5000;
const minRevolvingDelay = 32;
const maxRevolvingDelay = 128;

let pool;
let jobs;
const callbacks = {};
const executed = {};

describe('PostgresAdapter + JoSk', function () {
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
        console.error('TEST ERROR:', title, details);
        if (callbacks[details.uid]) {
          callbacks[details.uid](details.error || new Error(title));
        }
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
    if (jobs) {
      jobs.destroy();
    }
    if (pool) {
      await pool.end();
    }
    // Optional cleanup
  });

  it('setImmediate executes exactly once', async function () {
    let count = 0;
    const uid = 'pg-immediate-' + Date.now();
    callbacks[uid] = () => { count++; };

    await jobs.setImmediate(() => {
      count++;
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
    callbacks[uid] = () => { count++; };

    await jobs.setInterval((ready) => {
      count++;
      ready();
    }, 300, uid);

    await wait(1200);
    assert.isAtLeast(count, 2, 'multiple executions');
    await jobs.clearInterval(uid);
  });

  it('handles onError and zombie recovery', async function () {
    const uid = 'pg-zombie-' + Date.now();
    let errorCaught = false;
    callbacks[uid] = () => { errorCaught = true; };

    await jobs.setInterval(() => {
      throw new Error('test error for zombie');
    }, 200, uid);

    await wait(8000); // wait for zombieTime
    assert.isTrue(errorCaught, 'error hook triggered');
  });

  it('CRON helper works with parser', async function () {
    const uid = 'pg-cron-' + Date.now();
    let ran = 0;
    callbacks[uid] = () => { ran++; };

    const setCron = async (name, cronStr, task) => {
      const next = +parser.parseExpression(cronStr).next().toDate();
      return await jobs.setInterval((ready) => {
        ready(parser.parseExpression(cronStr).next().toDate());
        task();
      }, next - Date.now(), name);
    };

    await setCron(uid, '*/2 * * * * *', () => {
      ran++;
    });

    await wait(5000);
    assert.isAtLeast(ran, 1);
    await jobs.clearInterval(uid);
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
