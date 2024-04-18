import { Db } from 'mongodb';
import { RedisClientType as RedisClient } from 'redis';

/** Class representing a JoSk task runner (cron). */
export class JoSk {
  /**
   * Create a JoSk instance
   * @param {object} opts - configuration object
   * @param {boolean} [opts.debug] - Enable debug logging
   * @param {function} [opts.onError] - Informational hook, called instead of throwing exceptions, see readme for more details
   * @param {boolean} [opts.autoClear] - Remove obsolete tasks (any tasks which are not found in the instance memory during runtime, but exists in the database)
   * @param {number} [opts.zombieTime] - Time in milliseconds, after this period of time - task will be interpreted as "zombie". This parameter allows to rescue task from "zombie mode" in case when: `ready()` wasn't called, exception during runtime was thrown, or caused by bad logic
   * @param {function} [opts.onExecuted] - Informational hook, called when task is finished, see readme for more details
   * @param {number} [opts.minRevolvingDelay] - Minimum revolving delay — the minimum delay between tasks executions in milliseconds
   * @param {number} [opts.maxRevolvingDelay] - Maximum revolving delay — the maximum delay between tasks executions in milliseconds
   */
  constructor(opts?: {
    debug?: boolean;
    onError?: Function;
    autoClear?: boolean;
    zombieTime?: number;
    onExecuted?: Function;
    minRevolvingDelay?: number;
    maxRevolvingDelay?: number;
  });
  debug: boolean;
  onError: boolean | Function;
  autoClear: boolean;
  zombieTime: number;
  onExecuted: boolean | Function;
  isDestroyed: boolean;
  minRevolvingDelay: number;
  maxRevolvingDelay: number;
  nextRevolutionTimeout: number;
  tasks: {};
  _debug: (...args: any[]) => void;
  adapter: any;
  /**
   * @async
   * @memberOf JoSk
   * @name ping
   * @description Check package readiness and connection to Storage
   * @returns {Promise<object>}
   * @throws {mix}
   */
  ping(): Promise<object>;
  /**
   * @async
   * @memberOf JoSk
   * Create recurring task (loop)
   * @name setInterval
   * @param {function} func - Function (task) to execute
   * @param {number} delay - Delay between task execution in milliseconds
   * @param {string} uid - Unique function (task) identification as a string
   * @returns {Promise<string>} - Timer ID
   */
  setInterval(func: Function, delay: number, uid: string): Promise<string>;
  /**
   * @async
   * @memberOf JoSk
   * Create delayed task
   * @name setTimeout
   * @param {function} func - Function (task) to execute
   * @param {number} delay - Delay before task execution in milliseconds
   * @param {string} uid - Unique function (task) identification as a string
   * @returns {Promise<string>} - Timer ID
   */
  setTimeout(func: Function, delay: number, uid: string): Promise<string>;
  /**
   * @async
   * @memberOf JoSk
   * Create task, which would get executed immediately and only once across multi-server setup
   * @name setImmediate
   * @param {function} func - Function (task) to execute
   * @param {string} uid - Unique function (task) identification as a string
   * @returns {Promise<string>} - Timer ID
   */
  setImmediate(func: Function, uid: string): Promise<string>;
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
  clearInterval(timerId: string | Promise<string>): Promise<boolean>;
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
  clearTimeout(timerId: string | Promise<string>): Promise<boolean>;
  /**
   * @memberOf JoSk
   * Destroy JoSk instance and stop all tasks
   * @name destroy
   * @returns {boolean} - `true` if instance successfully destroyed, `false` if instance already destroyed
   */
  destroy(): boolean;
  __checkState(): boolean;
  __remove(timerId: any): Promise<any>;
  __add(uid: any, isInterval: any, delay: any): Promise<void>;
  __execute(task: any): Promise<void>;
  __iterate(): Promise<void>;
  __tick(): void;
  __errorHandler(error: any, title: any, description: any, uid: any): void;
}
/** Class representing MongoDB adapter for JoSk */
export class MongoAdapter {
  /**
   * Create a MongoAdapter instance
   * @param {JoSk} joskInstance - JoSk instance
   * @param {object} opts - configuration object
   * @param {Db} opts.db - Required, Mongo's `Db` instance, like one returned from `MongoClient#db()` method
   * @param {string} [opts.lockCollectionName] - custom "lock" collection name
   * @param {string} [opts.prefix] - prefix for scope isolation; use when creating multiple JoSK instances within the single application
   * @param {boolean} [opts.resetOnInit] - Make sure all old tasks is completed before setting a new one, see readme for more details
   */
  constructor(opts?: {
    db: Db;
    lockCollectionName?: string;
    prefix?: string;
    resetOnInit?: boolean;
  });
  name: string;
  prefix: string;
  lockCollectionName: string;
  resetOnInit: boolean;
  db: Db;
  uniqueName: string;
  collection: any;
  lockCollection: any;
  /**
   * @async
   * @memberOf MongoAdapter
   * @name ping
   * @description Check connection to MongoDB
   * @returns {Promise<object>}
   */
  ping(): Promise<object>;
  acquireLock(): Promise<boolean>;
  releaseLock(): Promise<void>;
  remove(uid: any): Promise<boolean>;
  add(uid: any, isInterval: any, delay: any): Promise<boolean>;
  update(task: any, nextExecuteAt: any): Promise<boolean>;
  iterate(nextExecuteAt: any): Promise<void>;
}
/** Class representing Redis adapter for JoSk */
export class RedisAdapter {
  /**
   * Create a RedisAdapter instance
   * @param {object} opts - configuration object
   * @param {RedisClient} opts.client - Required, Redis'es `RedisClient` instance, like one returned from `await redis.createClient().connect()` method
   * @param {string} [opts.lockCollectionName] - custom "lock" collection name
   * @param {string} [opts.prefix] - prefix for scope isolation; use when creating multiple JoSK instances within the single application
   * @param {boolean} [opts.resetOnInit] - Make sure all old tasks is completed before setting a new one, see readme for more details
   */
  constructor(opts?: {
    client: RedisClient;
    lockCollectionName?: string;
    prefix?: string;
    resetOnInit?: boolean;
  });
  name: string;
  prefix: string;
  uniqueName: string;
  lockKey: string;
  resetOnInit: boolean;
  client: RedisClient;
  /**
   * @async
   * @memberOf RedisAdapter
   * @name ping
   * @description Check connection to Redis
   * @returns {Promise<object>}
   */
  ping(): Promise<object>;
  acquireLock(): Promise<boolean>;
  releaseLock(): Promise<void>;
  remove(uid: any): Promise<boolean>;
  add(uid: any, isInterval: any, delay: any): Promise<boolean>;
  update(task: any, nextExecuteAt: any): Promise<boolean>;
  iterate(nextExecuteAt: any): Promise<void>;
  __getTaskKey(uid: any): string;
}
