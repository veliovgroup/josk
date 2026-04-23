export type Collection = import("mongodb").Collection;
export type Db = import("mongodb").Db;
export type JoSk = import("../index.js").JoSk;
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
    _id: unknown;
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
     * @async
     * @memberOf MongoAdapter
     * @name ping
     * @description Check connection to MongoDB
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
}
