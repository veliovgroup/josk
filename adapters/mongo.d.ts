export type Collection = import("mongodb").Collection;
export type Db = import("mongodb").Db;
export type JoSk = import("../index.js").JoSk;
export type JoSkExecuteMode = import("../index.js").JoSkExecuteMode;
export type JoSkLock = import("../index.js").JoSkLock;
export type AdapterPingResult = {
    status: string;
    code: number;
    statusCode: number;
    error?: unknown;
};
export type MongoAdapterOption = {
    db: Db;
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
};
/** Class representing MongoDB adapter for JoSk */
export class MongoAdapter {
    /**
     * Create a MongoAdapter instance
     * @param {MongoAdapterOption} opts - configuration object
     */
    constructor(opts?: MongoAdapterOption);
    name: string;
    prefix: string;
    lockCollectionName: string;
    resetOnInit: boolean;
    /** @type {Db} */
    db: Db;
    uniqueName: string;
    /** @type {Collection} */
    collection: Collection;
    /** @type {Collection} */
    lockCollection: Collection;
    /**
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
