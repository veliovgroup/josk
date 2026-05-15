import josk = require('josk');
import type {
  JoSkAdapter,
  JoSkOption,
  JoSkExecuteMode,
  JoSkLock,
  JoSkTask,
  JoSkOnError,
  JoSkOnExecuted
} from 'josk';

const adapter = {
  async acquireLock(_lock: { ownerId: string; leaseId: string; expireAt: Date; expiresAtMs: number }) {
    return true;
  },
  async releaseLock(_lock: { ownerId: string; leaseId: string; expireAt: Date; expiresAtMs: number }) {},
  async remove(_uid: string) {
    return true;
  },
  async add(_uid: string, _isInterval: boolean, _delay: number) {
    return true;
  },
  async update(_task: { uid: string }, _nextExecuteAt: Date) {
    return true;
  },
  async iterate(_nextExecuteAt: Date, _lock: { ownerId: string; leaseId: string; expireAt: Date; expiresAtMs: number }, _executeMode: 'one' | 'batch') {},
  async ping() {
    return {
      status: 'OK',
      code: 200,
      statusCode: 200
    };
  }
};

const jobs = new josk.JoSk({ adapter, execute: 'batch' });

jobs.setImmediate(() => {}, 'cjs-task');
jobs.destroy();

const adapterCtor = josk.PostgresAdapter;
void adapterCtor;

// Confirm built-in adapters satisfy the public JoSkAdapter contract via require()
type _RedisOk = InstanceType<typeof josk.RedisAdapter> extends JoSkAdapter ? true : never;
type _MongoOk = InstanceType<typeof josk.MongoAdapter> extends JoSkAdapter ? true : never;
type _PostgresOk = InstanceType<typeof josk.PostgresAdapter> extends JoSkAdapter ? true : never;

const _redisOk: _RedisOk = true;
const _mongoOk: _MongoOk = true;
const _postgresOk: _PostgresOk = true;
void _redisOk;
void _mongoOk;
void _postgresOk;

// Type-only imports resolve correctly through the .d.cts shim
const execute: JoSkExecuteMode = 'one';
const opt: JoSkOption = { adapter, execute, concurrency: 4 };
void opt;

const onError: JoSkOnError = (_title, _details) => {};
const onExecuted: JoSkOnExecuted = async (_uid, _details) => {};
void onError;
void onExecuted;

// Sanity: structural lock + task types are exported
const _lock: JoSkLock = {
  ownerId: 'owner',
  leaseId: 'lease',
  expireAt: new Date(),
  expiresAtMs: Date.now()
};
const _task: JoSkTask = {
  uid: 'job',
  delay: 1000,
  isInterval: true,
  isDeleted: false
};
void _lock;
void _task;
