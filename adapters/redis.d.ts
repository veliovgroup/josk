export type RedisClient = import("redis").RedisClientType;
export type JoSk = import("../index.js").JoSk;
export type JoSkExecuteMode = import("../index.js").JoSkExecuteMode;
export type JoSkLock = import("../index.js").JoSkLock;
export type AdapterPingResult = {
    status: string;
    code: number;
    statusCode: number;
    error?: unknown;
};
export type RedisAdapterOption = {
    client: RedisClient;
    prefix?: string | undefined;
    resetOnInit?: boolean | undefined;
};
export type RedisTask = {
    uid: string;
    delay: number;
    executeAt: number;
    isInterval: boolean;
    isDeleted: boolean;
};
/** Class representing Redis adapter for JoSk */
export class RedisAdapter {
    /**
     * Create a RedisAdapter instance
     * @param {RedisAdapterOption} opts - configuration object
     */
    constructor(opts?: RedisAdapterOption);
    name: string;
    prefix: string;
    uniqueName: string;
    lockKey: string;
    scheduleKey: string;
    tasksKey: string;
    resetOnInit: boolean;
    /** @type {RedisClient} */
    client: RedisClient;
    __readyPromise: Promise<void>;
    /**
     * @returns {Promise<void>}
     */
    ready(): Promise<void>;
    /** @internal */
    __setup(): Promise<void>;
    /**
     * @async
     * @memberOf RedisAdapter
     * @name ping
     * @description Check connection to Redis
     * @returns {Promise<AdapterPingResult>}
     */
    ping(): Promise<AdapterPingResult>;
    /**
     * @param {JoSkLock} lock
     * @returns {Promise<boolean>}
     */
    acquireLock(lock: JoSkLock): Promise<boolean>;
    /**
     * @param {JoSkLock} lock
     * @returns {Promise<void>}
     */
    releaseLock(lock: JoSkLock): Promise<void>;
    /**
     * @param {string} uid
     * @returns {Promise<boolean>}
     */
    remove(uid: string): Promise<boolean>;
    /**
     * @param {string} uid
     * @param {boolean} isInterval
     * @param {number} delay
     * @returns {Promise<boolean>}
     */
    add(uid: string, isInterval: boolean, delay: number): Promise<boolean>;
    /**
     * @param {{ uid: string }} task
     * @param {Date} nextExecuteAt
     * @returns {Promise<boolean>}
     */
    update(task: {
        uid: string;
    }, nextExecuteAt: Date): Promise<boolean>;
    /**
     * @param {Date} nextExecuteAt
     * @param {JoSkLock} lock
     * @param {JoSkExecuteMode} executeMode
     * @returns {Promise<number>}
     */
    iterate(nextExecuteAt: Date, lock: JoSkLock, executeMode: JoSkExecuteMode): Promise<number>;
    /**
     * @param {Date} nextExecuteAt
     * @param {JoSkLock} lock
     * @returns {Promise<RedisTask | null>}
     */
    __claimNextTask(nextExecuteAt: Date, lock: JoSkLock): Promise<RedisTask | null>;
    /**
     * @param {Date} nextExecuteAt
     * @param {JoSkLock} lock
     * @param {number} limit
     * @returns {Promise<RedisTask[]>}
     */
    __claimNextTasks(nextExecuteAt: Date, lock: JoSkLock, limit: number): Promise<RedisTask[]>;
    /**
     * @internal
     * @param {Record<string, unknown>} task
     * @returns {RedisTask | null}
     */
    __normalizeTask(task: Record<string, unknown>): RedisTask | null;
    /**
     * @internal
     * @param {JoSkLock} lock
     * @returns {string}
     */
    __serializeLock(lock: JoSkLock): string;
    /**
     * @internal
     * @param {string} uid
     * @returns {string}
     */
    __getTaskKey(uid: string): string;
}
