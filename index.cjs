'use strict';

/**
 * @typedef {import('mongodb').Collection} Collection
 * @typedef {import('mongodb').Db} Db
 * @typedef {import('../index.js').JoSk} JoSk
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
 * @property {unknown} _id
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
 * Ensure (create) index on MongoDB collection, catch and log exception if thrown
 * @function ensureIndex
 * @param {Collection} collection - Mongo's driver Collection instance
 * @param {object} keys - Field and value pairs where the field is the index key and the value describes the type of index for that field
 * @param {object} opts - Set of options that controls the creation of the index
 * @returns {Promise<void>}
 */
const ensureIndex = async (collection, keys, opts) => {
  try {
    await collection.createIndex(keys, opts);
  } catch (e) {
    if (e.code === 85) {
      let indexName;
      const indexes = await collection.indexes();
      for (const index of indexes) {
        let drop = true;
        for (const indexKey of Object.keys(keys)) {
          if (typeof index.key[indexKey] === 'undefined') {
            drop = false;
            break;
          }
        }

        for (const indexKey of Object.keys(index.key)) {
          if (typeof keys[indexKey] === 'undefined') {
            drop = false;
            break;
          }
        }

        if (drop) {
          indexName = index.name;
          break;
        }
      }

      if (indexName) {
        await collection.dropIndex(indexName);
        await collection.createIndex(keys, opts);
      }
    } else {
      console.info(`[INFO] [josk] [MongoAdapter] [ensureIndex] Can not set ${Object.keys(keys).join(' + ')} index on "${collection._name || 'MongoDB'}" collection`, { keys, opts, details: e });
    }
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
    this.prefix = (typeof opts.prefix === 'string') ? opts.prefix : '';
    this.lockCollectionName = opts.lockCollectionName || '__JobTasks__.lock';
    this.resetOnInit = opts.resetOnInit || false;

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
    ensureIndex(this.collection, {uid: 1}, {background: false, unique: true});
    ensureIndex(this.collection, {uid: 1, isDeleted: 1}, {background: false});
    ensureIndex(this.collection, {executeAt: 1}, {background: false});

    /** @type {Collection} */
    this.lockCollection = opts.db.collection(this.lockCollectionName);
    ensureIndex(this.lockCollection, {expireAt: 1}, {background: false, expireAfterSeconds: 1});
    ensureIndex(this.lockCollection, {uniqueName: 1}, {background: false, unique: true});
    /** @type {JoSk | undefined} */
    this.joskInstance = void 0;

    if (this.resetOnInit) {
      this.collection.deleteMany({
        isInterval: false
      }).then(() => {}).catch(logError);

      this.lockCollection.deleteMany({
        uniqueName: this.uniqueName
      }).then(() => {}).catch(logError);
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
        error: new Error(reason),
      };
    }

    try {
      const ping = await this.db.command({ ping: 1 });
      if (ping?.ok === 1) {
        return {
          status: 'OK',
          code: 200,
          statusCode: 200,
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
   * @returns {Promise<boolean>}
   */
  async acquireLock() {
    const expireAt = new Date(Date.now() + this.joskInstance.zombieTime);

    try {
      const record = await this.lockCollection.findOne({
        uniqueName: this.uniqueName
      }, {
        projection: {
          uniqueName: 1
        }
      });

      if (record?.uniqueName === this.uniqueName) {
        return false;
      }

      const result = await this.lockCollection.insertOne({
        uniqueName: this.uniqueName,
        expireAt
      });

      if (result.insertedId) {
        return true;
      }
      return false;
    } catch(opError) {
      if (opError?.code === 11000) {
        return false;
      }

      this.joskInstance.__errorHandler(opError, '[acquireLock] [opError]', 'Exception inside MongoAdapter#acquireLock() method');
      return false;
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async releaseLock() {
    await this.lockCollection.deleteOne({ uniqueName: this.uniqueName });
  }

  /**
   * @param {string} uid
   * @returns {Promise<boolean>}
   */
  async remove(uid) {
    try {
      const result = await this.collection.findOneAndUpdate({
        uid,
        isDeleted: false
      }, {
        $set: {
          isDeleted: true
        }
      }, {
        returnNewDocument: false,
        projection: {
          _id: 1,
          isDeleted: 1
        }
      });

      const res = result?._id ? result : result?.value; // mongodb 5 vs. 6 compatibility
      if (res?.isDeleted === false) {
        const deleteResult = await this.collection.deleteOne({ _id: res._id });
        return deleteResult?.deletedCount >= 1;
      }

      return false;
    } catch(opError) {
      this.joskInstance.__errorHandler(opError, '[remove] [opError]', 'Exception inside MongoAdapter#remove() method', uid);
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
    const next = Date.now() + delay;

    try {
      const task = await this.collection.findOne({
        uid: uid
      });

      if (!task) {
        await this.collection.insertOne({
          uid: uid,
          delay: delay,
          executeAt: new Date(next),
          isInterval: isInterval,
          isDeleted: false
        });

        return true;
      }

      if (task.isDeleted === false) {
        let update = null;
        if (task.delay !== delay) {
          update = { delay };
        }

        if (+task.executeAt !== next) {
          if (!update) {
            update = {};
          }
          update.executeAt = new Date(next);
        }

        if (update) {
          await this.collection.updateOne({
            uid: uid
          }, {
            $set: update
          });
        }

        return true;
      }

      return false;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[add] [opError]', 'Exception inside MongoAdapter#add()', uid);
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

    try {
      const updateResult = await this.collection.updateOne({
        uid: task.uid
      }, {
        $set: {
          executeAt: nextExecuteAt
        }
      });
      return updateResult?.modifiedCount >= 1;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[MongoAdapter] [update] [opError]', 'Exception inside MongoAdapter#update() method', task.uid);
      return false;
    }
  }

  /**
   * @param {Date} nextExecuteAt
   * @returns {Promise<void>}
   */
  async iterate(nextExecuteAt) {
    const _ids = [];
    const tasks = [];

    const cursor = this.collection.find({
      executeAt: {
        $lte: new Date()
      }
    }, {
      projection: {
        _id: 1,
        uid: 1,
        delay: 1,
        isDeleted: 1,
        isInterval: 1
      }
    });

    try {
      let task;
      while (await cursor.hasNext()) {
        task = await cursor.next();
        _ids.push(task._id);
        tasks.push(task);
      }
      await this.collection.updateMany({
        _id: {
          $in: _ids
        }
      }, {
        $set: {
          executeAt: nextExecuteAt
        }
      });
    } catch (mongoError) {
      logError('[iterate] mongoError:', mongoError);
    }

    for (const task of tasks) {
      this.joskInstance.__execute(/** @type {MongoTask} */ (task));
    }

    await cursor.close();
  }
}

/**
 * @typedef {import('redis').RedisClientType} RedisClient
 * @typedef {import('../index.js').JoSk} JoSk
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
 */

/**
 * @typedef {object} RedisTask
 * @property {string} uid
 * @property {number} delay
 * @property {number} executeAt
 * @property {boolean} isInterval
 * @property {boolean} isDeleted
 */

/** Class representing Redis adapter for JoSk */
class RedisAdapter {
  /**
   * Create a RedisAdapter instance
   * @param {RedisAdapterOption} opts - configuration object
   */
  constructor(opts = {}) {
    this.name = 'redis';
    this.prefix = (typeof opts.prefix === 'string') ? opts.prefix : 'default';
    this.uniqueName = `josk:${this.prefix}`;
    this.lockKey = `${this.uniqueName}:lock`;
    this.resetOnInit = opts.resetOnInit || false;

    if (!opts.client) {
      throw new Error('{client} option is required for RedisAdapter', {
        description: 'Redis database requires {client} option, e.g. returned from `redis.createClient()` or `redis.createCluster()` method'
      });
    }

    /** @type {RedisClient} */
    this.client = opts.client;
    /** @type {JoSk | undefined} */
    this.joskInstance = void 0;
    if (this.resetOnInit) {
      process.nextTick(async () => {
        const cursor = this.client.scanIterator({
          TYPE: 'hash',
          MATCH: this.__getTaskKey('*'),
          COUNT: 9999,
        });

        for await (const key of cursor) {
          await this.client.del(key);
        }
      });
    }
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
        error: new Error(reason),
      };
    }

    try {
      const ping = await this.client.ping();
      if (ping === 'PONG') {
        return {
          status: 'OK',
          code: 200,
          statusCode: 200,
        };
      }

      throw new Error(`Unexpected response from Redis#ping received: ${ping}`);
    } catch (pingError) {
      return {
        status: 'Internal Server Error',
        code: 500,
        statusCode: 500,
        error: pingError,
      };
    }
  }

  /**
   * @returns {Promise<boolean>}
   */
  async acquireLock() {
    const isLocked = await this.client.exists(this.lockKey);
    if (isLocked >= 1) {
      return false;
    }
    const res = await this.client.set(this.lockKey, `${Date.now() + this.joskInstance.zombieTime}`, {
      PX: this.joskInstance.zombieTime,
      NX: true
    });
    return res === 'OK';
  }

  /**
   * @returns {Promise<void>}
   */
  async releaseLock() {
    await this.client.del(this.lockKey);
  }

  /**
   * @param {string} uid
   * @returns {Promise<boolean>}
   */
  async remove(uid) {
    const taskKey = this.__getTaskKey(uid);
    try {
      const exists = await this.client.exists(taskKey);
      if (!exists) {
        return false;
      }
      await this.client.hSet(taskKey, {
        isDeleted: '1'
      });
      await this.client.del(taskKey);
      return true;
    } catch (removeError) {
      this.joskInstance.__errorHandler(removeError, '[remove] removeError:', 'Exception inside RedisAdapter#remove() method', uid);
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
    const taskKey = this.__getTaskKey(uid);

    try {
      const exists = await this.client.exists(taskKey);
      const next = Date.now() + delay;
      if (!exists) {
        await this.client.hSet(taskKey, {
          uid: uid,
          delay: `${delay}`,
          executeAt: `${next}`,
          isInterval: isInterval ? '1' : '0',
          isDeleted: '0'
        });
        return true;
      }
      const task = await this.client.hGetAll(taskKey);
      if (+task.isDeleted) {
        return false;
      }

      let update = null;
      if (+task.delay !== delay) {
        update = { delay };
      }

      if (+task.executeAt !== next) {
        if (!update) {
          update = {};
        }
        update.executeAt = next;
      }

      if (update) {
        await this.client.hSet(taskKey, update);
      }
      return false;
    } catch(opError) {
      this.joskInstance.__errorHandler(opError, '[add] [exist] [opError]', 'Exception inside RedisAdapter#add() method', uid);
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

    const taskKey = this.__getTaskKey(task.uid);
    try {
      const exists = await this.client.exists(taskKey);
      if (!exists) {
        return false;
      }
      await this.client.hSet(taskKey, {
        executeAt: `${+nextExecuteAt}`
      });
      return true;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[RedisAdapter] [update] [opError]', 'Exception inside RedisAdapter#update() method', task.uid);
      return false;
    }
  }

  /**
   * @param {Date} nextExecuteAt
   * @returns {Promise<void>}
   */
  async iterate(nextExecuteAt) {
    const now = Date.now();
    const nextRetry = +nextExecuteAt;

    const cursor = this.client.scanIterator({
      TYPE: 'hash',
      MATCH: this.__getTaskKey('*'),
      COUNT: 9999,
    });

    for await (const taskKey of cursor) {
      const task = await this.client.hGetAll(taskKey);
      if (+task.executeAt <= now) {
        await this.client.hSet(taskKey, {
          executeAt: `${nextRetry}`
        });
        this.joskInstance.__execute(/** @type {RedisTask} */ ({
          uid: task.uid,
          delay: +task.delay,
          executeAt: +task.executeAt,
          isInterval: !!+task.isInterval,
          isDeleted: !!+task.isDeleted,
        }));
      }
    }
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
 * @typedef {object} PostgresClient
 * @property {(queryText: string, values?: unknown[]) => Promise<PostgresQueryResult>} query
 */

/**
 * @typedef {import('../index.js').JoSk} JoSk
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

/** Class representing PostgreSQL adapter for JoSk */
class PostgresAdapter {
  /**
   * Create a PostgresAdapter instance
   * @param {PostgresAdapterOption} opts - configuration object
   */
  constructor (opts = {}) {
    this.name = 'postgres';
    this.prefix = (typeof opts.prefix === 'string' && opts.prefix.length > 0) ? opts.prefix : 'default';
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

    // Setup DB tables asynchronously
    this._setupTables();

    if (this.resetOnInit) {
      process.nextTick(async () => {
        try {
          await this.client.query('DELETE FROM josk_tasks WHERE prefix = $1', [this.prefix]);
          await this.client.query('DELETE FROM josk_locks WHERE lock_key = $1', [this.lockKey]);
        } catch (resetErr) {
          console.error('[josk] [PostgresAdapter] [resetOnInit] error:', resetErr);
        }
      });
    }
  }

  /** @internal */
  async _setupTables () {
    process.nextTick(async () => {
      try {
        await this.client.query(`
          CREATE TABLE IF NOT EXISTS josk_tasks (
            uid TEXT PRIMARY KEY,
            prefix TEXT NOT NULL DEFAULT 'default',
            delay INTEGER NOT NULL,
            execute_at BIGINT NOT NULL,
            is_interval BOOLEAN NOT NULL DEFAULT false,
            is_deleted BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await this.client.query(`
          CREATE INDEX IF NOT EXISTS idx_josk_tasks_prefix_execute 
          ON josk_tasks (prefix, execute_at) 
          WHERE is_deleted = false;
        `);
        await this.client.query('CREATE INDEX IF NOT EXISTS idx_josk_tasks_uid ON josk_tasks (uid);');

        await this.client.query(`
          CREATE TABLE IF NOT EXISTS josk_locks (
            lock_key TEXT PRIMARY KEY,
            locked_until BIGINT,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
          )
        `);
        this.joskInstance?._debug('[PostgresAdapter] tables ready');
      } catch (setupErr) {
        console.error('[josk] [PostgresAdapter] [_setupTables] error:', setupErr);
      }
    });
  }

  /**
   * @async
   * @memberOf PostgresAdapter
   * @name ping
   * @description Check connection to PostgreSQL
   * @returns {Promise<AdapterPingResult>}
   */
  async ping () {
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
   * @returns {Promise<boolean>}
   */
  async acquireLock () {
    const now = Date.now();
    const until = now + this.joskInstance.zombieTime;
    try {
      // Try update if expired or no lock
      let res = await this.client.query(
        `UPDATE josk_locks 
         SET locked_until = $2, updated_at = CURRENT_TIMESTAMP 
         WHERE lock_key = $1 
           AND (locked_until IS NULL OR locked_until < $3) 
         RETURNING locked_until`,
        [this.lockKey, until, now]
      );
      if (res.rowCount > 0) {
        return true;
      }

      // Insert new lock
      res = await this.client.query(
        `INSERT INTO josk_locks (lock_key, locked_until) 
         VALUES ($1, $2) 
         ON CONFLICT (lock_key) DO NOTHING 
         RETURNING locked_until`,
        [this.lockKey, until]
      );
      return res.rowCount > 0;
    } catch (lockError) {
      this.joskInstance.__errorHandler(lockError, '[PostgresAdapter] [acquireLock]', 'Failed to acquire lock', null);
      return false;
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async releaseLock () {
    try {
      await this.client.query(
        `UPDATE josk_locks 
         SET locked_until = NULL, updated_at = CURRENT_TIMESTAMP 
         WHERE lock_key = $1`,
        [this.lockKey]
      );
    } catch (releaseError) {
      // Non-critical, log via debug if possible
      this.joskInstance?._debug('[PostgresAdapter] [releaseLock] non-critical error:', releaseError);
    }
  }

  /**
   * @param {string} uid
   * @returns {Promise<boolean>}
   */
  async remove (uid) {
    try {
      const res = await this.client.query(
        `UPDATE josk_tasks 
         SET is_deleted = true, updated_at = CURRENT_TIMESTAMP 
         WHERE uid = $1 AND prefix = $2 
         RETURNING uid`,
        [uid, this.prefix]
      );
      const removed = res.rowCount > 0;
      return removed;
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
  async add (uid, isInterval, delay) {
    const executeAt = Date.now() + delay;
    try {
      await this.client.query(
        `INSERT INTO josk_tasks (uid, prefix, delay, execute_at, is_interval, is_deleted)
         VALUES ($1, $2, $3, $4, $5, false)
         ON CONFLICT (uid) DO UPDATE SET 
           delay = EXCLUDED.delay,
           execute_at = EXCLUDED.execute_at,
           is_interval = EXCLUDED.is_interval,
           is_deleted = false,
           updated_at = CURRENT_TIMESTAMP`,
        [uid, this.prefix, delay, executeAt, isInterval]
      );
      return true;
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
  async update (task, nextExecuteAt) {
    if (typeof task !== 'object' || typeof task.uid !== 'string') {
      this.joskInstance.__errorHandler({ task }, '[PostgresAdapter] [update] [task]', 'Task malformed or undefined');
      return false;
    }

    if (!(nextExecuteAt instanceof Date)) {
      this.joskInstance.__errorHandler({ nextExecuteAt }, '[PostgresAdapter] [update] [nextExecuteAt]', 'Next execution date is malformed or undefined', task.uid);
      return false;
    }

    try {
      const res = await this.client.query(
        `UPDATE josk_tasks 
         SET execute_at = $1, updated_at = CURRENT_TIMESTAMP 
         WHERE uid = $2 AND prefix = $3 AND is_deleted = false 
         RETURNING uid`,
        [+nextExecuteAt, task.uid, this.prefix]
      );
      return res.rowCount > 0;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[PostgresAdapter] [update] [opError]', 'Exception inside update method', task.uid);
      return false;
    }
  }

  /**
   * @param {Date} nextExecuteAt
   * @returns {Promise<void>}
   */
  async iterate (nextExecuteAt) {
    const now = Date.now();
    const nextRetry = +nextExecuteAt;

    try {
      const res = await this.client.query(
        `SELECT uid, delay, execute_at, is_interval, is_deleted 
         FROM josk_tasks 
         WHERE prefix = $1 
           AND is_deleted = false 
           AND execute_at <= $2 
         ORDER BY execute_at ASC`,
        [this.prefix, now]
      );

      for (const row of /** @type {PostgresTask[]} */ (res.rows || [])) {
        // Lock task by advancing execute_at to zombie time
        await this.update({ uid: row.uid }, new Date(nextRetry));

        // Execute via JoSk
        this.joskInstance.__execute({
          uid: row.uid,
          delay: parseInt(row.delay, 10),
          executeAt: parseInt(row.execute_at, 10),
          isInterval: row.is_interval,
          isDeleted: row.is_deleted
        });
      }
    } catch (iterError) {
      this.joskInstance.__errorHandler(iterError, '[PostgresAdapter] [iterate]', 'Exception inside iterate method', null);
    }
  }

  /** @internal */
  __customPrivateMethod () {
    // private methods prefixed with __ as per adapter convention
    return true;
  }
}

const prefixRegex = /set(Immediate|Timeout|Interval)$/;

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
 * @callback JoSkOnError
 * @param {string} title
 * @param {JoSkErrorDetails} details
 * @returns {void}
 */

/**
 * @callback JoSkOnExecuted
 * @param {string} uid
 * @param {JoSkExecutedDetails} details
 * @returns {void}
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
 * @returns {void | Promise<void>}
 */

/**
 * @typedef {JoSkTaskHandler & { isMissing?: boolean }} JoSkStoredTask
 */

/**
 * @typedef {object} JoSkAdapter
 * @property {JoSk | undefined} [joskInstance]
 * @property {() => Promise<boolean>} acquireLock
 * @property {() => Promise<void>} releaseLock
 * @property {(uid: string) => Promise<boolean>} remove
 * @property {(uid: string, isInterval: boolean, delay: number) => Promise<boolean | void>} add
 * @property {(task: JoSkTask, nextExecuteAt: Date) => Promise<boolean>} update
 * @property {(nextExecuteAt: Date) => Promise<void>} iterate
 * @property {() => Promise<JoSkPingResult>} ping
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
 */

const errors = {
  setInterval: {
    func: '[josk] [setInterval] the first argument must be a function!',
    delay: '[josk] [setInterval] delay must be positive Number!',
    uid: '[josk] [setInterval] [uid - task id must be specified (3rd argument)]'
  },
  setTimeout: {
    func: '[josk] [setTimeout] the first argument must be a function!',
    delay: '[josk] [setTimeout] delay must be positive Number!',
    uid: '[josk] [setTimeout] [uid - task id must be specified (3rd argument)]'
  },
  setImmediate: {
    func: '[josk] [setImmediate] the first argument must be a function!',
    uid: '[josk] [setImmediate] [uid - task id must be specified (2nd argument)]'
  },
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
    /** @internal */
    this.nextRevolutionTimeout = null;

    if (!opts.adapter || typeof opts.adapter !== 'object') {
      throw new Error('{adapter} option is required for JoSk', {
        description: 'JoSk requires MongoAdapter, RedisAdapter, or CustomAdapter to connect to an intermediate database'
      });
    }

    /** @type {Record<string, JoSkStoredTask>} */
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
   * @throws {mix}
   */
  async ping() {
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

    if (delay < 0) {
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
   * Create delayed task
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

    if (delay < 0) {
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
   * Create task, which would get executed immediately and only once across multi-server setup
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
   * @param {function} [callback] - optional callback
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
   * @param {function} [callback] - optional callback
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
      if (this.nextRevolutionTimeout) {
        clearTimeout(this.nextRevolutionTimeout);
        this.nextRevolutionTimeout = null;
      }
      return true;
    }
    return false;
  }

  /** @internal */
  __checkState() {
    if (this.isDestroyed) {
      if (this.onError) {
        const reason = 'JoSk instance destroyed';
        this.onError(reason, {
          description: 'invoking methods of destroyed JoSk instance',
          error: new Error(reason),
          uid: null
        });
      } else {
        this._debug('[__checkState] [warn] invoking methods of destroyed JoSk instance, call cause no action');
      }
      return true;
    }
    return false;
  }

  /** @internal */
  async __remove(timerId) {
    if (typeof timerId !== 'string') {
      return false;
    }

    const isRemoved = await this.adapter.remove(timerId);
    if (isRemoved && this.tasks?.[timerId]) {
      delete this.tasks[timerId];
    }
    return isRemoved;
  }

  /** @internal */
  async __add(uid, isInterval, delay) {
    if (this.isDestroyed) {
      return;
    }

    await this.adapter.add(uid, isInterval, delay);
  }

  /**
   * @internal
   * @param {JoSkTask} task
   * @returns {Promise<void>}
   */
  async __execute(task) {
    if (this.isDestroyed || task.isDeleted === true) {
      return;
    }

    if (!task || typeof task !== 'object' || typeof task.uid !== 'string') {
      if (this.onError) {
        this.onError('JoSk#__execute received malformed task', {
          description: 'Something went wrong with one of your tasks - malformed or undefined',
          error: null,
          task: task,
          uid: task.uid,
        });
      } else {
        this._debug('[__execute] received malformed task', task);
      }
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
          this.onExecuted(task.uid.replace(prefixRegex, ''), {
            uid: task.uid,
            date: date,
            delay: task.delay,
            timestamp: timestamp
          });
        }

        return true;
      };

      let hasError;
      let returnedPromise;
      try {
        if (task.isInterval === false) {
          const originalTask = this.tasks[task.uid];
          let isRemoved = false;
          try {
            isRemoved = await this.__remove(task.uid);
          } catch (removeError) {
            this._debug(`[${task.uid}] [__execute] [__remove] has thrown an exception; Check connection with StorageAdapter; removeError:`, removeError);
          }

          if (isRemoved === true) {
            returnedPromise = originalTask(ready);
          }
        } else {
          returnedPromise = this.tasks[task.uid](ready);
        }

        if (returnedPromise && returnedPromise instanceof Promise) {
          await returnedPromise;
        } else {
          return;
        }
      } catch (taskExecError) {
        hasError = true;
        this.__errorHandler(taskExecError, 'Exception during task execution', 'An exception was thrown during task execution', task.uid);
      }

      if ((returnedPromise && returnedPromise instanceof Promise) || (executionsQty === 0 && hasError)) {
        try {
          await ready();
        } catch (readyErr) {
          this._debug(`[${task.uid}] [__execute] [ready] has thrown an exception; readyErr:`, readyErr);
        }
      }
      return;
    }

    await this.adapter.update(task, new Date(Date.now() + this.zombieTime));
    this.tasks[task.uid] = /** @type {JoSkStoredTask} */ (function () { });
    this.tasks[task.uid].isMissing = true;

    if (this.autoClear) {
      try {
        await this.__remove(task.uid);
        this._debug(`[FYI] [${task.uid}] task was auto-cleared`);
      } catch (removeError) {
        this._debug(`[${task.uid}] [__execute] [this.autoClear] [__remove] has thrown an exception; removeError:`, removeError);
      }
    } else if (this.onError) {
      this.onError('One of your tasks is missing', {
        description: `Something went wrong with one of your tasks - is missing.
          Try to use different instances.
          It's safe to ignore this message.
          If this task is obsolete - simply remove it with \`JoSk#clearTimeout('${task.uid}')\`,
          or enable autoClear with \`new JoSk({autoClear: true})\``,
        error: null,
        uid: task.uid
      });
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

    const nextExecuteAt = new Date(Date.now() + this.zombieTime);

    try {
      const isAcquired = await this.adapter.acquireLock();
      if (isAcquired) {
        await this.adapter.iterate(nextExecuteAt);
        await this.adapter.releaseLock();
      }
      this.__tick();
    } catch (runError) {
      this.__errorHandler(runError, '[__iterate] runError:', 'adapter.iterate has returned an error', null);
    }
  }

  /** @internal */
  __tick() {
    if (this.isDestroyed) {
      return;
    }

    this.nextRevolutionTimeout = setTimeout(this.__iterate.bind(this), Math.round((Math.random() * this.maxRevolvingDelay) + this.minRevolvingDelay));
  }

  /** @internal */
  __errorHandler(error, title, description, uid) {
    if (error) {
      if (this.onError) {
        this.onError(title, { description, error, uid });
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
