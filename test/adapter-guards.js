import { describe, it } from 'mocha';
import { assert } from 'chai';

import { MongoAdapter, RedisAdapter } from '../index.js';

describe('Adapter guards', function () {
  it('RedisAdapter.update rejects invalid Date input', async function () {
    let hSetCalled = false;
    const errors = [];
    const adapter = new RedisAdapter({
      client: {
        async exists() {
          return 1;
        },
        async hSet() {
          hSetCalled = true;
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
    assert.equal(hSetCalled, false);
    assert.equal(errors[0]?.[1], '[RedisAdapter] [update] [nextExecuteAt]');
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
});
