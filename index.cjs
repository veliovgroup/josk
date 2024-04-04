'use strict';

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

/** Class representing Redis adapter for JoSk */
class RedisAdapter {
  /**
   * Create a RedisAdapter instance
   * @param {JoSk} joskInstance - JoSk instance
   * @param {object} opts - configuration object
   * @param {RedisClient} opts.client - Required, Redis'es `RedisClient` instance, like one returned from `await redis.createClient().connect()` method
   * @param {string} [opts.lockCollectionName] - custom "lock" collection name
   * @param {string} [opts.prefix] - prefix for scope isolation
   */
  constructor(joskInstance, opts = {}) {
    this.name = 'redis';
    this.joskInstance = joskInstance;
    this.prefix = opts.prefix || 'default';
    this.uniqueName = `josk:${this.prefix}`;
    this.lockKey = `${this.uniqueName}:lock`;

    if (!opts.client) {
      throw new Error('{client} option is required for RedisAdapter', {
        description: 'Redis database requires {client} option, e.g. returned from `redis.createClient()` or `redis.createCluster()` method'
      });
    }

    this.client = opts.client;
    if (this.joskInstance.resetOnInit) {
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

  acquireLock(cb) {
    this.client.exists([this.lockKey]).then((isLocked) => {
      if (isLocked >= 1) {
        cb(void 0, false);
      } else {
        this.client.set(this.lockKey, `${Date.now() + this.joskInstance.zombieTime}`, {
          PX: this.joskInstance.zombieTime,
          NX: true
        }).then((res) => {
          cb(void 0, res === 'OK');
        }).catch(cb);
      }
    }).catch(cb);
  }

  releaseLock(cb) {
    this.client.del(this.lockKey).then(() => {
      cb();
    }).catch(cb);
  }

  clear(uid, cb) {
    const taskKey = this.__getTaskKey(uid);
    this.client.hSet(taskKey, {
      isDeleted: '1'
    }).then(() => {
      this.client.del(taskKey).then(() => {
        cb(void 0, true);
      }).catch((deleteError) => {
        cb(deleteError, false);
      });
    }).catch((updateError) => {
      this.joskInstance.__errorHandler(updateError, '[clear] [hSet] updateError:', 'Error in a .catch() of hSet method of .clear()', uid);
      cb(updateError, false);
    });
  }

  addTask(uid, isInterval, delay) {
    const taskKey = this.__getTaskKey(uid);

    this.client.exists([taskKey]).then((exists) => {
      const next = Date.now() + delay;
      if (!exists) {
        this.client.hSet(taskKey, {
          uid: uid,
          delay: `${delay}`,
          executeAt: `${next}`,
          isInterval: isInterval ? '1' : '0',
          isDeleted: '0'
        }).then(() => {}).catch((insertError) => {
          this.joskInstance.__errorHandler(insertError, '[addTask] [hSet] insertError:', 'Error in a .catch() of .hSet() method of .addTask()', uid);
        });
      } else {
        this.client.hGetAll(taskKey).then((task) => {
          if (+task.isDeleted) {
            return;
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
            this.client.hSet(taskKey, update).then(() => {}).catch((updateError) => {
              this.joskInstance.__errorHandler(updateError, '[addTask] [hSet] updateError', 'Error in a .catch() of .hSet() method of .addTask()', uid);
            });
          }
        }).catch((findError) => {
          this.joskInstance.__errorHandler(findError, '[addTask] [exist] findError:', 'Error in a .catch() of .hGetAll() method of .addTask()', uid);
        });
      }
    }).catch((existError) => {
      this.joskInstance.__errorHandler(existError, '[addTask] [exist] existError:', 'Error in a .catch() of .exists() method of .addTask()', uid);
    });
  }

  getDoneCallback(task) {
    return (nextExecuteAt, readyCallback) => {
      this.client.hSet(this.__getTaskKey(task.uid), {
        executeAt: `${+nextExecuteAt}`
      }).then(() => {
        typeof readyCallback === 'function' && readyCallback(void 0, true);
      }).catch((updateError) => {
        typeof readyCallback === 'function' && readyCallback(updateError);
        this.joskInstance.__errorHandler(updateError, '[getDoneCallback] [done] [hSet] updateError:', 'Error in a .catch() of .hSet() method of .getDoneCallback()', task.uid);
      });
    };
  }

  runTasks(nextExecuteAt, cb) {
    const now = Date.now();
    const nextRetry = +nextExecuteAt;

    process.nextTick(async () => {
      try {
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
            this.joskInstance.__execute({
              uid: task.uid,
              delay: +task.delay,
              executeAt: +task.executeAt,
              isInterval: !!+task.isInterval,
              isDeleted: !!+task.isDeleted,
            });
          }
        }
        cb();
      } catch (scanError) {
        cb(scanError);
      }
    });
  }

  __getTaskKey(uid) {
    return `${this.uniqueName}:task:${uid}`;
  }
}

const prefixRegex = /set(Immediate|Timeout|Interval)$/;

const errors = {
  setInterval: {
    delay: '[josk] [setInterval] delay must be positive Number!',
    uid: '[josk] [setInterval] [uid - task id must be specified (3rd argument)]'
  },
  setTimeout: {
    delay: '[josk] [setTimeout] delay must be positive Number!',
    uid: '[josk] [setTimeout] [uid - task id must be specified (3rd argument)]'
  },
  setImmediate: {
    uid: '[josk] [setImmediate] [uid - task id must be specified (2nd argument)]'
  }
};

/** Class representing a JoSk task runner (cron). */
class JoSk {
  /**
   * Create a JoSk instance
   * @param {object} opts - configuration object
   * @param {boolean} [opts.debug] - Enable debug logging
   * @param {string} [opts.prefix] - prefix, use when creating multiple JoSK instances per single app
   * @param {function} [opts.onError] - Informational hook, called instead of throwing exceptions, see readme for more details
   * @param {boolean} [opts.autoClear] - Remove obsolete tasks (any tasks which are not found in the instance memory during runtime, but exists in the database)
   * @param {number} [opts.zombieTime] - Time in milliseconds, after this period of time - task will be interpreted as "zombie". This parameter allows to rescue task from "zombie mode" in case when: `ready()` wasn't called, exception during runtime was thrown, or caused by bad logic
   * @param {function} [opts.onExecuted] - Informational hook, called when task is finished, see readme for more details
   * @param {boolean} [opts.resetOnInit] - Make sure all old tasks is completed before setting a new one, see readme for more details
   * @param {number} [opts.minRevolvingDelay] - Minimum revolving delay — the minimum delay between tasks executions in milliseconds
   * @param {number} [opts.maxRevolvingDelay] - Maximum revolving delay — the maximum delay between tasks executions in milliseconds
   */
  constructor(opts = {}) {
    this.debug = opts.debug || false;
    this.prefix = opts.prefix || '';
    this.onError = opts.onError || false;
    this.autoClear = opts.autoClear || false;
    this.zombieTime = opts.zombieTime || 900000;
    this.onExecuted = opts.onExecuted || false;
    this.resetOnInit = opts.resetOnInit || false;
    this.isDestroyed = false;
    this.minRevolvingDelay = opts.minRevolvingDelay || 128;
    this.maxRevolvingDelay = opts.maxRevolvingDelay || 768;
    this.nextRevolutionTimeout = null;

    if (!opts.adapter) {
      throw new Error('{adapter} option is required for JoSk', {
        description: 'JoSk requires MongoAdapter, RedisAdapter, or CustomAdapter to connect to an intermediate database'
      });
    }

    this.tasks = {};

    this._debug = (...args) => {
      this.debug === true && console.info.call(console, '[DEBUG] [josk]', ...args);
    };

    this.adapter = new opts.adapter(this, opts);
    const adapterMethods = ['acquireLock', 'releaseLock', 'clear', 'addTask', 'getDoneCallback', 'runTasks'];

    for (let i = adapterMethods.length - 1; i >= 0; i--) {
      if (typeof this.adapter[adapterMethods[i]] !== 'function') {
        throw new Error(`{adapter} is missing {${adapterMethods[i]}} method that is required!`);
      }
    }

    this.__setNext();
  }

  /**
   * Create recurring task (loop)
   * @name setInterval
   * @param {function} func - Function (task) to execute
   * @param {number} delay - Delay between task execution in milliseconds
   * @param {string} _uid - Unique function (task) identification as a string
   * @returns {string} - Timer ID
   */
  setInterval(func, delay, _uid) {
    if (this.__checkState()) {
      return '';
    }

    let uid = _uid;

    if (delay < 0) {
      throw new Error(errors.setInterval.delay);
    }

    if (uid) {
      uid += 'setInterval';
    } else {
      throw new Error(errors.setInterval.uid);
    }

    this.tasks[uid] = func;
    this.__addTask(uid, true, delay);
    return uid;
  }

  /**
   * Create delayed task
   * @name setTimeout
   * @param {function} func - Function (task) to execute
   * @param {number} delay - Delay before task execution in milliseconds
   * @param {string} _uid - Unique function (task) identification as a string
   * @returns {string} - Timer ID
   */
  setTimeout(func, delay, _uid) {
    if (this.__checkState()) {
      return '';
    }

    let uid = _uid;

    if (delay < 0) {
      throw new Error(errors.setTimeout.delay);
    }

    if (uid) {
      uid += 'setTimeout';
    } else {
      throw new Error(errors.setTimeout.uid);
    }

    this.tasks[uid] = func;
    this.__addTask(uid, false, delay);
    return uid;
  }

  /**
   * Create task, which would get executed immediately and only once across multi-server setup
   * @name setImmediate
   * @param {function} func - Function (task) to execute
   * @param {string} _uid - Unique function (task) identification as a string
   * @returns {string} - Timer ID
   */
  setImmediate(func, _uid) {
    if (this.__checkState()) {
      return '';
    }

    let uid = _uid;

    if (uid) {
      uid += 'setImmediate';
    } else {
      throw new Error(errors.setImmediate.uid);
    }

    this.tasks[uid] = func;
    this.__addTask(uid, false, 0);
    return uid;
  }

  /**
   * Cancel (abort) current interval timer.
   * Must be called in a separate event loop from `.setInterval()`
   * @name clearInterval
   * @param {string} timerId - Unique function (task) identification as a string, returned from `.setInterval()`
   * @param {function} [callback] - optional callback
   * @returns {boolean} - `true` if task cleared, `false` if task doesn't exist
   */
  clearInterval() {
    return this.__clear.apply(this, arguments);
  }

  /**
   * Cancel (abort) current timeout timer.
   * Must be called in a separate event loop from `.setTimeout()`
   * @name clearTimeout
   * @param {string} timerId - Unique function (task) identification as a string, returned from `.setTimeout()`
   * @param {function} [callback] - optional callback
   * @returns {boolean} - `true` if task cleared, `false` if task doesn't exist
   */
  clearTimeout() {
    return this.__clear.apply(this, arguments);
  }

  /**
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

  __checkState() {
    if (this.isDestroyed) {
      if (this.onError) {
        this.onError('JoSk instance destroyed', {
          description: 'invoking methods of destroyed JoSk instance',
          error: 'JoSk instance destroyed',
          uid: null
        });
      } else {
        this._debug('[__checkState] [warn] invoking methods of destroyed JoSk instance, call cause no action');
      }
      return true;
    }
    return false;
  }

  __clear(uid, callback) {
    if (!uid) {
      typeof callback === 'function' && callback(new TypeError('{string} uid is not defined'), false);
      return false;
    }

    this.adapter.clear(uid, (clearError, isRemoved) => {
      if (clearError) {
        this.__errorHandler(clearError, '[__clear] [adapter.clear] clearError:', 'adapter.clear has returned an error', uid);
      } else if (isRemoved && this.tasks && this.tasks[uid]) {
        delete this.tasks[uid];
      }

      typeof callback === 'function' && callback(clearError, isRemoved);
    });
    return true;
  }

  __addTask(uid, isInterval, delay) {
    if (this.isDestroyed) {
      return;
    }

    this.adapter.addTask(uid, isInterval, delay);
  }

  __execute(task) {
    if (this.isDestroyed || task.isDeleted === true) {
      return;
    }

    const done = this.adapter.getDoneCallback(task);

    if (this.tasks && typeof this.tasks[task.uid] === 'function') {
      if (this.tasks[task.uid].isMissing === true) {
        return;
      }

      const ready = (readyCallback) => {
        const date = new Date();
        const timestamp = +date;

        if (task.isInterval === true) {
          done(new Date(timestamp + task.delay), readyCallback);
        } else {
          typeof readyCallback === 'function' && readyCallback(void 0, true);
        }

        if (this.onExecuted) {
          this.onExecuted(task.uid.replace(prefixRegex, ''), {
            uid: task.uid,
            date: date,
            delay: task.delay,
            timestamp: timestamp
          });
        }
      };

      if (task.isInterval === false) {
        const originalTask = this.tasks[task.uid];
        this.__clear(task.uid, (error, isSuccess) => {
          if (!error && isSuccess === true) {
            originalTask(ready);
          }
        });
      } else {
        this.tasks[task.uid](ready);
      }
    } else {
      done(new Date(Date.now() + this.zombieTime));
      this.tasks[task.uid] = function () { };
      this.tasks[task.uid].isMissing = true;

      if (this.autoClear) {
        this.__clear(task.uid);
        this._debug(`[FYI] [${task.uid}] task was auto-cleared`);
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
  }

  __runTasks() {
    if (this.isDestroyed) {
      return;
    }

    const nextExecuteAt = new Date(Date.now() + this.zombieTime);

    this.adapter.acquireLock((lockError, success) => {
      if (lockError) {
        this._debug('[__runTasks] [adapter.acquireLock] Error:', lockError);
        this.__setNext();
      } else if (!success) {
        this.__setNext();
      } else {
        this.adapter.runTasks(nextExecuteAt, (runError) => {
          if (runError) {
            this.__errorHandler(runError, '[__runTasks] runError:', 'adapter.runTasks has returned an error', null);
          }

          this.adapter.releaseLock((releaseError) => {
            this.__setNext();
            if (releaseError) {
              this._debug('[__runTasks] [adapter.releaseLock] releaseError:', releaseError);
            }
          });
        });
      }
    });
  }

  __setNext() {
    if (this.isDestroyed) {
      return;
    }

    this.nextRevolutionTimeout = setTimeout(this.__runTasks.bind(this), Math.round((Math.random() * this.maxRevolvingDelay) + this.minRevolvingDelay));
  }

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
exports.RedisAdapter = RedisAdapter;
