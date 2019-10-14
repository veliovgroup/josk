const mongoErrorHandler = (error) => {
  if (error) {
    console.error('[josk] [mongoErrorHandler]:', error);
  }
};
const _debug = (...args) => {
  console.info.call(console, '[DEBUG] [josk]', ...args);
};
const prefixRegex = /set(Immediate|Timeout|Interval)$/;

module.exports = class JoSk {
  constructor(opts = {}) {
    this.prefix      = opts.prefix;
    this.onError     = opts.onError;
    this.autoClear   = opts.autoClear;
    this.zombieTime  = opts.zombieTime;
    this.onExecuted  = opts.onExecuted;
    this.resetOnInit = opts.resetOnInit;

    this.minRevolvingDelay = opts.minRevolvingDelay;
    this.maxRevolvingDelay = opts.maxRevolvingDelay;

    if (!this.prefix) { this.prefix = ''; }
    if (!this.onError) { this.onError = false; }
    if (!this.autoClear) { this.autoClear = false; }
    if (!this.zombieTime) { this.zombieTime = 900000; }
    if (!this.onExecuted) { this.onExecuted = false; }
    if (!this.resetOnInit) { this.resetOnInit = false; }
    if (!this.minRevolvingDelay) { this.minRevolvingDelay = 32; }
    if (!this.maxRevolvingDelay) { this.maxRevolvingDelay = 256; }

    if (!opts.db) {
      if (this.onError) {
        this.onError('{db} option is required', {
          description: 'MongoDB database {db} option is required, like returned from `MongoClient.connect`',
          error: '{db} option is required',
          uid: null
        });
      } else {
        _debug('[constructor] MongoDB database {db} option is required, like returned from `MongoClient.connect`');
      }
      return;
    }

    this.collection = opts.db.collection(`__JobTasks__${this.prefix}`);
    this.collection.createIndex({uid: 1}, {background: false, unique: true}, (indexError) => {
      if (indexError) {
        _debug('[constructor] [createIndex] [uid]', indexError);
      }
    });

    this.collection.createIndex({executeAt: 1}, {background: false}, (indexError) => {
      if (indexError) {
        _debug('[constructor] [createIndex] [executeAt]', indexError);
      }
    });

    if (this.resetOnInit) {
      this.collection.deleteMany({
        isInterval: false
      }, mongoErrorHandler);
    }

    this.tasks = {};
    this.__setNext();
  }

  setInterval(func, delay, _uid) {
    let uid = _uid;

    if (delay < 0) {
      throw new Error('[josk] [setInterval] delay must be positive Number!');
    }

    if (uid) {
      uid += 'setInterval';
    } else {
      throw new Error('[josk] [setInterval] [uid - task id must be specified (3rd argument)]');
    }

    this.tasks[uid] = func;
    this.__addTask(uid, true, delay);
    return uid;
  }

  setTimeout(func, delay, _uid) {
    let uid = _uid;

    if (delay < 0) {
      throw new Error('[josk] [setTimeout] delay must be positive Number!');
    }

    if (uid) {
      uid += 'setTimeout';
    } else {
      throw new Error('[josk] [setTimeout] [uid - task id must be specified (3rd argument)]');
    }

    this.tasks[uid] = func;
    this.__addTask(uid, false, delay);
    return uid;
  }

  setImmediate(func, _uid) {
    let uid = _uid;

    if (uid) {
      uid += 'setImmediate';
    } else {
      throw new Error('[josk] [setImmediate] [uid - task id must be specified (2nd argument)]');
    }

    this.tasks[uid] = func;
    this.__addTask(uid, false, 0);
    return uid;
  }

  clearInterval() {
    return this.__clear.apply(this, arguments);
  }

  clearTimeout() {
    return this.__clear.apply(this, arguments);
  }

  __clear(uid) {
    this.collection.updateOne({
      uid: uid
    }, {
      $unset: {
        executeAt: ''
      }
    }, (error) => {
      this.collection.deleteOne({
        uid: uid
      }, mongoErrorHandler);

      if (error) {
        if (this.onError) {
          this.onError('[__clear] [updateOne] [error]', {
            description: 'Error in a callback of .updateOne() method of .__clear()',
            error: error,
            uid: uid
          });
        } else {
          _debug('[__clear] [updateOne]', error);
        }
      }
    });

    if (this.tasks && this.tasks[uid]) {
      delete this.tasks[uid];
    }
    return true;
  }

  __addTask(uid, isInterval, delay) {
    this.collection.findOne({
      uid: uid
    }, (error, task) => {
      if (error) {
        if (this.onError) {
          this.onError('[__addTask] [findOne] [error]', {
            description: 'Error in a callback of .findOne() method of .__addTask()',
            error: error,
            uid: uid
          });
        } else {
          _debug('[__addTask] [findOne] [error]', error);
        }
        return;
      }

      if (!task) {
        this.collection.insertOne({
          uid: uid,
          delay: delay,
          executeAt: new Date(Date.now() + delay),
          isInterval: isInterval
        }, mongoErrorHandler);
      } else {
        let update = null;
        if (task.delay !== delay) {
          if (!update) {
            update = {};
          }
          update.delay = delay;
        }

        if (+task.executeAt > Date.now() + delay) {
          if (!update) {
            update = {};
          }
          update.executeAt = new Date(Date.now() + delay);
        }

        if (update) {
          this.collection.updateOne({
            uid: uid
          }, {
            $set: update
          }, mongoErrorHandler);
        }
      }
    });
  }

  __execute(task) {
    const done = (_date) => {
      this.collection.updateOne({
        uid: task.uid
      }, {
        $set: {
          executeAt: _date
        }
      }, mongoErrorHandler);
    };

    if (this.tasks && this.tasks[task.uid]) {
      const ready = () => {
        const date = new Date();
        const timestamp = +date;

        if (task.isInterval === true) {
          done(new Date(timestamp + task.delay));
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

      this.tasks[task.uid](ready);
      if (task.isInterval === false) {
        this.__clear(task.uid);
      }
    } else {
      done(new Date());
      if (this.autoClear) {
        this.__clear(task.uid);
        _debug(`[FYI] [${task.uid}] task was auto-cleared`);
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
        _debug(`[__execute] [${task.uid}] Something went wrong with one of your tasks is missing.
          Try to use different instances.
          It's safe to ignore this message.
          If this task is obsolete - simply remove it with \`JoSk#clearTimeout(\'${task.uid}\')\`,
          or enable autoClear with \`new JoSk({autoClear: true})\``);
      }
    }
  }

  __runTasks() {
    const _date = new Date();
    try {
      this.collection.findOneAndUpdate({
        executeAt: {
          $lte: _date
        }
      }, {
        $set: {
          executeAt: new Date(+_date + this.zombieTime)
        }
      }, (error, task) => {
        this.__setNext();
        if (error) {
          if (this.onError) {
            this.onError('General Error during runtime', {
              description: 'General Error during runtime',
              error: error,
              uid: null
            });
          } else {
            _debug('[__runTasks] [findOneAndUpdate]', error);
          }
        } else if (task.value) {
          this.__execute(task.value);
        }
      });
    } catch (_error) {
      this.__setNext();
      if (this.onError) {
        this.onError('General Error during runtime', {
          description: 'General Error during runtime',
          error: _error,
          uid: null
        });
      } else {
        _debug('[__runTasks] [findOneAndUpdate] [catch]', _error);
      }
    }
  }

  __setNext() {
    setTimeout(this.__runTasks.bind(this), Math.round((Math.random() * this.maxRevolvingDelay) + this.minRevolvingDelay));
  }
};
