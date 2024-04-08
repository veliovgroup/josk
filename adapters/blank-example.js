class BlankAdapter {
  /**
   * Create a BlankAdapter instance
   * @param {JoSk} joskInstance - JoSk instance
   * @param {object} opts - configuration object
   * @param {object} opts.requiredOption - Required option description
   * @param {string} [opts.prefix] - prefix for scope isolation
   */
  constructor(joskInstance, opts = {}) {
    this.name = 'adapter-name'; // set unique adapter name
    this.joskInstance = joskInstance; // Pass down JoSk instance
    this.prefix = opts.prefix || 'default'; // Pass down user-defined prefix
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
    if (this.joskInstance.resetOnInit) { // Check if user wish to reset storage on init
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
   * Function called to remove task from the storage
   * @name releaseLock
   * @param {function} cb - callback that must get called after releaseLock
   * @returns {void 0}
   */
  acquireLock(cb) {
    if (isLocked) {
      // Lock not available
      cb(void 0, false);
    } else if (error) {
      // Error occurred
      cb(error, false);
    } else {
      // Lock acquired
      cb(void 0, true);
    }
  }

  /**
   * Function called to remove task from the storage
   * @name releaseLock
   * @param {function} cb - callback that must get called after releaseLock
   * @returns {void 0}
   */
  releaseLock(cb) {
    if (isReleased) {
      // Lock released
      cb();
    } else if (error) {
      // Error occurred
      cb(error);
    } else {
      // Can not release
      cb(new Error('Can not release storage-lock at the moment'));
    }
  }

  /**
   * Function called to remove task from the storage
   * @name clear
   * @param {string} uid - Unique ID of the task
   * @param {function} cb - callback that must get called after task is removed
   * @returns {void 0}
   */
  clear(uid, cb) {
    if (isRemoved) {
      // Task removed
      cb(void 0, true);
    } else if (error) {
      // Error occurred
      cb(error, false);
    } else {
      // Can not remove the task
      cb(new Error('Can not stop task at the moment'), false);
    }
  }

  /**
   * Function called to add task to the storage
   * @name addTask
   * @param {string} uid - Unique ID of the task
   * @param {boolean} isInterval - true/false defining loop or one-time task
   * @param {number} delay - Delay in milliseconds
   * @returns {void 0}
   */
  addTask(uid, isInterval, delay) {
    const next = Date.now() + delay;
    // STORE TASK IN THE STORAGE IN THE NEXT FORMAT
    this.requiredOption.save({
      uid: uid, // String
      delay: delay, // Number
      executeAt: next, // Number
      isInterval: isInterval, // Boolean
      isDeleted: false // Boolean
    });
  }

  /**
   * Function called after executing tasks
   * Used by "Interval" tasks to set the next execution
   * @name getDoneCallback
   * @param {object} task - Full object of the task from storage
   * @returns {function} - callback function `doneCallback`
   */
  getDoneCallback(task) {
    /**
     * Create and return callback function
     * that called for "interval" tasks to set time of the next run
     * @name doneCallback
     * @param {Date} nextExecuteAt - Date defining time of the next execution
     * @param {function} [readyCallback] - optional callback
     * @returns {void 0}
     */
    return (nextExecuteAt, readyCallback) => {
      this.requiredOption.update({
        uid: task.uid
      }, {
        executeAt: +nextExecuteAt, // Convert Date to Number (timestamp)
      }).then(() => {
        typeof readyCallback === 'function' && readyCallback(void 0, true);
      }).catch((updateError) => {
        typeof readyCallback === 'function' && readyCallback(updateError);
        this.joskInstance.__errorHandler(updateError, '[getDoneCallback] [done] [hSet] updateError:', 'Error in a .catch() of .hSet() method of .getDoneCallback()', task.uid);
      });
    };
  }

  /**
   * Find and run tasks one by one
   * @name runTasks
   * @param {Date} nextExecuteAt - Date defining time of the next execution for "zombie" tasks
   * @param {function} cb - callback that must get called after looping over tasks
   * @returns {void 0}
   */
  runTasks(nextExecuteAt, cb) {
    // GET TASKS WITHIN this.uniqueName SCOPE!
    // AND ONLY WHERE executeAt <= now
    // RUN ONE BY ONE VIA this.joskInstance.__execute() METHOD

    const cursorWithTasks = this.requiredOption.getTasks({
      scope: this.uniqueName,
      executeAt: {
        $lte: Date.now() // Number (timestamp)
      }
    });

    for (const task of cursorWithTasks) {
      // "Lock task" by setting the next execution far ahead (timestamp + zombieTime)
      this.requiredOption.update({
        uid: task.uid
      }, {
        executeAt: +nextExecuteAt, // Convert Date to Number (timestamp)
      });

      // EXECUTE TASK
      this.joskInstance.__execute(task);
    }

    // CALL cb() AFTER LOOPING OVER TASKS
    cb();
  }

  __customProvateMethod() {
    // DEFINE PREFIXED __ CUSTOM METHODS
    // WHEN NECESSARY FOR THE ADAPTER
    return true;
  }
}

export { BlankAdapter };
