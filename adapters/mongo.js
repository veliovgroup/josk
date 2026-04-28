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
    this.prefix = typeof opts.prefix === 'string' ? opts.prefix : '';
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
    await this.lockCollection.deleteOne({
      uniqueName: this.uniqueName,
      ownerId: lock.ownerId,
      leaseId: lock.leaseId
    });
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
      return updateResult?.modifiedCount >= 1;
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

    while (true) {
      const tasks = await this.__claimNextTasks(nextExecuteAt, lock, 100);
      if (tasks.length === 0) {
        break;
      }

      executed += tasks.length;
      for (const task of tasks) {
        this.joskInstance.__execute(task);
      }
    }

    return executed;
  }

  /**
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

export { MongoAdapter };
