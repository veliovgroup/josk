export type RedisClient = import("redis").RedisClientType | import("redis").RedisClusterType;
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
    /**
     * - Use Redis Cluster hash-tag keys (`josk:{prefix}:*`). Default keeps existing `josk:prefix:*` keys.
     */
    useHashTags?: boolean | undefined;
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
    useHashTags: boolean;
    uniqueName: string;
    lockKey: string;
    scheduleKey: string;
    tasksKey: string;
    resetOnInit: boolean;
    /** @type {RedisClient} */
    client: RedisClient;
    /**
     * @returns {Promise<void>}
     */
    ready(): Promise<void>;
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
}
