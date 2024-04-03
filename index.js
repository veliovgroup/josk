import { MongoAdapter } from './adapters/mongo.js';
import { RedisAdapter } from './adapters/redis.js';

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
   * Create a Job-Task manager (CRON)
   * @param {object} opts - configuration object
   * @param {object} opts.db - Connection to MongoDB, like returned as argument from `MongoClient.connect()`
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
    const adapterMethods = ['aquireLock', 'releaseLock', 'clear', 'addTask', 'afterExecuted', 'runTasks'];

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

    this.adapter.clear(uid, callback);
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

    const done = this.adapter.afterExecuted(task);

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

    this.adapter.aquireLock((lockError, success) => {
      if (lockError) {
        this._debug('[__runTasks] [adapter.aquireLock] Error:', lockError);
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

export { JoSk, MongoAdapter, RedisAdapter };
