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
 * @returns {void 0}
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
   * @param {object} opts - configuration object
   * @param {Db} opts.db - Required, Mongo's `Db` instance, like one returned from `MongoClient#db()` method
   * @param {string} [opts.lockCollectionName] - custom "lock" collection name
   * @param {string} [opts.prefix] - prefix for scope isolation; use when creating multiple JoSK instances within the single application
   * @param {boolean} [opts.resetOnInit] - Make sure all old tasks is completed before setting a new one, see readme for more details
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

    this.db = opts.db;
    this.uniqueName = `__JobTasks__${this.prefix}`;
    this.collection = opts.db.collection(this.uniqueName);
    ensureIndex(this.collection, {uid: 1}, {background: false, unique: true});
    ensureIndex(this.collection, {uid: 1, isDeleted: 1}, {background: false});
    ensureIndex(this.collection, {executeAt: 1}, {background: false});

    this.lockCollection = opts.db.collection(this.lockCollectionName);
    ensureIndex(this.lockCollection, {expireAt: 1}, {background: false, expireAfterSeconds: 1});
    ensureIndex(this.lockCollection, {uniqueName: 1}, {background: false, unique: true});

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
   * @returns {Promise<object>}
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

  async releaseLock() {
    await this.lockCollection.deleteOne({ uniqueName: this.uniqueName });
  }

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

  async update(task, nextExecuteAt) {
    if (typeof task !== 'object' || typeof task.uid !== 'string') {
      this.joskInstance.__errorHandler({ task }, '[MongoAdapter] [update] [task]', 'Task malformed or undefined');
      return false;
    }

    if (!nextExecuteAt instanceof Date) {
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
      this.joskInstance.__errorHandler(opError, '[MongoAdapter] [update] [opError]', 'Exception inside RedisAdapter#update() method', task.uid);
      return false;
    }
  }

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
      this.joskInstance.__execute(task);
    }

    await cursor.close();
  }
}

export { MongoAdapter };
