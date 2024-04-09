class BlankAdapter {
  /**
   * Create a BlankAdapter instance
   * @param {object} opts - configuration object
   * @param {object} opts.requiredOption - Required option description
   * @param {string} [opts.prefix] - prefix for scope isolation; use when creating multiple JoSK instances within the single application
   * @param {boolean} [opts.resetOnInit] - Make sure all old tasks is completed before setting a new one, see readme for more details
   */
  constructor(opts = {}) {
    this.name = 'adapter-name'; // set unique adapter name
    this.prefix = opts.prefix || 'default'; // Pass down user-defined prefix
    this.resetOnInit = opts.resetOnInit || false;
    this.uniqueName = `josk-${this.prefix}`; // Unique ID when multiple instances of JoSk are used
    this.lockKey = `${this.uniqueName}.lock`; // Key used for storage lock/release while tasks are running

    // Check that user has provided required option,
    // usually DB connector of some sort or other
    if (!opts.requiredOption) {
      throw new Error('{requiredOption} option is required for BlankAdapter', {
        description: 'BlankAdapter requires {requiredOption} option, e.g. returned from `driver.getRequiredOption()` method'
      });
    }

    this.requiredOption = opts.requiredOption;
    if (this.resetOnInit) { // Check if user wish to reset storage on init
      // REMOVE TASKS RECORDS ONLY WITHIN this.uniqueName SCOPE!
    }
  }

  /**
   * @async
   * @memberOf BlankAdapter
   * @name ping
   * @description Check connection to Storage
   * @returns {Promise<object>}
   */
  async ping() {
    // LEAVE THIS if BLOCK UNCHANGED
    if (!this.joskInstance) {
      const reason = 'JoSk instance not yet assigned to {joskInstance} of Storage Adapter context';
      return {
        status: reason,
        code: 503,
        statusCode: 503,
        error: new Error(reason),
      };
    }

    try {
      const ping = await this.requiredOption.ping();
      if (ping === 'PONG') {
        return {
          status: 'OK',
          code: 200,
          statusCode: 200,
        };
      }

      throw new Error(`Unexpected response from Storage#ping received: ${ping}`);
    } catch (pingError) {
      return {
        status: 'Internal Server Error',
        code: 500,
        statusCode: 500,
        error: pingError
      };
    }
  }

  /**
   * @async
   * @memberOf BlankAdapter
   * Function called to acquire read/write lock on Storage adapter
   * @name acquireLock
   * @returns {Promise<boolean>}
   */
  async acquireLock() {
    const isLocked = await this.requiredOption.lock();
    if (isLocked) {
      // Lock not available
      return false;
    }
    // Lock acquired
    return true;
  }

  /**
   * @async
   * @memberOf BlankAdapter
   * Function called to release write/read lock from Storage adapter
   * @name releaseLock
   * @returns {Promise<void 0>}
   */
  async releaseLock() {
    await this.requiredOption.release();
  }

  /**
   * @async
   * @memberOf BlankAdapter
   * Function called to remove task from the storage
   * @name remove
   * @param {string} uid - Unique ID of the task
   * @returns {Promise<boolean>}
   */
  async remove(uid) {
    const isRemoved = await this.requiredOption.remove(uid);
    if (isRemoved) {
      // Task removed
      return true;
    }
    // Can not remove the task
    return false;
  }

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
  async add(uid, isInterval, delay) {
    const next = Date.now() + delay;
    // STORE TASK IN THE STORAGE IN THE NEXT FORMAT
    this.requiredOption.save({
      uid: uid, // String
      delay: delay, // Number
      executeAt: next, // Date or Number
      isInterval: isInterval, // Boolean
      isDeleted: false // Boolean
    });
  }

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
  async update(task, nextExecuteAt) {
    if (typeof task !== 'object' || typeof task.uid !== 'string') {
      this.joskInstance.__errorHandler({ task }, '[StorageAdapter] [update] [task]', 'Task malformed or undefined');
      return false;
    }

    if (!nextExecuteAt instanceof Date) {
      this.joskInstance.__errorHandler({ nextExecuteAt }, '[StorageAdapter] [update] [nextExecuteAt]', 'Next execution date is malformed or undefined', task.uid);
      return false;
    }

    try {
      const exists = await this.requiredOption.exists(task.uid);
      if (!exists) {
        return false;
      }
      await this.requiredOption.update({
        uid: task.uid
      }, {
        executeAt: nextExecuteAt
      });
      return true;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[StorageAdapter] [update] [opError]', 'Exception inside StorageAdapter#update() method', task.uid);
      return false;
    }
  }

  /**
   * @async
   * @memberOf BlankAdapter
   * Find and run tasks one by one
   * @name iterate
   * @param {Date} nextExecuteAt - Date defining time of the next execution for "zombie" tasks
   * @param {function} cb - callback that must get called after looping over tasks
   * @returns {void 0}
   */
  async iterate(nextExecuteAt) {
    // GET TASKS WITHIN this.uniqueName SCOPE!
    // AND ONLY WHERE executeAt <= now
    // RUN ONE BY ONE VIA this.joskInstance.__execute() METHOD

    const cursorWithTasks = this.requiredOption.getTasks({
      scope: this.uniqueName,
      executeAt: {
        $lte: Date.now() // Number (timestamp)
      }
    });

    for await (const task of cursorWithTasks) {
      // "Lock task" by setting the next execution far ahead (timestamp + zombieTime)
      await this.requiredOption.update({
        uid: task.uid
      }, {
        executeAt: +nextExecuteAt, // Convert Date to Number (timestamp)
      });

      // EXECUTE TASK
      this.joskInstance.__execute(task);
    }
  }

  __customPrivateMethod() {
    // DEFINE PREFIXED __ CUSTOM METHODS
    // WHEN NEEDED FOR THE ADAPTER
    return true;
  }
}

export { BlankAdapter };
