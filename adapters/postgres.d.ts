export type PostgresQueryResult = {
    rowCount?: number | null | undefined;
    rows?: unknown[] | undefined;
};
/**
 * Minimal client surface used by PostgresAdapter. The official `pg`
 * package's `Pool` and `Client` both satisfy this shape. Pool is the
 * recommended choice for long-running applications.
 */
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
    /**
     * @returns {Promise<void>}
     */
    ready(): Promise<void>;
    /**
     * @async
     * @memberOf PostgresAdapter
     * @name ping
     * @description Check connection to PostgreSQL
     * @returns {Promise<AdapterPingResult>}
     */
    ping(): Promise<AdapterPingResult>;
    /**
     * Acquire scheduler lease using PostgreSQL server time so the lock is
     * resistant to client-side clock skew between distributed nodes.
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
