import { createHash } from 'crypto';

/**
 * @typedef {object} PostgresQueryResult
 * @property {number | null | undefined} [rowCount]
 * @property {unknown[]} [rows]
 */

/**
 * Minimal client surface used by PostgresAdapter. The official `pg`
 * package's `Pool` and `Client` both satisfy this shape. Pool is the
 * recommended choice for long-running applications.
 *
 * @typedef {object} PostgresClient
 * @property {(queryText: string, values?: unknown[]) => Promise<PostgresQueryResult>} query
 */

/**
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

// Two-key advisory lock: a stable JoSk namespace plus a per-prefix hash.
// `pg_advisory_lock(int4, int4)` lives in its own keyspace, isolated from any
// single-int callers in the same database. Co-tenant JoSk apps with distinct
// prefixes get distinct lock IDs, so their schema migrations no longer block
// each other.
const ADVISORY_LOCK_NAMESPACE = 0x4A6F536B; // 'JoSk' in ASCII as int32
const SCHEMA_VERSION = 2;

/**
 * @param {string} prefix
 * @returns {number} signed int32 hash of the prefix string
 */
const advisoryLockKeyFor = (prefix) => {
  return createHash('sha256').update(prefix).digest().readInt32BE(0);
};

/** Class representing PostgreSQL adapter for JoSk */
class PostgresAdapter {
  /**
   * Create a PostgresAdapter instance
   * @param {PostgresAdapterOption} opts - configuration object
   */
  constructor(opts = {}) {
    this.name = 'postgres';
    this.prefix = typeof opts.prefix === 'string' && opts.prefix.length > 0 ? opts.prefix : 'default';
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
    /** @internal */
    this.__advisoryLockKey = advisoryLockKeyFor(this.prefix);
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
    // pg_advisory_lock is session-scoped. A `pg.Pool` rotates connections per
    // query, so the lock must be acquired on one pinned session — otherwise
    // the migration DDL runs unprotected and the lock leaks until the pool
    // recycles the holding connection. Detect Pool by probing for a
    // `connect()` that yields a releasable client; raw `pg.Client` keeps its
    // own session so we use it directly.
    let setupClient = this.client;
    let release = null;
    if (typeof this.client.connect === 'function') {
      try {
        const dedicated = await this.client.connect();
        if (dedicated && typeof dedicated.query === 'function' && typeof dedicated.release === 'function') {
          setupClient = dedicated;
          release = () => dedicated.release();
        }
      } catch (connectErr) {
        // pg.Client.connect() after manual connect resolves to undefined or
        // throws "already connected" — both fine; fall back to this.client.
      }
    }

    await setupClient.query('SELECT pg_advisory_lock($1, $2)', [ADVISORY_LOCK_NAMESPACE, this.__advisoryLockKey]);

    try {
      await setupClient.query(`
        CREATE TABLE IF NOT EXISTS josk_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);

      const versionResult = await setupClient.query(
        `SELECT value FROM josk_meta WHERE key = 'schema_version'`
      );
      const currentVersion = versionResult.rows && versionResult.rows[0]
        ? parseInt(versionResult.rows[0].value, 10)
        : 0;

      await setupClient.query(`
        CREATE TABLE IF NOT EXISTS josk_tasks (
          prefix TEXT NOT NULL DEFAULT 'default',
          uid TEXT NOT NULL,
          delay BIGINT NOT NULL,
          execute_at BIGINT NOT NULL,
          is_interval BOOLEAN NOT NULL DEFAULT false,
          is_deleted BOOLEAN NOT NULL DEFAULT false,
          claim_owner_id TEXT,
          claim_lease_id TEXT,
          claimed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);

      if (currentVersion < 1) {
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS prefix TEXT NOT NULL DEFAULT 'default'`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS uid TEXT NOT NULL DEFAULT ''`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS delay BIGINT NOT NULL DEFAULT 0`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS execute_at BIGINT NOT NULL DEFAULT 0`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS is_interval BOOLEAN NOT NULL DEFAULT false`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT false`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS claim_owner_id TEXT`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS claim_lease_id TEXT`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`);
        await setupClient.query(`ALTER TABLE josk_tasks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`);

        const primaryKeyResult = await setupClient.query(`
          SELECT kc.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage kc
            ON tc.constraint_name = kc.constraint_name
           AND tc.table_schema = kc.table_schema
          WHERE tc.table_name = 'josk_tasks'
            AND tc.constraint_type = 'PRIMARY KEY'
          ORDER BY kc.ordinal_position ASC
        `);
        const primaryKeyColumns = (primaryKeyResult.rows || []).map((row) => row.column_name);

        if (primaryKeyColumns.length === 1 && primaryKeyColumns[0] === 'uid') {
          await setupClient.query(`ALTER TABLE josk_tasks DROP CONSTRAINT IF EXISTS josk_tasks_pkey`);
        }

        await setupClient.query(`
          ALTER TABLE josk_tasks
          ADD CONSTRAINT josk_tasks_pkey PRIMARY KEY (prefix, uid)
        `).catch((error) => {
          if (error?.code !== '42P16' && error?.code !== '42710') {
            throw error;
          }
        });

        await setupClient.query(`
          CREATE INDEX IF NOT EXISTS idx_josk_tasks_prefix_execute
          ON josk_tasks (prefix, execute_at)
          WHERE is_deleted = false
        `);

        await setupClient.query(`
          CREATE TABLE IF NOT EXISTS josk_locks (
            lock_key TEXT PRIMARY KEY,
            owner_id TEXT NOT NULL,
            lease_id TEXT NOT NULL,
            locked_until BIGINT NOT NULL,
            updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
          )
        `);

        await setupClient.query(`ALTER TABLE josk_locks ADD COLUMN IF NOT EXISTS owner_id TEXT`);
        await setupClient.query(`ALTER TABLE josk_locks ADD COLUMN IF NOT EXISTS lease_id TEXT`);
        await setupClient.query(`ALTER TABLE josk_locks ADD COLUMN IF NOT EXISTS locked_until BIGINT`);
        await setupClient.query(`ALTER TABLE josk_locks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`);
        await setupClient.query(`UPDATE josk_locks SET owner_id = COALESCE(owner_id, ''), lease_id = COALESCE(lease_id, ''), locked_until = COALESCE(locked_until, 0) WHERE owner_id IS NULL OR lease_id IS NULL OR locked_until IS NULL`);
        await setupClient.query(`ALTER TABLE josk_locks ALTER COLUMN owner_id SET NOT NULL`);
        await setupClient.query(`ALTER TABLE josk_locks ALTER COLUMN lease_id SET NOT NULL`);
        await setupClient.query(`ALTER TABLE josk_locks ALTER COLUMN locked_until SET NOT NULL`);

        await setupClient.query(`
          CREATE INDEX IF NOT EXISTS idx_josk_locks_locked_until
          ON josk_locks (locked_until)
        `);
      }

      if (currentVersion < 2) {
        // Widen `delay` from INTEGER (int4 max ~2147483647ms ≈ 24.8 days) to BIGINT;
        // longer delays/intervals overflowed int4 and silently failed to store. No-op on fresh installs.
        await setupClient.query(`ALTER TABLE josk_tasks ALTER COLUMN delay TYPE BIGINT`);
      }

      if (currentVersion < SCHEMA_VERSION) {
        await setupClient.query(
          `INSERT INTO josk_meta (key, value) VALUES ('schema_version', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [String(SCHEMA_VERSION)]
        );
      }

      if (this.resetOnInit) {
        await setupClient.query('DELETE FROM josk_tasks WHERE prefix = $1', [this.prefix]);
        await setupClient.query('DELETE FROM josk_locks WHERE lock_key = $1', [this.lockKey]);
      }
    } finally {
      try {
        await setupClient.query('SELECT pg_advisory_unlock($1, $2)', [ADVISORY_LOCK_NAMESPACE, this.__advisoryLockKey]);
      } finally {
        if (release) {
          release();
        }
      }
    }
  }

  /**
   * @async
   * @memberOf PostgresAdapter
   * @name ping
   * @description Check connection to PostgreSQL
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
   * Acquire scheduler lease using PostgreSQL server time so the lock is
   * resistant to client-side clock skew between distributed nodes.
   * @param {JoSkLock} lock
   * @returns {Promise<boolean>}
   */
  async acquireLock(lock) {
    await this.ready();

    try {
      const res = await this.client.query(
        `INSERT INTO josk_locks (lock_key, owner_id, lease_id, locked_until)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (lock_key) DO UPDATE
           SET owner_id = EXCLUDED.owner_id,
               lease_id = EXCLUDED.lease_id,
               locked_until = EXCLUDED.locked_until,
               updated_at = CURRENT_TIMESTAMP
         WHERE josk_locks.locked_until <= (EXTRACT(EPOCH FROM CURRENT_TIMESTAMP) * 1000)::BIGINT
         RETURNING lease_id`,
        [this.lockKey, lock.ownerId, lock.leaseId, lock.expiresAtMs]
      );
      return (res.rowCount || 0) >= 1;
    } catch (lockError) {
      this.joskInstance.__errorHandler(lockError, '[PostgresAdapter] [acquireLock]', 'Failed to acquire lock', null);
      return false;
    }
  }

  /**
   * @param {JoSkLock} lock
   * @returns {Promise<void>}
   */
  async releaseLock(lock) {
    await this.ready();

    try {
      await this.client.query(
        `DELETE FROM josk_locks
         WHERE lock_key = $1
           AND owner_id = $2
           AND lease_id = $3`,
        [this.lockKey, lock.ownerId, lock.leaseId]
      );
    } catch (releaseError) {
      this.joskInstance.__errorHandler(releaseError, '[PostgresAdapter] [releaseLock]', 'Exception inside PostgresAdapter#releaseLock() method', null);
    }
  }

  /**
   * @param {string} uid
   * @returns {Promise<boolean>}
   */
  async remove(uid) {
    await this.ready();

    try {
      const res = await this.client.query(
        `DELETE FROM josk_tasks
         WHERE prefix = $1
           AND uid = $2
         RETURNING uid`,
        [this.prefix, uid]
      );
      return (res.rowCount || 0) >= 1;
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
  async add(uid, isInterval, delay) {
    await this.ready();

    try {
      const res = await this.client.query(
        `INSERT INTO josk_tasks (prefix, uid, delay, execute_at, is_interval, is_deleted, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
         ON CONFLICT (prefix, uid) DO UPDATE SET
           delay = EXCLUDED.delay,
           execute_at = EXCLUDED.execute_at,
           is_interval = EXCLUDED.is_interval,
           is_deleted = false,
           updated_at = CURRENT_TIMESTAMP
         RETURNING uid`,
        [this.prefix, uid, delay, Date.now() + delay, isInterval]
      );
      return (res.rowCount || 0) >= 1;
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
  async update(task, nextExecuteAt) {
    if (typeof task !== 'object' || typeof task.uid !== 'string') {
      this.joskInstance.__errorHandler({ task }, '[PostgresAdapter] [update] [task]', 'Task malformed or undefined');
      return false;
    }

    if (!(nextExecuteAt instanceof Date)) {
      this.joskInstance.__errorHandler({ nextExecuteAt }, '[PostgresAdapter] [update] [nextExecuteAt]', 'Next execution date is malformed or undefined', task.uid);
      return false;
    }

    await this.ready();

    try {
      const res = await this.client.query(
        `UPDATE josk_tasks
         SET execute_at = $1,
             updated_at = CURRENT_TIMESTAMP
         WHERE prefix = $2
           AND uid = $3
           AND is_deleted = false
         RETURNING uid`,
        [+nextExecuteAt, this.prefix, task.uid]
      );
      return (res.rowCount || 0) >= 1;
    } catch (opError) {
      this.joskInstance.__errorHandler(opError, '[PostgresAdapter] [update] [opError]', 'Exception inside update method', task.uid);
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

      this.joskInstance.__execute({
        uid: task.uid,
        delay: parseInt(task.delay, 10),
        executeAt: parseInt(task.execute_at, 10),
        isInterval: task.is_interval,
        isDeleted: task.is_deleted
      });

      return executed + 1;
    }

    const batchLimit = 100;
    while (true) {
      const tasks = await this.__claimNextTasks(nextExecuteAt, lock, batchLimit);
      if (tasks.length === 0) {
        break;
      }

      executed += tasks.length;
      for (const task of tasks) {
        this.joskInstance.__execute({
          uid: task.uid,
          delay: parseInt(task.delay, 10),
          executeAt: parseInt(task.execute_at, 10),
          isInterval: task.is_interval,
          isDeleted: task.is_deleted
        });
      }

      if (tasks.length < batchLimit) {
        break;
      }
    }

    return executed;
  }

  /**
   * @internal
   * @param {Date} nextExecuteAt
   * @param {JoSkLock} lock
   * @returns {Promise<PostgresTask | null>}
   */
  async __claimNextTask(nextExecuteAt, lock) {
    try {
      const res = await this.client.query(
        `WITH due AS (
           SELECT prefix, uid, delay, execute_at, is_interval, is_deleted
           FROM josk_tasks
           WHERE prefix = $1
             AND is_deleted = false
             AND execute_at <= $2
           ORDER BY execute_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT 1
         )
         UPDATE josk_tasks AS task
         SET execute_at = $3,
             claim_owner_id = $4,
             claim_lease_id = $5,
             claimed_at = CURRENT_TIMESTAMP,
             updated_at = CURRENT_TIMESTAMP
         FROM due
         WHERE task.prefix = due.prefix
           AND task.uid = due.uid
         RETURNING due.uid, due.delay, due.execute_at, due.is_interval, due.is_deleted`,
        [this.prefix, Date.now(), +nextExecuteAt, lock.ownerId, lock.leaseId]
      );

      return /** @type {PostgresTask | null} */ ((res.rows && res.rows[0]) || null);
    } catch (iterError) {
      this.joskInstance.__errorHandler(iterError, '[PostgresAdapter] [iterate] [claim]', 'Exception inside PostgresAdapter#__claimNextTask() method', null);
      return null;
    }
  }

  /**
   * @internal
   * @param {Date} nextExecuteAt
   * @param {JoSkLock} lock
   * @param {number} limit
   * @returns {Promise<PostgresTask[]>}
   */
  async __claimNextTasks(nextExecuteAt, lock, limit) {
    try {
      const res = await this.client.query(
        `WITH due AS (
           SELECT prefix, uid, delay, execute_at, is_interval, is_deleted
           FROM josk_tasks
           WHERE prefix = $1
             AND is_deleted = false
             AND execute_at <= $2
           ORDER BY execute_at ASC
           FOR UPDATE SKIP LOCKED
           LIMIT $6
         ),
         updated AS (
           UPDATE josk_tasks AS task
           SET execute_at = $3,
               claim_owner_id = $4,
               claim_lease_id = $5,
               claimed_at = CURRENT_TIMESTAMP,
               updated_at = CURRENT_TIMESTAMP
           FROM due
           WHERE task.prefix = due.prefix
             AND task.uid = due.uid
           RETURNING due.uid, due.delay, due.execute_at, due.is_interval, due.is_deleted
         )
         SELECT uid, delay, execute_at, is_interval, is_deleted
         FROM updated
         ORDER BY execute_at ASC`,
        [this.prefix, Date.now(), +nextExecuteAt, lock.ownerId, lock.leaseId, limit]
      );

      return /** @type {PostgresTask[]} */ (res.rows || []);
    } catch (iterError) {
      this.joskInstance.__errorHandler(iterError, '[PostgresAdapter] [iterate] [batchClaim]', 'Exception inside PostgresAdapter#__claimNextTasks() method', null);
      return [];
    }
  }
}

export { PostgresAdapter };
