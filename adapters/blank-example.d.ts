export interface BlankAdapterOption {
  requiredOption: unknown;
  prefix?: string;
  resetOnInit?: boolean;
}

export class BlankAdapter {
  /**
   * Create a BlankAdapter instance
   * @param {object} opts - configuration object
   * @param {object} opts.requiredOption - Required option description
   * @param {string} [opts.prefix] - prefix for scope isolation; use when creating multiple JoSK instances within the single application
   * @param {boolean} [opts.resetOnInit] - Make sure all old tasks is completed before setting a new one, see readme for more details
   */
  constructor(opts?: BlankAdapterOption);
  name: string;
  prefix: string;
  resetOnInit: boolean;
  uniqueName: string;
  lockKey: string;
  requiredOption: unknown;
  /**
   * @async
   * @memberOf BlankAdapter
   * @name ping
   * @description Check connection to Storage
   * @returns {Promise<void>}
   */
  ping(): Promise<void>;
  /**
   * @async
   * @memberOf BlankAdapter
   * Function called to acquire read/write lock on Storage adapter
   * @name acquireLock
   * @returns {Promise<boolean>}
   */
  acquireLock(): Promise<boolean>;
  /**
   * @async
   * @memberOf BlankAdapter
   * Function called to release write/read lock from Storage adapter
   * @name releaseLock
   * @returns {Promise<void 0>}
   */
  releaseLock(): Promise<void>;
  /**
   * @async
   * @memberOf BlankAdapter
   * Function called to remove task from the storage
   * @name remove
   * @param {string} uid - Unique ID of the task
   * @returns {Promise<boolean>}
   */
  remove(uid: string): Promise<boolean>;
  /**
   * @async
   * @memberOf BlankAdapter
   * Function called to add task to the storage
   * @name add
   * @param {string} uid - Unique ID of the task
   * @param {boolean} isInterval - true/false defining loop or one-time task
   * @param {number} delay - Delay in milliseconds
   * @returns {Promise<void 0>}
   */
  add(uid: string, isInterval: boolean, delay: number): Promise<void>;
  /**
   * @async
   * @memberOf BlankAdapter
   * Function called after executing tasks
   * Used by "Interval" tasks to set the next execution
   * @name update
   * @param {object} task - Full object of the task from storage
   * @param {Date} nextExecuteAt - Date defining time of the next execution for "Interval" tasks
   * @returns {Promise<boolean>} - `true` if updated, `false` id doesn't exist
   */
  update(task: unknown, nextExecuteAt: Date): Promise<boolean>;
  /**
   * @async
   * @memberOf BlankAdapter
   * Find and run tasks one by one
   * @name iterate
   * @param {Date} nextExecuteAt - Date defining time of the next execution for "zombie" tasks
   * @param {function} cb - callback that must get called after looping over tasks
   * @returns {void 0}
   */
  iterate(nextExecuteAt: Date): void;
}
