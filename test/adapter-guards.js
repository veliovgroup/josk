import { describe, it } from 'mocha';
import { assert } from 'chai';

import { MongoAdapter, PostgresAdapter, RedisAdapter } from '../index.js';

describe('Adapter guards', function () {
  it('RedisAdapter resetOnInit deletes all scoped keys', async function () {
    const delCalls = [];
    const adapter = new RedisAdapter({
      resetOnInit: true,
      client: {
        async del(...args) {
          delCalls.push(args);
          return 0;
        },
        async *scanIterator() {}
      }
    });

    await adapter.ready();

    assert.deepEqual(delCalls[0], [[adapter.scheduleKey, adapter.tasksKey, adapter.lockKey]]);
  });

  it('RedisAdapter.update rejects invalid Date input', async function () {
    let evalCalled = false;
    const errors = [];
    const adapter = new RedisAdapter({
      client: {
        async eval() {
          evalCalled = true;
        }
      }
    });

    adapter.joskInstance = {
      __errorHandler(...args) {
        errors.push(args);
      }
    };

    const result = await adapter.update({ uid: 'redis-task' }, 'bad-date');

    assert.equal(result, false);
    assert.equal(evalCalled, false);
    assert.equal(errors[0]?.[1], '[RedisAdapter] [update] [nextExecuteAt]');
  });

  it('RedisAdapter.iterate batch uses batch claim and skips stale entries', async function () {
    const evalCalls = [];
    const executed = [];
    const adapter = new RedisAdapter({
      client: {
        async eval(script, options) {
          evalCalls.push({ script, options });

          if (options.arguments.length === 5) {
            return JSON.stringify([{
              uid: 'redis-batch-task',
              delay: 1000,
              executeAt: Date.now() - 1000,
              isInterval: false,
              isDeleted: false
            }]);
          }

          return JSON.stringify({ kind: 'missing', uid: 'stale-task' });
        }
      }
    });

    adapter.joskInstance = {
      __execute(task) {
        executed.push(task);
      },
      __errorHandler(error) {
        throw error;
      }
    };

    const count = await adapter.iterate(new Date(Date.now() + 5000), {
      ownerId: 'owner',
      leaseId: 'lease',
      expireAt: new Date(Date.now() + 5000),
      expiresAtMs: Date.now() + 5000
    }, 'batch');

    assert.equal(count, 1);
    assert.equal(executed.length, 1);
    assert.equal(executed[0].uid, 'redis-batch-task');
    assert.equal(evalCalls.length, 1);
    assert.equal(evalCalls[0].options.arguments.length, 5);
  });

  it('MongoAdapter.update rejects invalid Date input', async function () {
    let updateCalled = false;
    const errors = [];
    const collection = {
      async createIndex() {},
      async indexes() {
        return [];
      },
      async dropIndex() {},
      async updateOne() {
        updateCalled = true;
        return { modifiedCount: 1 };
      }
    };
    const adapter = new MongoAdapter({
      db: {
        collection() {
          return collection;
        }
      }
    });

    adapter.joskInstance = {
      __errorHandler(...args) {
        errors.push(args);
      }
    };

    const result = await adapter.update({ uid: 'mongo-task' }, 'bad-date');

    assert.equal(result, false);
    assert.equal(updateCalled, false);
    assert.equal(errors[0]?.[1], '[MongoAdapter] [update] [nextExecuteAt]');
  });

  it('PostgresAdapter.iterate claims batch tasks with one query', async function () {
    const tasks = [{
      uid: 'pg-batch-one',
      delay: 1000,
      execute_at: Date.now() - 1000,
      is_interval: false,
      is_deleted: false
    }, {
      uid: 'pg-batch-two',
      delay: 1000,
      execute_at: Date.now() - 1000,
      is_interval: false,
      is_deleted: false
    }];
    const executed = [];
    let claimCalls = 0;
    const client = {
      async query(queryText) {
        if (queryText.includes('WITH due AS')) {
          claimCalls++;
          if (queryText.includes('LIMIT $6')) {
            return {
              rowCount: tasks.length,
              rows: tasks
            };
          }

          return {
            rowCount: claimCalls <= tasks.length ? 1 : 0,
            rows: claimCalls <= tasks.length ? [tasks[claimCalls - 1]] : []
          };
        }

        if (queryText.includes('information_schema.table_constraints')) {
          return { rowCount: 0, rows: [] };
        }

        return { rowCount: 0, rows: [] };
      }
    };
    const adapter = new PostgresAdapter({
      client
    });

    adapter.joskInstance = {
      __execute(task) {
        executed.push(task);
      },
      __errorHandler(error) {
        throw error;
      }
    };

    const count = await adapter.iterate(new Date(Date.now() + 5000), {
      ownerId: 'owner',
      leaseId: 'lease',
      expireAt: new Date(Date.now() + 5000),
      expiresAtMs: Date.now() + 5000
    }, 'batch');

    assert.equal(count, 2);
    assert.equal(executed.length, 2);
    assert.equal(claimCalls, 1);
  });
});
