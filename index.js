/* jshint node:true */
var NoOp = function() {};

module.exports = (function() {
  "use strict";
  function JoSk(opts) {
    var self = this;
    if (!opts) { opts = {}; }
    this.prefix = opts.prefix;
    this.resetOnInit = opts.resetOnInit;
    this.zombieTime = opts.zombieTime;

    if (!this.prefix) { this.prefix = ''; }
    if (!this.resetOnInit) { this.resetOnInit = false; }
    if (!this.zombieTime) { this.zombieTime = 900000; }

    if (!opts.db) {
      throw "[josk] MongoDB database {db} option is required, like returned from `MongoClient.connect`";
    }

    this.collection = opts.db.collection("__JobTasks__" + this.prefix);
    this.collection.ensureIndex({uid: 1}, {background: true, unique: true});
    this.collection.ensureIndex({uid: 1, inProgress: 1});
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

    this.tasks = {};
    setInterval(function () {
      try {
        self.collection.find({
          $or: [{
            executeAt: {
              $lte: new Date()
            },
            inProgress: false
          }, {
            executeAt: {
              $lte: new Date(+(new Date()) - self.zombieTime)
            },
            inProgress: true
          }]
        }).toArray(function(error, tasks) {
          tasks.forEach(function(task) {
            if (self.tasks && self.tasks[task.uid]) {
              process.nextTick(function() {
                self.__execute(task, (task.executeAt <= new Date(+(new Date()) - self.zombieTime)));
              });
            }
          });
        });
      } catch (_error) {
        return;
      }
    }, (Math.random() * 1536) + 512);
  }

  JoSk.prototype.setInterval = function(func, delay, uid) {
    if (delay < 0) {
      throw '[josk] [setInterval] delay must be positive Number!';
    }

    if (uid) {
      uid += 'setInterval';
    } else {
      throw '[josk] [setInterval] [uid - task id must be specified (3rd argument)]';
    }

    this.tasks[uid] = func;
    this.__addTask(uid, true, delay);
    return uid;
  };

  JoSk.prototype.setTimeout = function(func, delay, uid) {
    if (delay < 0) {
      throw '[josk] [setTimeout] delay must be positive Number!';
    }

    if (uid) {
      uid += 'setTimeout';
    } else {
      throw '[josk] [setTimeout] [uid - task id must be specified (3rd argument)]';
    }

    this.tasks[uid] = func;
    this.__addTask(uid, false, delay);
    return uid;
  };

  JoSk.prototype.setImmediate = function(func, uid) {
    if (uid) {
      uid += 'setImmediate';
    } else {
      throw '[josk] [setImmediate] [uid - task id must be specified (2nd argument)]';
    }

    this.tasks[uid] = func;
    this.__addTask(uid, false, 0);
    return uid;
  };

  JoSk.prototype.clearInterval = function() {
    return this.__clear.apply(this, arguments);
  };

  JoSk.prototype.clearTimeout = function() {
    return this.__clear.apply(this, arguments);
  };

  JoSk.prototype.__clear = function(uid) {
    var self = this;

    this.collection.updateOne({
      uid: uid
    }, {
      $unset: {
        executeAt: '',
        inProgress: ''
      }
    }, function() {
      self.collection.deleteOne({
        uid: uid
      }, NoOp);
    });
    if (this.tasks && this.tasks[uid]) {
      delete this.tasks[uid];
    }
    return true;
  };

  JoSk.prototype.__addTask = function(uid, isInterval, delay) {
    var self = this;
    this.collection.findOne({
      uid: uid
    }, function(error, task) {
      if (!task) {
        self.collection.insertOne({
          uid: uid,
          delay: delay,
          executeAt: new Date((+(new Date())) + delay),
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
          update.executeAt = new Date((+(new Date())) + delay);
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

  JoSk.prototype.__execute = function(task, force) {
    var self = this;
    var selector = {
      uid: task.uid
    };

    var update = {
      $set: {
        inProgress: true
      }
    };

    if (!force) {
      selector.inProgress = false;
    } else {
      update['$set'].executeAt = new Date((+(new Date())) + task.delay);
    }

    this.collection.updateOne(selector, update, function () {
      if (self.tasks && self.tasks[task.uid]) {
        var ready = function() {
          if (task.isInterval === true) {
            self.collection.updateOne({
              uid: task.uid
            }, {
              $set: {
                executeAt: new Date((+(new Date())) + task.delay),
                inProgress: false
              }
            }, NoOp);
          } else {
            self.__clear(task.uid);
          }
        };
        self.tasks[task.uid](ready);
      } else {
        console.trace();
        console.warn('[josk] Something went wrong with one of your tasks - it\'s is missing. Try to use different instances.');
      }
    });
  };

  return JoSk;
})();