export type PostgresQueryResult = {
    rowCount?: number | null | undefined;
    rows?: unknown[] | undefined;
};
export type PostgresClient = {
    query: (queryText: string, values?: unknown[]) => Promise<PostgresQueryResult>;
};
export type JoSk = import("../index.js").JoSk;
export type JoSkExecuteMode = import("../index.js").JoSkExecuteMode;
export type JoSkLock = import("../index.js").JoSkLock;
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
 * @typedef {import('../index.js').JoSkExecuteMode} JoSkExecuteMode
 * @typedef {import('../index.js').JoSkLock} JoSkLock
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
    __readyPromise: Promise<void>;
    /**
     * @returns {Promise<void>}
     */
    ready(): Promise<void>;
    /** @internal */
    __setup(): Promise<void>;
    /**
     * @async
     * @memberOf PostgresAdapter
     * @name ping
     * @description Check connection to PostgreSQL
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
     * @returns {Promise<PostgresTask | null>}
     */
    __claimNextTask(nextExecuteAt: Date, lock: JoSkLock): Promise<PostgresTask | null>;
    /**
     * @param {Date} nextExecuteAt
     * @param {JoSkLock} lock
     * @param {number} limit
     * @returns {Promise<PostgresTask[]>}
     */
    __claimNextTasks(nextExecuteAt: Date, lock: JoSkLock, limit: number): Promise<PostgresTask[]>;
    /** @internal */
    __customPrivateMethod(): boolean;
}
