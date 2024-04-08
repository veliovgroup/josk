const mongoErrorHandler = (error) => {
  if (error) {
    console.error('[josk] [MongoAdapter] [mongoErrorHandler]:', error);
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
      console.info(`[INFO] [josk] [MongoAdapter] [ensureIndex] Can not set ${Object.keys(keys).join(' + ')} index on "${collection._name}" collection`, { keys, opts, details: e });
    }
  }
};

/** Class representing MongoDB adapter for JoSk */
class MongoAdapter {
  /**
   * Create a MongoAdapter instance
   * @param {JoSk} joskInstance - JoSk instance
   * @param {object} opts - configuration object
   * @param {Db} opts.db - Required, Mongo's `Db` instance, like one returned from `MongoClient#db()` method
   * @param {string} [opts.lockCollectionName] - custom "lock" collection name
   * @param {string} [opts.prefix] - prefix for scope isolation
   */
  constructor(joskInstance, opts = {}) {
    this.name = 'mongo';
    this.joskInstance = joskInstance;
    this.prefix = opts.prefix || '';
    this.lockCollectionName = opts.lockCollectionName || '__JobTasks__.lock';

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

    if (this.joskInstance.resetOnInit) {
      this.collection.deleteMany({
        isInterval: false
      }).then(() => {}).catch(mongoErrorHandler);

      this.lockCollection.deleteMany({
        uniqueName: this.uniqueName
      }).then(() => {}).catch(mongoErrorHandler);
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

  acquireLock(cb) {
    const expireAt = new Date(Date.now() + this.joskInstance.zombieTime);

    this.lockCollection.findOne({
      uniqueName: this.uniqueName
    }, {
      projection: {
        uniqueName: 1
      }
    }).then((record) => {
      if (record?.uniqueName === this.uniqueName) {
        cb(void 0, false);
      } else {
        this.lockCollection.insertOne({
          uniqueName: this.uniqueName,
          expireAt
        }).then((result) => {
          if (result.insertedId) {
            cb(void 0, true);
          } else {
            cb(void 0, false);
          }
        }).catch((insertError) => {
          if (insertError?.code === 11000) {
            cb(void 0, false);
          } else {
            cb(insertError);
          }
        });
      }
    }).catch((findError) => {
      cb(findError);
    });
  }

  releaseLock(cb) {
    this.lockCollection.deleteOne({ uniqueName: this.uniqueName }).then(() => {
      cb();
    }).catch((deleteOneError) => {
      cb(deleteOneError);
    });
  }

  clear(uid, cb) {
    this.collection.findOneAndUpdate({
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
    }).then((result) => {
      const res = result?._id ? result : result?.value; // mongodb 5 vs. 6 compatibility
      if (res?.isDeleted === false) {
        this.collection.deleteOne({ _id: res._id }).then((deleteResult) => {
          cb(void 0, deleteResult?.deletedCount >= 1);
        }).catch((deleteError) => {
          cb(deleteError, false);
        });
      } else {
        cb(void 0, false);
      }
    }).catch((findAndUpdateError) => {
      this.joskInstance.__errorHandler(findAndUpdateError, '[clear] [findAndUpdate] [findAndUpdateError]', 'Error in a callback of .findAndUpdate() method of .clear()', uid);
      cb(findAndUpdateError, false);
    });
  }

  addTask(uid, isInterval, delay) {
    this.collection.findOne({
      uid: uid
    }).then((task) => {
      const next = Date.now() + delay;
      if (!task) {
        this.collection.insertOne({
          uid: uid,
          delay: delay,
          executeAt: new Date(next),
          isInterval: isInterval,
          isDeleted: false
        }).then(() => {}).catch((insertError) => {
          this.joskInstance.__errorHandler(insertError, '[addTask] [insertOne] [insertError]', 'Error in a callback of .insertOne() method of .addTask()', uid);
        });
      } else if (task.isDeleted === false) {
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
          this.collection.updateOne({
            uid: uid
          }, {
            $set: update
          }).then(() => {}).catch((updateError) => {
            this.joskInstance.__errorHandler(updateError, '[addTask] [updateOne] [updateError]', 'Error in a callback of .updateOne() method of .addTask()', uid);
          });
        }
      }
    }).catch((findError) => {
      this.joskInstance.__errorHandler(findError, '[addTask] [findOne] [findError]', 'Error in a callback of .findOne() method of .addTask()', uid);
    });
  }

  getDoneCallback(task) {
    return (nextExecuteAt, readyCallback) => {
      this.collection.updateOne({
        uid: task.uid
      }, {
        $set: {
          executeAt: nextExecuteAt
        }
      }).then((updateResult) => {
        typeof readyCallback === 'function' && readyCallback(void 0, updateResult?.modifiedCount >= 1);
      }).catch((updateError) => {
        typeof readyCallback === 'function' && readyCallback(updateError);
        this.joskInstance.__errorHandler(updateError, '[getDoneCallback] [done] [updateOne] [updateError]', 'Error in a callback of .updateOne() method of .getDoneCallback()', task.uid);
      });
    };
  }

  runTasks(nextExecuteAt, callback) {
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

    cursor.forEach((task) => {
      _ids.push(task._id);
      tasks.push(task);
    }).then(() => {
      if (_ids.length) {
        this.collection.updateMany({
          _id: {
            $in: _ids
          }
        }, {
          $set: {
            executeAt: nextExecuteAt
          }
        }).then(() => {
          for (const task of tasks) {
            this.joskInstance.__execute(task);
          }
          callback();
        }).catch((updateError) => {
          callback(updateError);
        });
      } else {
        callback();
      }
    }).catch((forEachError) => {
      callback(forEachError);
    }).finally(() => {
      cursor.close();
    });
  }
}

export { MongoAdapter };
