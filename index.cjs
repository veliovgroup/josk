'use strict';

var node_crypto = require('node:crypto');

// MongoDB Storage Adapter for JoSk.
//
// IMPORTANT: This adapter is designed for and tested against the official
// `mongodb` driver only. Other Mongo-compatible clients (Mongoose, custom
// wrappers) may work if they expose the same `Db.collection()`,
// `Db.command()`, and `Collection` APIs, but are not officially supported.

/**
 * @typedef {import('mongodb').Collection} Collection
 * @typedef {import('mongodb').Db} Db
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
 * @typedef {object} MongoAdapterOption
 * @property {Db} db
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
 */

const logError = (error, ...args) => {
  if (error) {
    console.error('[josk] [MongoAdapter] [logError]:', error, ...args);
  }
};

/**
 * @param {Collection} collection
 * @param {object} keys
 * @param {object} opts
 * @returns {Promise<void>}
 */
const ensureIndex = async (collection, keys, opts) => {
  try {
    await collection.createIndex(keys, opts);
  } catch (error) {
    if (error?.code !== 85 && error?.codeName !== 'IndexOptionsConflict') {
      throw error;
    }

    const indexes = await collection.indexes();
    for (const index of indexes) {
      const indexKeys = Object.keys(index.key || {});
      const desiredKeys = Object.keys(keys);
      if (indexKeys.length !== desiredKeys.length) {
        continue;
      }

      let matches = true;
      for (const key of desiredKeys) {
        if (index.key[key] !== keys[key]) {
          matches = false;
          break;
        }
      }

      if (matches) {
        await collection.dropIndex(index.name);
        break;
      }
    }

    await collection.createIndex(keys, opts);
  }
};

/** Class representing MongoDB adapter for JoSk */
class MongoAdapter {
  /**
   * Create a MongoAdapter instance
   * @param {MongoAdapterOption} opts - configuration object
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

    /** @type {Db} */
    this.db = opts.db;
    this.uniqueName = `__JobTasks__${this.prefix}`;
    /** @type {Collection} */
    this.collection = opts.db.collection(this.uniqueName);
    /** @type {Collection} */
    this.lockCollection = opts.db.collection(this.lockCollectionName);
    /** @type {JoSk | undefined} */
    this.joskInstance = void 0;
    /** @internal */
    this.__readyPromise = this.__setup();
  }

  /**
   * @returns {Promise<void>}
   */
  async ready() {
    await this.__readyPromise;
  }

  /** @internal */
  async __setup() {
    await ensureIndex(this.collection, { uid: 1 }, { name: 'uid_unique', unique: true }).catch((error) => {
      logError(error, '[setup] [createIndex] uid_unique');
      throw error;
    });

    await ensureIndex(this.collection, { isDeleted: 1, executeAt: 1 }, { name: 'due_lookup' }).catch((error) => {
      logError(error, '[setup] [createIndex] due_lookup');
      throw error;
    });

    await ensureIndex(this.lockCollection, { uniqueName: 1 }, { name: 'uniqueName_unique', unique: true }).catch((error) => {
      logError(error, '[setup] [createIndex] uniqueName_unique');
      throw error;
    });

    await ensureIndex(this.lockCollection, { expireAt: 1 }, { name: 'expireAt_ttl', expireAfterSeconds: 0 }).catch((error) => {
      logError(error, '[setup] [createIndex] expireAt_ttl');
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
      await this.collection.updateOne({
        uid
      }, {
        $set: {
          uid,
          delay,
          executeAt: new Date(Date.now() + delay),
          isInterval,
          isDeleted: false
        }
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
   * @param {{ uid: string }} task
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
      const updateResult = await this.collection.updateOne({
        uid: task.uid,
        isDeleted: false
      }, {
        $set: {
          executeAt: nextExecuteAt
        }
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

    const batchLimit = 100;
    while (true) {
      const tasks = await this.__claimNextTasks(nextExecuteAt, lock, batchLimit);
      if (tasks.length === 0) {
        break;
      }

      executed += tasks.length;
      for (const task of tasks) {
        this.joskInstance.__execute(task);
      }

      if (tasks.length < batchLimit) {
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
      return task || null;
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
        return tasks;
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

      return tasks.filter((task) => claimedIds.has(String(task._id)));
    } catch (mongoError) {
      this.joskInstance.__errorHandler(mongoError, '[MongoAdapter] [iterate] [batchClaim]', 'Exception inside MongoAdapter#__claimNextTasks() method', null);
      return [];
    }
  }
}

/**
 * @typedef {import('redis').RedisClientType | import('redis').RedisClusterType} RedisClient
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
 * @typedef {object} RedisAdapterOption
 * @property {RedisClient} client
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

const ADD_TASK_SCRIPT = `
  local payload = redis.call('HGET', KEYS[2], ARGV[1])
  local task = payload and cjson.decode(payload) or {
    uid = ARGV[1],
    delay = tonumber(ARGV[2]),
    executeAt = tonumber(ARGV[3]),
    isInterval = ARGV[4] == '1',
    isDeleted = false
  }

  if payload and task.isDeleted then
    return 0
  end

  task.delay = tonumber(ARGV[2])
  task.executeAt = tonumber(ARGV[3])
  task.isInterval = ARGV[4] == '1'
  task.isDeleted = false

  redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(task))
  redis.call('ZADD', KEYS[1], tonumber(ARGV[3]), ARGV[1])
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

  task.executeAt = tonumber(ARGV[2])
  redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(task))
  redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[1])
  return 1
`;

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
        task.executeAt = nextExecuteAt
        task.claimOwnerId = ARGV[3]
        task.claimLeaseId = ARGV[4]

        redis.call('HSET', KEYS[2], uid, cjson.encode(task))
        redis.call('ZADD', KEYS[1], nextExecuteAt, uid)
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
          task.executeAt = nextExecuteAt
          task.claimOwnerId = ARGV[3]
          task.claimLeaseId = ARGV[4]

          redis.call('HSET', KEYS[2], uid, cjson.encode(task))
          redis.call('ZADD', KEYS[1], nextExecuteAt, uid)
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

const sha1Hex = (str) => node_crypto.createHash('sha1').update(str).digest('hex');

const isNoScriptError = (error) => {
  if (!error) {
    return false;
  }
  const message = typeof error.message === 'string' ? error.message : '';
  return message.indexOf('NOSCRIPT') !== -1 || error.code === 'NOSCRIPT';
};

/** Class representing Redis adapter for JoSk */
class RedisAdapter {
  /**
   * Create a RedisAdapter instance
   * @param {RedisAdapterOption} opts - configuration object
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

    /** @type {RedisClient} */
    this.client = opts.client;
    /** @type {JoSk | undefined} */
    this.joskInstance = void 0;
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
    /** @internal */
    this.__readyPromise = this.__setup();
  }

  /**
   * @returns {Promise<void>}
   */
  async ready() {
    await this.__readyPromise;
  }

  /** @internal */
  async __setup() {
    if (this.resetOnInit) {
      await this.client.del([this.scheduleKey, this.tasksKey, this.lockKey]);
      const cursor = this.client.scanIterator({
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

  /**
   * @internal
   * @param {keyof RedisAdapter['__scriptShas']} scriptKey
   * @param {{ keys: string[], arguments: string[] }} options
   * @returns {Promise<unknown>}
   */
  async __runScript(scriptKey, options) {
    const sha = this.__scriptShas[scriptKey];
    const source = this.__scriptSources[scriptKey];

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
      const ping = await this.client.ping();
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

    const res = await this.__runScript('acquireLock', {
      keys: [this.lockKey],
      arguments: [this.__serializeLock(lock), `${this.joskInstance.zombieTime}`]
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
   * @param {{ uid: string }} task
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
        arguments: [task.uid, `${+nextExecuteAt}`]
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

    while (true) {
      const tasks = await this.__claimNextTasks(nextExecuteAt, lock, REDIS_BATCH_CLAIM_LIMIT);
      if (tasks.length === 0) {
        break;
      }

      executed += tasks.length;
      for (let i = 0; i < tasks.length; i++) {
        this.joskInstance.__execute(tasks[i]);
      }

      if (tasks.length < REDIS_BATCH_CLAIM_LIMIT) {
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
      const claimed = await this.__runScript('claimBatch', {
        keys: [this.scheduleKey, this.tasksKey],
        arguments: [`${Date.now()}`, `${+nextExecuteAt}`, lock.ownerId, lock.leaseId, `${limit}`, `${REDIS_SCAN_LIMIT}`]
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
      isDeleted: !!task.isDeleted
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

const ADVISORY_LOCK_KEY = 93824517;
const SCHEMA_VERSION = 1;

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
    this.joskInstance = void 0;
    /** @internal */
    this.__readyPromise = this.__setup();
  }

  /**
   * @returns {Promise<void>}
   */
  async ready() {
    await this.__readyPromise;
  }

  /** @internal */
  async __setup() {
    // pg_advisory_lock is session-scoped. A `pg.Pool` rotates connections per
    // query, so the lock must be acquired on one pinned session — otherwise
    // the migration DDL runs unprotected and the lock leaks until the pool
    // recycles the holding connection. Detect Pool by probing for a
    // `connect()` that yields a releasable client; raw `pg.Client` keeps its
    // own session so we use it directly.
    let setupClient = this.client;
    let release = null;
    if (typeof this.client.connect === 'function') {
      try {
        const dedicated = await this.client.connect();
        if (dedicated && typeof dedicated.query === 'function' && typeof dedicated.release === 'function') {
          setupClient = dedicated;
          release = () => dedicated.release();
        }
      } catch (connectErr) {
        // pg.Client.connect() after manual connect resolves to undefined or
        // throws "already connected" — both fine; fall back to this.client.
      }
    }

    await setupClient.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);

    try {
      await setupClient.query(`
        CREATE TABLE IF NOT EXISTS josk_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);

      const versionResult = await setupClient.query(
        `SELECT value FROM josk_meta WHERE key = 'schema_version'`
      );
      const currentVersion = versionResult.rows && versionResult.rows[0]
        ? parseInt(versionResult.rows[0].value, 10)
        : 0;

      await setupClient.query(`
        CREATE TABLE IF NOT EXISTS josk_tasks (
          prefix TEXT NOT NULL DEFAULT 'default',
          uid TEXT NOT NULL,
          delay INTEGER NOT NULL,
          execute_at BIGINT NOT NULL,
          is_interval BOOLEAN NOT NULL DEFAULT false,
          is_deleted BOOLEAN NOT NULL DEFAULT false,
          claim_owner_id TEXT,
          claim_lease_id TEXT,
          claimed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);

      if (currentVersion < 1) {
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS prefix TEXT NOT NULL DEFAULT 'default'`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS uid TEXT NOT NULL DEFAULT ''`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS delay INTEGER NOT NULL DEFAULT 0`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS execute_at BIGINT NOT NULL DEFAULT 0`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS is_interval BOOLEAN NOT NULL DEFAULT false`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS claim_owner_id TEXT`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS claim_lease_id TEXT`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`);

        const primaryKeyResult = await setupClient.query(`
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

        if (primaryKeyColumns.length === 1 && primaryKeyColumns[0] === 'uid') {
          await setupClient.query(`ALTER TABLE josk_tasks DROP CONSTRAINT IF EXISTS josk_tasks_pkey`);
        }

        await setupClient.query(`
          ALTER TABLE josk_tasks
          ADD CONSTRAINT josk_tasks_pkey PRIMARY KEY (prefix, uid)
        `).catch((error) => {
          if (error?.code !== '42P16' && error?.code !== '42710') {
            throw error;
          }
        });

        await setupClient.query(`
          CREATE INDEX IF NOT EXISTS idx_josk_tasks_prefix_execute
          ON josk_tasks (prefix, execute_at)
          WHERE is_deleted = false
        `);

        await setupClient.query(`
          CREATE TABLE IF NOT EXISTS josk_locks (
            lock_key TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            lease_id TEXT NOT NULL,
            locked_until BIGINT NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
          )
        `);

        await setupClient.query(`ALTER TABLE josk_locks ADD COLUMN IF NOT EXISTS owner_id TEXT`);
        await setupClient.query(`ALTER TABLE josk_locks ADD COLUMN IF NOT EXISTS lease_id TEXT`);
        await setupClient.query(`ALTER TABLE josk_locks ADD COLUMN IF NOT EXISTS locked_until BIGINT`);
        await setupClient.query(`ALTER TABLE josk_locks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`);
        await setupClient.query(`UPDATE josk_locks SET owner_id = COALESCE(owner_id, ''), lease_id = COALESCE(lease_id, ''), locked_until = COALESCE(locked_until, 0) WHERE owner_id IS NULL OR lease_id IS NULL OR locked_until IS NULL`);
        await setupClient.query(`ALTER TABLE josk_locks ALTER COLUMN owner_id SET NOT NULL`);
        await setupClient.query(`ALTER TABLE josk_locks ALTER COLUMN lease_id SET NOT NULL`);
        await setupClient.query(`ALTER TABLE josk_locks ALTER COLUMN locked_until SET NOT NULL`);

        await setupClient.query(`
          CREATE INDEX IF NOT EXISTS idx_josk_locks_locked_until
          ON josk_locks (locked_until)
        `);

        await setupClient.query(
          `INSERT INTO josk_meta (key, value) VALUES ('schema_version', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [String(SCHEMA_VERSION)]
        );
      }

      if (this.resetOnInit) {
        await setupClient.query('DELETE FROM josk_tasks WHERE prefix = $1', [this.prefix]);
        await setupClient.query('DELETE FROM josk_locks WHERE lock_key = $1', [this.lockKey]);
      }
    } finally {
      try {
        await setupClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]);
      } finally {
        if (release) {
          release();
        }
      }
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
      const res = await this.client.query(
        `INSERT INTO josk_locks (lock_key, owner_id, lease_id, locked_until)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (lock_key) DO UPDATE
           SET owner_id = EXCLUDED.owner_id,
               lease_id = EXCLUDED.lease_id,
               locked_until = EXCLUDED.locked_until,
               updated_at = CURRENT_TIMESTAMP
         WHERE josk_locks.locked_until <= (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::BIGINT
         RETURNING lease_id`,
        [this.lockKey, lock.ownerId, lock.leaseId, lock.expiresAtMs]
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
      const res = await this.client.query(
        `INSERT INTO josk_tasks (prefix, uid, delay, execute_at, is_interval, is_deleted, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (prefix, uid) DO UPDATE SET
           delay = EXCLUDED.delay,
           execute_at = EXCLUDED.execute_at,
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
   * @param {{ uid: string }} task
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
             updated_at = CURRENT_TIMESTAMP
         WHERE prefix = $2
           AND uid = $3
           AND is_deleted = false
         RETURNING uid`,
        [+nextExecuteAt, this.prefix, task.uid]
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
        isDeleted: task.is_deleted
      });

      return executed + 1;
    }

    const batchLimit = 100;
    while (true) {
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
          isDeleted: task.is_deleted
        });
      }

      if (tasks.length < batchLimit) {
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

const createRandomId = () => node_crypto.randomUUID();
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
 * @returns {void | PromiseLike<void>}
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
 * @property {JoSkOnExecuted} [onExecuted]
 * @property {number} [minRevolvingDelay]
 * @property {number} [maxRevolvingDelay]
 * @property {JoSkExecuteMode} [execute]
 * @property {string} [lockOwnerId]
 * @property {number} [concurrency]
 */

const errors = {
  execute: '[josk] [execute] option must be either "batch" or "one"!',
  concurrency: '[josk] [concurrency] option must be a positive integer or Infinity',
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
    /** @internal */
    this.__adapterReadyPromise = null;
    /** @internal */
    this.__activeExecutions = 0;
    /** @internal */
    this.__pendingTasks = [];
    /** @internal */
    this.__pausedAll = false;
    /** @internal */
    this.__pausedUserIds = new Set();

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
    await this.__adapterReady();
    return await this.adapter.ping();
  }

  /**
   * @async
   * @memberOf JoSk
   * Create recurring task (loop)
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
      this.__pausedUserIds.clear();
      if (this.nextRevolutionTimeout) {
        clearTimeout(this.nextRevolutionTimeout);
        this.nextRevolutionTimeout = null;
      }
      return true;
    }
    return false;
  }

  /**
   * Pause this instance from competing for scheduler work.
   * @param {string} [uid] - User task id or internal timer id; omit to pause all tasks on this instance
   * @returns {boolean}
   */
  pause(uid) {
    if (this.isDestroyed) {
      return false;
    }

    if (uid === void 0) {
      if (this.__pausedAll) {
        return false;
      }
      this.__pausedAll = true;
      return true;
    }

    if (typeof uid !== 'string' || uid.length === 0) {
      throw new Error('[josk] [pause] uid must be a non-empty string');
    }

    const bare = uid.replace(prefixRegex, '');
    if (this.__pausedUserIds.has(bare)) {
      return false;
    }
    this.__pausedUserIds.add(bare);
    return true;
  }

  /**
   * Resume competing for scheduler work.
   * @param {string} [uid] - User task id or internal timer id; omit to resume all
   * @returns {boolean}
   */
  resume(uid) {
    if (this.isDestroyed) {
      return false;
    }

    if (uid === void 0) {
      if (!this.__pausedAll) {
        return false;
      }
      this.__pausedAll = false;
      return true;
    }

    if (typeof uid !== 'string' || uid.length === 0) {
      throw new Error('[josk] [resume] uid must be a non-empty string');
    }

    const bare = uid.replace(prefixRegex, '');
    if (!this.__pausedUserIds.has(bare)) {
      return false;
    }
    this.__pausedUserIds.delete(bare);
    return true;
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

  /** @internal */
  async __adapterReady() {
    if (typeof this.adapter.ready !== 'function') {
      return;
    }

    if (!this.__adapterReadyPromise) {
      this.__adapterReadyPromise = Promise.resolve().then(() => this.adapter.ready());
    }

    return await this.__adapterReadyPromise;
  }

  /** @internal */
  __getLock() {
    const expireAt = new Date(Date.now() + this.zombieTime);
    this.__lockLeaseCounter++;
    return {
      ownerId: this.lockOwnerId,
      leaseId: `${this.lockOwnerId}:${this.__lockLeaseCounter}:${createRandomId()}`,
      expireAt,
      expiresAtMs: +expireAt
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
    await this.adapter.add(uid, isInterval, delay);
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
    if (this.concurrency === Infinity) {
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
    const bare = timerId.replace(prefixRegex, '');
    return this.__pausedUserIds.has(bare);
  }

  /**
   * @internal
   * @param {JoSkTask} task
   * @returns {Promise<void>}
   */
  async __deferClaimedTask(task) {
    const deferMs = Math.max(2000, typeof task.delay === 'number' && task.delay >= 2000 ? task.delay : 2000);
    const nextExecuteAt = new Date(Date.now() + deferMs);
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
    if (this.isDestroyed || task?.isDeleted === true) {
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

    if (this.__isTaskPaused(task.uid)) {
      await this.__deferClaimedTask(task);
      return;
    }

    let executionsQty = 0;

    if (this.tasks && typeof this.tasks[task.uid] === 'function') {
      if (this.tasks[task.uid].isMissing === true) {
        return;
      }

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

        if (task.isInterval === true) {
          if (typeof readyArg1 === 'object' && readyArg1 instanceof Date && +readyArg1 >= timestamp) {
            await this.adapter.update(task, readyArg1);
          } else if (typeof readyArg1 === 'number' && readyArg1 >= timestamp) {
            await this.adapter.update(task, new Date(readyArg1));
          } else {
            await this.adapter.update(task, new Date(timestamp + task.delay));
          }
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
        If this task is obsolete - simply remove it with \`JoSk#clearTimeout(\'${task.uid}\')\`,
        or enable autoClear with \`new JoSk({autoClear: true})\``);
    }
  }

  /** @internal */
  async __iterate() {
    if (this.isDestroyed) {
      return;
    }

    if (this.__pausedAll) {
      this.__tick();
      return;
    }

    const nextExecuteAt = new Date(Date.now() + this.zombieTime);
    const lock = this.__getLock();
    let isAcquired = false;

    try {
      await this.__adapterReady();
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
      this.__tick();
    }
  }

  /** @internal */
  __tick() {
    if (this.isDestroyed) {
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
