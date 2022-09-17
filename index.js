const mongoErrorHandler = (error) => {
  if (error) {
    console.error('[josk] [mongoErrorHandler]:', error);
  }
};
const prefixRegex = /set(Immediate|Timeout|Interval)$/;

const errors = {
  dbOption: {
    error: '{db} option is required',
    description: 'MongoDB database {db} option is required, e.g. returned from `MongoClient.connect` method'
  },
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
      console.info(`[INFO] [josk] Can not set ${Object.keys(keys).join(' + ')} index on "${collection._name}" collection`, { keys, opts, details: e });
    }
  }
};

/** Class representing a JoSk task runner (cron). */
module.exports = class JoSk {
  /**
   * Create a Job-Task manager (CRON)
   * @param {object} opts - configuration object
   * @param {object} opts.db - Connection to MongoDB, like returned as argument from `MongoClient.connect()`
   * @param {boolean} [opts.db] - Enable debug logging
   * @param {string} [opts.prefix] - prefix, use when creating multiple JoSK instances per single app
   * @param {string} [opts.lockCollectionName] - Name for *.lock collection
   * @param {function} [opts.onError] - Informational hook, called instead of throwing exceptions, see readme for more details
   * @param {boolean} [opts.autoClear] - Remove obsolete tasks (any tasks which are not found in the instance memory during runtime, but exists in the database)
   * @param {number} [opts.zombieTime] - Time in milliseconds, after this period of time - task will be interpreted as "zombie". This parameter allows to rescue task from "zombie mode" in case when: `ready()` wasn't called, exception during runtime was thrown, or caused by bad logic
   * @param {function} [opts.onExecuted] - Informational hook, called when task is finished, see readme for more details
   * @param {boolean} [opts.resetOnInit] - Make sure all old tasks is completed before setting a new one, see readme for more details
   * @param {number} [opts.minRevolvingDelay] - Minimum revolving delay — the minimum delay between tasks executions in milliseconds
   * @param {number} [opts.maxRevolvingDelay] - Maximum revolving delay — the maximum delay between tasks executions in milliseconds
   * @param {string} [opts.participant.name] - Unique hostname within a cluster, default `os.hostname`
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
    this.lockCollectionName = opts.lockCollectionName || '__JobTasks__.lock';
    this.nextRevolutionTimeout = null;
    this.tasks = {};

    this._debug = (...args) => {
      this.debug === true && console.info.call(console, '[DEBUG] [josk]', ...args);
    };

    if (!opts.db) {
      if (this.onError) {
        this.onError(errors.dbOption.error, {
          description: errors.dbOption.description,
          error: errors.dbOption.error,
          uid: null
        });
      } else {
        this._debug(`[constructor] ${errors.dbOption.description}`);
      }
      return;
    }

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
      }, mongoErrorHandler);

      this.lockCollection.deleteMany({
        uniqueName: this.uniqueName
      }, mongoErrorHandler);
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

  __aquireLock(cb) {
    const expireAt = new Date(Date.now() + this.zombieTime);

    this.lockCollection.findOne({
      uniqueName: this.uniqueName
    }, {
      projection: {
        uniqueName: 1
      }
    }, (findError, record) => {
      if (findError) {
        cb(findError);
      } else if (record?.uniqueName === this.uniqueName) {
        cb(void 0, false);
      } else {
        this.lockCollection.insertOne({
          uniqueName: this.uniqueName,
          expireAt
        }, (insertError, result) => {
          if (insertError) {
            if (insertError?.code === 11000) {
              cb(void 0, false);
            } else {
              cb(insertError);
            }
          } else if (result.insertedId) {
            cb(void 0, true);
          } else {
            cb(void 0, false);
          }
        });
      }
    });
  }

  __releaseLock(cb) {
    this.lockCollection.deleteOne({ uniqueName: this.uniqueName }, cb);
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
    }, (findAndUpdateError, result) => {
      if (findAndUpdateError) {
        this.__errorHandler(findAndUpdateError, '[__clear] [findAndUpdate] [findAndUpdateError]', 'Error in a callback of .findAndUpdate() method of .__clear()', uid);
        typeof callback === 'function' && callback(findAndUpdateError, false);
      } else if (result?.value?.isDeleted === false) {
        this.collection.deleteOne({ _id: result.value._id }, (deleteError, deleteResult) => {
          this.__errorHandler(deleteError, '[__clear] [deleteOne] [deleteError]', 'Error in a callback of .deleteOne() method of .__clear()', uid);
          if (this.tasks && this.tasks[uid]) {
            delete this.tasks[uid];
          }
          typeof callback === 'function' && callback(deleteError, deleteResult?.deletedCount >= 1);
        });
      } else {
        typeof callback === 'function' && callback(void 0, false);
      }
    });

    return true;
  }

  __addTask(uid, isInterval, delay) {
    if (this.isDestroyed) {
      return;
    }

    this.collection.findOne({
      uid: uid
    }, (findError, task) => {
      const next = Date.now() + delay;
      if (findError) {
        this.__errorHandler(findError, '[__addTask] [findOne] [findError]', 'Error in a callback of .findOne() method of .__addTask()', uid);
      } else if (!task) {
        this.collection.insertOne({
          uid: uid,
          delay: delay,
          executeAt: new Date(next),
          isInterval: isInterval,
          isDeleted: false
        }, (insertError) => {
          this.__errorHandler(insertError, '[__addTask] [insertOne] [insertError]', 'Error in a callback of .insertOne() method of .__addTask()', uid);
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
          }, (updateError) => {
            this.__errorHandler(updateError, '[__addTask] [updateOne] [updateError]', 'Error in a callback of .updateOne() method of .__addTask()', uid);
          });
        }
      }
    });
  }

  __execute(task) {
    if (this.isDestroyed || task.isDeleted === true) {
      return;
    }

    const done = (_date, readyCallback) => {
      this.collection.updateOne({
        uid: task.uid
      }, {
        $set: {
          executeAt: _date
        }
      }, (updateError, updateResult) => {
        this.__errorHandler(updateError, '[__execute] [done] [updateOne] [updateError]', 'Error in a callback of .updateOne() method of .__execute()', task.uid);
        typeof readyCallback === 'function' && readyCallback(updateError, updateResult?.modifiedCount >= 1);
      });
    };

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

    const _date = new Date();
    const nextExecuteAt = new Date(+_date + this.zombieTime);

    this.__aquireLock((lockError, success) => {
      if (lockError) {
        this._debug('[__runTasks] [__aquireLock] Error:', lockError);
        this.__setNext();
      } else if (!success) {
        this.__setNext();
      } else {
        const _ids = [];
        const tasks = [];
        const releaseLock = () => {
          this.__releaseLock((releaseError) => {
            this.__setNext();
            if (releaseError) {
              this._debug('[__runTasks] [__releaseLock] Error:', releaseError);
            }
          });
        };

        try {
          const cursor = this.collection.find({
            executeAt: {
              $lte: _date
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
          }, (forEachError) => {
            cursor.close();
            if (forEachError) {
              releaseLock();
              this.__errorHandler(forEachError, '[__runTasks] [forEachError]', 'General Error during runtime in forEach endCallback block of __runTasks()', null);
            } else if (_ids.length) {
              this.collection.updateMany({
                _id: {
                  $in: _ids
                }
              }, {
                $set: {
                  executeAt: nextExecuteAt
                }
              }, (updateError) => {
                if (updateError) {
                  releaseLock();
                  this.__errorHandler(updateError, '[__runTasks] [updateMany] [updateError]', 'General Error during runtime in updateMany callback block of __runTasks()', null);
                } else {
                  for (const task of tasks) {
                    this.__execute(task);
                  }
                  releaseLock();
                }
              });
            } else {
              releaseLock();
            }
          });
        } catch (_error) {
          this.__setNext();
          this.__errorHandler(_error, '[__runTasks] [catch]', 'General Error during runtime in try-catch block of __runTasks()', null);
        }
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
        mongoErrorHandler(error);
      }
    }
  }
};
