import { Db } from 'mongodb';
import { RedisClientType as RedisClient } from 'redis';
interface ErrorDetails {
  description: string
  error: Error
  uid: null | string
  task?: unknown
}

interface ExecutedDetails {
  uid: string
  date: Date
  delay: number
  timestamp: number
}

type OnErrorFunc = (title: string, details: ErrorDetails) => void
type OnExecutedFunc = (uid: string, details: ExecutedDetails) => void
type AsyncTaskFunc = () => Promise<void>
type SyncTaskFunc = () => void
type SyncNextTaskFunc = (ready: (next?: Date) => void) => void

export interface JoSkOption {
  debug?: boolean;
  onError?: OnErrorFunc;
  autoClear?: boolean;
  zombieTime?: number;
  onExecuted?: OnExecutedFunc;
  minRevolvingDelay?: number;
  maxRevolvingDelay?: number;
}

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
  constructor(opts?: JoSkOption);
  debug: boolean;
  onError: false | OnErrorFunc;
  autoClear: boolean;
  zombieTime: number;
  onExecuted: false | OnExecutedFunc;
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
  ping(): Promise<unknown>;
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
  setInterval(func: AsyncTaskFunc | SyncNextTaskFunc, delay: number, uid: string): Promise<string>;
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
  setTimeout(func: AsyncTaskFunc | SyncTaskFunc, delay: number, uid: string): Promise<string>;
  /**
   * @async
   * @memberOf JoSk
   * Create task, which would get executed immediately and only once across multi-server setup
   * @name setImmediate
   * @param {function} func - Function (task) to execute
   * @param {string} uid - Unique function (task) identification as a string
   * @returns {Promise<string>} - Timer ID
   */
  setImmediate(func: AsyncTaskFunc | SyncTaskFunc, uid: string): Promise<string>;
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
  __remove(timerId: string): Promise<any>;
  __add(uid: string, isInterval: boolean, delay: number): Promise<void>;
  __execute(task: unknown): Promise<void>;
  __iterate(): Promise<void>;
  __tick(): void;
  __errorHandler(error: unknown, title: string, description: string, uid: string): void;
}

export interface MongoAdapterOption {
  db: Db;
  lockCollectionName?: string;
  prefix?: string;
  resetOnInit?: boolean;
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
  constructor(opts?: MongoAdapterOption);
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
  ping(): Promise<unknown>;
  acquireLock(): Promise<boolean>;
  releaseLock(): Promise<void>;
  remove(uid: string): Promise<boolean>;
  add(uid: string, isInterval: boolean, delay: number): Promise<boolean>;
  update(task: unknown, nextExecuteAt: Date): Promise<boolean>;
  iterate(nextExecuteAt: Date): Promise<void>;
}

export interface RedisAdapterOption {
  client: RedisClient;
  lockCollectionName?: string;
  prefix?: string;
  resetOnInit?: boolean;
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
  constructor(opts?: RedisAdapterOption);
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
  ping(): Promise<unknown>;
  acquireLock(): Promise<boolean>;
  releaseLock(): Promise<void>;
  remove(uid: string): Promise<boolean>;
  add(uid: string, isInterval: boolean, delay: number): Promise<boolean>;
  update(task: unknown, nextExecuteAt: Date): Promise<boolean>;
  iterate(nextExecuteAt: Date): Promise<void>;
  __getTaskKey(uid: string): string;
}
