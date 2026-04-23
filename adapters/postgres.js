/**
 * @typedef {object} PostgresQueryResult
 * @property {number | null | undefined} [rowCount]
 * @property {unknown[]} [rows]
 */

/**
 * @typedef {object} PostgresClient
 * @property {(queryText: string, values?: unknown[]) => Promise<PostgresQueryResult>} query
 */

/**
 * @typedef {import('../index.js').JoSk} JoSk
 */

/**
 * @typedef {object} AdapterPingResult
 * @property {string} status
 * @property {number} code
 * @property {number} statusCode
 * @property {unknown} [error]
 */

/**
 * @typedef {object} PostgresAdapterOption
 * @property {PostgresClient} client
 * @property {string} [prefix]
 * @property {boolean} [resetOnInit]
 */

/**
 * @typedef {object} PostgresTask
 * @property {string} uid
 * @property {string | number} delay
 * @property {string | number} execute_at
 * @property {boolean} is_interval
 * @property {boolean} is_deleted
 */

/** Class representing PostgreSQL adapter for JoSk */
class PostgresAdapter {
  /**
   * Create a PostgresAdapter instance
   * @param {PostgresAdapterOption} opts - configuration object
   */
  constructor (opts = {}) {
    this.name = 'postgres';
    this.prefix = (typeof opts.prefix === 'string' && opts.prefix.length > 0) ? opts.prefix : 'default';
    this.uniqueName = `josk-${this.prefix}`;
    this.lockKey = `${this.uniqueName}.lock`;
    this.resetOnInit = !!opts.resetOnInit;

    if (!opts.client) {
      throw new Error('{client} option is required for PostgresAdapter', {
        description: 'PostgresAdapter requires {client} option, e.g. new Pool({ connectionString: "..." }) from \'pg\' package'
      });
    }

    /** @type {PostgresClient} */
    this.client = opts.client;
    /** @type {JoSk | undefined} */
    this.joskInstance = void 0;

    // Setup DB tables asynchronously
    this._setupTables();

    if (this.resetOnInit) {
      process.nextTick(async () => {
        try {
          await this.client.query('DELETE FROM josk_tasks WHERE prefix = $1', [this.prefix]);
          await this.client.query('DELETE FROM josk_locks WHERE lock_key = $1', [this.lockKey]);
        } catch (resetErr) {
          console.error('[josk] [PostgresAdapter] [resetOnInit] error:', resetErr);
        }
      });
    }
  }

  /** @internal */
  async _setupTables () {
    process.nextTick(async () => {
      try {
        await this.client.query(`
          CREATE TABLE IF NOT EXISTS josk_tasks (
            uid TEXT PRIMARY KEY,
            prefix TEXT NOT NULL DEFAULT 'default',
            delay INTEGER NOT NULL,
            execute_at BIGINT NOT NULL,
            is_interval BOOLEAN NOT NULL DEFAULT false,
            is_deleted BOOLEAN NOT NULL DEFAULT false,
            created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
          )
        `);
        await this.client.query(`
          CREATE INDEX IF NOT EXISTS idx_josk_tasks_prefix_execute 
          ON josk_tasks (prefix, execute_at) 
          WHERE is_deleted = false;
        `);
        await this.client.query('CREATE INDEX IF NOT EXISTS idx_josk_tasks_uid ON josk_tasks (uid);');

        await this.client.query(`
          CREATE TABLE IF NOT EXISTS josk_locks (
            lock_key TEXT PRIMARY KEY,
            locked_until BIGINT,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
          )
        `);
        this.joskInstance?._debug('[PostgresAdapter] tables ready');
      } catch (setupErr) {
        console.error('[josk] [PostgresAdapter] [_setupTables] error:', setupErr);
      }
    });
  }

  /**
   * @async
   * @memberOf PostgresAdapter
   * @name ping
   * @description Check connection to PostgreSQL
   * @returns {Promise<AdapterPingResult>}
   */
  async ping () {
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
      const res = await this.client.query('SELECT 1 as ping');
      if (res.rows && res.rows[0] && res.rows[0].ping === 1) {
        return {
          status: 'OK',
          code: 200,
          statusCode: 200
        };
      }
      throw new Error(`Unexpected response from Postgres#ping received: ${JSON.stringify(res.rows)}`);
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
   * @returns {Promise<boolean>}
   */
  async acquireLock () {
    const now = Date.now();
    const until = now + this.joskInstance.zombieTime;
    try {
      // Try update if expired or no lock
      let res = await this.client.query(
        `UPDATE josk_locks 
         SET locked_until = $2, updated_at = CURRENT_TIMESTAMP 
         WHERE lock_key = $1 
           AND (locked_until IS NULL OR locked_until < $3) 
         RETURNING locked_until`,
        [this.lockKey, until, now]
      );
      if (res.rowCount > 0) {
        return true;
      }

      // Insert new lock
      res = await this.client.query(
        `INSERT INTO josk_locks (lock_key, locked_until) 
         VALUES ($1, $2) 
         ON CONFLICT (lock_key) DO NOTHING 
         RETURNING locked_until`,
        [this.lockKey, until]
      );
      return res.rowCount > 0;
    } catch (lockError) {
      this.joskInstance.__errorHandler(lockError, '[PostgresAdapter] [acquireLock]', 'Failed to acquire lock', null);
      return false;
    }
  }

  /**
   * @returns {Promise<void>}
   */
  async releaseLock () {
    try {
      await this.client.query(
        `UPDATE josk_locks 
         SET locked_until = NULL, updated_at = CURRENT_TIMESTAMP 
         WHERE lock_key = $1`,
        [this.lockKey]
      );
    } catch (releaseError) {
      // Non-critical, log via debug if possible
      this.joskInstance?._debug('[PostgresAdapter] [releaseLock] non-critical error:', releaseError);
    }
  }

  /**
   * @param {string} uid
   * @returns {Promise<boolean>}
   */
  async remove (uid) {
    try {
      const res = await this.client.query(
        `UPDATE josk_tasks 
         SET is_deleted = true, updated_at = CURRENT_TIMESTAMP 
         WHERE uid = $1 AND prefix = $2 
         RETURNING uid`,
        [uid, this.prefix]
      );
      const removed = res.rowCount > 0;
      return removed;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[PostgresAdapter] [remove]', 'Exception inside remove method', uid);
      return false;
    }
  }

  /**
   * @param {string} uid
   * @param {boolean} isInterval
   * @param {number} delay
   * @returns {Promise<boolean>}
   */
  async add (uid, isInterval, delay) {
    const executeAt = Date.now() + delay;
    try {
      await this.client.query(
        `INSERT INTO josk_tasks (uid, prefix, delay, execute_at, is_interval, is_deleted)
         VALUES ($1, $2, $3, $4, $5, false)
         ON CONFLICT (uid) DO UPDATE SET 
           delay = EXCLUDED.delay,
           execute_at = EXCLUDED.execute_at,
           is_interval = EXCLUDED.is_interval,
           is_deleted = false,
           updated_at = CURRENT_TIMESTAMP`,
        [uid, this.prefix, delay, executeAt, isInterval]
      );
      return true;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[PostgresAdapter] [add]', 'Exception inside add method', uid);
      return false;
    }
  }

  /**
   * @param {{ uid: string }} task
   * @param {Date} nextExecuteAt
   * @returns {Promise<boolean>}
   */
  async update (task, nextExecuteAt) {
    if (typeof task !== 'object' || typeof task.uid !== 'string') {
      this.joskInstance.__errorHandler({ task }, '[PostgresAdapter] [update] [task]', 'Task malformed or undefined');
      return false;
    }

    if (!(nextExecuteAt instanceof Date)) {
      this.joskInstance.__errorHandler({ nextExecuteAt }, '[PostgresAdapter] [update] [nextExecuteAt]', 'Next execution date is malformed or undefined', task.uid);
      return false;
    }

    try {
      const res = await this.client.query(
        `UPDATE josk_tasks 
         SET execute_at = $1, updated_at = CURRENT_TIMESTAMP 
         WHERE uid = $2 AND prefix = $3 AND is_deleted = false 
         RETURNING uid`,
        [+nextExecuteAt, task.uid, this.prefix]
      );
      return res.rowCount > 0;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[PostgresAdapter] [update] [opError]', 'Exception inside update method', task.uid);
      return false;
    }
  }

  /**
   * @param {Date} nextExecuteAt
   * @returns {Promise<void>}
   */
  async iterate (nextExecuteAt) {
    const now = Date.now();
    const nextRetry = +nextExecuteAt;

    try {
      const res = await this.client.query(
        `SELECT uid, delay, execute_at, is_interval, is_deleted 
         FROM josk_tasks 
         WHERE prefix = $1 
           AND is_deleted = false 
           AND execute_at <= $2 
         ORDER BY execute_at ASC`,
        [this.prefix, now]
      );

      for (const row of /** @type {PostgresTask[]} */ (res.rows || [])) {
        // Lock task by advancing execute_at to zombie time
        await this.update({ uid: row.uid }, new Date(nextRetry));

        // Execute via JoSk
        this.joskInstance.__execute({
          uid: row.uid,
          delay: parseInt(row.delay, 10),
          executeAt: parseInt(row.execute_at, 10),
          isInterval: row.is_interval,
          isDeleted: row.is_deleted
        });
      }
    } catch (iterError) {
      this.joskInstance.__errorHandler(iterError, '[PostgresAdapter] [iterate]', 'Exception inside iterate method', null);
    }
  }

  /** @internal */
  __customPrivateMethod () {
    // private methods prefixed with __ as per adapter convention
    return true;
  }
}

export { PostgresAdapter };
