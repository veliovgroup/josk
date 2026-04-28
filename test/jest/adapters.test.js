import { afterEach, describe, expect, it, jest } from '@jest/globals';
import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { createClient } from 'redis';

import { MongoAdapter, PostgresAdapter, RedisAdapter } from '../../index.js';

const uniquePrefix = (name) => `jest-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const createLock = (ownerId = 'owner') => {
  const expireAt = new Date(Date.now() + 10000);
  return {
    ownerId,
    leaseId: `${ownerId}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    expireAt,
    expiresAtMs: +expireAt
  };
};

const createHarness = () => ({
  zombieTime: 10000,
  __execute: jest.fn(),
  __errorHandler: jest.fn(),
  _debug: jest.fn()
});

const expectOwnerBoundLock = async (adapter) => {
  const first = createLock('owner-a');
  const second = createLock('owner-b');

  await expect(adapter.acquireLock(first)).resolves.toBe(true);
  await expect(adapter.acquireLock(second)).resolves.toBe(false);
  await adapter.releaseLock(second);
  await expect(adapter.acquireLock(second)).resolves.toBe(false);
  await adapter.releaseLock(first);
  await expect(adapter.acquireLock(second)).resolves.toBe(true);
  await adapter.releaseLock(second);
};

const expectDueTaskClaiming = async (adapter, harness) => {
  await expect(adapter.add('due-one', false, -1000)).resolves.toBe(true);
  await expect(adapter.add('due-two', true, -1000)).resolves.toBe(true);

  const nextExecuteAt = new Date(Date.now() + 60000);
  const claimed = await adapter.iterate(nextExecuteAt, createLock('claim-owner'), 'batch');

  expect(claimed).toBe(2);
  expect(harness.__execute).toHaveBeenCalledTimes(2);
  expect(harness.__execute.mock.calls.map(([task]) => task.uid).sort()).toEqual(['due-one', 'due-two']);
  expect(harness.__execute.mock.calls.map(([task]) => task.isDeleted)).toEqual([false, false]);

  harness.__execute.mockClear();
  await expect(adapter.iterate(nextExecuteAt, createLock('claim-owner-2'), 'batch')).resolves.toBe(0);
  expect(harness.__execute).not.toHaveBeenCalled();
};

describe('Adapter constructor guards', () => {
  it('requires Redis client', () => {
    expect(() => new RedisAdapter()).toThrow('{client} option is required for RedisAdapter');
  });

  it('requires MongoDB db', () => {
    expect(() => new MongoAdapter()).toThrow('{db} option is required for MongoAdapter');
  });

  it('requires PostgreSQL client', () => {
    expect(() => new PostgresAdapter()).toThrow('{client} option is required for PostgresAdapter');
  });
});

const adapterSuites = [{
  name: 'RedisAdapter',
  enabled: !!process.env.REDIS_URL,
  async setup() {
    const client = await createClient({
      url: process.env.REDIS_URL,
      socket: {
        connectTimeout: 1000,
        reconnectStrategy: false
      }
    }).connect();
    const adapter = new RedisAdapter({
      client,
      prefix: uniquePrefix('redis'),
      resetOnInit: true
    });

    return {
      adapter,
      async cleanup() {
        await client.del([adapter.scheduleKey, adapter.tasksKey, adapter.lockKey]);
        await client.quit();
      }
    };
  }
}, {
  name: 'MongoAdapter',
  enabled: !!process.env.MONGO_URL,
  async setup() {
    const client = await MongoClient.connect(process.env.MONGO_URL, {
      appname: 'josk-jest-adapter-tests',
      connectTimeoutMS: 1000,
      serverSelectionTimeoutMS: 1000,
      socketTimeoutMS: 1000
    });
    const adapter = new MongoAdapter({
      db: client.db(),
      prefix: uniquePrefix('mongo'),
      resetOnInit: true
    });

    return {
      adapter,
      async cleanup() {
        await adapter.collection.drop().catch(() => {});
        await adapter.lockCollection.deleteMany({
          uniqueName: adapter.uniqueName
        }).catch(() => {});
        await client.close();
      }
    };
  }
}, {
  name: 'PostgresAdapter',
  enabled: !!process.env.PG_URL,
  async setup() {
    const client = new Pool({
      connectionString: process.env.PG_URL,
      connectionTimeoutMillis: 1000
    });
    const adapter = new PostgresAdapter({
      client,
      prefix: uniquePrefix('postgres'),
      resetOnInit: true
    });

    return {
      adapter,
      async cleanup() {
        await client.query('DELETE FROM josk_tasks WHERE prefix = $1', [adapter.prefix]).catch(() => {});
        await client.query('DELETE FROM josk_locks WHERE lock_key = $1', [adapter.lockKey]).catch(() => {});
        await client.end();
      }
    };
  }
}];

for (const suite of adapterSuites) {
  const suiteDescribe = suite.enabled ? describe : describe.skip;

  suiteDescribe(`${suite.name} live contract`, () => {
    let context;
    let harness;

    afterEach(async () => {
      if (context) {
        await context.cleanup();
        context = null;
      }
    });

    const setupAdapter = async () => {
      try {
        context = await suite.setup();
        harness = createHarness();
        context.adapter.joskInstance = harness;
        await context.adapter.ready();
        return context.adapter;
      } catch (error) {
        if (context) {
          await context.cleanup();
          context = null;
        }
        throw error;
      }
    };

    it('pings storage successfully', async () => {
      const adapter = await setupAdapter();

      await expect(adapter.ping()).resolves.toEqual({
        status: 'OK',
        code: 200,
        statusCode: 200
      });
    });

    it('keeps scheduler locks owner-bound', async () => {
      const adapter = await setupAdapter();

      await expectOwnerBoundLock(adapter);
    });

    it('claims due tasks once in batch mode', async () => {
      const adapter = await setupAdapter();

      await expectDueTaskClaiming(adapter, harness);
    });

    it('claims one due task in one mode', async () => {
      const adapter = await setupAdapter();
      await expect(adapter.add('single-due', false, -1000)).resolves.toBe(true);

      const claimed = await adapter.iterate(new Date(Date.now() + 60000), createLock('one-owner'), 'one');

      expect(claimed).toBe(1);
      expect(harness.__execute).toHaveBeenCalledTimes(1);
      expect(harness.__execute.mock.calls[0][0].uid).toBe('single-due');
    });

    it('rejects malformed update date before touching storage', async () => {
      const adapter = await setupAdapter();

      await expect(adapter.update({ uid: 'bad-date' }, 'not-a-date')).resolves.toBe(false);
      expect(harness.__errorHandler).toHaveBeenCalledTimes(1);
      expect(harness.__errorHandler.mock.calls[0][1]).toContain('[update] [nextExecuteAt]');
    });
  });
}
