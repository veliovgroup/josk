import { createHash } from 'node:crypto';

/**
 * @typedef {import('redis').RedisClientType | import('redis').RedisClusterType} RedisClient
 * @typedef {import('../index.js').JoSk} JoSk
 * @typedef {import('../index.js').JoSkExecuteMode} JoSkExecuteMode
 * @typedef {import('../index.js').JoSkLock} JoSkLock
 */

/**
 * @typedef {object} AdapterPingResult
 * @property {string} status
 * @property {number} code
 * @property {number} statusCode
 * @property {unknown} [error]
 */

/**
 * @typedef {object} RedisAdapterOption
 * @property {RedisClient} client
 * @property {string} [prefix]
 * @property {boolean} [resetOnInit]
 */

/**
 * @typedef {object} RedisTask
 * @property {string} uid
 * @property {number} delay
 * @property {number} executeAt
 * @property {boolean} isInterval
 * @property {boolean} isDeleted
 */

const VALID_PREFIX = /^[A-Za-z0-9_\-:.]+$/;

const ACQUIRE_LOCK_SCRIPT = `
  return redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
`;

const RELEASE_LOCK_SCRIPT = `
  if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
  end
  return 0
`;

const ADD_TASK_SCRIPT = `
  local payload = redis.call('HGET', KEYS[2], ARGV[1])
  local task = payload and cjson.decode(payload) or {
    uid = ARGV[1],
    delay = tonumber(ARGV[2]),
    executeAt = tonumber(ARGV[3]),
    isInterval = ARGV[4] == '1',
    isDeleted = false
  }

  if payload and task.isDeleted then
    return 0
  end

  task.delay = tonumber(ARGV[2])
  task.executeAt = tonumber(ARGV[3])
  task.isInterval = ARGV[4] == '1'
  task.isDeleted = false

  redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(task))
  redis.call('ZADD', KEYS[1], tonumber(ARGV[3]), ARGV[1])
  return 1
`;

const REMOVE_TASK_SCRIPT = `
  local removed = redis.call('HDEL', KEYS[2], ARGV[1])
  redis.call('ZREM', KEYS[1], ARGV[1])
  return removed
`;

const UPDATE_TASK_SCRIPT = `
  local payload = redis.call('HGET', KEYS[2], ARGV[1])
  if not payload then
    redis.call('ZREM', KEYS[1], ARGV[1])
    return 0
  end

  local task = cjson.decode(payload)
  if task.isDeleted then
    redis.call('HDEL', KEYS[2], ARGV[1])
    redis.call('ZREM', KEYS[1], ARGV[1])
    return 0
  end

  task.executeAt = tonumber(ARGV[2])
  redis.call('HSET', KEYS[2], ARGV[1], cjson.encode(task))
  redis.call('ZADD', KEYS[1], tonumber(ARGV[2]), ARGV[1])
  return 1
`;

const CLAIM_ONE_TASK_SCRIPT = `
  local now = tonumber(ARGV[1])
  local nextExecuteAt = tonumber(ARGV[2])
  local scanLimit = tonumber(ARGV[5]) or 1000

  for i = 1, scanLimit do
    local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, 1)
    if #due == 0 then
      return nil
    end

    local uid = due[1]
    local payload = redis.call('HGET', KEYS[2], uid)
    if not payload then
      redis.call('ZREM', KEYS[1], uid)
    else
      local task = cjson.decode(payload)
      if task.isDeleted then
        redis.call('HDEL', KEYS[2], uid)
        redis.call('ZREM', KEYS[1], uid)
      elseif tonumber(task.executeAt) > now then
        redis.call('ZADD', KEYS[1], tonumber(task.executeAt), uid)
      else
        task.executeAt = nextExecuteAt
        task.claimOwnerId = ARGV[3]
        task.claimLeaseId = ARGV[4]

        redis.call('HSET', KEYS[2], uid, cjson.encode(task))
        redis.call('ZADD', KEYS[1], nextExecuteAt, uid)
        return cjson.encode(task)
      end
    end
  end

  return nil
`;

const CLAIM_BATCH_TASKS_SCRIPT = `
  local now = tonumber(ARGV[1])
  local nextExecuteAt = tonumber(ARGV[2])
  local limit = tonumber(ARGV[5])
  local scanLimit = tonumber(ARGV[6]) or (limit * 20)
  local scanned = 0
  local claimed = {}

  while #claimed < limit and scanned < scanLimit do
    local remaining = math.min(limit - #claimed, scanLimit - scanned)
    local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, remaining)
    if #due == 0 then
      break
    end

    scanned = scanned + #due
    for index, uid in ipairs(due) do
      local payload = redis.call('HGET', KEYS[2], uid)
      if not payload then
        redis.call('ZREM', KEYS[1], uid)
      else
        local task = cjson.decode(payload)
        if task.isDeleted then
          redis.call('HDEL', KEYS[2], uid)
          redis.call('ZREM', KEYS[1], uid)
        elseif tonumber(task.executeAt) > now then
          redis.call('ZADD', KEYS[1], tonumber(task.executeAt), uid)
        else
          task.executeAt = nextExecuteAt
          task.claimOwnerId = ARGV[3]
          task.claimLeaseId = ARGV[4]

          redis.call('HSET', KEYS[2], uid, cjson.encode(task))
          redis.call('ZADD', KEYS[1], nextExecuteAt, uid)
          table.insert(claimed, task)
        end

        if #claimed >= limit then
          break
        end
      end
    end
  end

  return cjson.encode(claimed)
`;

const REDIS_BATCH_CLAIM_LIMIT = 100;
const REDIS_SCAN_LIMIT = 2000;

const sha1Hex = (str) => createHash('sha1').update(str).digest('hex');

const isNoScriptError = (error) => {
  if (!error) {
    return false;
  }
  const message = typeof error.message === 'string' ? error.message : '';
  return message.indexOf('NOSCRIPT') !== -1 || error.code === 'NOSCRIPT';
};

/** Class representing Redis adapter for JoSk */
class RedisAdapter {
  /**
   * Create a RedisAdapter instance
   * @param {RedisAdapterOption} opts - configuration object
   */
  constructor(opts = {}) {
    this.name = 'redis';
    const rawPrefix = typeof opts.prefix === 'string' && opts.prefix.length > 0 ? opts.prefix : 'default';
    if (!VALID_PREFIX.test(rawPrefix)) {
      throw new Error(`{prefix} option for RedisAdapter must match ${VALID_PREFIX} (received: "${rawPrefix}"). Curly braces and other special characters break Redis Cluster hash-tag routing.`);
    }
    this.prefix = rawPrefix;
    this.uniqueName = `josk:${this.prefix}`;
    this.lockKey = `${this.uniqueName}:lock`;
    this.scheduleKey = `${this.uniqueName}:schedule`;
    this.tasksKey = `${this.uniqueName}:tasks`;
    this.resetOnInit = !!opts.resetOnInit;

    if (!opts.client) {
      throw new Error('{client} option is required for RedisAdapter', {
        description: 'Redis database requires {client} option, e.g. returned from `redis.createClient()` or `redis.createCluster()` method'
      });
    }

    /** @type {RedisClient} */
    this.client = opts.client;
    /** @type {JoSk | undefined} */
    this.joskInstance = void 0;
    /** @internal */
    this.__scriptShas = {
      acquireLock: sha1Hex(ACQUIRE_LOCK_SCRIPT),
      releaseLock: sha1Hex(RELEASE_LOCK_SCRIPT),
      addTask: sha1Hex(ADD_TASK_SCRIPT),
      removeTask: sha1Hex(REMOVE_TASK_SCRIPT),
      updateTask: sha1Hex(UPDATE_TASK_SCRIPT),
      claimOne: sha1Hex(CLAIM_ONE_TASK_SCRIPT),
      claimBatch: sha1Hex(CLAIM_BATCH_TASKS_SCRIPT)
    };
    /** @internal */
    this.__scriptSources = {
      acquireLock: ACQUIRE_LOCK_SCRIPT,
      releaseLock: RELEASE_LOCK_SCRIPT,
      addTask: ADD_TASK_SCRIPT,
      removeTask: REMOVE_TASK_SCRIPT,
      updateTask: UPDATE_TASK_SCRIPT,
      claimOne: CLAIM_ONE_TASK_SCRIPT,
      claimBatch: CLAIM_BATCH_TASKS_SCRIPT
    };
    /** @internal */
    this.__loadedShas = new Set();
    /** @internal */
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
      await this.client.del([this.scheduleKey, this.tasksKey, this.lockKey]);
      const cursor = this.client.scanIterator({
        MATCH: `${this.uniqueName}:task:*`,
        COUNT: 9999
      });

      for await (const batch of cursor) {
        const keys = Array.isArray(batch) ? batch : [batch];
        if (keys.length) {
          await this.client.del(keys);
        }
      }
    }
  }

  /**
   * @internal
   * @param {keyof RedisAdapter['__scriptShas']} scriptKey
   * @param {{ keys: string[], arguments: string[] }} options
   * @returns {Promise<unknown>}
   */
  async __runScript(scriptKey, options) {
    const sha = this.__scriptShas[scriptKey];
    const source = this.__scriptSources[scriptKey];

    if (this.__loadedShas.has(sha) && typeof this.client.evalSha === 'function') {
      try {
        return await this.client.evalSha(sha, options);
      } catch (error) {
        if (!isNoScriptError(error)) {
          throw error;
        }
        this.__loadedShas.delete(sha);
      }
    }

    if (typeof this.client.scriptLoad === 'function' && typeof this.client.evalSha === 'function') {
      try {
        await this.client.scriptLoad(source);
        this.__loadedShas.add(sha);
        return await this.client.evalSha(sha, options);
      } catch (error) {
        if (!isNoScriptError(error)) {
          // Fall back to EVAL on cluster nodes that haven't seen the script yet
        }
      }
    }

    return await this.client.eval(source, options);
  }

  /**
   * @async
   * @memberOf RedisAdapter
   * @name ping
   * @description Check connection to Redis
   * @returns {Promise<AdapterPingResult>}
   */
  async ping() {
    if (!this.joskInstance) {
      const reason = 'JoSk instance not yet assigned to {joskInstance} of Storage Adapter context';
      return {
        status: reason,
        code: 503,
        statusCode: 503,
        error: new Error(reason)
      };
    }

    try {
      await this.ready();
      const ping = await this.client.ping();
      if (ping === 'PONG') {
        return {
          status: 'OK',
          code: 200,
          statusCode: 200
        };
      }

      throw new Error(`Unexpected response from Redis#ping received: ${ping}`);
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
   * @param {JoSkLock} lock
   * @returns {Promise<boolean>}
   */
  async acquireLock(lock) {
    await this.ready();

    const res = await this.__runScript('acquireLock', {
      keys: [this.lockKey],
      arguments: [this.__serializeLock(lock), `${this.joskInstance.zombieTime}`]
    });

    return res === 'OK';
  }

  /**
   * @param {JoSkLock} lock
   * @returns {Promise<void>}
   */
  async releaseLock(lock) {
    await this.ready();
    await this.__runScript('releaseLock', {
      keys: [this.lockKey],
      arguments: [this.__serializeLock(lock)]
    });
  }

  /**
   * @param {string} uid
   * @returns {Promise<boolean>}
   */
  async remove(uid) {
    await this.ready();

    try {
      const removed = await this.__runScript('removeTask', {
        keys: [this.scheduleKey, this.tasksKey],
        arguments: [uid]
      });
      return Number(removed) >= 1;
    } catch (removeError) {
      this.joskInstance.__errorHandler(removeError, '[RedisAdapter] [remove] removeError:', 'Exception inside RedisAdapter#remove() method', uid);
      return false;
    }
  }

  /**
   * @param {string} uid
   * @param {boolean} isInterval
   * @param {number} delay
   * @returns {Promise<boolean>}
   */
  async add(uid, isInterval, delay) {
    await this.ready();

    try {
      const next = Date.now() + delay;
      const result = await this.__runScript('addTask', {
        keys: [this.scheduleKey, this.tasksKey],
        arguments: [uid, `${delay}`, `${next}`, isInterval ? '1' : '0']
      });
      return Number(result) >= 1;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[RedisAdapter] [add] [opError]', 'Exception inside RedisAdapter#add() method', uid);
      return false;
    }
  }

  /**
   * @param {{ uid: string }} task
   * @param {Date} nextExecuteAt
   * @returns {Promise<boolean>}
   */
  async update(task, nextExecuteAt) {
    if (typeof task !== 'object' || typeof task.uid !== 'string') {
      this.joskInstance.__errorHandler({ task }, '[RedisAdapter] [update] [task]', 'Task malformed or undefined');
      return false;
    }

    if (!(nextExecuteAt instanceof Date)) {
      this.joskInstance.__errorHandler({ nextExecuteAt }, '[RedisAdapter] [update] [nextExecuteAt]', 'Next execution date is malformed or undefined', task.uid);
      return false;
    }

    await this.ready();

    try {
      const exists = await this.__runScript('updateTask', {
        keys: [this.scheduleKey, this.tasksKey],
        arguments: [task.uid, `${+nextExecuteAt}`]
      });
      return Number(exists) >= 1;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[RedisAdapter] [update] [opError]', 'Exception inside RedisAdapter#update() method', task.uid);
      return false;
    }
  }

  /**
   * @param {Date} nextExecuteAt
   * @param {JoSkLock} lock
   * @param {JoSkExecuteMode} executeMode
   * @returns {Promise<number>}
   */
  async iterate(nextExecuteAt, lock, executeMode) {
    await this.ready();

    let executed = 0;
    if (executeMode === 'one') {
      const task = await this.__claimNextTask(nextExecuteAt, lock);
      if (!task) {
        return executed;
      }

      this.joskInstance.__execute(task);
      return executed + 1;
    }

    while (true) {
      const tasks = await this.__claimNextTasks(nextExecuteAt, lock, REDIS_BATCH_CLAIM_LIMIT);
      if (tasks.length === 0) {
        break;
      }

      executed += tasks.length;
      for (let i = 0; i < tasks.length; i++) {
        this.joskInstance.__execute(tasks[i]);
      }

      if (tasks.length < REDIS_BATCH_CLAIM_LIMIT) {
        break;
      }
    }

    return executed;
  }

  /**
   * @internal
   * @param {Date} nextExecuteAt
   * @param {JoSkLock} lock
   * @returns {Promise<RedisTask | null>}
   */
  async __claimNextTask(nextExecuteAt, lock) {
    try {
      const claimed = await this.__runScript('claimOne', {
        keys: [this.scheduleKey, this.tasksKey],
        arguments: [`${Date.now()}`, `${+nextExecuteAt}`, lock.ownerId, lock.leaseId, `${REDIS_SCAN_LIMIT}`]
      });

      if (!claimed) {
        return null;
      }

      const parsed = JSON.parse(String(claimed));
      return this.__normalizeTask(parsed);
    } catch (iterError) {
      this.joskInstance.__errorHandler(iterError, '[RedisAdapter] [iterate] [claim]', 'Exception inside RedisAdapter#__claimNextTask() method', null);
      return null;
    }
  }

  /**
   * @internal
   * @param {Date} nextExecuteAt
   * @param {JoSkLock} lock
   * @param {number} limit
   * @returns {Promise<RedisTask[]>}
   */
  async __claimNextTasks(nextExecuteAt, lock, limit) {
    try {
      const claimed = await this.__runScript('claimBatch', {
        keys: [this.scheduleKey, this.tasksKey],
        arguments: [`${Date.now()}`, `${+nextExecuteAt}`, lock.ownerId, lock.leaseId, `${limit}`, `${REDIS_SCAN_LIMIT}`]
      });

      if (!claimed) {
        return [];
      }

      const parsed = JSON.parse(String(claimed));
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed.map((task) => this.__normalizeTask(task)).filter(Boolean);
    } catch (iterError) {
      this.joskInstance.__errorHandler(iterError, '[RedisAdapter] [iterate] [batchClaim]', 'Exception inside RedisAdapter#__claimNextTasks() method', null);
      return [];
    }
  }

  /**
   * @internal
   * @param {Record<string, unknown>} task
   * @returns {RedisTask | null}
   */
  __normalizeTask(task) {
    if (!task || typeof task.uid !== 'string') {
      return null;
    }

    return /** @type {RedisTask} */ ({
      uid: task.uid,
      delay: +task.delay,
      executeAt: +task.executeAt,
      isInterval: !!task.isInterval,
      isDeleted: !!task.isDeleted
    });
  }

  /**
   * @internal
   * @param {JoSkLock} lock
   * @returns {string}
   */
  __serializeLock(lock) {
    return JSON.stringify({
      ownerId: lock.ownerId,
      leaseId: lock.leaseId,
      expiresAtMs: lock.expiresAtMs
    });
  }

  /**
   * @internal
   * @param {string} uid
   * @returns {string}
   */
  __getTaskKey(uid) {
    return `${this.uniqueName}:task:${uid}`;
  }
}

export { RedisAdapter };
