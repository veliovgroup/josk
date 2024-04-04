/** Class representing Redis adapter for JoSk */
class RedisAdapter {
  /**
   * Create a RedisAdapter instance
   * @param {JoSk} joskInstance - JoSk instance
   * @param {object} opts - configuration object
   * @param {RedisClient} opts.client - Required, Redis'es `RedisClient` instance, like one returned from `await redis.createClient().connect()` method
   * @param {string} [opts.lockCollectionName] - custom "lock" collection name
   * @param {string} [opts.prefix] - prefix for scope isolation
   */
  constructor(joskInstance, opts = {}) {
    this.name = 'redis';
    this.joskInstance = joskInstance;
    this.prefix = opts.prefix || 'default';
    this.uniqueName = `josk:${this.prefix}`;
    this.lockKey = `${this.uniqueName}:lock`;

    if (!opts.client) {
      throw new Error('{client} option is required for RedisAdapter', {
        description: 'Redis database requires {client} option, e.g. returned from `redis.createClient()` or `redis.createCluster()` method'
      });
    }

    this.client = opts.client;
    if (this.joskInstance.resetOnInit) {
      process.nextTick(async () => {
        const cursor = this.client.scanIterator({
          TYPE: 'hash',
          MATCH: this.__getTaskKey('*'),
          COUNT: 9999,
        });

        for await (const key of cursor) {
          await this.client.del(key);
        }
      });
    }
  }

  acquireLock(cb) {
    this.client.exists([this.lockKey]).then((isLocked) => {
      if (isLocked >= 1) {
        cb(void 0, false);
      } else {
        this.client.set(this.lockKey, `${Date.now() + this.joskInstance.zombieTime}`, {
          PX: this.joskInstance.zombieTime,
          NX: true
        }).then((res) => {
          cb(void 0, res === 'OK');
        }).catch(cb);
      }
    }).catch(cb);
  }

  releaseLock(cb) {
    this.client.del(this.lockKey).then(() => {
      cb();
    }).catch(cb);
  }

  clear(uid, cb) {
    const taskKey = this.__getTaskKey(uid);
    this.client.hSet(taskKey, {
      isDeleted: '1'
    }).then(() => {
      this.client.del(taskKey).then(() => {
        cb(void 0, true);
      }).catch((deleteError) => {
        cb(deleteError, false);
      });
    }).catch((updateError) => {
      this.joskInstance.__errorHandler(updateError, '[clear] [hSet] updateError:', 'Error in a .catch() of hSet method of .clear()', uid);
      cb(updateError, false);
    });
  }

  addTask(uid, isInterval, delay) {
    const taskKey = this.__getTaskKey(uid);

    this.client.exists([taskKey]).then((exists) => {
      const next = Date.now() + delay;
      if (!exists) {
        this.client.hSet(taskKey, {
          uid: uid,
          delay: `${delay}`,
          executeAt: `${next}`,
          isInterval: isInterval ? '1' : '0',
          isDeleted: '0'
        }).then(() => {}).catch((insertError) => {
          this.joskInstance.__errorHandler(insertError, '[addTask] [hSet] insertError:', 'Error in a .catch() of .hSet() method of .addTask()', uid);
        });
      } else {
        this.client.hGetAll(taskKey).then((task) => {
          if (+task.isDeleted) {
            return;
          }

          let update = null;
          if (+task.delay !== delay) {
            update = { delay };
          }

          if (+task.executeAt !== next) {
            if (!update) {
              update = {};
            }
            update.executeAt = next;
          }

          if (update) {
            this.client.hSet(taskKey, update).then(() => {}).catch((updateError) => {
              this.joskInstance.__errorHandler(updateError, '[addTask] [hSet] updateError', 'Error in a .catch() of .hSet() method of .addTask()', uid);
            });
          }
        }).catch((findError) => {
          this.joskInstance.__errorHandler(findError, '[addTask] [exist] findError:', 'Error in a .catch() of .hGetAll() method of .addTask()', uid);
        });
      }
    }).catch((existError) => {
      this.joskInstance.__errorHandler(existError, '[addTask] [exist] existError:', 'Error in a .catch() of .exists() method of .addTask()', uid);
    });
  }

  getDoneCallback(task) {
    return (nextExecuteAt, readyCallback) => {
      this.client.hSet(this.__getTaskKey(task.uid), {
        executeAt: `${+nextExecuteAt}`
      }).then(() => {
        typeof readyCallback === 'function' && readyCallback(void 0, true);
      }).catch((updateError) => {
        typeof readyCallback === 'function' && readyCallback(updateError);
        this.joskInstance.__errorHandler(updateError, '[getDoneCallback] [done] [hSet] updateError:', 'Error in a .catch() of .hSet() method of .getDoneCallback()', task.uid);
      });
    };
  }

  runTasks(nextExecuteAt, cb) {
    const now = Date.now();
    const nextRetry = +nextExecuteAt;

    process.nextTick(async () => {
      try {
        const cursor = this.client.scanIterator({
          TYPE: 'hash',
          MATCH: this.__getTaskKey('*'),
          COUNT: 9999,
        });

        for await (const taskKey of cursor) {
          const task = await this.client.hGetAll(taskKey);
          if (+task.executeAt <= now) {
            await this.client.hSet(taskKey, {
              executeAt: `${nextRetry}`
            });
            this.joskInstance.__execute({
              uid: task.uid,
              delay: +task.delay,
              executeAt: +task.executeAt,
              isInterval: !!+task.isInterval,
              isDeleted: !!+task.isDeleted,
            });
          }
        }
        cb();
      } catch (scanError) {
        cb(scanError);
      }
    });
  }

  __getTaskKey(uid) {
    return `${this.uniqueName}:task:${uid}`;
  }
}

export { RedisAdapter };
