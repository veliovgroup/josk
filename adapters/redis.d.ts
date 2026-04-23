export type RedisClient = import("redis").RedisClientType;
export type JoSk = import("../index.js").JoSk;
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
/**
 * @typedef {import('redis').RedisClientType} RedisClient
 * @typedef {import('../index.js').JoSk} JoSk
 */
/**
 * @typedef {object} AdapterPingResult
 * @property {string} status
 * @property {number} code
 * @property {number} statusCode
 * @property {unknown} [error]
 */
/**
 * @typedef {object} RedisAdapterOption
 * @property {RedisClient} client
 * @property {string} [prefix]
 * @property {boolean} [resetOnInit]
 */
/**
 * @typedef {object} RedisTask
 * @property {string} uid
 * @property {number} delay
 * @property {number} executeAt
 * @property {boolean} isInterval
 * @property {boolean} isDeleted
 */
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
    resetOnInit: boolean;
    /** @type {RedisClient} */
    client: RedisClient;
    /**
     * @async
     * @memberOf RedisAdapter
     * @name ping
     * @description Check connection to Redis
     * @returns {Promise<AdapterPingResult>}
     */
    ping(): Promise<AdapterPingResult>;
    /**
     * @returns {Promise<boolean>}
     */
    acquireLock(): Promise<boolean>;
    /**
     * @returns {Promise<void>}
     */
    releaseLock(): Promise<void>;
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
     * @returns {Promise<void>}
     */
    iterate(nextExecuteAt: Date): Promise<void>;
    /**
     * @internal
     * @param {string} uid
     * @returns {string}
     */
    __getTaskKey(uid: string): string;
}
