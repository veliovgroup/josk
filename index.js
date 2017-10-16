var NoOp = function () {};
var _debug = function (message) {
  console.trace();
  console.warn(message);
};
var prefixRegex = /(setImmediate|setTimeout|setInterval)$/;

module.exports = (function () {
  'use strict';
  function JoSk(_opts) {
    var self = this;
    var opts = _opts;
    if (!opts) { opts = {}; }

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

    this.collection = opts.db.collection('__JobTasks__' + this.prefix);
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

    this.tasks   = {};
    var setNext;
    var _date    = new Date();
    var runTasks = function () {
      try {
        _date = new Date();
        self.collection.findOneAndUpdate({
          $or: [{
            executeAt: {
              $lte: _date
            },
            inProgress: false
          }, {
            executeAt: {
              $lte: new Date(+_date - self.zombieTime)
            },
            inProgress: true
          }]
        }, {
          $set: {
            inProgress: true,
            executeAt: new Date(+_date + self.zombieTime)
          }
        }, {
          returnOriginal: false
        }, function (error, task) {
          setNext();
          if (error) {
            if (self.onError) {
              self.onError('General Error during runtime', {
                description: 'General Error during runtime',
                error: error,
                uid: null
              });
              return;
            }
            _debug(error);
            throw new Error('[josk] [General Error during runtime]: ' + error);
          }

          if (task.value) {
            self.__execute(task.value);
          }
        });
      } catch (_error) {
        setNext();
        return;
      }
    };

    setNext = function () {
      setTimeout(runTasks, Math.round((Math.random() * 256) + 32));
    };

    setNext();
  }

  JoSk.prototype.setInterval = function (func, delay, _uid) {
    var uid = _uid;

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
  };

  JoSk.prototype.setTimeout = function (func, delay, _uid) {
    var uid = _uid;

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
  };

  JoSk.prototype.setImmediate = function (func, _uid) {
    var uid = _uid;

    if (uid) {
      uid += 'setImmediate';
    } else {
      throw new Error('[josk] [setImmediate] [uid - task id must be specified (2nd argument)]');
    }

    this.tasks[uid] = func;
    this.__addTask(uid, false, 0);
    return uid;
  };

  JoSk.prototype.clearInterval = function () {
    return this.__clear.apply(this, arguments);
  };

  JoSk.prototype.clearTimeout = function () {
    return this.__clear.apply(this, arguments);
  };

  JoSk.prototype.__clear = function (uid) {
    var self = this;
    this.collection.updateOne({
      uid: uid
    }, {
      $unset: {
        executeAt: '',
        inProgress: ''
      }
    }, function (error) {
      if (error && self.onError) {
        self.onError('[__clear] [updateOne] [error]', {
          description: 'Error in a callback of .updateOne() method of .__clear()',
          error: error,
          uid: uid
        });
      }

      self.collection.deleteOne({
        uid: uid
      }, NoOp);
    });

    if (this.tasks && this.tasks[uid]) {
      delete this.tasks[uid];
    }
    return true;
  };

  JoSk.prototype.__addTask = function (uid, isInterval, delay) {
    var self = this;
    this.collection.findOne({
      uid: uid
    }, function (error, task) {
      if (error) {
        if (self.onError) {
          self.onError('[__addTask] [findOne] [error]', {
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
        self.collection.insertOne({
          uid: uid,
          delay: delay,
          executeAt: new Date(+new Date() + delay),
          isInterval: isInterval,
          inProgress: false
        }, NoOp);
      } else {
        var update = null;
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
          self.collection.updateOne({
            uid: uid
          }, {
            $set: update
          }, NoOp);
        }
      }
    });
  };

  JoSk.prototype.__execute = function (task) {
    var self = this;
    var done = function (_date) {
      self.collection.updateOne({
        uid: task.uid
      }, {
        $set: {
          executeAt: _date,
          inProgress: false
        }
      }, NoOp);
    };

    if (this.tasks && this.tasks[task.uid]) {
      var ready = function () {
        var date = new Date();
        var timestamp = +date;

        if (task.isInterval === true) {
          done(new Date(timestamp + task.delay));
        } else {
          self.__clear(task.uid);
        }

        if (self.onExecuted) {
          self.onExecuted(task.uid.replace(prefixRegex, ''), {
            uid: task.uid,
            timestamp: timestamp,
            date: date
          });
        }
      };

      this.tasks[task.uid](ready);
    } else {
      done(new Date());
      if (this.autoClear) {
        this.__clear(task.uid);
        console.info('[josk] [FYI] [' + task.uid + '] task was auto-cleared');
      } else if (this.onError) {
        this.onError('One of your tasks is missing', {
          description: 'Something went wrong with one of your tasks - is missing.\nTry to use different instances.\nIt\'s safe to ignore this message.\nIf this task is obsolete - simply remove it with `JoSk#clearTimeout(\'' + task.uid + '\')`,\nor enable autoClear with `new JoSk({autoClear: true})`',
          error: null,
          uid: task.uid
        });
      } else {
        _debug('[josk] [' + task.uid + '] Something went wrong with one of your tasks is missing.\nTry to use different instances.\nIt\'s safe to ignore this message.\nIf this task is obsolete - simply remove it with `JoSk#clearTimeout(\'' + task.uid + '\')`,\nor enable autoClear with `new JoSk({autoClear: true})`');
      }
    }
  };

  return JoSk;
})();
