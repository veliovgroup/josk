export type PostgresQueryResult = {
    rowCount?: number | null | undefined;
    rows?: unknown[] | undefined;
};
export type PostgresClient = {
    query: (queryText: string, values?: unknown[]) => Promise<PostgresQueryResult>;
};
export type JoSk = import("../index.js").JoSk;
export type AdapterPingResult = {
    status: string;
    code: number;
    statusCode: number;
    error?: unknown;
};
export type PostgresAdapterOption = {
    client: PostgresClient;
    prefix?: string | undefined;
    resetOnInit?: boolean | undefined;
};
export type PostgresTask = {
    uid: string;
    delay: string | number;
    execute_at: string | number;
    is_interval: boolean;
    is_deleted: boolean;
};
/**
 * @typedef {object} PostgresQueryResult
 * @property {number | null | undefined} [rowCount]
 * @property {unknown[]} [rows]
 */
/**
 * @typedef {object} PostgresClient
 * @property {(queryText: string, values?: unknown[]) => Promise<PostgresQueryResult>} query
 */
/**
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
 * @typedef {object} PostgresAdapterOption
 * @property {PostgresClient} client
 * @property {string} [prefix]
 * @property {boolean} [resetOnInit]
 */
/**
 * @typedef {object} PostgresTask
 * @property {string} uid
 * @property {string | number} delay
 * @property {string | number} execute_at
 * @property {boolean} is_interval
 * @property {boolean} is_deleted
 */
/** Class representing PostgreSQL adapter for JoSk */
export class PostgresAdapter {
    /**
     * Create a PostgresAdapter instance
     * @param {PostgresAdapterOption} opts - configuration object
     */
    constructor(opts?: PostgresAdapterOption);
    name: string;
    prefix: string;
    uniqueName: string;
    lockKey: string;
    resetOnInit: boolean;
    /** @type {PostgresClient} */
    client: PostgresClient;
    /** @internal */
    _setupTables(): Promise<void>;
    /**
     * @async
     * @memberOf PostgresAdapter
     * @name ping
     * @description Check connection to PostgreSQL
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
    /** @internal */
    __customPrivateMethod(): boolean;
}
