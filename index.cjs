'use strict';

const crypto = require('crypto');

// MongoDB Storage Adapter for JoSk.
//
// IMPORTANT: This adapter is designed for and tested against the official
// `mongodb` driver only. Other Mongo-compatible clients (Mongoose, custom
// wrappers) may work if they expose the same `Db.collection()`,
// `Db.command()`, and `Collection` APIs, but are not officially supported.

/**
 * @typedef {object} MongoDbLike
 * @property {(name: string) => object} collection
 * @property {(command: { ping: number }) => Promise<unknown>} command
 * @typedef {import('../index.js').JoSk} JoSk
 * @typedef {import('../index.js').JoSkExecuteMode} JoSkExecuteMode
 * @typedef {import('../index.js').JoSkLock} JoSkLock
 */

/**
 * @typedef {object} AdapterPingResult
 * @property {string} status
 * @property {number} code
 * @property {number} statusCode
 * @property {unknown} [error]
 */

/**
 * @template {MongoDbLike} [D=MongoDbLike]
 * @typedef {object} MongoAdapterOption
 * @property {D} db
 * @property {string} [lockCollectionName]
 * @property {string} [prefix]
 * @property {boolean} [resetOnInit]
 */

/**
 * @typedef {object} MongoTask
 * @property {unknown} [_id]
 * @property {string} uid
 * @property {number} delay
 * @property {Date} [executeAt]
 * @property {boolean} isInterval
 * @property {boolean} isDeleted
 * @property {string} [claimLeaseId]
 */

// Stop claiming this much before the scheduler lease expires.
const LEASE_STOP_MARGIN$1 = 500;

const logError = (error, ...args) => {
  if (error) {
    console.error('[josk] [MongoAdapter] [logError]:', error, ...args);
  }
};

const sameKeys = (a = {}, b = {}) => {
  const ak = Object.keys(a);
  const bk = Object.keys(b);
  return ak.length === bk.length && ak.every((key, i) => bk[i] === key && a[key] === b[key]);
};

/**
 * Index setup that never drops a usable index. JoSk 5.x and 6.x can share a
 * collection, and a drop opens a window without the unique index, where
 * concurrent upserts insert duplicate documents. An existing index with the
 * same key pattern is adopted whatever its name is. Fresh indexes use the
 * names and options of JoSk 5.x, so a 5.x startup finds them unchanged.
 * @param {object} collection
 * @param {{ keys: object, name: string, unique?: boolean, ttl?: boolean, expireAfterSeconds?: number, plain?: boolean, dropNonUnique?: boolean }} spec
 * @returns {Promise<void>}
 */
const ensureIndexOnce = async (collection, spec, state) => {
  const check = async () => {
    let indexes = [];
    try {
      indexes = await collection.indexes();
    } catch (error) {
      if (error?.code !== 26 && error?.codeName !== 'NamespaceNotFound') {
        throw error;
      }
    }

    const found = indexes.find((index) => sameKeys(index.key, spec.keys));
    if (!found) {
      return false;
    }

    let usable = true;
    if (spec.unique) {
      // A non-simple collation makes distinct uids collide and plain lookups skip the index.
      usable = found.unique === true && !found.partialFilterExpression && (!found.collation || found.collation.locale === 'simple');
    } else if (!spec.plain) {
      usable = typeof found.expireAfterSeconds === 'number' && !found.partialFilterExpression;
    }

    if (usable && (found.hidden || (spec.plain && found.partialFilterExpression))) {
      console.warn(`[josk] [MongoAdapter] adopted index "${found.name}" on "${collection.collectionName}" is ${found.hidden ? 'hidden' : 'partial'}; queries may not use it`);
    }

    if (!usable) {
      if (spec.dropNonUnique && found.unique !== true && typeof found.expireAfterSeconds !== 'number') {
        // A non-unique index protects nothing, replacing it opens no duplicate window.
        // Never drop when duplicates exist: the unique index could not be built afterwards.
        // The probe scans the whole collection, so it runs once per ensureIndex call, not once per retry.
        const key = Object.keys(spec.keys)[0];
        const duplicates = state.probed ? [] : await collection.aggregate([{ $group: { _id: `$${key}`, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $limit: 1 }], { allowDiskUse: true }).toArray();
        state.probed = true;
        if (duplicates.length > 0) {
          const dupError = new Error(`[josk] [MongoAdapter] duplicate "${key}" documents in "${collection.collectionName}"; index "${found.name}" was kept. Dedupe the collection before starting JoSk 6 (see docs/mongodb.md).`);
          dupError.code = 11000;
          throw dupError;
        }

        // A concurrent starter may have replaced it with a unique index since the first read.
        const current = (await collection.indexes()).find((index) => index.name === found.name);
        if (!current || current.unique === true || !sameKeys(current.key, spec.keys)) {
          return false;
        }

        try {
          await collection.dropIndex(found.name);
        } catch (error) {
          if (error?.code !== 27 && error?.codeName !== 'IndexNotFound') {
            throw error;
          }
        }
        return false;
      }

      throw new Error(`[josk] [MongoAdapter] index "${found.name}" on "${collection.collectionName}" has the key ${JSON.stringify(spec.keys)} but is not ${spec.unique ? 'a plain unique index' : 'a TTL index'}. JoSk never drops indexes it can not replace safely. Drop or fix this index manually, or ${spec.dropNonUnique ? 'use a different {prefix}' : 'set a separate {lockCollectionName}'}.`);
    }

    return true;
  };

  if (await check()) {
    return;
  }

  let options = { name: spec.name };
  if (spec.unique) {
    options = { name: spec.name, unique: true };
  } else if (!spec.plain) {
    options = { name: spec.name, expireAfterSeconds: spec.expireAfterSeconds };
  }

  try {
    await collection.createIndex(spec.keys, options);
  } catch (error) {
    if (spec.unique && error?.code === 11000) {
      const key = Object.keys(spec.keys)[0];
      const hint = spec.dropNonUnique
        ? 'dedupe before starting JoSk 6 (see docs/mongodb.md)'
        : 'set a separate {lockCollectionName} for JoSk 6 (see docs/mongodb.md)';
      const dupError = new Error(`[josk] [MongoAdapter] duplicate "${key}" documents in "${collection.collectionName}"; ${hint}`);
      dupError.code = 11000;
      dupError.cause = error;
      throw dupError;
    }

    const conflict = error?.code === 85 || error?.code === 86 || error?.codeName === 'IndexOptionsConflict' || error?.codeName === 'IndexKeySpecsConflict' || error?.code === 68 || error?.codeName === 'IndexAlreadyExists';
    if (!conflict || !(await check())) {
      throw error;
    }
  }
};

const isBusyError = (error) => error?.code === 12587 || error?.code === 117 || error?.code === 276 || error?.codeName === 'IndexBuildAborted' || error?.codeName === 'BackgroundOperationInProgressForNamespace' || error?.codeName === 'ConflictingOperationInProgress';

/**
 * Concurrent starters can race index builds and drops. MongoDB 4.2 rejects the
 * loser with "a background operation is currently running", so retry briefly.
 * @param {object} collection
 * @param {object} spec
 * @returns {Promise<void>}
 */
const ensureIndex = async (collection, spec) => {
  const state = { probed: false };
  for (let attempt = 0; ; attempt++) {
    try {
      return await ensureIndexOnce(collection, spec, state);
    } catch (error) {
      if (!isBusyError(error)) {
        throw error;
      }

      if (attempt >= 8) {
        const busyError = new Error(`[josk] [MongoAdapter] index build on "${collection.collectionName}" stayed busy after ${attempt + 1} attempts`);
        busyError.code = error.code;
        busyError.cause = error;
        throw busyError;
      }
      await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
    }
  }
};

/**
 * Update pipeline for re-registering an interval. Preserve a claimed task's
 * recovery deadline; otherwise keep an unchanged interval's earlier schedule.
 * Field references inside one `$set` stage read the pre-update document.
 * @param {string} uid
 * @param {number} delay
 * @param {Date} executeAt
 * @returns {object[]}
 */
const intervalUpsertPipeline = (uid, delay, executeAt) => {
  const existingInterval = [
    { $eq: ['$isInterval', true] },
    { $eq: ['$isDeleted', false] },
    { $eq: [{ $type: '$executeAt' }, 'date'] }
  ];
  const activeClaim = {
    $and: [
      ...existingInterval,
      { $eq: [{ $type: '$claimLeaseId' }, 'string'] },
      { $ne: ['$claimLeaseId', ''] }
    ]
  };

  return [{
    $set: {
      executeAt: {
        $cond: [activeClaim, '$executeAt', {
          $cond: [{
            $and: [
              ...existingInterval,
              { $eq: ['$delay', { $literal: delay }] },
              { $lt: ['$executeAt', { $literal: executeAt }] }
            ]
          }, '$executeAt', { $literal: executeAt }]
        }]
      },
      claimLeaseId: { $cond: [activeClaim, '$claimLeaseId', '$$REMOVE'] },
      uid: { $literal: uid },
      delay: { $literal: delay },
      isInterval: true,
      isDeleted: false
    }
  }];
};

/**
 * Class representing MongoDB adapter for JoSk
 * @template {MongoDbLike} [D=MongoDbLike]
 */
class MongoAdapter {
  /**
   * Create a MongoAdapter instance
   * @param {MongoAdapterOption<D>} opts - configuration object
   */
  constructor(opts = {}) {
    this.name = 'mongo';
    this.prefix = typeof opts.prefix === 'string' && opts.prefix.length > 0 ? opts.prefix : 'default';
    this.lockCollectionName = opts.lockCollectionName || '__JobTasks__.lock';
    this.resetOnInit = !!opts.resetOnInit;

    if (!opts.db) {
      throw new Error('{db} option is required for MongoAdapter', {
        description: 'MongoDB database {db} option is required, e.g. returned from `MongoClient.connect` method'
      });
    }

    /** @type {D} */
    this.db = opts.db;
    this.uniqueName = `__JobTasks__${this.prefix}`;
    /** @type {ReturnType<D['collection']>} */
    this.collection = opts.db.collection(this.uniqueName);
    /** @type {ReturnType<D['collection']>} */
    this.lockCollection = opts.db.collection(this.lockCollectionName);
    /** @type {JoSk | undefined} */
    this.joskInstance = undefined; // `void 0` would drop this property from the emitted .d.ts
    /** @internal @type {Promise<void> | null} */
    this.__readyPromise = null;
    this.ready().catch(() => {});
  }

  /**
   * Run setup once; a failed attempt is re-run by the next call.
   * @returns {Promise<void>}
   */
  async ready() {
    if (!this.__readyPromise) {
      this.__readyPromise = this.__setup();
    }

    const attempt = this.__readyPromise;
    try {
      await attempt;
    } catch (setupError) {
      if (this.__readyPromise === attempt) {
        this.__readyPromise = null;
      }
      throw setupError;
    }
  }

  /** @internal */
  async __setup() {
    await ensureIndex(this.collection, { keys: { uid: 1 }, name: 'uid_1', unique: true, dropNonUnique: true }).catch((error) => {
      logError(error, '[setup] [ensureIndex] uid_1');
      throw error;
    });

    await ensureIndex(this.collection, { keys: { isDeleted: 1, executeAt: 1 }, name: 'due_lookup', plain: true }).catch((error) => {
      logError(error, '[setup] [ensureIndex] due_lookup');
      throw error;
    });

    await ensureIndex(this.lockCollection, { keys: { uniqueName: 1 }, name: 'uniqueName_1', unique: true }).catch((error) => {
      logError(error, '[setup] [ensureIndex] uniqueName_1');
      throw error;
    });

    await ensureIndex(this.lockCollection, { keys: { expireAt: 1 }, name: 'expireAt_1', expireAfterSeconds: 1 }).catch((error) => {
      logError(error, '[setup] [ensureIndex] expireAt_1');
      throw error;
    });

    if (this.resetOnInit) {
      await this.collection.deleteMany({});
      await this.lockCollection.deleteMany({
        uniqueName: this.uniqueName
      });
    }
  }

  /**
   * @async
   * @memberOf MongoAdapter
   * @name ping
   * @description Check connection to MongoDB
   * @returns {Promise<AdapterPingResult>}
   */
  async ping() {
    if (!this.joskInstance) {
      const reason = 'JoSk instance not yet assigned to {joskInstance} of Storage Adapter context';
      return {
        status: reason,
        code: 503,
        statusCode: 503,
        error: new Error(reason)
      };
    }

    try {
      await this.ready();
      const ping = await this.db.command({ ping: 1 });
      if (ping?.ok === 1) {
        return {
          status: 'OK',
          code: 200,
          statusCode: 200
        };
      }
    } catch (pingError) {
      return {
        status: 'Internal Server Error',
        code: 500,
        statusCode: 500,
        error: pingError
      };
    }

    return {
      status: 'Service Unavailable',
      code: 503,
      statusCode: 503,
      error: new Error('Service Unavailable')
    };
  }

  /**
   * @param {JoSkLock} lock
   * @returns {Promise<boolean>}
   */
  async acquireLock(lock) {
    await this.ready();

    try {
      const result = await this.lockCollection.updateOne({
        uniqueName: this.uniqueName,
        $or: [
          { expireAt: { $lte: new Date() } },
          { expireAt: { $exists: false } }
        ]
      }, {
        $set: {
          uniqueName: this.uniqueName,
          ownerId: lock.ownerId,
          leaseId: lock.leaseId,
          expireAt: lock.expireAt
        }
      }, {
        upsert: true
      });

      return result.modifiedCount >= 1 || !!result.upsertedCount;
    } catch (opError) {
      if (opError?.code === 11000) {
        return false;
      }

      this.joskInstance.__errorHandler(opError, '[MongoAdapter] [acquireLock] [opError]', 'Exception inside MongoAdapter#acquireLock() method', null);
      return false;
    }
  }

  /**
   * @param {JoSkLock} lock
   * @returns {Promise<void>}
   */
  async releaseLock(lock) {
    await this.ready();
    try {
      await this.lockCollection.deleteOne({
        uniqueName: this.uniqueName,
        ownerId: lock.ownerId,
        leaseId: lock.leaseId
      });
    } catch (releaseError) {
      this.joskInstance.__errorHandler(releaseError, '[MongoAdapter] [releaseLock]', 'Exception inside MongoAdapter#releaseLock() method', null);
    }
  }

  /**
   * @param {string} uid
   * @returns {Promise<boolean>}
   */
  async remove(uid) {
    await this.ready();

    try {
      const result = await this.collection.findOneAndDelete({
        uid,
        isDeleted: false
      }, {
        projection: {
          _id: 1
        }
      });

      const removed = result?._id ? result : result?.value;
      return !!removed?._id;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[MongoAdapter] [remove] [opError]', 'Exception inside MongoAdapter#remove() method', uid);
      return false;
    }
  }

  /**
   * @param {string} uid
   * @param {boolean} isInterval
   * @param {number} delay
   * @returns {Promise<boolean>}
   */
  async add(uid, isInterval, delay) {
    await this.ready();

    try {
      const executeAt = new Date(Date.now() + delay);
      await this.collection.updateOne({
        uid
      }, isInterval ? intervalUpsertPipeline(uid, delay, executeAt) : {
        $set: {
          uid,
          delay,
          executeAt,
          isInterval,
          isDeleted: false
        },
        $unset: { claimLeaseId: '' }
      }, {
        upsert: true
      });
      return true;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[MongoAdapter] [add] [opError]', 'Exception inside MongoAdapter#add() method', uid);
      return false;
    }
  }

  /**
   * Skips the write when `task.claimLeaseId` no longer matches storage.
   * @param {{ uid: string, claimLeaseId?: string }} task
   * @param {Date} nextExecuteAt
   * @returns {Promise<boolean>}
   */
  async update(task, nextExecuteAt) {
    if (typeof task !== 'object' || typeof task.uid !== 'string') {
      this.joskInstance.__errorHandler({ task }, '[MongoAdapter] [update] [task]', 'Task malformed or undefined');
      return false;
    }

    if (!(nextExecuteAt instanceof Date)) {
      this.joskInstance.__errorHandler({ nextExecuteAt }, '[MongoAdapter] [update] [nextExecuteAt]', 'Next execution date is malformed or undefined', task.uid);
      return false;
    }

    await this.ready();

    try {
      const filter = { uid: task.uid, isDeleted: false };
      if (typeof task.claimLeaseId === 'string' && task.claimLeaseId !== '') {
        filter.claimLeaseId = task.claimLeaseId;
      }

      const updateResult = await this.collection.updateOne(filter, {
        $set: { executeAt: nextExecuteAt },
        $unset: { claimLeaseId: '' }
      });
      return (updateResult?.matchedCount || 0) >= 1;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[MongoAdapter] [update] [opError]', 'Exception inside MongoAdapter#update() method', task.uid);
      return false;
    }
  }

  /**
   * @param {Date} nextExecuteAt
   * @param {JoSkLock} lock
   * @param {JoSkExecuteMode} executeMode
   * @returns {Promise<number>}
   */
  async iterate(nextExecuteAt, lock, executeMode) {
    await this.ready();

    let executed = 0;
    if (executeMode === 'one') {
      const task = await this.__claimNextTask(nextExecuteAt, lock);
      if (!task) {
        return executed;
      }

      this.joskInstance.__execute(task);
      return executed + 1;
    }

    // Bounded by the lease expiry so a huge due-batch can't outlive the lock;
    // leftover due tasks are picked up on the next revolution.
    const batchLimit = 100;
    const stopAtMs = lock.expiresAtMs - LEASE_STOP_MARGIN$1;
    while (Date.now() < stopAtMs) {
      const tasks = await this.__claimNextTasks(nextExecuteAt, lock, batchLimit);
      if (tasks.length === 0) {
        break;
      }

      executed += tasks.length;
      for (const task of tasks) {
        this.joskInstance.__execute(task);
      }

      if (tasks.length < batchLimit || this.joskInstance.isDestroyed) {
        break;
      }
    }

    return executed;
  }

  /**
   * @internal
   * @param {Date} nextExecuteAt
   * @param {JoSkLock} lock
   * @returns {Promise<MongoTask | null>}
   */
  async __claimNextTask(nextExecuteAt, lock) {
    try {
      const result = await this.collection.findOneAndUpdate({
        isDeleted: false,
        executeAt: {
          $lte: new Date()
        }
      }, {
        $set: {
          executeAt: nextExecuteAt,
          claimOwnerId: lock.ownerId,
          claimLeaseId: lock.leaseId,
          claimedAt: new Date()
        }
      }, {
        sort: {
          executeAt: 1
        },
        projection: {
          uid: 1,
          delay: 1,
          executeAt: 1,
          isDeleted: 1,
          isInterval: 1
        },
        returnDocument: 'before'
      });

      const task = result?._id ? result : result?.value;
      return task ? { ...task, claimLeaseId: lock.leaseId } : null;
    } catch (mongoError) {
      this.joskInstance.__errorHandler(mongoError, '[MongoAdapter] [iterate] [claim]', 'Exception inside MongoAdapter#__claimNextTask() method', null);
      return null;
    }
  }

  /**
   * @internal
   * @param {Date} nextExecuteAt
   * @param {JoSkLock} lock
   * @param {number} limit
   * @returns {Promise<MongoTask[]>}
   */
  async __claimNextTasks(nextExecuteAt, lock, limit) {
    try {
      const now = new Date();
      const tasks = await this.collection.find({
        isDeleted: false,
        executeAt: {
          $lte: now
        }
      }, {
        sort: {
          executeAt: 1
        },
        limit,
        projection: {
          _id: 1,
          uid: 1,
          delay: 1,
          executeAt: 1,
          isDeleted: 1,
          isInterval: 1
        }
      }).toArray();

      if (tasks.length === 0) {
        return [];
      }

      const claimedAt = new Date();
      const ops = tasks.map((task) => ({
        updateOne: {
          filter: {
            _id: task._id,
            isDeleted: false,
            executeAt: task.executeAt
          },
          update: {
            $set: {
              executeAt: nextExecuteAt,
              claimOwnerId: lock.ownerId,
              claimLeaseId: lock.leaseId,
              claimedAt
            }
          }
        }
      }));

      const result = await this.collection.bulkWrite(ops, {
        ordered: false
      });

      if ((result.modifiedCount || 0) === tasks.length) {
        return tasks.map((task) => ({ ...task, claimLeaseId: lock.leaseId }));
      }

      const claimed = await this.collection.find({
        _id: {
          $in: tasks.map((task) => task._id)
        },
        claimOwnerId: lock.ownerId,
        claimLeaseId: lock.leaseId,
        claimedAt
      }, {
        projection: {
          _id: 1
        }
      }).toArray();
      const claimedIds = new Set(claimed.map((task) => String(task._id)));

      return tasks
        .filter((task) => claimedIds.has(String(task._id)))
        .map((task) => ({ ...task, claimLeaseId: lock.leaseId }));
    } catch (mongoError) {
      this.joskInstance.__errorHandler(mongoError, '[MongoAdapter] [iterate] [batchClaim]', 'Exception inside MongoAdapter#__claimNextTasks() method', null);
      return [];
    }
  }
}

/**
 * @typedef {object} RedisBaseClient
 * @property {(keys: string[]) => Promise<unknown>} del
 * @property {(script: string, options: { keys: string[], arguments: string[] }) => Promise<unknown>} eval
 * @property {(script: string) => Promise<string>} [scriptLoad]
 * @property {(sha: string, options: { keys: string[], arguments: string[] }) => Promise<unknown>} [evalSha]
 * @typedef {object} RedisStandaloneClient
 * @property {(options: { MATCH: string, COUNT: number }) => AsyncIterable<string | string[]>} scanIterator
 * @property {() => Promise<string>} ping
 * @typedef {object} RedisClusterClient
 * @property {readonly unknown[]} masters
 * @property {() => unknown} getRandomNode
 * @property {(...args: never[]) => unknown} nodeClient
 * @property {(firstKey: string, isReadonly: boolean, args: string[]) => Promise<unknown>} [sendCommand]
 * @typedef {RedisBaseClient & (RedisStandaloneClient | RedisClusterClient)} RedisClientLike
 * @typedef {import('../index.js').JoSk} JoSk
 * @typedef {import('../index.js').JoSkExecuteMode} JoSkExecuteMode
 * @typedef {import('../index.js').JoSkLock} JoSkLock
 */

/**
 * @typedef {object} AdapterPingResult
 * @property {string} status
 * @property {number} code
 * @property {number} statusCode
 * @property {unknown} [error]
 */

/**
 * @template {RedisClientLike} [C=RedisClientLike]
 * @typedef {object} RedisAdapterOption
 * @property {C} client
 * @property {string} [prefix]
 * @property {boolean} [resetOnInit]
 * @property {boolean} [useHashTags] - Use Redis Cluster hash-tag keys (`josk:{prefix}:*`). Default keeps existing `josk:prefix:*` keys.
 */

/**
 * @typedef {object} RedisTask
 * @property {string} uid
 * @property {number} delay
 * @property {number} executeAt
 * @property {boolean} isInterval
 * @property {boolean} isDeleted
 * @property {string} [claimLeaseId]
 */

const VALID_PREFIX = /^[A-Za-z0-9_\-:.]+$/;

const ACQUIRE_LOCK_SCRIPT = `
  return redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
`;

const RELEASE_LOCK_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

// Keep a claimed interval's recovery deadline; otherwise keep an unchanged
// interval's earlier schedule. Hash and schedule ZSET get the same value.
const ADD_TASK_SCRIPT = `
  local payload = redis.call('HGET', KEYS[2], ARGV[1])
  local delay = tonumber(ARGV[2])
  local executeAt = tonumber(ARGV[3])
  local isInterval = ARGV[4] == '1'
  local task = payload and cjson.decode(payload) or {
    uid = ARGV[1],
    isDeleted = false
  }

  if payload and task.isDeleted then
    return 0
  end

  local wasClaimed = payload and isInterval and task.isInterval == true
    and type(task.claimLeaseId) == 'string' and task.claimLeaseId ~= ''
    and tonumber(task.executeAt)

  if wasClaimed then
    executeAt = tonumber(task.executeAt)
  elseif payload and isInterval and task.isInterval == true and tonumber(task.delay) == delay then
    local storedExecuteAt = tonumber(task.executeAt)
    if storedExecuteAt and storedExecuteAt < executeAt then
      executeAt = storedExecuteAt
    end
  end

  task.delay = delay
  task.executeAt = executeAt
  task.isInterval = isInterval
  task.isDeleted = false
  if not wasClaimed then
    task.claimLeaseId = nil
  end

  redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(task))
  redis.call('ZADD', KEYS[1], executeAt, ARGV[1])
  return 1
`;

const REMOVE_TASK_SCRIPT = `
  local removed = redis.call('HDEL', KEYS[2], ARGV[1])
  redis.call('ZREM', KEYS[1], ARGV[1])
  return removed
`;

const UPDATE_TASK_SCRIPT = `
  local payload = redis.call('HGET', KEYS[2], ARGV[1])
  if not payload then
    redis.call('ZREM', KEYS[1], ARGV[1])
    return 0
  end

  local task = cjson.decode(payload)
  if task.isDeleted then
    redis.call('HDEL', KEYS[2], ARGV[1])
    redis.call('ZREM', KEYS[1], ARGV[1])
    return 0
  end

  if ARGV[3] and ARGV[3] ~= '' and task.claimLeaseId ~= ARGV[3] then
    return 0
  end

  task.executeAt = tonumber(ARGV[2])
  task.claimLeaseId = nil
  redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(task))
  redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[1])
  return 1
`;

// Returns the pre-claim task payload (executeAt = when the task was due) to
// match the documented adapter contract (docs/adapter-api.md): storage holds
// the post-claim park time, but callers see the original executeAt.
const CLAIM_ONE_TASK_SCRIPT = `
  local now = tonumber(ARGV[1])
  local nextExecuteAt = tonumber(ARGV[2])
  local scanLimit = tonumber(ARGV[5]) or 1000

  for i = 1, scanLimit do
    local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, 1)
    if #due == 0 then
      return nil
    end

    local uid = due[1]
    local payload = redis.call('HGET', KEYS[2], uid)
    if not payload then
      redis.call('ZREM', KEYS[1], uid)
    else
      local task = cjson.decode(payload)
      if task.isDeleted then
        redis.call('HDEL', KEYS[2], uid)
        redis.call('ZREM', KEYS[1], uid)
      elseif tonumber(task.executeAt) > now then
        redis.call('ZADD', KEYS[1], tonumber(task.executeAt), uid)
      else
        local originalExecuteAt = task.executeAt
        task.executeAt = nextExecuteAt
        task.claimOwnerId = ARGV[3]
        task.claimLeaseId = ARGV[4]

        redis.call('HSET', KEYS[2], uid, cjson.encode(task))
        redis.call('ZADD', KEYS[1], nextExecuteAt, uid)

        task.executeAt = originalExecuteAt
        return cjson.encode(task)
      end
    end
  end

  return nil
`;

const CLAIM_BATCH_TASKS_SCRIPT = `
  local now = tonumber(ARGV[1])
  local nextExecuteAt = tonumber(ARGV[2])
  local limit = tonumber(ARGV[5])
  local scanLimit = tonumber(ARGV[6]) or (limit * 20)
  local scanned = 0
  local claimed = {}

  while #claimed < limit and scanned < scanLimit do
    local remaining = math.min(limit - #claimed, scanLimit - scanned)
    local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, remaining)
    if #due == 0 then
      break
    end

    scanned = scanned + #due
    for index, uid in ipairs(due) do
      local payload = redis.call('HGET', KEYS[2], uid)
      if not payload then
        redis.call('ZREM', KEYS[1], uid)
      else
        local task = cjson.decode(payload)
        if task.isDeleted then
          redis.call('HDEL', KEYS[2], uid)
          redis.call('ZREM', KEYS[1], uid)
        elseif tonumber(task.executeAt) > now then
          redis.call('ZADD', KEYS[1], tonumber(task.executeAt), uid)
        else
          local originalExecuteAt = task.executeAt
          task.executeAt = nextExecuteAt
          task.claimOwnerId = ARGV[3]
          task.claimLeaseId = ARGV[4]

          redis.call('HSET', KEYS[2], uid, cjson.encode(task))
          redis.call('ZADD', KEYS[1], nextExecuteAt, uid)

          task.executeAt = originalExecuteAt
          table.insert(claimed, task)
        end

        if #claimed >= limit then
          break
        end
      end
    end
  end

  return cjson.encode(claimed)
`;

const REDIS_BATCH_CLAIM_LIMIT = 100;
const REDIS_SCAN_LIMIT = 2000;
const REDIS_LEASE_STOP_MARGIN = 500;

const sha1Hex = (str) => crypto.createHash('sha1').update(str).digest('hex');

const isNoScriptError = (error) => {
  if (!error) {
    return false;
  }
  const message = typeof error.message === 'string' ? error.message : '';
  return message.indexOf('NOSCRIPT') !== -1 || error.code === 'NOSCRIPT';
};

/**
 * @param {object} client
 * @returns {boolean}
 */
const isClusterClient = (client) => typeof client.nodeClient === 'function' && typeof client.scanIterator !== 'function';

/**
 * Class representing Redis adapter for JoSk
 * @template {RedisClientLike} [C=RedisClientLike]
 */
class RedisAdapter {
  /**
   * Create a RedisAdapter instance
   * @param {RedisAdapterOption<C>} opts - configuration object
   */
  constructor(opts = {}) {
    this.name = 'redis';
    const rawPrefix = typeof opts.prefix === 'string' && opts.prefix.length > 0 ? opts.prefix : 'default';
    if (!VALID_PREFIX.test(rawPrefix)) {
      throw new Error(`{prefix} option for RedisAdapter must match ${VALID_PREFIX} (received: "${rawPrefix}"). Curly braces and other special characters break Redis Cluster hash-tag routing.`);
    }
    this.prefix = rawPrefix;
    if (opts.useHashTags !== undefined && typeof opts.useHashTags !== 'boolean') {
      throw new Error(`{useHashTags} option for RedisAdapter must be a boolean (received: ${typeof opts.useHashTags}).`);
    }
    this.useHashTags = opts.useHashTags === true;
    this.uniqueName = this.useHashTags ? `josk:{${this.prefix}}` : `josk:${this.prefix}`;
    this.lockKey = `${this.uniqueName}:lock`;
    this.scheduleKey = `${this.uniqueName}:schedule`;
    this.tasksKey = `${this.uniqueName}:tasks`;
    this.resetOnInit = !!opts.resetOnInit;

    if (!opts.client) {
      throw new Error('{client} option is required for RedisAdapter', {
        description: 'Redis database requires {client} option, e.g. returned from `redis.createClient()` or `redis.createCluster()` method'
      });
    }

    if (!this.useHashTags && isClusterClient(opts.client)) {
      throw new Error('{useHashTags: true} option is required for RedisAdapter with a Redis Cluster client. Without hash tags, adapter keys land in different slots and every Lua script fails with CROSSSLOT.');
    }

    /** @type {C} */
    this.client = opts.client;
    /** @type {JoSk | undefined} */
    this.joskInstance = undefined; // `void 0` would drop this property from the emitted .d.ts
    /** @internal */
    this.__scriptShas = {
      acquireLock: sha1Hex(ACQUIRE_LOCK_SCRIPT),
      releaseLock: sha1Hex(RELEASE_LOCK_SCRIPT),
      addTask: sha1Hex(ADD_TASK_SCRIPT),
      removeTask: sha1Hex(REMOVE_TASK_SCRIPT),
      updateTask: sha1Hex(UPDATE_TASK_SCRIPT),
      claimOne: sha1Hex(CLAIM_ONE_TASK_SCRIPT),
      claimBatch: sha1Hex(CLAIM_BATCH_TASKS_SCRIPT)
    };
    /** @internal */
    this.__scriptSources = {
      acquireLock: ACQUIRE_LOCK_SCRIPT,
      releaseLock: RELEASE_LOCK_SCRIPT,
      addTask: ADD_TASK_SCRIPT,
      removeTask: REMOVE_TASK_SCRIPT,
      updateTask: UPDATE_TASK_SCRIPT,
      claimOne: CLAIM_ONE_TASK_SCRIPT,
      claimBatch: CLAIM_BATCH_TASKS_SCRIPT
    };
    /** @internal */
    this.__loadedShas = new Set();
    /** @internal @type {Promise<void> | null} */
    this.__readyPromise = null;
    this.ready().catch(() => {});
  }

  /**
   * Run setup once; a failed attempt is re-run by the next call.
   * @returns {Promise<void>}
   */
  async ready() {
    if (!this.__readyPromise) {
      this.__readyPromise = this.__setup();
    }

    const attempt = this.__readyPromise;
    try {
      await attempt;
    } catch (setupError) {
      if (this.__readyPromise === attempt) {
        this.__readyPromise = null;
      }
      throw setupError;
    }
  }

  /** @internal */
  async __setup() {
    if (this.resetOnInit) {
      await this.client.del([this.scheduleKey, this.tasksKey, this.lockKey]);
      const scanClients = isClusterClient(this.client)
        ? await Promise.all(this.client.masters.map((node) => this.client.nodeClient(node)))
        : [this.client];

      for (const scanClient of scanClients) {
        // Legacy v5 per-task keys; a client pool has no SCAN iterator and never wrote them.
        if (typeof scanClient.scanIterator !== 'function') {
          continue;
        }
        const cursor = scanClient.scanIterator({
          MATCH: `${this.uniqueName}:task:*`,
          COUNT: 9999
        });

        for await (const batch of cursor) {
          const keys = Array.isArray(batch) ? batch : [batch];
          if (keys.length) {
            await this.client.del(keys);
          }
        }
      }
    }
  }

  /**
   * @internal
   * @param {keyof RedisAdapter['__scriptShas']} scriptKey
   * @param {{ keys: string[], arguments: string[] }} options
   * @returns {Promise<unknown>}
   */
  async __runScript(scriptKey, options) {
    const sha = this.__scriptShas[scriptKey];
    const source = this.__scriptSources[scriptKey];

    // redis@4 cluster eval()/evalSha() pick the node from the wrong argument
    // and land on a random master. sendCommand() routes by the first key.
    if (isClusterClient(this.client) && typeof this.client.sendCommand === 'function') {
      const firstKey = options.keys[0];
      const args = [`${options.keys.length}`, ...options.keys, ...options.arguments];
      try {
        return await this.client.sendCommand(firstKey, false, ['EVALSHA', sha, ...args]);
      } catch (error) {
        if (!isNoScriptError(error)) {
          throw error;
        }
      }
      return await this.client.sendCommand(firstKey, false, ['EVAL', source, ...args]);
    }

    if (this.__loadedShas.has(sha) && typeof this.client.evalSha === 'function') {
      try {
        return await this.client.evalSha(sha, options);
      } catch (error) {
        if (!isNoScriptError(error)) {
          throw error;
        }
        this.__loadedShas.delete(sha);
      }
    }

    if (typeof this.client.scriptLoad === 'function' && typeof this.client.evalSha === 'function') {
      try {
        await this.client.scriptLoad(source);
        this.__loadedShas.add(sha);
        return await this.client.evalSha(sha, options);
      } catch (error) {
        if (!isNoScriptError(error) && this.joskInstance) {
          // EVAL fallback below will likely re-surface this; emit a debug
          // breadcrumb so operators can correlate cluster-node script-cache
          // problems with the eventual error.
          this.joskInstance._debug(`[RedisAdapter] [__runScript] [${scriptKey}] scriptLoad/evalSha failed, falling back to EVAL:`, error);
        }
      }
    }

    return await this.client.eval(source, options);
  }

  /**
   * @async
   * @memberOf RedisAdapter
   * @name ping
   * @description Check connection to Redis
   * @returns {Promise<AdapterPingResult>}
   */
  async ping() {
    if (!this.joskInstance) {
      const reason = 'JoSk instance not yet assigned to {joskInstance} of Storage Adapter context';
      return {
        status: reason,
        code: 503,
        statusCode: 503,
        error: new Error(reason)
      };
    }

    try {
      await this.ready();
      const pingClient = isClusterClient(this.client)
        ? await this.client.nodeClient(this.client.getRandomNode())
        : this.client;
      const ping = await pingClient.ping();
      if (ping === 'PONG') {
        return {
          status: 'OK',
          code: 200,
          statusCode: 200
        };
      }

      throw new Error(`Unexpected response from Redis#ping received: ${ping}`);
    } catch (pingError) {
      return {
        status: 'Internal Server Error',
        code: 500,
        statusCode: 500,
        error: pingError
      };
    }
  }

  /**
   * @param {JoSkLock} lock
   * @returns {Promise<boolean>}
   */
  async acquireLock(lock) {
    await this.ready();

    // Prefer the relative duration minted with the lock: re-deriving from the
    // absolute deadline re-reads the app clock, and a clock step between
    // __getLock() and here stretches or collapses the lease (see JoSkLock.leaseMs).
    const px = Math.max(1, Number.isFinite(lock.leaseMs) ? lock.leaseMs : (lock.expiresAtMs - Date.now()));
    const res = await this.__runScript('acquireLock', {
      keys: [this.lockKey],
      arguments: [this.__serializeLock(lock), `${px}`]
    });

    return res === 'OK';
  }

  /**
   * @param {JoSkLock} lock
   * @returns {Promise<void>}
   */
  async releaseLock(lock) {
    await this.ready();
    await this.__runScript('releaseLock', {
      keys: [this.lockKey],
      arguments: [this.__serializeLock(lock)]
    });
  }

  /**
   * @param {string} uid
   * @returns {Promise<boolean>}
   */
  async remove(uid) {
    await this.ready();

    try {
      const removed = await this.__runScript('removeTask', {
        keys: [this.scheduleKey, this.tasksKey],
        arguments: [uid]
      });
      return Number(removed) >= 1;
    } catch (removeError) {
      this.joskInstance.__errorHandler(removeError, '[RedisAdapter] [remove] removeError:', 'Exception inside RedisAdapter#remove() method', uid);
      return false;
    }
  }

  /**
   * @param {string} uid
   * @param {boolean} isInterval
   * @param {number} delay
   * @returns {Promise<boolean>}
   */
  async add(uid, isInterval, delay) {
    await this.ready();

    try {
      const next = Date.now() + delay;
      const result = await this.__runScript('addTask', {
        keys: [this.scheduleKey, this.tasksKey],
        arguments: [uid, `${delay}`, `${next}`, isInterval ? '1' : '0']
      });
      return Number(result) >= 1;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[RedisAdapter] [add] [opError]', 'Exception inside RedisAdapter#add() method', uid);
      return false;
    }
  }

  /**
   * Skips the write when `task.claimLeaseId` no longer matches storage.
   * @param {{ uid: string, claimLeaseId?: string }} task
   * @param {Date} nextExecuteAt
   * @returns {Promise<boolean>}
   */
  async update(task, nextExecuteAt) {
    if (typeof task !== 'object' || typeof task.uid !== 'string') {
      this.joskInstance.__errorHandler({ task }, '[RedisAdapter] [update] [task]', 'Task malformed or undefined');
      return false;
    }

    if (!(nextExecuteAt instanceof Date)) {
      this.joskInstance.__errorHandler({ nextExecuteAt }, '[RedisAdapter] [update] [nextExecuteAt]', 'Next execution date is malformed or undefined', task.uid);
      return false;
    }

    await this.ready();

    try {
      const exists = await this.__runScript('updateTask', {
        keys: [this.scheduleKey, this.tasksKey],
        arguments: [task.uid, `${+nextExecuteAt}`, typeof task.claimLeaseId === 'string' ? task.claimLeaseId : '']
      });
      return Number(exists) >= 1;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[RedisAdapter] [update] [opError]', 'Exception inside RedisAdapter#update() method', task.uid);
      return false;
    }
  }

  /**
   * @param {Date} nextExecuteAt
   * @param {JoSkLock} lock
   * @param {JoSkExecuteMode} executeMode
   * @returns {Promise<number>}
   */
  async iterate(nextExecuteAt, lock, executeMode) {
    await this.ready();

    let executed = 0;
    if (executeMode === 'one') {
      const task = await this.__claimNextTask(nextExecuteAt, lock);
      if (!task) {
        return executed;
      }

      this.joskInstance.__execute(task);
      return executed + 1;
    }

    // Bounded by the lease expiry so a huge due-batch can't outlive the lock;
    // leftover due tasks are picked up on the next revolution.
    const stopAtMs = lock.expiresAtMs - REDIS_LEASE_STOP_MARGIN;
    while (Date.now() < stopAtMs) {
      const tasks = await this.__claimNextTasks(nextExecuteAt, lock, REDIS_BATCH_CLAIM_LIMIT);
      if (tasks.length === 0) {
        break;
      }

      executed += tasks.length;
      for (let i = 0; i < tasks.length; i++) {
        this.joskInstance.__execute(tasks[i]);
      }

      if (tasks.length < REDIS_BATCH_CLAIM_LIMIT || this.joskInstance.isDestroyed) {
        break;
      }
    }

    return executed;
  }

  /**
   * @internal
   * @param {Date} nextExecuteAt
   * @param {JoSkLock} lock
   * @returns {Promise<RedisTask | null>}
   */
  async __claimNextTask(nextExecuteAt, lock) {
    try {
      const claimed = await this.__runScript('claimOne', {
        keys: [this.scheduleKey, this.tasksKey],
        arguments: [`${Date.now()}`, `${+nextExecuteAt}`, lock.ownerId, lock.leaseId, `${REDIS_SCAN_LIMIT}`]
      });

      if (!claimed) {
        return null;
      }

      const parsed = JSON.parse(String(claimed));
      return this.__normalizeTask(parsed);
    } catch (iterError) {
      this.joskInstance.__errorHandler(iterError, '[RedisAdapter] [iterate] [claim]', 'Exception inside RedisAdapter#__claimNextTask() method', null);
      return null;
    }
  }

  /**
   * @internal
   * @param {Date} nextExecuteAt
   * @param {JoSkLock} lock
   * @param {number} limit
   * @returns {Promise<RedisTask[]>}
   */
  async __claimNextTasks(nextExecuteAt, lock, limit) {
    try {
      // A park time at or before `now` stays due, and the batch script would
      // claim the same task again until `limit`.
      const now = Date.now();
      const claimed = await this.__runScript('claimBatch', {
        keys: [this.scheduleKey, this.tasksKey],
        arguments: [`${now}`, `${Math.max(+nextExecuteAt, now + 1)}`, lock.ownerId, lock.leaseId, `${limit}`, `${REDIS_SCAN_LIMIT}`]
      });

      if (!claimed) {
        return [];
      }

      const parsed = JSON.parse(String(claimed));
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.map((task) => this.__normalizeTask(task)).filter(Boolean);
    } catch (iterError) {
      this.joskInstance.__errorHandler(iterError, '[RedisAdapter] [iterate] [batchClaim]', 'Exception inside RedisAdapter#__claimNextTasks() method', null);
      return [];
    }
  }

  /**
   * @internal
   * @param {Record<string, unknown>} task
   * @returns {RedisTask | null}
   */
  __normalizeTask(task) {
    if (!task || typeof task.uid !== 'string') {
      return null;
    }

    return /** @type {RedisTask} */ ({
      uid: task.uid,
      delay: +task.delay,
      executeAt: +task.executeAt,
      isInterval: !!task.isInterval,
      isDeleted: !!task.isDeleted,
      ...(typeof task.claimLeaseId === 'string' && task.claimLeaseId !== '' ? { claimLeaseId: task.claimLeaseId } : {})
    });
  }

  /**
   * @internal
   * @param {JoSkLock} lock
   * @returns {string}
   */
  __serializeLock(lock) {
    return JSON.stringify({
      ownerId: lock.ownerId,
      leaseId: lock.leaseId,
      expiresAtMs: lock.expiresAtMs
    });
  }

  /**
   * @internal
   * @param {string} uid
   * @returns {string}
   */
  __getTaskKey(uid) {
    return `${this.uniqueName}:task:${uid}`;
  }
}

/**
 * @typedef {object} PostgresQueryResult
 * @property {number | null | undefined} [rowCount]
 * @property {unknown[]} [rows]
 */

/**
 * Minimal client surface used by PostgresAdapter. The official `pg`
 * package's `Pool` and `Client` both satisfy this shape. Pool is the
 * recommended choice for long-running applications.
 *
 * @typedef {object} PostgresClient
 * @property {(queryText: string, values?: unknown[]) => Promise<PostgresQueryResult>} query
 */

/**
 * @typedef {import('../index.js').JoSk} JoSk
 * @typedef {import('../index.js').JoSkExecuteMode} JoSkExecuteMode
 * @typedef {import('../index.js').JoSkLock} JoSkLock
 */

/**
 * @typedef {object} AdapterPingResult
 * @property {string} status
 * @property {number} code
 * @property {number} statusCode
 * @property {unknown} [error]
 */

/**
 * @typedef {object} PostgresAdapterOption
 * @property {PostgresClient} client
 * @property {string} [prefix]
 * @property {boolean} [resetOnInit]
 */

/**
 * @typedef {object} PostgresTask
 * @property {string} uid
 * @property {string | number} delay
 * @property {string | number} execute_at
 * @property {boolean} is_interval
 * @property {boolean} is_deleted
 */

// Two-key advisory lock: `pg_advisory_lock(int4, int4)` lives in its own
// keyspace, isolated from any single-int callers in the same database. Every
// prefix shares one key because all prefixes share the same tables: concurrent
// `CREATE TABLE IF NOT EXISTS` from two sessions fails with 23505.
// Stop claiming this much before the scheduler lease expires.
const LEASE_STOP_MARGIN = 500;

const ADVISORY_LOCK_NAMESPACE = 0x4A6F536B; // 'JoSk' in ASCII as int32
const ADVISORY_LOCK_KEY = 0;
const SCHEMA_VERSION = 2;

/** Class representing PostgreSQL adapter for JoSk */
class PostgresAdapter {
  /**
   * Create a PostgresAdapter instance
   * @param {PostgresAdapterOption} opts - configuration object
   */
  constructor(opts = {}) {
    this.name = 'postgres';
    this.prefix = typeof opts.prefix === 'string' && opts.prefix.length > 0 ? opts.prefix : 'default';
    this.uniqueName = `josk-${this.prefix}`;
    this.lockKey = `${this.uniqueName}.lock`;
    this.resetOnInit = !!opts.resetOnInit;

    if (!opts.client) {
      throw new Error('{client} option is required for PostgresAdapter', {
        description: 'PostgresAdapter requires {client} option, e.g. new Pool({ connectionString: "..." }) from \'pg\' package'
      });
    }

    /** @type {PostgresClient} */
    this.client = opts.client;
    /** @type {JoSk | undefined} */
    this.joskInstance = undefined; // `void 0` would drop this property from the emitted .d.ts
    /** @internal @type {Promise<void> | null} */
    this.__readyPromise = null;
    this.ready().catch(() => {});
  }

  /**
   * Run setup once; a failed attempt is re-run by the next call.
   * @returns {Promise<void>}
   */
  async ready() {
    if (!this.__readyPromise) {
      this.__readyPromise = this.__setup();
    }

    const attempt = this.__readyPromise;
    try {
      await attempt;
    } catch (setupError) {
      if (this.__readyPromise === attempt) {
        this.__readyPromise = null;
      }
      throw setupError;
    }
  }

  /** @internal */
  async __setup() {
    // The advisory lock and the DDL must share one session. `pg.Pool` rotates
    // connections per query, so pin one client; `pg.Client` is one session.
    const isPool = typeof this.client.connect === 'function' && typeof this.client.totalCount === 'number';
    const setupClient = isPool ? await this.client.connect() : this.client;

    try {
      await setupClient.query('BEGIN');
      try {
        // Transaction-scoped: released by COMMIT/ROLLBACK, so it can not leak
        // and it works behind transaction-pooling PgBouncer.
        await setupClient.query('SELECT pg_advisory_xact_lock($1, $2)', [ADVISORY_LOCK_NAMESPACE, ADVISORY_LOCK_KEY]);
        await this.__migrate(setupClient);
        await setupClient.query('COMMIT');
      } catch (setupError) {
        await setupClient.query('ROLLBACK').catch(() => {});
        throw setupError;
      }
    } finally {
      if (isPool) {
        setupClient.release();
      }
    }
  }

  /**
   * Create or upgrade the shared tables. Runs inside the setup transaction.
   * @internal
   * @param {PostgresClient} client
   * @returns {Promise<void>}
   */
  async __migrate(client) {
    await client.query(`
      CREATE TABLE IF NOT EXISTS josk_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    const versionResult = await client.query(
      `SELECT value FROM josk_meta WHERE key = 'schema_version'`
    );
    const currentVersion = versionResult.rows && versionResult.rows[0]
      ? parseInt(versionResult.rows[0].value, 10)
      : 0;

    // Tables and indexes are re-checked on every boot, independent of the
    // recorded schema version, so a dropped table is recreated.
    await client.query(`
      CREATE TABLE IF NOT EXISTS josk_tasks (
        prefix TEXT NOT NULL DEFAULT 'default',
        uid TEXT NOT NULL,
        delay BIGINT NOT NULL,
        execute_at BIGINT NOT NULL,
        is_interval BOOLEAN NOT NULL DEFAULT false,
        is_deleted BOOLEAN NOT NULL DEFAULT false,
        claim_owner_id TEXT,
        claim_lease_id TEXT,
        claimed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (prefix, uid)
      )
    `);

    if (currentVersion < 1) {
      await client.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS prefix TEXT NOT NULL DEFAULT 'default'`);
      await client.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS uid TEXT NOT NULL DEFAULT ''`);
      await client.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS delay BIGINT NOT NULL DEFAULT 0`);
      await client.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS execute_at BIGINT NOT NULL DEFAULT 0`);
      await client.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS is_interval BOOLEAN NOT NULL DEFAULT false`);
      await client.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false`);
      await client.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS claim_owner_id TEXT`);
      await client.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS claim_lease_id TEXT`);
      await client.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`);
      await client.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`);
      await client.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`);

      const primaryKeyResult = await client.query(`
        SELECT kc.column_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kc
          ON tc.constraint_name = kc.constraint_name
         AND tc.table_schema = kc.table_schema
        WHERE tc.table_name = 'josk_tasks'
          AND tc.constraint_type = 'PRIMARY KEY'
        ORDER BY kc.ordinal_position ASC
      `);
      const primaryKeyColumns = (primaryKeyResult.rows || []).map((row) => row.column_name);

      // A failed statement aborts the setup transaction, so check before altering.
      const primaryKey = primaryKeyColumns.join(',');
      if (primaryKey === 'uid') {
        await client.query(`ALTER TABLE josk_tasks DROP CONSTRAINT IF EXISTS josk_tasks_pkey`);
      }

      if (primaryKey !== 'prefix,uid') {
        await client.query(`
          ALTER TABLE josk_tasks
          ADD CONSTRAINT josk_tasks_pkey PRIMARY KEY (prefix, uid)
        `);
      }
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_josk_tasks_prefix_execute
      ON josk_tasks (prefix, execute_at)
      WHERE is_deleted = false
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS josk_locks (
        lock_key TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        lease_id TEXT NOT NULL,
        locked_until BIGINT NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `);

    if (currentVersion < 1) {
      await client.query(`ALTER TABLE josk_locks ADD COLUMN IF NOT EXISTS owner_id TEXT`);
      await client.query(`ALTER TABLE josk_locks ADD COLUMN IF NOT EXISTS lease_id TEXT`);
      await client.query(`ALTER TABLE josk_locks ADD COLUMN IF NOT EXISTS locked_until BIGINT`);
      await client.query(`ALTER TABLE josk_locks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`);
      await client.query(`UPDATE josk_locks SET owner_id = COALESCE(owner_id, ''), lease_id = COALESCE(lease_id, ''), locked_until = COALESCE(locked_until, 0) WHERE owner_id IS NULL OR lease_id IS NULL OR locked_until IS NULL`);
      await client.query(`ALTER TABLE josk_locks ALTER COLUMN owner_id SET NOT NULL`);
      await client.query(`ALTER TABLE josk_locks ALTER COLUMN lease_id SET NOT NULL`);
      await client.query(`ALTER TABLE josk_locks ALTER COLUMN locked_until SET NOT NULL`);
    }

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_josk_locks_locked_until
      ON josk_locks (locked_until)
    `);

    if (currentVersion < 2) {
      // Widen `delay` from INTEGER (int4 max ~2147483647ms ≈ 24.8 days) to BIGINT;
      // longer delays/intervals overflowed int4 and silently failed to store. No-op on fresh installs.
      await client.query(`ALTER TABLE josk_tasks ALTER COLUMN delay TYPE BIGINT`);
    }

    if (currentVersion < SCHEMA_VERSION) {
      await client.query(
        `INSERT INTO josk_meta (key, value) VALUES ('schema_version', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [String(SCHEMA_VERSION)]
      );
    }

    if (this.resetOnInit) {
      await client.query('DELETE FROM josk_tasks WHERE prefix = $1', [this.prefix]);
      await client.query('DELETE FROM josk_locks WHERE lock_key = $1', [this.lockKey]);
    }
  }

  /**
   * @async
   * @memberOf PostgresAdapter
   * @name ping
   * @description Check connection to PostgreSQL
   * @returns {Promise<AdapterPingResult>}
   */
  async ping() {
    if (!this.joskInstance) {
      const reason = 'JoSk instance not yet assigned to {joskInstance} of Storage Adapter context';
      return {
        status: reason,
        code: 503,
        statusCode: 503,
        error: new Error(reason)
      };
    }

    try {
      await this.ready();
      const res = await this.client.query('SELECT 1 as ping');
      if (res.rows && res.rows[0] && res.rows[0].ping === 1) {
        return {
          status: 'OK',
          code: 200,
          statusCode: 200
        };
      }
      throw new Error(`Unexpected response from Postgres#ping received: ${JSON.stringify(res.rows)}`);
    } catch (pingError) {
      return {
        status: 'Internal Server Error',
        code: 500,
        statusCode: 500,
        error: pingError
      };
    }
  }

  /**
   * Acquire scheduler lease using PostgreSQL server time so the lock is
   * resistant to client-side clock skew between distributed nodes.
   * @param {JoSkLock} lock
   * @returns {Promise<boolean>}
   */
  async acquireLock(lock) {
    await this.ready();

    try {
      // Prefer the relative duration minted with the lock: re-deriving from the
      // absolute deadline re-reads the app clock, and a clock step between
      // __getLock() and here stretches or collapses the lease (see JoSkLock.leaseMs).
      const leaseDuration = Math.max(1, Number.isFinite(lock.leaseMs) ? lock.leaseMs : (lock.expiresAtMs - Date.now()));
      const res = await this.client.query(
        `INSERT INTO josk_locks (lock_key, owner_id, lease_id, locked_until)
         VALUES ($1, $2, $3, (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::BIGINT + $4)
         ON CONFLICT (lock_key) DO UPDATE
           SET owner_id = EXCLUDED.owner_id,
               lease_id = EXCLUDED.lease_id,
               locked_until = EXCLUDED.locked_until,
               updated_at = CURRENT_TIMESTAMP
         WHERE josk_locks.locked_until <= (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::BIGINT
         RETURNING lease_id`,
        [this.lockKey, lock.ownerId, lock.leaseId, leaseDuration]
      );
      return (res.rowCount || 0) >= 1;
    } catch (lockError) {
      this.joskInstance.__errorHandler(lockError, '[PostgresAdapter] [acquireLock]', 'Failed to acquire lock', null);
      return false;
    }
  }

  /**
   * @param {JoSkLock} lock
   * @returns {Promise<void>}
   */
  async releaseLock(lock) {
    await this.ready();

    try {
      await this.client.query(
        `DELETE FROM josk_locks
         WHERE lock_key = $1
           AND owner_id = $2
           AND lease_id = $3`,
        [this.lockKey, lock.ownerId, lock.leaseId]
      );
    } catch (releaseError) {
      this.joskInstance.__errorHandler(releaseError, '[PostgresAdapter] [releaseLock]', 'Exception inside PostgresAdapter#releaseLock() method', null);
    }
  }

  /**
   * @param {string} uid
   * @returns {Promise<boolean>}
   */
  async remove(uid) {
    await this.ready();

    try {
      const res = await this.client.query(
        `DELETE FROM josk_tasks
         WHERE prefix = $1
           AND uid = $2
         RETURNING uid`,
        [this.prefix, uid]
      );
      return (res.rowCount || 0) >= 1;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[PostgresAdapter] [remove]', 'Exception inside remove method', uid);
      return false;
    }
  }

  /**
   * @param {string} uid
   * @param {boolean} isInterval
   * @param {number} delay
   * @returns {Promise<boolean>}
   */
  async add(uid, isInterval, delay) {
    await this.ready();

    try {
      // Preserve claimed intervals until their recovery deadline; otherwise
      // keep unchanged intervals' earlier schedule. SET reads the old row.
      const res = await this.client.query(
        `INSERT INTO josk_tasks (prefix, uid, delay, execute_at, is_interval, is_deleted, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (prefix, uid) DO UPDATE SET
           delay = EXCLUDED.delay,
           execute_at = CASE
             WHEN EXCLUDED.is_interval = true
              AND josk_tasks.is_interval = true
              AND josk_tasks.is_deleted = false
              AND josk_tasks.claim_lease_id IS NOT NULL
              AND josk_tasks.claim_lease_id <> ''
             THEN josk_tasks.execute_at
             WHEN EXCLUDED.is_interval = true
              AND josk_tasks.is_interval = true
              AND josk_tasks.is_deleted = false
              AND josk_tasks.delay = EXCLUDED.delay
              AND josk_tasks.execute_at < EXCLUDED.execute_at
             THEN josk_tasks.execute_at
             ELSE EXCLUDED.execute_at
           END,
           claim_lease_id = CASE
             WHEN EXCLUDED.is_interval = true
              AND josk_tasks.is_interval = true
              AND josk_tasks.is_deleted = false
              AND josk_tasks.claim_lease_id IS NOT NULL
              AND josk_tasks.claim_lease_id <> ''
             THEN josk_tasks.claim_lease_id
             ELSE NULL
           END,
           is_interval = EXCLUDED.is_interval,
           is_deleted = false,
           updated_at = CURRENT_TIMESTAMP
         RETURNING uid`,
        [this.prefix, uid, delay, Date.now() + delay, isInterval]
      );
      return (res.rowCount || 0) >= 1;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[PostgresAdapter] [add]', 'Exception inside add method', uid);
      return false;
    }
  }

  /**
   * Skips the write when `task.claimLeaseId` no longer matches storage.
   * @param {{ uid: string, claimLeaseId?: string }} task
   * @param {Date} nextExecuteAt
   * @returns {Promise<boolean>}
   */
  async update(task, nextExecuteAt) {
    if (typeof task !== 'object' || typeof task.uid !== 'string') {
      this.joskInstance.__errorHandler({ task }, '[PostgresAdapter] [update] [task]', 'Task malformed or undefined');
      return false;
    }

    if (!(nextExecuteAt instanceof Date)) {
      this.joskInstance.__errorHandler({ nextExecuteAt }, '[PostgresAdapter] [update] [nextExecuteAt]', 'Next execution date is malformed or undefined', task.uid);
      return false;
    }

    await this.ready();

    try {
      const res = await this.client.query(
        `UPDATE josk_tasks
         SET execute_at = $1,
             claim_lease_id = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE prefix = $2
           AND uid = $3
           AND is_deleted = false
           AND ($4::text IS NULL OR claim_lease_id = $4::text)
         RETURNING uid`,
        [+nextExecuteAt, this.prefix, task.uid, typeof task.claimLeaseId === 'string' && task.claimLeaseId !== '' ? task.claimLeaseId : null]
      );
      return (res.rowCount || 0) >= 1;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[PostgresAdapter] [update] [opError]', 'Exception inside update method', task.uid);
      return false;
    }
  }

  /**
   * @param {Date} nextExecuteAt
   * @param {JoSkLock} lock
   * @param {JoSkExecuteMode} executeMode
   * @returns {Promise<number>}
   */
  async iterate(nextExecuteAt, lock, executeMode) {
    await this.ready();

    let executed = 0;
    if (executeMode === 'one') {
      const task = await this.__claimNextTask(nextExecuteAt, lock);
      if (!task) {
        return executed;
      }

      this.joskInstance.__execute({
        uid: task.uid,
        delay: parseInt(task.delay, 10),
        executeAt: parseInt(task.execute_at, 10),
        isInterval: task.is_interval,
        isDeleted: task.is_deleted,
        claimLeaseId: lock.leaseId
      });

      return executed + 1;
    }

    // Bounded by the lease expiry so a huge due-batch can't outlive the lock;
    // leftover due tasks are picked up on the next revolution.
    const batchLimit = 100;
    const stopAtMs = lock.expiresAtMs - LEASE_STOP_MARGIN;
    while (Date.now() < stopAtMs) {
      const tasks = await this.__claimNextTasks(nextExecuteAt, lock, batchLimit);
      if (tasks.length === 0) {
        break;
      }

      executed += tasks.length;
      for (const task of tasks) {
        this.joskInstance.__execute({
          uid: task.uid,
          delay: parseInt(task.delay, 10),
          executeAt: parseInt(task.execute_at, 10),
          isInterval: task.is_interval,
          isDeleted: task.is_deleted,
          claimLeaseId: lock.leaseId
        });
      }

      if (tasks.length < batchLimit || this.joskInstance.isDestroyed) {
        break;
      }
    }

    return executed;
  }

  /**
   * @internal
   * @param {Date} nextExecuteAt
   * @param {JoSkLock} lock
   * @returns {Promise<PostgresTask | null>}
   */
  async __claimNextTask(nextExecuteAt, lock) {
    try {
      const res = await this.client.query(
        `WITH due AS (
           SELECT prefix, uid, delay, execute_at, is_interval, is_deleted
           FROM josk_tasks
           WHERE prefix = $1
             AND is_deleted = false
             AND execute_at <= $2
           ORDER BY execute_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE josk_tasks AS task
         SET execute_at = $3,
             claim_owner_id = $4,
             claim_lease_id = $5,
             claimed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         FROM due
         WHERE task.prefix = due.prefix
           AND task.uid = due.uid
         RETURNING due.uid, due.delay, due.execute_at, due.is_interval, due.is_deleted`,
        [this.prefix, Date.now(), +nextExecuteAt, lock.ownerId, lock.leaseId]
      );

      return /** @type {PostgresTask | null} */ ((res.rows && res.rows[0]) || null);
    } catch (iterError) {
      this.joskInstance.__errorHandler(iterError, '[PostgresAdapter] [iterate] [claim]', 'Exception inside PostgresAdapter#__claimNextTask() method', null);
      return null;
    }
  }

  /**
   * @internal
   * @param {Date} nextExecuteAt
   * @param {JoSkLock} lock
   * @param {number} limit
   * @returns {Promise<PostgresTask[]>}
   */
  async __claimNextTasks(nextExecuteAt, lock, limit) {
    try {
      const res = await this.client.query(
        `WITH due AS (
           SELECT prefix, uid, delay, execute_at, is_interval, is_deleted
           FROM josk_tasks
           WHERE prefix = $1
             AND is_deleted = false
             AND execute_at <= $2
           ORDER BY execute_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $6
         ),
         updated AS (
           UPDATE josk_tasks AS task
           SET execute_at = $3,
               claim_owner_id = $4,
               claim_lease_id = $5,
               claimed_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           FROM due
           WHERE task.prefix = due.prefix
             AND task.uid = due.uid
           RETURNING due.uid, due.delay, due.execute_at, due.is_interval, due.is_deleted
         )
         SELECT uid, delay, execute_at, is_interval, is_deleted
         FROM updated
         ORDER BY execute_at ASC`,
        [this.prefix, Date.now(), +nextExecuteAt, lock.ownerId, lock.leaseId, limit]
      );

      return /** @type {PostgresTask[]} */ (res.rows || []);
    } catch (iterError) {
      this.joskInstance.__errorHandler(iterError, '[PostgresAdapter] [iterate] [batchClaim]', 'Exception inside PostgresAdapter#__claimNextTasks() method', null);
      return [];
    }
  }
}

const prefixRegex = /set(Immediate|Timeout|Interval)$/;
const validExecuteModes = new Set(['batch', 'one']);
// Failed adapter initialization is retried no sooner than this.
const ADAPTER_RETRY_DELAY = 5000;
// A claim taken by a paused instance is handed back due this soon, so a peer
// picks it up on its next polls instead of after the task's full `delay`.
const PAUSED_CLAIM_DEFER = 2000;

const createRandomId = typeof crypto.randomUUID === 'function' ? () => crypto.randomUUID() : () => crypto.randomBytes(16).toString('hex');
const isPromiseLike = (value) => {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
};
const isValidDelay = (delay) => typeof delay === 'number' && Number.isFinite(delay) && delay >= 0;

/**
 * @typedef {object} JoSkPingResult
 * @property {string} status
 * @property {number} code
 * @property {number} statusCode
 * @property {unknown} [error]
 */

/**
 * @typedef {object} JoSkErrorDetails
 * @property {string} description
 * @property {unknown} error
 * @property {string | null} uid
 * @property {unknown} [task]
 */

/**
 * @typedef {object} JoSkExecutedDetails
 * @property {string} uid
 * @property {Date} date
 * @property {number} delay
 * @property {number} timestamp
 */

/**
 * @typedef {object} JoSkTask
 * @property {string} uid
 * @property {number} delay
 * @property {boolean} isInterval
 * @property {boolean} isDeleted
 * @property {Date | number} [executeAt]
 * @property {string} [claimLeaseId] Lease written by the claim; adapters fence `update()` on it when present
 */

/**
 * @typedef {'batch' | 'one'} JoSkExecuteMode
 */

/**
 * @typedef {object} JoSkLock
 * @property {string} ownerId
 * @property {string} leaseId
 * @property {Date} expireAt
 * @property {number} expiresAtMs
 * @property {number} [leaseMs] Relative lease duration (ms) captured at mint time; adapters MUST prefer this over re-deriving a duration from `expiresAtMs - Date.now()`, which re-reads the app clock and is distorted by clock steps between mint and acquire
 */

/**
 * @callback JoSkOnError
 * @param {string} title
 * @param {JoSkErrorDetails} details
 * @returns {void | PromiseLike<void>}
 */

/**
 * @callback JoSkOnExecuted
 * @param {string} uid
 * @param {JoSkExecutedDetails} details
 * @returns {void | PromiseLike<void>}
 */

/**
 * @callback JoSkReadyCallback
 * @param {Error | undefined} error
 * @param {boolean} success
 * @returns {void}
 */

/**
 * @callback JoSkReady
 * @param {Date | number | JoSkReadyCallback} [nextExecuteAt]
 * @returns {Promise<boolean>}
 */

/**
 * @callback JoSkTaskHandler
 * @param {JoSkReady} ready
 * @returns {void | PromiseLike<unknown>}
 */

/**
 * @typedef {JoSkTaskHandler & { isMissing?: boolean }} JoSkStoredTask
 */

/**
 * @typedef {object} JoSkAdapter
 * @property {JoSk | undefined} [joskInstance]
 * @property {(lock: JoSkLock) => Promise<boolean>} acquireLock
 * @property {(lock: JoSkLock) => Promise<void>} releaseLock
 * @property {(uid: string) => Promise<boolean>} remove
 * @property {(uid: string, isInterval: boolean, delay: number) => Promise<boolean | void>} add
 * @property {(task: JoSkTask, nextExecuteAt: Date) => Promise<boolean>} update
 * @property {(nextExecuteAt: Date, lock: JoSkLock, executeMode: JoSkExecuteMode) => Promise<number | void>} iterate
 * @property {() => Promise<JoSkPingResult>} ping
 * @property {() => Promise<void>} [ready]
 */

/**
 * @typedef {object} JoSkOption
 * @property {JoSkAdapter} adapter
 * @property {boolean} [debug]
 * @property {JoSkOnError} [onError]
 * @property {boolean} [autoClear]
 * @property {number} [zombieTime]
 * @property {number} [lockLeaseTime]
 * @property {JoSkOnExecuted} [onExecuted]
 * @property {number} [minRevolvingDelay]
 * @property {number} [maxRevolvingDelay]
 * @property {JoSkExecuteMode} [execute]
 * @property {string} [lockOwnerId]
 * @property {number} [concurrency]
 */

/**
 * Adapter option and client types, re-exported for consumers that build
 * configuration objects before constructing an adapter.
 * @typedef {import('./adapters/redis.js').RedisClientLike} RedisClientLike
 * @typedef {import('./adapters/mongo.js').MongoDbLike} MongoDbLike
 * @typedef {import('./adapters/postgres.js').PostgresClient} PostgresClient
 * @typedef {import('./adapters/postgres.js').PostgresAdapterOption} PostgresAdapterOption
 */

/**
 * @template {RedisClientLike} [C=RedisClientLike]
 * @typedef {import('./adapters/redis.js').RedisAdapterOption<C>} RedisAdapterOption
 */

/**
 * @template {MongoDbLike} [D=MongoDbLike]
 * @typedef {import('./adapters/mongo.js').MongoAdapterOption<D>} MongoAdapterOption
 */

/**
 * @typedef {object} JoSkShutdownOption
 * @property {number} [timeout] Milliseconds to wait for running handlers to call `ready()`. Default: `10000`
 */

const errors = {
  execute: '[josk] [execute] option must be either "batch" or "one"!',
  concurrency: '[josk] [concurrency] option must be a positive integer or Infinity',
  lockLeaseTime: '[josk] [lockLeaseTime] option must be a positive finite Number',
  shutdownTimeout: '[josk] [shutdown] timeout option must be a finite non-negative Number',
  setInterval: {
    func: '[josk] [setInterval] the first argument must be a function!',
    delay: '[josk] [setInterval] delay must be a finite non-negative Number!',
    uid: '[josk] [setInterval] uid (3rd argument) must be a string'
  },
  setTimeout: {
    func: '[josk] [setTimeout] the first argument must be a function!',
    delay: '[josk] [setTimeout] delay must be a finite non-negative Number!',
    uid: '[josk] [setTimeout] uid (3rd argument) must be a string'
  },
  setImmediate: {
    func: '[josk] [setImmediate] the first argument must be a function!',
    uid: '[josk] [setImmediate] uid (2nd argument) must be a string'
  }
};

/** Class representing a JoSk task runner (cron). */
class JoSk {
  /**
   * Create a JoSk instance
   * @param {JoSkOption} opts - configuration object
   */
  constructor(opts = {}) {
    this.debug = opts.debug || false;
    this.onError = opts.onError || false;
    this.autoClear = opts.autoClear || false;
    this.zombieTime = opts.zombieTime || 900000;
    this.onExecuted = opts.onExecuted || false;
    this.isDestroyed = false;
    this.minRevolvingDelay = opts.minRevolvingDelay || 128;
    this.maxRevolvingDelay = opts.maxRevolvingDelay || 768;
    this.execute = opts.execute || 'batch';
    this.lockOwnerId = typeof opts.lockOwnerId === 'string' && opts.lockOwnerId.length > 0 ? opts.lockOwnerId : `josk-${createRandomId()}`;

    if (opts.lockLeaseTime !== void 0 && (typeof opts.lockLeaseTime !== 'number' || !Number.isFinite(opts.lockLeaseTime) || opts.lockLeaseTime <= 0)) {
      throw new Error(errors.lockLeaseTime);
    }
    // Redis `PX` and Postgres BIGINT reject a fractional lease.
    this.lockLeaseTime = Math.ceil(Math.max(opts.lockLeaseTime || Math.min(this.zombieTime, 30000), (2 * this.maxRevolvingDelay) + 1000));

    if (opts.concurrency !== void 0) {
      if (opts.concurrency !== Infinity && (!Number.isInteger(opts.concurrency) || opts.concurrency < 1)) {
        throw new Error(errors.concurrency);
      }
      this.concurrency = opts.concurrency;
    } else {
      this.concurrency = Infinity;
    }

    /** @internal */
    this.nextRevolutionTimeout = null;
    /** @internal */
    this.__lockLeaseCounter = 0;
    /** @internal @type {Promise<void> | null} */
    this.__adapterReadyPromise = null;
    /** @internal */
    this.__adapterReadyError = null;
    /** @internal */
    this.__adapterRetryAt = 0;
    /** @internal */
    this.__activeExecutions = 0;
    /** @internal */
    this.__pendingTasks = [];
    /** @internal */
    this.__pausedAll = false;
    /** @internal @type {Set<string>} */
    this.__pausedTimerIds = new Set();
    /** @internal @type {Map<string, { task: JoSkTask, released: boolean, superseded: boolean, settle: () => void, done: Promise<void> }>} */
    this.__inFlight = new Map();
    /** @internal @type {Map<string, { task: JoSkTask, released: boolean, superseded: boolean, settle: () => void, done: Promise<void> }>} */
    this.__superseded = new Map();
    /** @internal @type {Promise<boolean> | null} */
    this.__shutdownPromise = null;
    /** @internal @type {Set<{ task: JoSkTask, released: boolean, superseded: boolean, settle: () => void, done: Promise<void> }>} */
    this.__running = new Set();
    /** @internal */
    this.__warnedMissingClaimLeaseId = false;
    /** @internal @type {JoSkTask[]} */
    this.__releaseQueue = [];
    /** @internal @type {Set<Promise<void>>} */
    this.__releasing = new Set();
    /** @internal */
    this.__iterating = false;
    /** @internal */
    this.__nudgePending = false;
    /** @internal @type {Promise<void> | null} */
    this.__iteratePromise = null;

    if (!validExecuteModes.has(this.execute)) {
      throw new Error(errors.execute);
    }

    if (!opts.adapter || typeof opts.adapter !== 'object') {
      throw new Error('{adapter} option is required for JoSk', {
        description: 'JoSk requires MongoAdapter, RedisAdapter, PostgresAdapter, or CustomAdapter to connect to an intermediate database'
      });
    }

    /**
     * @type {Record<string, JoSkStoredTask>}
     * @internal
     */
    this.tasks = {};

    /** @internal */
    this._debug = (...args) => {
      this.debug === true && console.info.call(console, '[DEBUG] [josk]', ...args);
    };

    /** @type {JoSkAdapter} */
    this.adapter = opts.adapter;
    this.adapter.joskInstance = this;
    const adapterMethods = ['acquireLock', 'releaseLock', 'remove', 'add', 'update', 'iterate', 'ping'];

    for (let i = adapterMethods.length - 1; i >= 0; i--) {
      if (typeof this.adapter[adapterMethods[i]] !== 'function') {
        throw new Error(`{adapter} instance is missing {${adapterMethods[i]}} method that is required!`);
      }
    }

    this.__tick();
  }

  /**
   * @async
   * @memberOf JoSk
   * @name ping
   * @description Check package readiness and connection to Storage
   * @returns {Promise<JoSkPingResult>}
   */
  async ping() {
    try {
      await this.__adapterReady();
    } catch (readyError) {
      return {
        status: 'Internal Server Error',
        code: 500,
        statusCode: 500,
        error: readyError
      };
    }
    return await this.adapter.ping();
  }

  /**
   * @async
   * @memberOf JoSk
   * Create recurring task (loop). Re-registering a stored task with the same
   * `delay` (e.g. on process boot) keeps its next run when that is earlier than
   * `now + delay`; otherwise the next run is `now + delay`. A task another
   * instance is running keeps its `zombieTime` hold.
   * @name setInterval
   * @param {JoSkTaskHandler} func - Function (task) to execute
   * @param {number} delay - Delay between task execution in milliseconds
   * @param {string} uid - Unique function (task) identification as a string
   * @returns {Promise<string>} - Timer ID
   */
  async setInterval(func, delay, uid) {
    if (this.__checkState()) {
      return '';
    }

    if (typeof func !== 'function') {
      throw new Error(errors.setInterval.func);
    }

    if (!isValidDelay(delay)) {
      throw new Error(errors.setInterval.delay);
    }

    if (typeof uid !== 'string') {
      throw new Error(errors.setInterval.uid);
    }

    const timerId = `${uid}setInterval`;
    this.tasks[timerId] = func;
    await this.__add(timerId, true, delay);
    return timerId;
  }

  /**
   * @async
   * @memberOf JoSk
   * Create delayed task. Executes at-most-once across the cluster: the task
   * is removed from storage before the handler runs, so a crash between
   * removal and completion drops the run.
   * @name setTimeout
   * @param {JoSkTaskHandler} func - Function (task) to execute
   * @param {number} delay - Delay before task execution in milliseconds
   * @param {string} uid - Unique function (task) identification as a string
   * @returns {Promise<string>} - Timer ID
   */
  async setTimeout(func, delay, uid) {
    if (this.__checkState()) {
      return '';
    }

    if (typeof func !== 'function') {
      throw new Error(errors.setTimeout.func);
    }

    if (!isValidDelay(delay)) {
      throw new Error(errors.setTimeout.delay);
    }

    if (typeof uid !== 'string') {
      throw new Error(errors.setTimeout.uid);
    }

    const timerId = `${uid}setTimeout`;
    this.tasks[timerId] = func;
    await this.__add(timerId, false, delay);
    return timerId;
  }

  /**
   * @async
   * @memberOf JoSk
   * Create one-shot task that runs as soon as the next scheduler tick claims it.
   * Executes at-most-once across the cluster: the task is removed from storage
   * before the handler runs, so a crash between removal and completion drops the run.
   * @name setImmediate
   * @param {JoSkTaskHandler} func - Function (task) to execute
   * @param {string} uid - Unique function (task) identification as a string
   * @returns {Promise<string>} - Timer ID
   */
  async setImmediate(func, uid) {
    if (this.__checkState()) {
      return '';
    }

    if (typeof func !== 'function') {
      throw new Error(errors.setImmediate.func);
    }

    if (typeof uid !== 'string') {
      throw new Error(errors.setImmediate.uid);
    }

    const timerId = `${uid}setImmediate`;
    this.tasks[timerId] = func;
    await this.__add(timerId, false, 0);
    return timerId;
  }

  /**
   * @async
   * @memberOf JoSk
   * Cancel (abort) current interval timer.
   * Must be called in a separate event loop from `.setInterval()`
   * @name clearInterval
   * @param {string|Promise<string>} timerId - Unique function (task) identification as a string, returned from `.setInterval()`
   * @returns {Promise<boolean>} - `true` if task cleared, `false` if task doesn't exist
   */
  async clearInterval(timerId) {
    if (typeof timerId === 'object' && timerId instanceof Promise) {
      return await this.__remove(await timerId);
    }
    return await this.__remove(timerId);
  }

  /**
   * @async
   * @memberOf JoSk
   * Cancel (abort) current timeout timer.
   * Must be called in a separate event loop from `.setTimeout()`
   * @name clearTimeout
   * @param {string|Promise<string>} timerId - Unique function (task) identification as a string, returned from `.setTimeout()`
   * @returns {Promise<boolean>} - `true` if task cleared, `false` if task doesn't exist
   */
  async clearTimeout(timerId) {
    if (typeof timerId === 'object' && timerId instanceof Promise) {
      return await this.__remove(await timerId);
    }
    return await this.__remove(timerId);
  }

  /**
   * @memberOf JoSk
   * Destroy JoSk instance and stop all tasks
   * @name destroy
   * @returns {boolean} - `true` if instance successfully destroyed, `false` if instance already destroyed
   */
  destroy() {
    if (!this.isDestroyed) {
      this.isDestroyed = true;
      this.__pausedAll = false;
      this.__pausedTimerIds.clear();
      if (this.nextRevolutionTimeout) {
        clearTimeout(this.nextRevolutionTimeout);
        this.nextRevolutionTimeout = null;
      }

      const pending = this.__pendingTasks.splice(0);
      for (const entry of pending) {
        this.__queueRelease(entry.task);
        entry.resolve();
      }
      return true;
    }
    return false;
  }

  /**
   * @async
   * @memberOf JoSk
   * Destroy the instance, wait for running handlers to call `ready()`, then
   * hand unfinished interval claims back to storage so another instance can
   * run them without waiting for `zombieTime`. Report unfinished runs at timeout;
   * abandon one-shot tasks to preserve at-most-once execution. Repeated calls
   * share the first attempt and its timeout. Call before exit.
   * @name shutdown
   * @param {JoSkShutdownOption} [opts]
   * @returns {Promise<boolean>} - `true` if every running handler finished within `timeout`
   */
  async shutdown(opts = {}) {
    const timeout = opts.timeout === void 0 ? 10000 : opts.timeout;
    if (!isValidDelay(timeout)) {
      throw new Error(errors.shutdownTimeout);
    }

    if (!this.__shutdownPromise) {
      this.__shutdownPromise = this.__shutdown(timeout);
    }

    return await this.__shutdownPromise;
  }

  /** @internal */
  async __shutdown(timeout) {
    this.destroy();
    if (this.__iteratePromise) {
      await this.__iteratePromise;
    }

    if (this.__running.size > 0) {
      let timer;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(resolve, timeout);
      });
      await Promise.race([Promise.all([...this.__running].map((run) => run.done)), timedOut]);
      clearTimeout(timer);
    }

    const unfinished = [...this.__running];
    for (const run of unfinished) {
      run.released = true;
      this.__finishRun(run);

      const isInterval = run.task.isInterval === true;
      const kind = isInterval ? 'interval' : 'one-shot';
      let outcome = 'abandoned to preserve at-most-once execution';
      if (isInterval) {
        outcome = run.superseded
          ? 'superseded claim left unchanged'
          : 'claim queued to be handed back to storage';
      }
      if (isInterval && !run.superseded) {
        this.__queueRelease(run.task);
      }
      this.__errorHandler(
        new Error(`${kind} task ${run.task.uid} did not finish within shutdown timeout; ${outcome}`),
        '[shutdown] timeout',
        `Unfinished ${kind} task; ${outcome}`,
        run.task.uid
      );
    }

    this.__flushReleases();
    await Promise.all([...this.__releasing]);
    return unfinished.length === 0;
  }

  /**
   * Pause this instance from competing for scheduler work.
   * @param {string} [timerId] - Timer id returned from `setInterval` / `setTimeout` / `setImmediate`; omit to pause all tasks on this instance
   * @returns {boolean}
   */
  pause(timerId) {
    if (this.isDestroyed) {
      return false;
    }

    if (timerId === void 0) {
      if (this.__pausedAll) {
        return false;
      }
      this.__pausedAll = true;
      return true;
    }

    if (typeof timerId !== 'string' || timerId.length === 0) {
      throw new Error('[josk] [pause] timerId must be a non-empty string');
    }

    if (!prefixRegex.test(timerId)) {
      throw new Error('[josk] [pause] timerId must be the string returned from setInterval, setTimeout, or setImmediate');
    }

    if (this.__pausedTimerIds.has(timerId)) {
      return false;
    }
    this.__pausedTimerIds.add(timerId);
    return true;
  }

  /**
   * Resume competing for scheduler work.
   * @param {string} [timerId] - Timer id returned from `setInterval` / `setTimeout` / `setImmediate`; omit to resume all
   * @returns {boolean}
   */
  resume(timerId) {
    if (this.isDestroyed) {
      return false;
    }

    if (timerId === void 0) {
      if (!this.__pausedAll) {
        return false;
      }
      this.__pausedAll = false;
      this.__nudgeRevolution();
      return true;
    }

    if (typeof timerId !== 'string' || timerId.length === 0) {
      throw new Error('[josk] [resume] timerId must be a non-empty string');
    }

    if (!prefixRegex.test(timerId)) {
      throw new Error('[josk] [resume] timerId must be the string returned from setInterval, setTimeout, or setImmediate');
    }

    if (!this.__pausedTimerIds.has(timerId)) {
      return false;
    }
    this.__pausedTimerIds.delete(timerId);
    this.__nudgeRevolution();
    return true;
  }

  /**
   * Schedule an immediate revolution after pause clears (do not wait for jitter tick).
   * @internal
   */
  __nudgeRevolution() {
    if (this.isDestroyed) {
      return;
    }

    // A running iteration schedules the next one from `__tick()`; starting
    // another here would fork a second polling loop.
    if (this.__iterating) {
      this.__nudgePending = true;
      return;
    }

    if (this.nextRevolutionTimeout) {
      clearTimeout(this.nextRevolutionTimeout);
      this.nextRevolutionTimeout = null;
    }

    this.nextRevolutionTimeout = setTimeout(this.__iterate.bind(this), 0);
  }

  /**
   * Hand a claimed task back to storage as due soon.
   * @internal
   * @param {JoSkTask} task
   * @returns {void}
   */
  __queueRelease(task) {
    if (!task || typeof task.uid !== 'string' || task.isDeleted === true) {
      return;
    }

    this.__releaseQueue.push(task);
    if (!this.__iterating) {
      this.__flushReleases();
    }
  }

  /**
   * Released tasks are due immediately, so flush only after `iterate()`
   * returns; otherwise the same claim loop would pick them up again.
   * @internal
   * @returns {void}
   */
  __flushReleases() {
    const tasks = this.__releaseQueue.splice(0);
    if (tasks.length === 0) {
      return;
    }

    const promise = (async () => {
      await this.__adapterReady();
      await Promise.all(tasks.map(async (task) => {
        try {
          await this.adapter.update(task, new Date());
        } catch (releaseError) {
          this.__errorHandler(releaseError, '[__flushReleases] releaseError', 'Failed to release claimed task', task.uid);
        }
      }));
    })().catch((releaseError) => {
      this.__errorHandler(releaseError, '[__flushReleases] releaseError', 'Failed to release claimed tasks', null);
    });
    this.__releasing.add(promise);
    promise.finally(() => this.__releasing.delete(promise));
  }

  /** @internal */
  __checkState() {
    if (this.isDestroyed) {
      if (this.onError) {
        const reason = 'JoSk instance destroyed';
        this.__callHook('onError', this.onError, [reason, {
          description: 'invoking methods of destroyed JoSk instance',
          error: new Error(reason),
          uid: null
        }]);
      } else {
        this._debug('[__checkState] [warn] invoking methods of destroyed JoSk instance, call cause no action');
      }
      return true;
    }
    return false;
  }

  /**
   * Await adapter initialization. A failed attempt is retried on the next call
   * after `ADAPTER_RETRY_DELAY`; until then the last error is rethrown.
   * @internal
   * @returns {Promise<void>}
   */
  async __adapterReady() {
    if (typeof this.adapter.ready !== 'function') {
      return;
    }

    if (!this.__adapterReadyPromise) {
      if (Date.now() < this.__adapterRetryAt) {
        throw this.__adapterReadyError;
      }

      const attempt = Promise.resolve().then(() => this.adapter.ready());
      this.__adapterReadyPromise = attempt;
      attempt.catch((readyError) => {
        if (this.__adapterReadyPromise === attempt) {
          this.__adapterReadyPromise = null;
          this.__adapterReadyError = readyError;
          this.__adapterRetryAt = Date.now() + ADAPTER_RETRY_DELAY;
        }
      });
    }

    await this.__adapterReadyPromise;
  }

  /** @internal */
  __getLock() {
    const expireAt = new Date(Date.now() + this.lockLeaseTime);
    this.__lockLeaseCounter++;
    return {
      ownerId: this.lockOwnerId,
      leaseId: `${this.lockOwnerId}:${this.__lockLeaseCounter}:${createRandomId()}`,
      expireAt,
      expiresAtMs: +expireAt,
      leaseMs: this.lockLeaseTime
    };
  }

  /**
   * @internal
   * @param {string} timerId
   * @returns {Promise<boolean>}
   */
  async __remove(timerId) {
    if (typeof timerId !== 'string') {
      return false;
    }

    await this.__adapterReady();

    const isRemoved = await this.adapter.remove(timerId);
    if (isRemoved && this.tasks[timerId]) {
      delete this.tasks[timerId];
    }
    return isRemoved;
  }

  /**
   * @internal
   * @param {string} uid
   * @param {boolean} isInterval
   * @param {number} delay
   * @returns {Promise<void>}
   */
  async __add(uid, isInterval, delay) {
    if (this.isDestroyed) {
      return;
    }

    await this.__adapterReady();
    // Storage keeps whole milliseconds; Postgres BIGINT rejects a fraction.
    await this.adapter.add(uid, isInterval, Math.round(delay));
  }

  /**
   * Entry point used by adapters. Respects the configured concurrency cap.
   * Returns a Promise that resolves when the task finishes; adapters call
   * this fire-and-forget for batched throughput.
   * @internal
   * @param {JoSkTask} task
   * @returns {Promise<void>}
   */
  __execute(task) {
    // After destroy() nothing drains `__pendingTasks`; hand the claim back now.
    if (this.concurrency === Infinity || this.isDestroyed) {
      const promise = this.__doExecute(task);
      promise.catch((err) => {
        this._debug(`[__execute] [${task?.uid || 'unknown'}] unhandled exception:`, err);
      });
      return promise;
    }

    return new Promise((resolve) => {
      this.__pendingTasks.push({ task, resolve });
      this.__drainPending();
    });
  }

  /**
   * Drains queued tasks under the configured `concurrency` cap.
   *
   * Pulls FIFO entries off `__pendingTasks` and starts `__doExecute` for each
   * while `__activeExecutions < concurrency`. Every started task:
   *   - increments `__activeExecutions` before it begins
   *   - decrements it when it settles (success or failure)
   *   - resolves the awaiter promise returned from `__execute(task)`
   *   - re-invokes `__drainPending()` so the next queued task starts
   *     immediately without waiting for another tick
   *
   * Only used when `concurrency !== Infinity`. When concurrency is unbounded,
   * `__execute` runs tasks directly without queueing.
   *
   * @internal
   * @returns {void}
   */
  __drainPending() {
    while (this.__activeExecutions < this.concurrency && this.__pendingTasks.length > 0) {
      const entry = this.__pendingTasks.shift();
      this.__activeExecutions++;
      this.__doExecute(entry.task).catch((err) => {
        this._debug(`[__execute] [${entry.task?.uid || 'unknown'}] unhandled exception:`, err);
      }).finally(() => {
        this.__activeExecutions--;
        entry.resolve();
        this.__drainPending();
      });
    }
  }

  /**
   * @internal
   * @param {string} timerId
   */
  __isTaskPaused(timerId) {
    if (this.__pausedAll) {
      return true;
    }
    return this.__pausedTimerIds.has(timerId);
  }

  /**
   * @internal
   * @param {JoSkTask} task
   * @returns {Promise<void>}
   */
  async __deferClaimedTask(task) {
    const nextExecuteAt = new Date(Date.now() + PAUSED_CLAIM_DEFER);
    try {
      await this.__adapterReady();
      await this.adapter.update(task, nextExecuteAt);
    } catch (deferError) {
      this.__errorHandler(deferError, '[__deferClaimedTask] deferError', 'Failed to reschedule paused task', task.uid);
    }
  }

  /**
   * @internal
   * @param {JoSkTask} task
   * @returns {Promise<void>}
   */
  async __doExecute(task) {
    if (task?.isDeleted === true) {
      return;
    }

    if (this.isDestroyed) {
      this.__queueRelease(task);
      return;
    }

    if (!task || typeof task !== 'object' || typeof task.uid !== 'string') {
      if (this.onError) {
        this.__callHook('onError', this.onError, ['JoSk#__execute received malformed task', {
          description: 'Something went wrong with one of your tasks - malformed or undefined',
          error: null,
          task,
          uid: null
        }]);
      } else {
        this._debug('[__execute] received malformed task', task);
      }
      return;
    }

    if (task.isInterval === true && (typeof task.claimLeaseId !== 'string' || task.claimLeaseId === '') && !this.__warnedMissingClaimLeaseId && this.debug === true) {
      this.__warnedMissingClaimLeaseId = true;
      this._debug(`[${task.uid}] [__execute] claimed task has no claimLeaseId; late ready() calls can overwrite a newer cross-instance run unless adapter fences updates another way`);
    }

    if (this.__isTaskPaused(task.uid)) {
      await this.__deferClaimedTask(task);
      return;
    }

    let executionsQty = 0;

    if (this.tasks && typeof this.tasks[task.uid] === 'function') {
      if (this.tasks[task.uid].isMissing === true) {
        return;
      }

      const run = this.__trackRun(task);
      const ready = async (readyArg1) => {
        executionsQty++;
        if (executionsQty >= 2) {
          const error = new Error(`[josk] [${task.uid}] Resolution method is overspecified. Specify a callback *or* return a Promise. Task resolution was called more than once!`);
          if (typeof readyArg1 === 'function') {
            readyArg1(error, false);
            return false;
          }
          throw error;
        }

        const date = new Date();
        const timestamp = +date;

        if (typeof readyArg1 === 'function') {
          readyArg1(void 0, true);
        }

        try {
          if (task.isInterval === true && !run.released && !run.superseded) {
            let nextExecuteAt = new Date(timestamp + task.delay);
            if (typeof readyArg1 === 'object' && readyArg1 instanceof Date && +readyArg1 >= timestamp) {
              nextExecuteAt = readyArg1;
            } else if (typeof readyArg1 === 'number' && readyArg1 >= timestamp) {
              nextExecuteAt = new Date(readyArg1);
            }

            const isUpdated = await this.adapter.update(task, nextExecuteAt);
            if (!isUpdated) {
              this._debug(`[${task.uid}] [ready] schedule not updated; task was removed or re-claimed by another run`);
            }
          }
        } finally {
          this.__finishRun(run);
        }

        if (this.onExecuted) {
          this.__callHook('onExecuted', this.onExecuted, [task.uid.replace(prefixRegex, ''), {
            uid: task.uid,
            date,
            delay: task.delay,
            timestamp
          }]);
        }

        return true;
      };

      const taskFunc = this.tasks[task.uid];
      const funcArity = taskFunc.length;
      let hasError = false;
      let didInvoke = false;
      let returnedPromise;
      try {
        if (task.isInterval === false) {
          let isRemoved = false;
          try {
            isRemoved = await this.__remove(task.uid);
          } catch (removeError) {
            this._debug(`[${task.uid}] [__execute] [__remove] has thrown an exception; Check connection with StorageAdapter; removeError:`, removeError);
          }

          if (isRemoved === true) {
            didInvoke = true;
            returnedPromise = taskFunc(ready);
          }
        } else {
          didInvoke = true;
          returnedPromise = taskFunc(ready);
        }

        if (isPromiseLike(returnedPromise)) {
          await Promise.resolve(returnedPromise);
        }
      } catch (taskExecError) {
        hasError = true;
        this.__errorHandler(taskExecError, 'Exception during task execution', 'An exception was thrown during task execution', task.uid);
      }

      if (!didInvoke) {
        // setTimeout/setImmediate handler skipped because remove() failed or
        // the task was claimed elsewhere. Do not auto-ready: that would fire
        // onExecuted for a run that never happened.
        this.__finishRun(run);
        return;
      }

      const isPromise = isPromiseLike(returnedPromise);
      const isCallbackStyle = funcArity === 0;
      const needsAutoReady = executionsQty === 0 && (isPromise || hasError || isCallbackStyle);

      if (needsAutoReady) {
        try {
          await ready();
        } catch (readyErr) {
          this._debug(`[${task.uid}] [__execute] [ready] has thrown an exception; readyErr:`, readyErr);
        }
      } else if (executionsQty === 0 && !isPromise && !hasError) {
        this._debug(`[${task.uid}] [__execute] handler returned synchronously without calling ready(); task will be retried after zombieTime`);
      }
      return;
    }

    await this.adapter.update(task, new Date(Date.now() + this.zombieTime));
    this.tasks[task.uid] = /** @type {JoSkStoredTask} */ (function () {});
    this.tasks[task.uid].isMissing = true;

    if (this.autoClear) {
      try {
        await this.__remove(task.uid);
        this._debug(`[FYI] [${task.uid}] task was auto-cleared`);
      } catch (removeError) {
        this._debug(`[${task.uid}] [__execute] [this.autoClear] [__remove] has thrown an exception; removeError:`, removeError);
      }
    } else if (this.onError) {
      this.__callHook('onError', this.onError, ['One of your tasks is missing', {
        description: `Something went wrong with one of your tasks - is missing.
          Try to use different instances.
          It's safe to ignore this message.
          If this task is obsolete - simply remove it with \`JoSk#clearTimeout('${task.uid}')\`,
          or enable autoClear with \`new JoSk({autoClear: true})\``,
        error: null,
        uid: task.uid
      }]);
    } else {
      this._debug(`[__execute] [${task.uid}] Something went wrong with one of your tasks is missing.
        Try to use different instances.
        It's safe to ignore this message.
        If this task is obsolete - simply remove it with \`JoSk#clearTimeout('${task.uid}')\`,
        or enable autoClear with \`new JoSk({autoClear: true})\``);
    }
  }

  /**
   * @internal
   * @param {JoSkTask} task
   */
  __trackRun(task) {
    const previous = this.__inFlight.get(task.uid);
    if (previous) {
      previous.superseded = true;
      // Track one superseded run per uid; drop older ones so handlers that
      // never call ready() don't pile up until shutdown().
      const older = this.__superseded.get(task.uid);
      if (older) {
        this.__finishRun(older);
      }
      this.__superseded.set(task.uid, previous);
    }

    let settle = () => {};
    const done = new Promise((resolve) => {
      settle = resolve;
    });
    const run = { task, released: false, superseded: false, settle, done };
    this.__inFlight.set(task.uid, run);
    this.__running.add(run);
    return run;
  }

  /**
   * @internal
   * @param {{ task: JoSkTask, released: boolean, superseded: boolean, settle: () => void, done: Promise<void> }} run
   */
  __finishRun(run) {
    if (this.__inFlight.get(run.task.uid) === run) {
      this.__inFlight.delete(run.task.uid);
    }
    if (this.__superseded.get(run.task.uid) === run) {
      this.__superseded.delete(run.task.uid);
    }
    this.__running.delete(run);
    run.settle();
  }

  /** @internal */
  __iterate() {
    this.__iteratePromise = this.__iterateOnce();
    return this.__iteratePromise;
  }

  /** @internal */
  async __iterateOnce() {
    if (this.isDestroyed) {
      return;
    }

    if (this.__pausedAll) {
      this.__tick();
      return;
    }

    let isAcquired = false;
    let lock;
    this.__iterating = true;

    try {
      await this.__adapterReady();
      const nextExecuteAt = new Date(Date.now() + this.zombieTime);
      lock = this.__getLock();
      isAcquired = await this.adapter.acquireLock(lock);
      if (isAcquired) {
        await this.adapter.iterate(nextExecuteAt, lock, this.execute);
      }
    } catch (runError) {
      this.__errorHandler(runError, '[__iterate] runError:', 'adapter.iterate has returned an error', null);
    } finally {
      if (isAcquired) {
        try {
          await this.adapter.releaseLock(lock);
        } catch (releaseError) {
          this.__errorHandler(releaseError, '[__iterate] [releaseLock] releaseError:', 'adapter.releaseLock has returned an error', null);
        }
      }
      this.__iterating = false;
      this.__flushReleases();
      this.__tick();
    }
  }

  /** @internal */
  __tick() {
    if (this.isDestroyed) {
      return;
    }

    if (this.__nudgePending) {
      this.__nudgePending = false;
      this.nextRevolutionTimeout = setTimeout(this.__iterate.bind(this), 0);
      return;
    }

    const jitterRange = Math.max(0, this.maxRevolvingDelay - this.minRevolvingDelay);
    this.nextRevolutionTimeout = setTimeout(this.__iterate.bind(this), this.minRevolvingDelay + Math.round(Math.random() * jitterRange));
  }

  /**
   * @internal
   * @param {string} hookName
   * @param {Function} hook
   * @param {unknown[]} args
   * @returns {void}
   */
  __callHook(hookName, hook, args) {
    try {
      const result = hook(...args);
      if (isPromiseLike(result)) {
        Promise.resolve(result).catch((hookError) => {
          console.error(`[josk] [${hookName}] hook rejected`, hookError);
        });
      }
    } catch (hookError) {
      console.error(`[josk] [${hookName}] hook failed`, hookError);
    }
  }

  /**
   * @internal
   * @param {unknown} error
   * @param {string} title
   * @param {string} description
   * @param {string | null} uid
   * @returns {void}
   */
  __errorHandler(error, title, description, uid) {
    if (error) {
      if (this.onError) {
        this.__callHook('onError', this.onError, [title, { description, error, uid }]);
      } else {
        console.error(title, { description, error, uid });
      }
    }
  }
}

exports.JoSk = JoSk;
exports.MongoAdapter = MongoAdapter;
exports.PostgresAdapter = PostgresAdapter;
exports.RedisAdapter = RedisAdapter;
