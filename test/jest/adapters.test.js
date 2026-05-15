const testApi = typeof globalThis.Bun === 'undefined'
  ? await import('@jest/globals')
  : await import('bun:test');
const { afterEach, describe, expect, it, jest } = testApi;

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

const createRedisClient = (opts = {}) => {
  const evalResults = [...(opts.evalResults || [])];
  return {
    del: jest.fn(async () => 1),
    scanIterator: jest.fn(() => (async function* () {
      for (const key of opts.scanKeys || []) {
        yield key;
      }
    })()),
    ping: jest.fn(async () => opts.pingResult ?? 'PONG'),
    eval: jest.fn(async (...args) => {
      const result = evalResults.length > 0 ? evalResults.shift() : opts.evalResult;
      if (result instanceof Error) {
        throw result;
      }
      if (typeof result === 'function') {
        return await result(...args);
      }
      return result;
    })
  };
};

const setupRedisAdapter = async (clientOpts = {}, adapterOpts = {}) => {
  const client = createRedisClient(clientOpts);
  const adapter = new RedisAdapter({
    client,
    prefix: uniquePrefix('redis-unit'),
    ...adapterOpts
  });
  const harness = createHarness();
  adapter.joskInstance = harness;
  await adapter.ready();
  return { adapter, client, harness };
};

const createMongoCollection = (overrides = {}) => ({
  createIndex: jest.fn(async () => void 0),
  indexes: jest.fn(async () => []),
  dropIndex: jest.fn(async () => void 0),
  deleteMany: jest.fn(async () => ({ deletedCount: 0 })),
  updateOne: jest.fn(async () => ({ modifiedCount: 1, upsertedCount: 0 })),
  deleteOne: jest.fn(async () => ({ deletedCount: 1 })),
  findOneAndDelete: jest.fn(async () => null),
  findOneAndUpdate: jest.fn(async () => null),
  find: jest.fn(() => ({
    toArray: async () => []
  })),
  bulkWrite: jest.fn(async () => ({ modifiedCount: 0 })),
  drop: jest.fn(async () => void 0),
  ...overrides
});

const createMongoDb = (opts = {}) => {
  const taskCollection = opts.taskCollection || createMongoCollection();
  const lockCollection = opts.lockCollection || createMongoCollection();
  return {
    collection: jest.fn((name) => (name === (opts.lockCollectionName || '__JobTasks__.lock') ? lockCollection : taskCollection)),
    command: opts.command || jest.fn(async () => ({ ok: 1 })),
    taskCollection,
    lockCollection
  };
};

const setupMongoAdapter = async (dbOpts = {}, adapterOpts = {}) => {
  const db = createMongoDb(dbOpts);
  const adapter = new MongoAdapter({
    db,
    prefix: uniquePrefix('mongo-unit'),
    ...adapterOpts
  });
  const harness = createHarness();
  adapter.joskInstance = harness;
  await adapter.ready();
  return {
    adapter,
    db,
    collection: db.taskCollection,
    lockCollection: db.lockCollection,
    harness
  };
};

const createPostgresClient = (handler = () => ({ rows: [], rowCount: 0 })) => {
  let index = 0;
  return {
    query: jest.fn(async (queryText, values) => {
      const result = await handler(String(queryText), values, index++);
      return result ?? { rows: [], rowCount: 0 };
    })
  };
};

const setupPostgresAdapter = async (handler, adapterOpts = {}) => {
  const client = createPostgresClient(handler);
  const adapter = new PostgresAdapter({
    client,
    prefix: uniquePrefix('postgres-unit'),
    ...adapterOpts
  });
  const harness = createHarness();
  adapter.joskInstance = harness;
  await adapter.ready();
  return { adapter, client, harness };
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

describe('RedisAdapter unit coverage', () => {
  it('deletes scanned task keys on reset', async () => {
    const client = createRedisClient({
      scanKeys: ['josk:reset:task:a', 'josk:reset:task:b']
    });
    const adapter = new RedisAdapter({
      client,
      prefix: 'reset',
      resetOnInit: true
    });

    await adapter.ready();

    expect(client.del).toHaveBeenCalledWith([adapter.scheduleKey, adapter.tasksKey, adapter.lockKey]);
    expect(client.del).toHaveBeenCalledWith('josk:reset:task:a');
    expect(client.del).toHaveBeenCalledWith('josk:reset:task:b');
  });

  it('reports ping states before assignment and on unexpected replies', async () => {
    const client = createRedisClient();
    const unassigned = new RedisAdapter({
      client,
      prefix: uniquePrefix('redis-ping')
    });
    await unassigned.ready();

    await expect(unassigned.ping()).resolves.toMatchObject({
      code: 503,
      statusCode: 503
    });

    const { adapter } = await setupRedisAdapter({
      pingResult: 'NOPE'
    });
    const result = await adapter.ping();

    expect(result.code).toBe(500);
    expect(result.error.message).toContain('Unexpected response');
  });

  it('handles remove, add, and update failures', async () => {
    const removeError = new Error('remove failed');
    const addError = new Error('add failed');
    const updateError = new Error('update failed');
    const { adapter, harness } = await setupRedisAdapter({
      evalResults: [1, removeError, addError, 1, updateError]
    });

    await expect(adapter.remove('remove-ok')).resolves.toBe(true);
    await expect(adapter.remove('remove-fail')).resolves.toBe(false);
    await expect(adapter.add('add-fail', false, 1)).resolves.toBe(false);
    await expect(adapter.update(void 0, new Date())).resolves.toBe(false);
    await expect(adapter.update({ uid: 'bad-date' }, 'bad')).resolves.toBe(false);
    await expect(adapter.update({ uid: 'update-ok' }, new Date())).resolves.toBe(true);
    await expect(adapter.update({ uid: 'update-fail' }, new Date())).resolves.toBe(false);

    expect(harness.__errorHandler).toHaveBeenCalledTimes(5);
  });

  it('handles empty, malformed, and failed claims', async () => {
    const claimError = new Error('claim failed');
    const batchError = new Error('batch failed');
    const { adapter, harness } = await setupRedisAdapter({
      evalResults: [null, claimError, null, '{}', batchError]
    });
    const lock = createLock('redis-unit');
    const nextExecuteAt = new Date(Date.now() + 1000);

    await expect(adapter.iterate(nextExecuteAt, lock, 'one')).resolves.toBe(0);
    await expect(adapter.__claimNextTask(nextExecuteAt, lock)).resolves.toBeNull();
    await expect(adapter.__claimNextTasks(nextExecuteAt, lock, 10)).resolves.toEqual([]);
    await expect(adapter.__claimNextTasks(nextExecuteAt, lock, 10)).resolves.toEqual([]);
    await expect(adapter.__claimNextTasks(nextExecuteAt, lock, 10)).resolves.toEqual([]);

    expect(adapter.__normalizeTask(null)).toBeNull();
    expect(adapter.__getTaskKey('abc')).toBe(`${adapter.uniqueName}:task:abc`);
    expect(harness.__execute).not.toHaveBeenCalled();
    expect(harness.__errorHandler).toHaveBeenCalledTimes(2);
  });
});

describe('MongoAdapter unit coverage', () => {
  it('rebuilds conflicting indexes with matching keys', async () => {
    const conflict = new Error('index conflict');
    conflict.code = 85;
    const taskCollection = createMongoCollection({
      createIndex: jest.fn()
        .mockRejectedValueOnce(conflict)
        .mockResolvedValue(void 0),
      indexes: jest.fn(async () => [{
        name: 'wrong-length',
        key: {
          uid: 1,
          extra: 1
        }
      }, {
        name: 'wrong-direction',
        key: {
          uid: -1
        }
      }, {
        name: 'uid_old',
        key: {
          uid: 1
        }
      }])
    });
    const db = createMongoDb({
      taskCollection
    });
    const adapter = new MongoAdapter({
      db,
      prefix: uniquePrefix('mongo-index')
    });

    await adapter.ready();

    expect(taskCollection.dropIndex).toHaveBeenCalledWith('uid_old');
    expect(taskCollection.createIndex).toHaveBeenCalledTimes(3);
  });

  it('logs setup index failures for each setup index', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    for (let failAt = 1; failAt <= 4; failAt++) {
      const setupError = new Error(`setup-${failAt}`);
      let createIndexCalls = 0;
      const createIndex = jest.fn(async () => {
        createIndexCalls++;
        if (createIndexCalls === failAt) {
          throw setupError;
        }
      });
      const db = createMongoDb({
        taskCollection: createMongoCollection({
          createIndex
        }),
        lockCollection: createMongoCollection({
          createIndex
        })
      });
      const adapter = new MongoAdapter({
        db,
        prefix: uniquePrefix(`mongo-setup-${failAt}`)
      });

      await expect(adapter.ready()).rejects.toBe(setupError);
    }

    expect(errorSpy).toHaveBeenCalledTimes(4);
    errorSpy.mockRestore();
  });

  it('reports ping states before assignment, on command errors, and on unavailable service', async () => {
    const unassignedDb = createMongoDb();
    const unassigned = new MongoAdapter({
      db: unassignedDb,
      prefix: uniquePrefix('mongo-ping')
    });
    await unassigned.ready();

    await expect(unassigned.ping()).resolves.toMatchObject({
      code: 503,
      statusCode: 503
    });

    const commandError = new Error('ping failed');
    const failed = await setupMongoAdapter({
      command: jest.fn(async () => {
        throw commandError;
      })
    });
    await expect(failed.adapter.ping()).resolves.toMatchObject({
      code: 500,
      error: commandError
    });

    const unavailable = await setupMongoAdapter({
      command: jest.fn(async () => ({ ok: 0 }))
    });
    await expect(unavailable.adapter.ping()).resolves.toMatchObject({
      code: 503,
      status: 'Service Unavailable'
    });
  });

  it('handles lock acquisition conflicts and errors', async () => {
    const lockError = new Error('lock failed');
    const lockCollection = createMongoCollection({
      updateOne: jest.fn()
        .mockRejectedValueOnce({
          code: 11000
        })
        .mockRejectedValueOnce(lockError)
    });
    const { adapter, harness } = await setupMongoAdapter({
      lockCollection
    });

    await expect(adapter.acquireLock(createLock('mongo-duplicate'))).resolves.toBe(false);
    await expect(adapter.acquireLock(createLock('mongo-error'))).resolves.toBe(false);

    expect(harness.__errorHandler).toHaveBeenCalledTimes(1);
    expect(harness.__errorHandler.mock.calls[0][0]).toBe(lockError);
  });

  it('handles remove, add, and update branches', async () => {
    const removeError = new Error('remove failed');
    const addError = new Error('add failed');
    const updateError = new Error('update failed');
    const taskCollection = createMongoCollection({
      findOneAndDelete: jest.fn()
        .mockResolvedValueOnce({
          value: {
            _id: 'legacy-remove'
          }
        })
        .mockRejectedValueOnce(removeError),
      updateOne: jest.fn(async (filter) => {
        if (filter.uid === 'add-fail') {
          throw addError;
        }
        if (filter.uid === 'update-ok') {
          return {
            modifiedCount: 1,
            matchedCount: 1
          };
        }
        if (filter.uid === 'update-fail') {
          throw updateError;
        }
        return {
          modifiedCount: 1,
          matchedCount: 1,
          upsertedCount: 0
        };
      })
    });
    const { adapter, harness } = await setupMongoAdapter({
      taskCollection
    });

    await expect(adapter.remove('legacy-remove')).resolves.toBe(true);
    await expect(adapter.remove('remove-fail')).resolves.toBe(false);
    await expect(adapter.add('add-fail', false, 1)).resolves.toBe(false);
    await expect(adapter.update(void 0, new Date())).resolves.toBe(false);
    await expect(adapter.update({ uid: 'bad-date' }, 'bad')).resolves.toBe(false);
    await expect(adapter.update({ uid: 'update-ok' }, new Date())).resolves.toBe(true);
    await expect(adapter.update({ uid: 'update-fail' }, new Date())).resolves.toBe(false);

    expect(harness.__errorHandler.mock.calls.length).toBeGreaterThanOrEqual(5);
  });

  it('handles empty one-mode claims and legacy claim results', async () => {
    const task = {
      _id: 'legacy-claim',
      uid: 'legacy-claim',
      delay: 1,
      executeAt: new Date(),
      isInterval: false,
      isDeleted: false
    };
    const taskCollection = createMongoCollection({
      findOneAndUpdate: jest.fn()
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          value: task
        })
    });
    const { adapter, harness } = await setupMongoAdapter({
      taskCollection
    });
    const lock = createLock('mongo-claim');
    const nextExecuteAt = new Date(Date.now() + 1000);

    await expect(adapter.iterate(nextExecuteAt, lock, 'one')).resolves.toBe(0);
    await expect(adapter.__claimNextTask(nextExecuteAt, lock)).resolves.toBe(task);

    expect(harness.__execute).not.toHaveBeenCalled();
  });

  it('returns partially claimed batch tasks and reports claim errors', async () => {
    const claimError = new Error('claim failed');
    const batchError = new Error('batch failed');
    const tasks = [{
      _id: 'a',
      uid: 'a',
      delay: 1,
      executeAt: new Date(),
      isInterval: false,
      isDeleted: false
    }, {
      _id: 'b',
      uid: 'b',
      delay: 1,
      executeAt: new Date(),
      isInterval: true,
      isDeleted: false
    }];
    const taskCollection = createMongoCollection({
      findOneAndUpdate: jest.fn().mockRejectedValueOnce(claimError),
      find: jest.fn()
        .mockReturnValueOnce({
          toArray: async () => tasks
        })
        .mockReturnValueOnce({
          toArray: async () => [{
            _id: 'b'
          }]
        }),
      bulkWrite: jest.fn(async () => ({
        modifiedCount: 1
      }))
    });
    const { adapter, harness } = await setupMongoAdapter({
      taskCollection
    });
    const lock = createLock('mongo-batch');
    const nextExecuteAt = new Date(Date.now() + 1000);

    await expect(adapter.__claimNextTask(nextExecuteAt, lock)).resolves.toBeNull();
    await expect(adapter.__claimNextTasks(nextExecuteAt, lock, 2)).resolves.toEqual([tasks[1]]);

    const failing = await setupMongoAdapter({
      taskCollection: createMongoCollection({
        find: jest.fn(() => {
          throw batchError;
        })
      })
    });
    await expect(failing.adapter.__claimNextTasks(nextExecuteAt, lock, 2)).resolves.toEqual([]);

    expect(harness.__errorHandler).toHaveBeenCalledTimes(1);
    expect(failing.harness.__errorHandler).toHaveBeenCalledWith(batchError, '[MongoAdapter] [iterate] [batchClaim]', 'Exception inside MongoAdapter#__claimNextTasks() method', null);
  });
});

describe('PostgresAdapter unit coverage', () => {
  it('drops legacy uid primary key and resets scoped rows during setup', async () => {
    const { adapter, client } = await setupPostgresAdapter((sql) => {
      if (sql.includes('information_schema.table_constraints')) {
        return {
          rows: [{
            column_name: 'uid'
          }]
        };
      }
      return {
        rows: [],
        rowCount: 0
      };
    }, {
      resetOnInit: true
    });

    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('DROP CONSTRAINT IF EXISTS josk_tasks_pkey'));
    expect(client.query).toHaveBeenCalledWith('DELETE FROM josk_tasks WHERE prefix = $1', [adapter.prefix]);
    expect(client.query).toHaveBeenCalledWith('DELETE FROM josk_locks WHERE lock_key = $1', [adapter.lockKey]);
  });

  it('rethrows unexpected primary key setup errors and releases advisory lock', async () => {
    const setupError = new Error('primary key failed');
    setupError.code = 'XX000';
    const client = createPostgresClient((sql) => {
      if (sql.includes('ADD CONSTRAINT josk_tasks_pkey')) {
        throw setupError;
      }
      return {
        rows: [],
        rowCount: 0
      };
    });
    const adapter = new PostgresAdapter({
      client,
      prefix: uniquePrefix('postgres-setup')
    });

    await expect(adapter.ready()).rejects.toBe(setupError);
    expect(client.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1)', [93824517]);
  });

  it('reports ping states before assignment and on unexpected replies', async () => {
    const client = createPostgresClient();
    const unassigned = new PostgresAdapter({
      client,
      prefix: uniquePrefix('postgres-ping')
    });
    await unassigned.ready();

    await expect(unassigned.ping()).resolves.toMatchObject({
      code: 503,
      statusCode: 503
    });

    const { adapter } = await setupPostgresAdapter((sql) => {
      if (sql.includes('SELECT 1 as ping')) {
        return {
          rows: [{
            ping: 0
          }]
        };
      }
      return {
        rows: [],
        rowCount: 0
      };
    });
    const result = await adapter.ping();

    expect(result.code).toBe(500);
    expect(result.error.message).toContain('Unexpected response');
  });

  it('handles lock, remove, add, and update failure branches', async () => {
    const lockError = new Error('lock failed');
    const releaseError = new Error('release failed');
    const removeError = new Error('remove failed');
    const addError = new Error('add failed');
    const updateError = new Error('update failed');
    const { adapter, harness } = await setupPostgresAdapter((sql, values) => {
      if (sql.includes('INSERT INTO josk_locks')) {
        throw lockError;
      }
      if (sql.includes('DELETE FROM josk_locks')) {
        throw releaseError;
      }
      if (sql.includes('DELETE FROM josk_tasks')) {
        if (values?.[1] === 'remove-ok') {
          return {
            rowCount: 1,
            rows: [{
              uid: 'remove-ok'
            }]
          };
        }
        throw removeError;
      }
      if (sql.includes('INSERT INTO josk_tasks')) {
        throw addError;
      }
      if (sql.includes('UPDATE josk_tasks') && sql.includes('SET execute_at')) {
        if (values?.[2] === 'update-ok') {
          return {
            rowCount: 1,
            rows: [{
              uid: 'update-ok'
            }]
          };
        }
        throw updateError;
      }
      return {
        rows: [],
        rowCount: 0
      };
    });

    await expect(adapter.acquireLock(createLock('postgres-lock'))).resolves.toBe(false);
    await expect(adapter.releaseLock(createLock('postgres-release'))).resolves.toBeUndefined();
    await expect(adapter.remove('remove-ok')).resolves.toBe(true);
    await expect(adapter.remove('remove-fail')).resolves.toBe(false);
    await expect(adapter.add('add-fail', false, 1)).resolves.toBe(false);
    await expect(adapter.update(void 0, new Date())).resolves.toBe(false);
    await expect(adapter.update({ uid: 'bad-date' }, 'bad')).resolves.toBe(false);
    await expect(adapter.update({ uid: 'update-ok' }, new Date())).resolves.toBe(true);
    await expect(adapter.update({ uid: 'update-fail' }, new Date())).resolves.toBe(false);

    expect(harness.__errorHandler.mock.calls.some(([err, title]) => err === releaseError && title === '[PostgresAdapter] [releaseLock]')).toBe(true);
    expect(harness.__errorHandler.mock.calls.length).toBeGreaterThanOrEqual(6);
  });

  it('handles empty one-mode iteration and full batch page continuation', async () => {
    const { adapter, harness } = await setupPostgresAdapter();
    const tasks = Array.from({
      length: 100
    }, (_, index) => ({
      uid: `task-${index}`,
      delay: '1',
      execute_at: `${Date.now() - 1000}`,
      is_interval: index % 2 === 0,
      is_deleted: false
    }));

    adapter.__claimNextTask = jest.fn(async () => null);
    await expect(adapter.iterate(new Date(Date.now() + 1000), createLock('postgres-empty'), 'one')).resolves.toBe(0);

    adapter.__claimNextTasks = jest.fn()
      .mockResolvedValueOnce(tasks)
      .mockResolvedValueOnce([]);
    await expect(adapter.iterate(new Date(Date.now() + 1000), createLock('postgres-batch'), 'batch')).resolves.toBe(100);

    expect(harness.__execute).toHaveBeenCalledTimes(100);
  });

  it('acquireLock compares server time, not client time, to resist clock skew', async () => {
    const queries = [];
    const { adapter } = await setupPostgresAdapter((sql, values) => {
      queries.push({ sql, values });
      if (sql.includes('INSERT INTO josk_locks')) {
        return { rowCount: 1, rows: [{ lease_id: 'l1' }] };
      }
      return { rows: [], rowCount: 0 };
    });

    const expireAt = new Date(Date.now() + 5000);
    const acquired = await adapter.acquireLock({
      ownerId: 'owner',
      leaseId: 'lease',
      expireAt,
      expiresAtMs: +expireAt
    });

    expect(acquired).toBe(true);
    const lockQuery = queries.find((q) => q.sql.includes('INSERT INTO josk_locks'));
    expect(lockQuery).toBeTruthy();
    expect(lockQuery.sql).toContain('EXTRACT(EPOCH FROM CURRENT_TIMESTAMP)');
  });

  it('reports claim errors and exposes private method coverage', async () => {
    const claimError = new Error('claim failed');
    const batchError = new Error('batch failed');
    const { adapter, harness } = await setupPostgresAdapter((sql) => {
      if (sql.includes('LIMIT 1')) {
        throw claimError;
      }
      if (sql.includes('LIMIT $6')) {
        throw batchError;
      }
      return {
        rows: [],
        rowCount: 0
      };
    });
    const lock = createLock('postgres-claims');
    const nextExecuteAt = new Date(Date.now() + 1000);

    await expect(adapter.__claimNextTask(nextExecuteAt, lock)).resolves.toBeNull();
    await expect(adapter.__claimNextTasks(nextExecuteAt, lock, 2)).resolves.toEqual([]);
    expect(harness.__errorHandler).toHaveBeenCalledTimes(2);
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
