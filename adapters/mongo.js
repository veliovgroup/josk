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
const ensureIndex = async (collection, spec) => {
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
      usable = found.unique === true && !found.partialFilterExpression;
    } else if (!spec.plain) {
      usable = typeof found.expireAfterSeconds === 'number' && !found.partialFilterExpression;
    }

    if (usable && spec.plain && (found.partialFilterExpression || found.hidden)) {
      console.warn(`[josk] [MongoAdapter] adopted index "${found.name}" on "${collection.collectionName}" is ${found.hidden ? 'hidden' : 'partial'}; the due-task scan may not use it`);
    }

    if (!usable) {
      if (spec.dropNonUnique && found.unique !== true && typeof found.expireAfterSeconds !== 'number') {
        // A non-unique index protects nothing, replacing it opens no duplicate window.
        // Never drop when duplicates exist: the unique index could not be built afterwards.
        const key = Object.keys(spec.keys)[0];
        const duplicates = await collection.aggregate([{ $group: { _id: `$${key}`, n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }, { $limit: 1 }]).toArray();
        if (duplicates.length > 0) {
          throw new Error(`[josk] [MongoAdapter] duplicate "${key}" documents in "${collection.collectionName}"; index "${found.name}" was kept. Dedupe the collection before starting JoSk 6 (see docs/mongodb.md).`);
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

      throw new Error(`[josk] [MongoAdapter] index "${found.name}" on "${collection.collectionName}" has the key ${JSON.stringify(spec.keys)} but is not ${spec.unique ? 'a plain unique index' : 'a TTL index'}. JoSk never drops indexes it can not replace safely. Drop or fix this index manually, or set a separate {lockCollectionName}.`);
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
      throw new Error(`[josk] [MongoAdapter] duplicate "${Object.keys(spec.keys)[0]}" documents in "${collection.collectionName}"; dedupe before starting JoSk 6 (see docs/mongodb.md)`);
    }

    const conflict = error?.code === 85 || error?.code === 86 || error?.codeName === 'IndexOptionsConflict' || error?.codeName === 'IndexKeySpecsConflict' || error?.code === 68 || error?.codeName === 'IndexAlreadyExists';
    if (!conflict || !(await check())) {
      throw error;
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

export { MongoAdapter };
