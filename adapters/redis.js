/** Class representing Redis adapter for JoSk */
class RedisAdapter {
  /**
   * Create a RedisAdapter instance
   * @param {object} opts - configuration object
   * @param {RedisClient} opts.client - Required, Redis'es `RedisClient` instance, like one returned from `await redis.createClient().connect()` method
   * @param {string} [opts.prefix] - prefix for scope isolation; use when creating multiple JoSK instances within the single application
   * @param {boolean} [opts.resetOnInit] - Make sure all old tasks is completed before setting a new one, see readme for more details
   */
  constructor(opts = {}) {
    this.name = 'redis';
    this.prefix = (typeof opts.prefix === 'string') ? opts.prefix : 'default';
    this.uniqueName = `josk:${this.prefix}`;
    this.lockKey = `${this.uniqueName}:lock`;
    this.resetOnInit = opts.resetOnInit || false;

    if (!opts.client) {
      throw new Error('{client} option is required for RedisAdapter', {
        description: 'Redis database requires {client} option, e.g. returned from `redis.createClient()` or `redis.createCluster()` method'
      });
    }

    this.client = opts.client;
    if (this.resetOnInit) {
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

  /**
   * @async
   * @memberOf RedisAdapter
   * @name ping
   * @description Check connection to Redis
   * @returns {Promise<object>}
   */
  async ping() {
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
      const ping = await this.client.ping();
      if (ping === 'PONG') {
        return {
          status: 'OK',
          code: 200,
          statusCode: 200,
        };
      }

      throw new Error(`Unexpected response from Redis#ping received: ${ping}`);
    } catch (pingError) {
      return {
        status: 'Internal Server Error',
        code: 500,
        statusCode: 500,
        error: pingError,
      };
    }
  }

  async acquireLock() {
    const isLocked = await this.client.exists(this.lockKey);
    if (isLocked >= 1) {
      return false;
    }
    const res = await this.client.set(this.lockKey, `${Date.now() + this.joskInstance.zombieTime}`, {
      PX: this.joskInstance.zombieTime,
      NX: true
    });
    return res === 'OK';
  }

  async releaseLock() {
    await this.client.del(this.lockKey);
  }

  async remove(uid) {
    const taskKey = this.__getTaskKey(uid);
    try {
      const exists = await this.client.exists(taskKey);
      if (!exists) {
        return false;
      }
      await this.client.hSet(taskKey, {
        isDeleted: '1'
      });
      await this.client.del(taskKey);
      return true;
    } catch (removeError) {
      this.joskInstance.__errorHandler(removeError, '[remove] removeError:', 'Exception inside RedisAdapter#remove() method', uid);
      return false;
    }
  }

  async add(uid, isInterval, delay) {
    const taskKey = this.__getTaskKey(uid);

    try {
      const exists = await this.client.exists(taskKey);
      const next = Date.now() + delay;
      if (!exists) {
        await this.client.hSet(taskKey, {
          uid: uid,
          delay: `${delay}`,
          executeAt: `${next}`,
          isInterval: isInterval ? '1' : '0',
          isDeleted: '0'
        });
        return true;
      }
      const task = await this.client.hGetAll(taskKey);
      if (+task.isDeleted) {
        return false;
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
        await this.client.hSet(taskKey, update);
      }
      return false;
    } catch(opError) {
      this.joskInstance.__errorHandler(opError, '[add] [exist] [opError]', 'Exception inside RedisAdapter#add() method', uid);
      return false;
    }
  }

  async update(task, nextExecuteAt) {
    if (typeof task !== 'object' || typeof task.uid !== 'string') {
      this.joskInstance.__errorHandler({ task }, '[RedisAdapter] [update] [task]', 'Task malformed or undefined');
      return false;
    }

    if (!nextExecuteAt instanceof Date) {
      this.joskInstance.__errorHandler({ nextExecuteAt }, '[RedisAdapter] [update] [nextExecuteAt]', 'Next execution date is malformed or undefined', task.uid);
      return false;
    }

    const taskKey = this.__getTaskKey(task.uid);
    try {
      const exists = await this.client.exists(taskKey);
      if (!exists) {
        return false;
      }
      await this.client.hSet(taskKey, {
        executeAt: `${+nextExecuteAt}`
      });
      return true;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[RedisAdapter] [update] [opError]', 'Exception inside RedisAdapter#update() method', task.uid);
      return false;
    }
  }

  async iterate(nextExecuteAt) {
    const now = Date.now();
    const nextRetry = +nextExecuteAt;

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
  }

  __getTaskKey(uid) {
    return `${this.uniqueName}:task:${uid}`;
  }
}

export { RedisAdapter };
