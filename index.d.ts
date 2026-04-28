export type JoSkPingResult = {
    status: string;
    code: number;
    statusCode: number;
    error?: unknown;
};
export type JoSkErrorDetails = {
    description: string;
    error: unknown;
    uid: string | null;
    task?: unknown;
};
export type JoSkExecutedDetails = {
    uid: string;
    date: Date;
    delay: number;
    timestamp: number;
};
export type JoSkTask = {
    uid: string;
    delay: number;
    isInterval: boolean;
    isDeleted: boolean;
    executeAt?: number | Date | undefined;
};
export type JoSkExecuteMode = "batch" | "one";
export type JoSkLock = {
    ownerId: string;
    leaseId: string;
    expireAt: Date;
    expiresAtMs: number;
};
export type JoSkOnError = (title: string, details: JoSkErrorDetails) => void;
export type JoSkOnExecuted = (uid: string, details: JoSkExecutedDetails) => void;
export type JoSkReadyCallback = (error: Error | undefined, success: boolean) => void;
export type JoSkReady = (nextExecuteAt?: number | Date | JoSkReadyCallback | undefined) => Promise<boolean>;
export type JoSkTaskHandler = (ready: JoSkReady) => void | Promise<void>;
export type JoSkStoredTask = JoSkTaskHandler & {
    isMissing?: boolean;
};
export type JoSkAdapter = {
    joskInstance?: JoSk | undefined;
    acquireLock: (lock: JoSkLock) => Promise<boolean>;
    releaseLock: (lock: JoSkLock) => Promise<void>;
    remove: (uid: string) => Promise<boolean>;
    add: (uid: string, isInterval: boolean, delay: number) => Promise<boolean | void>;
    update: (task: JoSkTask, nextExecuteAt: Date) => Promise<boolean>;
    iterate: (nextExecuteAt: Date, lock: JoSkLock, executeMode: JoSkExecuteMode) => Promise<number | void>;
    ping: () => Promise<JoSkPingResult>;
    ready?: (() => Promise<void>) | undefined;
};
export type JoSkOption = {
    adapter: JoSkAdapter;
    debug?: boolean | undefined;
    onError?: JoSkOnError | undefined;
    autoClear?: boolean | undefined;
    zombieTime?: number | undefined;
    onExecuted?: JoSkOnExecuted | undefined;
    minRevolvingDelay?: number | undefined;
    maxRevolvingDelay?: number | undefined;
    execute?: JoSkExecuteMode | undefined;
    lockOwnerId?: string | undefined;
};
/** Class representing a JoSk task runner (cron). */
export class JoSk {
    /**
     * Create a JoSk instance
     * @param {JoSkOption} opts - configuration object
     */
    constructor(opts?: JoSkOption);
    debug: boolean;
    onError: boolean | JoSkOnError;
    autoClear: boolean;
    zombieTime: number;
    onExecuted: boolean | JoSkOnExecuted;
    isDestroyed: boolean;
    minRevolvingDelay: number;
    maxRevolvingDelay: number;
    execute: JoSkExecuteMode;
    lockOwnerId: string;
    /** @internal */
    nextRevolutionTimeout: NodeJS.Timeout | null;
    /** @internal */
    __lockLeaseCounter: number;
    /** @internal */
    __adapterReadyPromise: Promise<void> | null;
    /** @type {Record<string, JoSkStoredTask>} */
    tasks: Record<string, JoSkStoredTask>;
    /** @internal */
    _debug: (...args: any[]) => void;
    /** @type {JoSkAdapter} */
    adapter: JoSkAdapter;
    /**
     * @async
     * @memberOf JoSk
     * @name ping
     * @description Check package readiness and connection to Storage
     * @returns {Promise<JoSkPingResult>}
     */
    ping(): Promise<JoSkPingResult>;
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
    setInterval(func: JoSkTaskHandler, delay: number, uid: string): Promise<string>;
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
    setTimeout(func: JoSkTaskHandler, delay: number, uid: string): Promise<string>;
    /**
     * @async
     * @memberOf JoSk
     * Create task, which would get executed immediately and only once across multi-server setup
     * @name setImmediate
     * @param {JoSkTaskHandler} func - Function (task) to execute
     * @param {string} uid - Unique function (task) identification as a string
     * @returns {Promise<string>} - Timer ID
     */
    setImmediate(func: JoSkTaskHandler, uid: string): Promise<string>;
    /**
     * @async
     * @memberOf JoSk
     * Cancel (abort) current interval timer.
     * Must be called in a separate event loop from `.setInterval()`
     * @name clearInterval
     * @param {string|Promise<string>} timerId - Unique function (task) identification as a string, returned from `.setInterval()`
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
    /** @internal */
    __checkState(): boolean;
    /** @internal */
    __adapterReady(): Promise<void>;
    /** @internal */
    __getLock(): {
        ownerId: string;
        leaseId: string;
        expireAt: Date;
        expiresAtMs: number;
    };
    /** @internal */
    __remove(timerId: any): Promise<boolean>;
    /** @internal */
    __add(uid: any, isInterval: any, delay: any): Promise<void>;
    /**
     * @internal
     * @param {JoSkTask} task
     * @returns {Promise<void>}
     */
    __execute(task: JoSkTask): Promise<void>;
    /** @internal */
    __iterate(): Promise<void>;
    /** @internal */
    __tick(): void;
    /** @internal */
    __errorHandler(error: any, title: any, description: any, uid: any): void;
}
import { MongoAdapter } from './adapters/mongo.js';
import { RedisAdapter } from './adapters/redis.js';
import { PostgresAdapter } from './adapters/postgres.js';
export { MongoAdapter, RedisAdapter, PostgresAdapter };
