import { MongoAdapter } from './adapters/mongo.js';
import { RedisAdapter } from './adapters/redis.js';
import { PostgresAdapter } from './adapters/postgres.js';

const prefixRegex = /set(Immediate|Timeout|Interval)$/;

/**
 * @typedef {object} JoSkPingResult
 * @property {string} status
 * @property {number} code
 * @property {number} statusCode
 * @property {unknown} [error]
 */

/**
 * @typedef {object} JoSkErrorDetails
 * @property {string} description
 * @property {unknown} error
 * @property {string | null} uid
 * @property {unknown} [task]
 */

/**
 * @typedef {object} JoSkExecutedDetails
 * @property {string} uid
 * @property {Date} date
 * @property {number} delay
 * @property {number} timestamp
 */

/**
 * @typedef {object} JoSkTask
 * @property {string} uid
 * @property {number} delay
 * @property {boolean} isInterval
 * @property {boolean} isDeleted
 * @property {Date | number} [executeAt]
 */

/**
 * @callback JoSkOnError
 * @param {string} title
 * @param {JoSkErrorDetails} details
 * @returns {void}
 */

/**
 * @callback JoSkOnExecuted
 * @param {string} uid
 * @param {JoSkExecutedDetails} details
 * @returns {void}
 */

/**
 * @callback JoSkReadyCallback
 * @param {Error | undefined} error
 * @param {boolean} success
 * @returns {void}
 */

/**
 * @callback JoSkReady
 * @param {Date | number | JoSkReadyCallback} [nextExecuteAt]
 * @returns {Promise<boolean>}
 */

/**
 * @callback JoSkTaskHandler
 * @param {JoSkReady} ready
 * @returns {void | Promise<void>}
 */

/**
 * @typedef {JoSkTaskHandler & { isMissing?: boolean }} JoSkStoredTask
 */

/**
 * @typedef {object} JoSkAdapter
 * @property {JoSk | undefined} [joskInstance]
 * @property {() => Promise<boolean>} acquireLock
 * @property {() => Promise<void>} releaseLock
 * @property {(uid: string) => Promise<boolean>} remove
 * @property {(uid: string, isInterval: boolean, delay: number) => Promise<boolean | void>} add
 * @property {(task: JoSkTask, nextExecuteAt: Date) => Promise<boolean>} update
 * @property {(nextExecuteAt: Date) => Promise<void>} iterate
 * @property {() => Promise<JoSkPingResult>} ping
 */

/**
 * @typedef {object} JoSkOption
 * @property {JoSkAdapter} adapter
 * @property {boolean} [debug]
 * @property {JoSkOnError} [onError]
 * @property {boolean} [autoClear]
 * @property {number} [zombieTime]
 * @property {JoSkOnExecuted} [onExecuted]
 * @property {number} [minRevolvingDelay]
 * @property {number} [maxRevolvingDelay]
 */

const errors = {
  setInterval: {
    func: '[josk] [setInterval] the first argument must be a function!',
    delay: '[josk] [setInterval] delay must be positive Number!',
    uid: '[josk] [setInterval] [uid - task id must be specified (3rd argument)]'
  },
  setTimeout: {
    func: '[josk] [setTimeout] the first argument must be a function!',
    delay: '[josk] [setTimeout] delay must be positive Number!',
    uid: '[josk] [setTimeout] [uid - task id must be specified (3rd argument)]'
  },
  setImmediate: {
    func: '[josk] [setImmediate] the first argument must be a function!',
    uid: '[josk] [setImmediate] [uid - task id must be specified (2nd argument)]'
  },
};

/** Class representing a JoSk task runner (cron). */
class JoSk {
  /**
   * Create a JoSk instance
   * @param {JoSkOption} opts - configuration object
   */
  constructor(opts = {}) {
    this.debug = opts.debug || false;
    this.onError = opts.onError || false;
    this.autoClear = opts.autoClear || false;
    this.zombieTime = opts.zombieTime || 900000;
    this.onExecuted = opts.onExecuted || false;
    this.isDestroyed = false;
    this.minRevolvingDelay = opts.minRevolvingDelay || 128;
    this.maxRevolvingDelay = opts.maxRevolvingDelay || 768;
    /** @internal */
    this.nextRevolutionTimeout = null;

    if (!opts.adapter || typeof opts.adapter !== 'object') {
      throw new Error('{adapter} option is required for JoSk', {
        description: 'JoSk requires MongoAdapter, RedisAdapter, or CustomAdapter to connect to an intermediate database'
      });
    }

    /** @type {Record<string, JoSkStoredTask>} */
    this.tasks = {};

    /** @internal */
    this._debug = (...args) => {
      this.debug === true && console.info.call(console, '[DEBUG] [josk]', ...args);
    };

    /** @type {JoSkAdapter} */
    this.adapter = opts.adapter;
    this.adapter.joskInstance = this;
    const adapterMethods = ['acquireLock', 'releaseLock', 'remove', 'add', 'update', 'iterate', 'ping'];

    for (let i = adapterMethods.length - 1; i >= 0; i--) {
      if (typeof this.adapter[adapterMethods[i]] !== 'function') {
        throw new Error(`{adapter} instance is missing {${adapterMethods[i]}} method that is required!`);
      }
    }

    this.__tick();
  }

  /**
   * @async
   * @memberOf JoSk
   * @name ping
   * @description Check package readiness and connection to Storage
   * @returns {Promise<JoSkPingResult>}
   * @throws {mix}
   */
  async ping() {
    return await this.adapter.ping();
  }

  /**
   * @async
   * @memberOf JoSk
   * Create recurring task (loop)
   * @name setInterval
   * @param {JoSkTaskHandler} func - Function (task) to execute
   * @param {number} delay - Delay between task execution in milliseconds
   * @param {string} uid - Unique function (task) identification as a string
   * @returns {Promise<string>} - Timer ID
   */
  async setInterval(func, delay, uid) {
    if (this.__checkState()) {
      return '';
    }

    if (typeof func !== 'function') {
      throw new Error(errors.setInterval.func);
    }

    if (delay < 0) {
      throw new Error(errors.setInterval.delay);
    }

    if (typeof uid !== 'string') {
      throw new Error(errors.setInterval.uid);
    }

    const timerId = `${uid}setInterval`;
    this.tasks[timerId] = func;
    await this.__add(timerId, true, delay);
    return timerId;
  }

  /**
   * @async
   * @memberOf JoSk
   * Create delayed task
   * @name setTimeout
   * @param {JoSkTaskHandler} func - Function (task) to execute
   * @param {number} delay - Delay before task execution in milliseconds
   * @param {string} uid - Unique function (task) identification as a string
   * @returns {Promise<string>} - Timer ID
   */
  async setTimeout(func, delay, uid) {
    if (this.__checkState()) {
      return '';
    }

    if (typeof func !== 'function') {
      throw new Error(errors.setTimeout.func);
    }

    if (delay < 0) {
      throw new Error(errors.setTimeout.delay);
    }

    if (typeof uid !== 'string') {
      throw new Error(errors.setTimeout.uid);
    }

    const timerId = `${uid}setTimeout`;
    this.tasks[timerId] = func;
    await this.__add(timerId, false, delay);
    return timerId;
  }

  /**
   * @async
   * @memberOf JoSk
   * Create task, which would get executed immediately and only once across multi-server setup
   * @name setImmediate
   * @param {JoSkTaskHandler} func - Function (task) to execute
   * @param {string} uid - Unique function (task) identification as a string
   * @returns {Promise<string>} - Timer ID
   */
  async setImmediate(func, uid) {
    if (this.__checkState()) {
      return '';
    }

    if (typeof func !== 'function') {
      throw new Error(errors.setImmediate.func);
    }

    if (typeof uid !== 'string') {
      throw new Error(errors.setImmediate.uid);
    }

    const timerId = `${uid}setImmediate`;
    this.tasks[timerId] = func;
    await this.__add(timerId, false, 0);
    return timerId;
  }

  /**
   * @async
   * @memberOf JoSk
   * Cancel (abort) current interval timer.
   * Must be called in a separate event loop from `.setInterval()`
   * @name clearInterval
   * @param {string|Promise<string>} timerId - Unique function (task) identification as a string, returned from `.setInterval()`
   * @param {function} [callback] - optional callback
   * @returns {Promise<boolean>} - `true` if task cleared, `false` if task doesn't exist
   */
  async clearInterval(timerId) {
    if (typeof timerId === 'object' && timerId instanceof Promise) {
      return await this.__remove(await timerId);
    }
    return await this.__remove(timerId);
  }

  /**
   * @async
   * @memberOf JoSk
   * Cancel (abort) current timeout timer.
   * Must be called in a separate event loop from `.setTimeout()`
   * @name clearTimeout
   * @param {string|Promise<string>} timerId - Unique function (task) identification as a string, returned from `.setTimeout()`
   * @param {function} [callback] - optional callback
   * @returns {Promise<boolean>} - `true` if task cleared, `false` if task doesn't exist
   */
  async clearTimeout(timerId) {
    if (typeof timerId === 'object' && timerId instanceof Promise) {
      return await this.__remove(await timerId);
    }
    return await this.__remove(timerId);
  }

  /**
   * @memberOf JoSk
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

  /** @internal */
  __checkState() {
    if (this.isDestroyed) {
      if (this.onError) {
        const reason = 'JoSk instance destroyed';
        this.onError(reason, {
          description: 'invoking methods of destroyed JoSk instance',
          error: new Error(reason),
          uid: null
        });
      } else {
        this._debug('[__checkState] [warn] invoking methods of destroyed JoSk instance, call cause no action');
      }
      return true;
    }
    return false;
  }

  /** @internal */
  async __remove(timerId) {
    if (typeof timerId !== 'string') {
      return false;
    }

    const isRemoved = await this.adapter.remove(timerId);
    if (isRemoved && this.tasks?.[timerId]) {
      delete this.tasks[timerId];
    }
    return isRemoved;
  }

  /** @internal */
  async __add(uid, isInterval, delay) {
    if (this.isDestroyed) {
      return;
    }

    await this.adapter.add(uid, isInterval, delay);
  }

  /**
   * @internal
   * @param {JoSkTask} task
   * @returns {Promise<void>}
   */
  async __execute(task) {
    if (this.isDestroyed || task.isDeleted === true) {
      return;
    }

    if (!task || typeof task !== 'object' || typeof task.uid !== 'string') {
      if (this.onError) {
        this.onError('JoSk#__execute received malformed task', {
          description: 'Something went wrong with one of your tasks - malformed or undefined',
          error: null,
          task: task,
          uid: task.uid,
        });
      } else {
        this._debug('[__execute] received malformed task', task);
      }
      return;
    }

    let executionsQty = 0;

    if (this.tasks && typeof this.tasks[task.uid] === 'function') {
      if (this.tasks[task.uid].isMissing === true) {
        return;
      }

      const ready = async (readyArg1) => {
        executionsQty++;
        if (executionsQty >= 2) {
          const error = new Error(`[josk] [${task.uid}] Resolution method is overspecified. Specify a callback *or* return a Promise. Task resolution was called more than once!`);
          if (typeof readyArg1 === 'function') {
            readyArg1(error, false);
            return false;
          }
          throw error;
        }

        const date = new Date();
        const timestamp = +date;

        if (typeof readyArg1 === 'function') {
          readyArg1(void 0, true);
        }

        if (task.isInterval === true) {
          if (typeof readyArg1 === 'object' && readyArg1 instanceof Date && +readyArg1 >= timestamp) {
            await this.adapter.update(task, readyArg1);
          } else if (typeof readyArg1 === 'number' && readyArg1 >= timestamp) {
            await this.adapter.update(task, new Date(readyArg1));
          } else {
            await this.adapter.update(task, new Date(timestamp + task.delay));
          }
        }

        if (this.onExecuted) {
          this.onExecuted(task.uid.replace(prefixRegex, ''), {
            uid: task.uid,
            date: date,
            delay: task.delay,
            timestamp: timestamp
          });
        }

        return true;
      };

      let hasError;
      let returnedPromise;
      try {
        if (task.isInterval === false) {
          const originalTask = this.tasks[task.uid];
          let isRemoved = false;
          try {
            isRemoved = await this.__remove(task.uid);
          } catch (removeError) {
            this._debug(`[${task.uid}] [__execute] [__remove] has thrown an exception; Check connection with StorageAdapter; removeError:`, removeError);
          }

          if (isRemoved === true) {
            returnedPromise = originalTask(ready);
          }
        } else {
          returnedPromise = this.tasks[task.uid](ready);
        }

        if (returnedPromise && returnedPromise instanceof Promise) {
          await returnedPromise;
        } else {
          return;
        }
      } catch (taskExecError) {
        hasError = true;
        this.__errorHandler(taskExecError, 'Exception during task execution', 'An exception was thrown during task execution', task.uid);
      }

      if ((returnedPromise && returnedPromise instanceof Promise) || (executionsQty === 0 && hasError)) {
        try {
          await ready();
        } catch (readyErr) {
          this._debug(`[${task.uid}] [__execute] [ready] has thrown an exception; readyErr:`, readyErr);
        }
      }
      return;
    }

    await this.adapter.update(task, new Date(Date.now() + this.zombieTime));
    this.tasks[task.uid] = /** @type {JoSkStoredTask} */ (function () { });
    this.tasks[task.uid].isMissing = true;

    if (this.autoClear) {
      try {
        await this.__remove(task.uid);
        this._debug(`[FYI] [${task.uid}] task was auto-cleared`);
      } catch (removeError) {
        this._debug(`[${task.uid}] [__execute] [this.autoClear] [__remove] has thrown an exception; removeError:`, removeError);
      }
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

  /** @internal */
  async __iterate() {
    if (this.isDestroyed) {
      return;
    }

    const nextExecuteAt = new Date(Date.now() + this.zombieTime);

    try {
      const isAcquired = await this.adapter.acquireLock();
      if (isAcquired) {
        await this.adapter.iterate(nextExecuteAt);
        await this.adapter.releaseLock();
      }
      this.__tick();
    } catch (runError) {
      this.__errorHandler(runError, '[__iterate] runError:', 'adapter.iterate has returned an error', null);
    }
  }

  /** @internal */
  __tick() {
    if (this.isDestroyed) {
      return;
    }

    this.nextRevolutionTimeout = setTimeout(this.__iterate.bind(this), Math.round((Math.random() * this.maxRevolvingDelay) + this.minRevolvingDelay));
  }

  /** @internal */
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

export { JoSk, MongoAdapter, RedisAdapter, PostgresAdapter };
