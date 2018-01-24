const NoOp = () => {};
const _debug = (message) => {
  console.trace();
  console.warn(message);
};
const prefixRegex = /(setImmediate|setTimeout|setInterval)$/;

module.exports = class JoSk {
  constructor(opts = {}) {
    this.prefix      = opts.prefix;
    this.onError     = opts.onError;
    this.autoClear   = opts.autoClear;
    this.zombieTime  = opts.zombieTime;
    this.onExecuted  = opts.onExecuted;
    this.resetOnInit = opts.resetOnInit;

    if (!this.prefix) { this.prefix = ''; }
    if (!this.onError) { this.onError = false; }
    if (!this.autoClear) { this.autoClear = false; }
    if (!this.zombieTime) { this.zombieTime = 900000; }
    if (!this.onExecuted) { this.onExecuted = false; }
    if (!this.resetOnInit) { this.resetOnInit = false; }

    if (!opts.db) {
      if (this.onError) {
        this.onError('{db} option is required', {
          description: 'MongoDB database {db} option is required, like returned from `MongoClient.connect`',
          error: '{db} option is required',
          uid: null
        });
        return;
      }
      throw new Error('[josk] MongoDB database {db} option is required, like returned from `MongoClient.connect`');
    }

    this.collection = opts.db.collection(`__JobTasks__${this.prefix}`);
    this.collection.ensureIndex({uid: 1}, {background: true, unique: true});
    this.collection.ensureIndex({executeAt: 1, inProgress: 1}, {background: true});

    if (this.resetOnInit) {
      this.collection.updateMany({}, {
        $set: {
          inProgress: false
        }
      }, NoOp);

      this.collection.deleteMany({
        isInterval: false
      }, NoOp);
    }

    let setNext;
    this.tasks = {};
    let _date  = new Date();
    const runTasks = () => {
      _date    = new Date();
      try {
        this.collection.findOneAndUpdate({
          executeAt: {
            $lte: _date
          }
        }, {
          $set: {
            inProgress: true,
            executeAt: new Date(+_date + this.zombieTime)
          }
        }, {
          returnOriginal: false
        }, (error, task) => {
          setNext();
          if (error) {
            if (this.onError) {
              this.onError('General Error during runtime', {
                description: 'General Error during runtime',
                error: error,
                uid: null
              });
              return;
            }
            _debug(error);
            throw new Error(`[josk] [General Error during runtime]: ${error}`);
          }

          if (task.value) {
            this.__execute(task.value);
          }
        });
      } catch (_error) {
        setNext();
        return;
      }
    };

    setNext = () => {
      setTimeout(runTasks, Math.round((Math.random() * 256) + 32));
    };

    setNext();
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
        executeAt: '',
        inProgress: ''
      }
    }, (error) => {
      if (error && this.onError) {
        this.onError('[__clear] [updateOne] [error]', {
          description: 'Error in a callback of .updateOne() method of .__clear()',
          error: error,
          uid: uid
        });
      }

      this.collection.deleteOne({
        uid: uid
      }, NoOp);
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
          return;
        }
        _debug(error);
        throw new Error('[josk] [__addTask] [Error]: ' + error);
      }

      if (!task) {
        this.collection.insertOne({
          uid: uid,
          delay: delay,
          executeAt: new Date(+new Date() + delay),
          isInterval: isInterval,
          inProgress: false
        }, NoOp);
      } else {
        let update = null;
        if (task.delay !== delay) {
          if (!update) {
            update = {};
          }
          update.delay = delay;
        }

        if (+task.executeAt > +new Date() + delay) {
          if (!update) {
            update = {};
          }
          update.executeAt = new Date(+new Date() + delay);
        }

        if (update) {
          this.collection.updateOne({
            uid: uid
          }, {
            $set: update
          }, NoOp);
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
          executeAt: _date,
          inProgress: false
        }
      }, NoOp);
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
            timestamp: timestamp,
            date: date
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
        console.info(`[josk] [FYI] [${task.uid}] task was auto-cleared`);
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
        _debug(`[josk] [${task.uid}] Something went wrong with one of your tasks is missing.
          Try to use different instances.
          It's safe to ignore this message.
          If this task is obsolete - simply remove it with \`JoSk#clearTimeout(\'${task.uid}\')\`,
          or enable autoClear with \`new JoSk({autoClear: true})\``);
      }
    }
  }
};
