export type MongoDbLike = {
    collection: (name: string) => object;
    command: (command: {
        ping: number;
    }) => Promise<unknown>;
};
export type JoSk = import("../index.cjs").JoSk;
export type JoSkExecuteMode = import("../index.cjs").JoSkExecuteMode;
export type JoSkLock = import("../index.cjs").JoSkLock;
export type AdapterPingResult = {
    status: string;
    code: number;
    statusCode: number;
    error?: unknown;
};
export type MongoAdapterOption<D extends MongoDbLike = MongoDbLike> = {
    db: D;
    lockCollectionName?: string | undefined;
    prefix?: string | undefined;
    resetOnInit?: boolean | undefined;
};
export type MongoTask = {
    _id?: unknown;
    uid: string;
    delay: number;
    executeAt?: Date | undefined;
    isInterval: boolean;
    isDeleted: boolean;
    claimLeaseId?: string | undefined;
};
/**
 * Class representing MongoDB adapter for JoSk
 * @template {MongoDbLike} [D=MongoDbLike]
 */
export class MongoAdapter<D extends MongoDbLike = MongoDbLike> {
    /**
     * Create a MongoAdapter instance
     * @param {MongoAdapterOption<D>} opts - configuration object
     */
    constructor(opts?: MongoAdapterOption<D>);
    name: string;
    prefix: string;
    lockCollectionName: string;
    resetOnInit: boolean;
    /** @type {D} */
    db: D;
    uniqueName: string;
    /** @type {ReturnType<D['collection']>} */
    collection: ReturnType<D["collection"]>;
    /** @type {ReturnType<D['collection']>} */
    lockCollection: ReturnType<D["collection"]>;
    /** @type {JoSk | undefined} */
    joskInstance: JoSk | undefined;
    /**
     * Run setup once; a failed attempt is re-run by the next call.
     * @returns {Promise<void>}
     */
    ready(): Promise<void>;
    /**
     * @async
     * @memberOf MongoAdapter
     * @name ping
     * @description Check connection to MongoDB
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
     * Skips the write when `task.claimLeaseId` no longer matches storage.
     * @param {{ uid: string, claimLeaseId?: string }} task
     * @param {Date} nextExecuteAt
     * @returns {Promise<boolean>}
     */
    update(task: {
        uid: string;
        claimLeaseId?: string;
    }, nextExecuteAt: Date): Promise<boolean>;
    /**
     * @param {Date} nextExecuteAt
     * @param {JoSkLock} lock
     * @param {JoSkExecuteMode} executeMode
     * @returns {Promise<number>}
     */
    iterate(nextExecuteAt: Date, lock: JoSkLock, executeMode: JoSkExecuteMode): Promise<number>;
}
