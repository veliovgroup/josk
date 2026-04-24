export class BlankAdapter {
    /**
     * Create a BlankAdapter instance
     * @param {object} opts - configuration object
     * @param {object} opts.requiredOption - Required option description
     * @param {string} [opts.prefix] - prefix for scope isolation; use when creating multiple JoSK instances within the single application
     * @param {boolean} [opts.resetOnInit] - clear old tasks on startup
     */
    constructor(opts?: {
        requiredOption: object;
        prefix?: string | undefined;
        resetOnInit?: boolean | undefined;
    });
    name: string;
    prefix: string;
    resetOnInit: boolean;
    uniqueName: string;
    lockKey: string;
    requiredOption: object;
    __readyPromise: Promise<void>;
    /**
     * @returns {Promise<void>}
     */
    ready(): Promise<void>;
    /** @internal */
    __setup(): Promise<void>;
    /**
     * @async
     * @memberOf BlankAdapter
     * @name ping
     * @description Check connection to Storage
     * @returns {Promise<object>}
     */
    ping(): Promise<object>;
    /**
     * @async
     * @memberOf BlankAdapter
     * Acquire second-layer scheduler lock with owner token
     * @name acquireLock
     * @param {{ ownerId: string, leaseId: string, expiresAtMs: number }} lock
     * @returns {Promise<boolean>}
     */
    acquireLock(lock: {
        ownerId: string;
        leaseId: string;
        expiresAtMs: number;
    }): Promise<boolean>;
    /**
     * @async
     * @memberOf BlankAdapter
     * Release second-layer scheduler lock only when owner token matches
     * @name releaseLock
     * @param {{ ownerId: string, leaseId: string }} lock
     * @returns {Promise<void>}
     */
    releaseLock(lock: {
        ownerId: string;
        leaseId: string;
    }): Promise<void>;
    /**
     * @async
     * @memberOf BlankAdapter
     * Remove task from storage
     * @name remove
     * @param {string} uid - Unique ID of task
     * @returns {Promise<boolean>}
     */
    remove(uid: string): Promise<boolean>;
    /**
     * @async
     * @memberOf BlankAdapter
     * Upsert task in storage
     * @name add
     * @param {string} uid - Unique ID of task
     * @param {boolean} isInterval - true/false defining loop or one-time task
     * @param {number} delay - Delay in milliseconds
     * @returns {Promise<boolean>}
     */
    add(uid: string, isInterval: boolean, delay: number): Promise<boolean>;
    /**
     * @async
     * @memberOf BlankAdapter
     * Update next execution timestamp
     * @name update
     * @param {object} task - Full object of task from storage
     * @param {Date} nextExecuteAt - Date defining time of next execution
     * @returns {Promise<boolean>}
     */
    update(task: object, nextExecuteAt: Date): Promise<boolean>;
    /**
     * @async
     * @memberOf BlankAdapter
     * Claim due tasks atomically and execute them
     * @name iterate
     * @param {Date} nextExecuteAt - Date defining time of next execution for zombie recovery
     * @param {{ ownerId: string, leaseId: string }} lock
     * @param {'batch' | 'one'} executeMode
     * @returns {Promise<number>}
     */
    iterate(nextExecuteAt: Date, lock: {
        ownerId: string;
        leaseId: string;
    }, executeMode: "batch" | "one"): Promise<number>;
    /** @internal */
    __customPrivateMethod(): boolean;
}
