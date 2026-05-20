import { randomUUID } from 'node:crypto';

import { MongoAdapter } from './adapters/mongo.js';
import { RedisAdapter } from './adapters/redis.js';
import { PostgresAdapter } from './adapters/postgres.js';

const prefixRegex = /set(Immediate|Timeout|Interval)$/;
const validExecuteModes = new Set(['batch', 'one']);

const createRandomId = () => randomUUID();
const isPromiseLike = (value) => {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && typeof value.then === 'function';
};
const isValidDelay = (delay) => typeof delay === 'number' && Number.isFinite(delay) && delay >= 0;

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
 * @typedef {'batch' | 'one'} JoSkExecuteMode
 */

/**
 * @typedef {object} JoSkLock
 * @property {string} ownerId
 * @property {string} leaseId
 * @property {Date} expireAt
 * @property {number} expiresAtMs
 */

/**
 * @callback JoSkOnError
 * @param {string} title
 * @param {JoSkErrorDetails} details
 * @returns {void | PromiseLike<void>}
 */

/**
 * @callback JoSkOnExecuted
 * @param {string} uid
 * @param {JoSkExecutedDetails} details
 * @returns {void | PromiseLike<void>}
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
 * @returns {void | PromiseLike<void>}
 */

/**
 * @typedef {JoSkTaskHandler & { isMissing?: boolean }} JoSkStoredTask
 */

/**
 * @typedef {object} JoSkAdapter
 * @property {JoSk | undefined} [joskInstance]
 * @property {(lock: JoSkLock) => Promise<boolean>} acquireLock
 * @property {(lock: JoSkLock) => Promise<void>} releaseLock
 * @property {(uid: string) => Promise<boolean>} remove
 * @property {(uid: string, isInterval: boolean, delay: number) => Promise<boolean | void>} add
 * @property {(task: JoSkTask, nextExecuteAt: Date) => Promise<boolean>} update
 * @property {(nextExecuteAt: Date, lock: JoSkLock, executeMode: JoSkExecuteMode) => Promise<number | void>} iterate
 * @property {() => Promise<JoSkPingResult>} ping
 * @property {() => Promise<void>} [ready]
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
 * @property {JoSkExecuteMode} [execute]
 * @property {string} [lockOwnerId]
 * @property {number} [concurrency]
 */

const errors = {
  execute: '[josk] [execute] option must be either "batch" or "one"!',
  concurrency: '[josk] [concurrency] option must be a positive integer or Infinity',
  setInterval: {
    func: '[josk] [setInterval] the first argument must be a function!',
    delay: '[josk] [setInterval] delay must be a finite non-negative Number!',
    uid: '[josk] [setInterval] uid (3rd argument) must be a string'
  },
  setTimeout: {
    func: '[josk] [setTimeout] the first argument must be a function!',
    delay: '[josk] [setTimeout] delay must be a finite non-negative Number!',
    uid: '[josk] [setTimeout] uid (3rd argument) must be a string'
  },
  setImmediate: {
    func: '[josk] [setImmediate] the first argument must be a function!',
    uid: '[josk] [setImmediate] uid (2nd argument) must be a string'
  }
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
    this.execute = opts.execute || 'batch';
    this.lockOwnerId = typeof opts.lockOwnerId === 'string' && opts.lockOwnerId.length > 0 ? opts.lockOwnerId : `josk-${createRandomId()}`;

    if (opts.concurrency !== void 0) {
      if (opts.concurrency !== Infinity && (!Number.isInteger(opts.concurrency) || opts.concurrency < 1)) {
        throw new Error(errors.concurrency);
      }
      this.concurrency = opts.concurrency;
    } else {
      this.concurrency = Infinity;
    }

    /** @internal */
    this.nextRevolutionTimeout = null;
    /** @internal */
    this.__lockLeaseCounter = 0;
    /** @internal */
    this.__adapterReadyPromise = null;
    /** @internal */
    this.__activeExecutions = 0;
    /** @internal */
    this.__pendingTasks = [];
    /** @internal */
    this.__pausedAll = false;
    /** @internal @type {Set<string>} */
    this.__pausedTimerIds = new Set();

    if (!validExecuteModes.has(this.execute)) {
      throw new Error(errors.execute);
    }

    if (!opts.adapter || typeof opts.adapter !== 'object') {
      throw new Error('{adapter} option is required for JoSk', {
        description: 'JoSk requires MongoAdapter, RedisAdapter, PostgresAdapter, or CustomAdapter to connect to an intermediate database'
      });
    }

    /**
     * @type {Record<string, JoSkStoredTask>}
     * @internal
     */
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
   */
  async ping() {
    await this.__adapterReady();
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

    if (!isValidDelay(delay)) {
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
   * Create delayed task. Executes at-most-once across the cluster: the task
   * is removed from storage before the handler runs, so a crash between
   * removal and completion drops the run.
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

    if (!isValidDelay(delay)) {
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
   * Create one-shot task that runs as soon as the next scheduler tick claims it.
   * Executes at-most-once across the cluster: the task is removed from storage
   * before the handler runs, so a crash between removal and completion drops the run.
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
      this.__pausedAll = false;
      this.__pausedTimerIds.clear();
      if (this.nextRevolutionTimeout) {
        clearTimeout(this.nextRevolutionTimeout);
        this.nextRevolutionTimeout = null;
      }
      return true;
    }
    return false;
  }

  /**
   * Pause this instance from competing for scheduler work.
   * @param {string} [timerId] - Timer id returned from `setInterval` / `setTimeout` / `setImmediate`; omit to pause all tasks on this instance
   * @returns {boolean}
   */
  pause(timerId) {
    if (this.isDestroyed) {
      return false;
    }

    if (timerId === void 0) {
      if (this.__pausedAll) {
        return false;
      }
      this.__pausedAll = true;
      return true;
    }

    if (typeof timerId !== 'string' || timerId.length === 0) {
      throw new Error('[josk] [pause] timerId must be a non-empty string');
    }

    if (!prefixRegex.test(timerId)) {
      throw new Error('[josk] [pause] timerId must be the string returned from setInterval, setTimeout, or setImmediate');
    }

    if (this.__pausedTimerIds.has(timerId)) {
      return false;
    }
    this.__pausedTimerIds.add(timerId);
    return true;
  }

  /**
   * Resume competing for scheduler work.
   * @param {string} [timerId] - Timer id returned from `setInterval` / `setTimeout` / `setImmediate`; omit to resume all
   * @returns {boolean}
   */
  resume(timerId) {
    if (this.isDestroyed) {
      return false;
    }

    if (timerId === void 0) {
      if (!this.__pausedAll) {
        return false;
      }
      this.__pausedAll = false;
      return true;
    }

    if (typeof timerId !== 'string' || timerId.length === 0) {
      throw new Error('[josk] [resume] timerId must be a non-empty string');
    }

    if (!prefixRegex.test(timerId)) {
      throw new Error('[josk] [resume] timerId must be the string returned from setInterval, setTimeout, or setImmediate');
    }

    if (!this.__pausedTimerIds.has(timerId)) {
      return false;
    }
    this.__pausedTimerIds.delete(timerId);
    return true;
  }

  /** @internal */
  __checkState() {
    if (this.isDestroyed) {
      if (this.onError) {
        const reason = 'JoSk instance destroyed';
        this.__callHook('onError', this.onError, [reason, {
          description: 'invoking methods of destroyed JoSk instance',
          error: new Error(reason),
          uid: null
        }]);
      } else {
        this._debug('[__checkState] [warn] invoking methods of destroyed JoSk instance, call cause no action');
      }
      return true;
    }
    return false;
  }

  /** @internal */
  async __adapterReady() {
    if (typeof this.adapter.ready !== 'function') {
      return;
    }

    if (!this.__adapterReadyPromise) {
      this.__adapterReadyPromise = Promise.resolve().then(() => this.adapter.ready());
    }

    return await this.__adapterReadyPromise;
  }

  /** @internal */
  __getLock() {
    const expireAt = new Date(Date.now() + this.zombieTime);
    this.__lockLeaseCounter++;
    return {
      ownerId: this.lockOwnerId,
      leaseId: `${this.lockOwnerId}:${this.__lockLeaseCounter}:${createRandomId()}`,
      expireAt,
      expiresAtMs: +expireAt
    };
  }

  /**
   * @internal
   * @param {string} timerId
   * @returns {Promise<boolean>}
   */
  async __remove(timerId) {
    if (typeof timerId !== 'string') {
      return false;
    }

    await this.__adapterReady();

    const isRemoved = await this.adapter.remove(timerId);
    if (isRemoved && this.tasks[timerId]) {
      delete this.tasks[timerId];
    }
    return isRemoved;
  }

  /**
   * @internal
   * @param {string} uid
   * @param {boolean} isInterval
   * @param {number} delay
   * @returns {Promise<void>}
   */
  async __add(uid, isInterval, delay) {
    if (this.isDestroyed) {
      return;
    }

    await this.__adapterReady();
    await this.adapter.add(uid, isInterval, delay);
  }

  /**
   * Entry point used by adapters. Respects the configured concurrency cap.
   * Returns a Promise that resolves when the task finishes; adapters call
   * this fire-and-forget for batched throughput.
   * @internal
   * @param {JoSkTask} task
   * @returns {Promise<void>}
   */
  __execute(task) {
    if (this.concurrency === Infinity) {
      const promise = this.__doExecute(task);
      promise.catch((err) => {
        this._debug(`[__execute] [${task?.uid || 'unknown'}] unhandled exception:`, err);
      });
      return promise;
    }

    return new Promise((resolve) => {
      this.__pendingTasks.push({ task, resolve });
      this.__drainPending();
    });
  }

  /**
   * Drains queued tasks under the configured `concurrency` cap.
   *
   * Pulls FIFO entries off `__pendingTasks` and starts `__doExecute` for each
   * while `__activeExecutions < concurrency`. Every started task:
   *   - increments `__activeExecutions` before it begins
   *   - decrements it when it settles (success or failure)
   *   - resolves the awaiter promise returned from `__execute(task)`
   *   - re-invokes `__drainPending()` so the next queued task starts
   *     immediately without waiting for another tick
   *
   * Only used when `concurrency !== Infinity`. When concurrency is unbounded,
   * `__execute` runs tasks directly without queueing.
   *
   * @internal
   * @returns {void}
   */
  __drainPending() {
    while (this.__activeExecutions < this.concurrency && this.__pendingTasks.length > 0) {
      const entry = this.__pendingTasks.shift();
      this.__activeExecutions++;
      this.__doExecute(entry.task).catch((err) => {
        this._debug(`[__execute] [${entry.task?.uid || 'unknown'}] unhandled exception:`, err);
      }).finally(() => {
        this.__activeExecutions--;
        entry.resolve();
        this.__drainPending();
      });
    }
  }

  /**
   * @internal
   * @param {string} timerId
   */
  __isTaskPaused(timerId) {
    if (this.__pausedAll) {
      return true;
    }
    return this.__pausedTimerIds.has(timerId);
  }

  /**
   * @internal
   * @param {JoSkTask} task
   * @returns {Promise<void>}
   */
  async __deferClaimedTask(task) {
    const deferMs = Math.max(2000, typeof task.delay === 'number' && task.delay >= 2000 ? task.delay : 2000);
    const nextExecuteAt = new Date(Date.now() + deferMs);
    try {
      await this.__adapterReady();
      await this.adapter.update(task, nextExecuteAt);
    } catch (deferError) {
      this.__errorHandler(deferError, '[__deferClaimedTask] deferError', 'Failed to reschedule paused task', task.uid);
    }
  }

  /**
   * @internal
   * @param {JoSkTask} task
   * @returns {Promise<void>}
   */
  async __doExecute(task) {
    if (this.isDestroyed || task?.isDeleted === true) {
      return;
    }

    if (!task || typeof task !== 'object' || typeof task.uid !== 'string') {
      if (this.onError) {
        this.__callHook('onError', this.onError, ['JoSk#__execute received malformed task', {
          description: 'Something went wrong with one of your tasks - malformed or undefined',
          error: null,
          task,
          uid: null
        }]);
      } else {
        this._debug('[__execute] received malformed task', task);
      }
      return;
    }

    if (this.__isTaskPaused(task.uid)) {
      await this.__deferClaimedTask(task);
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
          this.__callHook('onExecuted', this.onExecuted, [task.uid.replace(prefixRegex, ''), {
            uid: task.uid,
            date,
            delay: task.delay,
            timestamp
          }]);
        }

        return true;
      };

      const taskFunc = this.tasks[task.uid];
      const funcArity = taskFunc.length;
      let hasError = false;
      let didInvoke = false;
      let returnedPromise;
      try {
        if (task.isInterval === false) {
          let isRemoved = false;
          try {
            isRemoved = await this.__remove(task.uid);
          } catch (removeError) {
            this._debug(`[${task.uid}] [__execute] [__remove] has thrown an exception; Check connection with StorageAdapter; removeError:`, removeError);
          }

          if (isRemoved === true) {
            didInvoke = true;
            returnedPromise = taskFunc(ready);
          }
        } else {
          didInvoke = true;
          returnedPromise = taskFunc(ready);
        }

        if (isPromiseLike(returnedPromise)) {
          await Promise.resolve(returnedPromise);
        }
      } catch (taskExecError) {
        hasError = true;
        this.__errorHandler(taskExecError, 'Exception during task execution', 'An exception was thrown during task execution', task.uid);
      }

      if (!didInvoke) {
        // setTimeout/setImmediate handler skipped because remove() failed or
        // the task was claimed elsewhere. Do not auto-ready: that would fire
        // onExecuted for a run that never happened.
        return;
      }

      const isPromise = isPromiseLike(returnedPromise);
      const isCallbackStyle = funcArity === 0;
      const needsAutoReady = executionsQty === 0 && (isPromise || hasError || isCallbackStyle);

      if (needsAutoReady) {
        try {
          await ready();
        } catch (readyErr) {
          this._debug(`[${task.uid}] [__execute] [ready] has thrown an exception; readyErr:`, readyErr);
        }
      } else if (executionsQty === 0 && !isPromise && !hasError) {
        this._debug(`[${task.uid}] [__execute] handler returned synchronously without calling ready(); task will be retried after zombieTime`);
      }
      return;
    }

    await this.adapter.update(task, new Date(Date.now() + this.zombieTime));
    this.tasks[task.uid] = /** @type {JoSkStoredTask} */ (function () {});
    this.tasks[task.uid].isMissing = true;

    if (this.autoClear) {
      try {
        await this.__remove(task.uid);
        this._debug(`[FYI] [${task.uid}] task was auto-cleared`);
      } catch (removeError) {
        this._debug(`[${task.uid}] [__execute] [this.autoClear] [__remove] has thrown an exception; removeError:`, removeError);
      }
    } else if (this.onError) {
      this.__callHook('onError', this.onError, ['One of your tasks is missing', {
        description: `Something went wrong with one of your tasks - is missing.
          Try to use different instances.
          It's safe to ignore this message.
          If this task is obsolete - simply remove it with \`JoSk#clearTimeout('${task.uid}')\`,
          or enable autoClear with \`new JoSk({autoClear: true})\``,
        error: null,
        uid: task.uid
      }]);
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

    if (this.__pausedAll) {
      this.__tick();
      return;
    }

    const nextExecuteAt = new Date(Date.now() + this.zombieTime);
    const lock = this.__getLock();
    let isAcquired = false;

    try {
      await this.__adapterReady();
      isAcquired = await this.adapter.acquireLock(lock);
      if (isAcquired) {
        await this.adapter.iterate(nextExecuteAt, lock, this.execute);
      }
    } catch (runError) {
      this.__errorHandler(runError, '[__iterate] runError:', 'adapter.iterate has returned an error', null);
    } finally {
      if (isAcquired) {
        try {
          await this.adapter.releaseLock(lock);
        } catch (releaseError) {
          this.__errorHandler(releaseError, '[__iterate] [releaseLock] releaseError:', 'adapter.releaseLock has returned an error', null);
        }
      }
      this.__tick();
    }
  }

  /** @internal */
  __tick() {
    if (this.isDestroyed) {
      return;
    }

    const jitterRange = Math.max(0, this.maxRevolvingDelay - this.minRevolvingDelay);
    this.nextRevolutionTimeout = setTimeout(this.__iterate.bind(this), this.minRevolvingDelay + Math.round(Math.random() * jitterRange));
  }

  /**
   * @internal
   * @param {string} hookName
   * @param {Function} hook
   * @param {unknown[]} args
   * @returns {void}
   */
  __callHook(hookName, hook, args) {
    try {
      const result = hook(...args);
      if (isPromiseLike(result)) {
        Promise.resolve(result).catch((hookError) => {
          console.error(`[josk] [${hookName}] hook rejected`, hookError);
        });
      }
    } catch (hookError) {
      console.error(`[josk] [${hookName}] hook failed`, hookError);
    }
  }

  /**
   * @internal
   * @param {unknown} error
   * @param {string} title
   * @param {string} description
   * @param {string | null} uid
   * @returns {void}
   */
  __errorHandler(error, title, description, uid) {
    if (error) {
      if (this.onError) {
        this.__callHook('onError', this.onError, [title, { description, error, uid }]);
      } else {
        console.error(title, { description, error, uid });
      }
    }
  }
}

export { JoSk, MongoAdapter, RedisAdapter, PostgresAdapter };
