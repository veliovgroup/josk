class BlankAdapter {
  /**
   * Create a BlankAdapter instance
   * @param {object} opts - configuration object
   * @param {object} opts.requiredOption - Required option description
   * @param {string} [opts.prefix] - prefix for scope isolation; use when creating multiple JoSK instances within the single application
   * @param {boolean} [opts.resetOnInit] - clear old tasks on startup
   */
  constructor(opts = {}) {
    this.name = 'adapter-name'; // set unique adapter name
    this.prefix = opts.prefix || 'default'; // Pass down user-defined prefix
    this.resetOnInit = !!opts.resetOnInit;
    this.uniqueName = `josk-${this.prefix}`; // Unique ID when multiple instances of JoSk are used
    this.lockKey = `${this.uniqueName}.lock`; // Key used for storage lock/release while tasks are running

    if (!opts.requiredOption) {
      throw new Error('{requiredOption} option is required for BlankAdapter', {
        description: 'BlankAdapter requires {requiredOption} option, e.g. returned from `driver.getRequiredOption()` method'
      });
    }

    this.requiredOption = opts.requiredOption;
    this.__readyPromise = this.__setup();
  }

  /**
   * @returns {Promise<void>}
   */
  async ready() {
    await this.__readyPromise;
  }

  /** @internal */
  async __setup() {
    if (this.resetOnInit) {
      await this.requiredOption.clearScope(this.uniqueName);
      await this.requiredOption.release(this.lockKey);
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
    // LEAVE THIS `if` BLOCK UNCHANGED
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
      await this.ready();
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
   * Acquire second-layer scheduler lock with owner token
   * @name acquireLock
   * @param {{ ownerId: string, leaseId: string, expiresAtMs: number }} lock
   * @returns {Promise<boolean>}
   */
  async acquireLock(lock) {
    await this.ready();
    return await this.requiredOption.acquireLock({
      key: this.lockKey,
      ownerId: lock.ownerId,
      leaseId: lock.leaseId,
      expiresAtMs: lock.expiresAtMs,
    });
  }

  /**
   * @async
   * @memberOf BlankAdapter
   * Release second-layer scheduler lock only when owner token matches
   * @name releaseLock
   * @param {{ ownerId: string, leaseId: string }} lock
   * @returns {Promise<void>}
   */
  async releaseLock(lock) {
    await this.ready();
    await this.requiredOption.releaseLock({
      key: this.lockKey,
      ownerId: lock.ownerId,
      leaseId: lock.leaseId,
    });
  }

  /**
   * @async
   * @memberOf BlankAdapter
   * Remove task from storage
   * @name remove
   * @param {string} uid - Unique ID of task
   * @returns {Promise<boolean>}
   */
  async remove(uid) {
    await this.ready();
    return await this.requiredOption.remove({
      scope: this.uniqueName,
      uid,
    });
  }

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
  async add(uid, isInterval, delay) {
    await this.ready();
    return await this.requiredOption.save({
      scope: this.uniqueName,
      uid,
      delay,
      executeAt: Date.now() + delay,
      isInterval,
      isDeleted: false
    });
  }

  /**
   * @async
   * @memberOf BlankAdapter
   * Update next execution timestamp
   * @name update
   * @param {object} task - Full object of task from storage
   * @param {Date} nextExecuteAt - Date defining time of next execution
   * @returns {Promise<boolean>}
   */
  async update(task, nextExecuteAt) {
    if (typeof task !== 'object' || typeof task.uid !== 'string') {
      this.joskInstance.__errorHandler({ task }, '[StorageAdapter] [update] [task]', 'Task malformed or undefined');
      return false;
    }

    if (!(nextExecuteAt instanceof Date)) {
      this.joskInstance.__errorHandler({ nextExecuteAt }, '[StorageAdapter] [update] [nextExecuteAt]', 'Next execution date is malformed or undefined', task.uid);
      return false;
    }

    await this.ready();

    try {
      return await this.requiredOption.update({
        scope: this.uniqueName,
        uid: task.uid,
        executeAt: +nextExecuteAt
      });
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[StorageAdapter] [update] [opError]', 'Exception inside StorageAdapter#update() method', task.uid);
      return false;
    }
  }

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
  async iterate(nextExecuteAt, lock, executeMode) {
    await this.ready();

    let executed = 0;
    const maxIterations = executeMode === 'one' ? 1 : Number.MAX_SAFE_INTEGER;

    while (executed < maxIterations) {
      const task = await this.requiredOption.claimNextTask({
        scope: this.uniqueName,
        before: Date.now(),
        nextExecuteAt: +nextExecuteAt,
        ownerId: lock.ownerId,
        leaseId: lock.leaseId
      });

      if (!task) {
        break;
      }

      executed++;
      this.joskInstance.__execute(task);
    }

    return executed;
  }

  /** @internal */
  __customPrivateMethod() {
    return true;
  }
}

export { BlankAdapter };
