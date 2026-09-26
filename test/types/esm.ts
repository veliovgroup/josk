import { JoSk, MongoAdapter, PostgresAdapter, RedisAdapter } from 'josk';
import type { JoSkAdapter, JoSkOnError, JoSkOnExecuted } from 'josk';
import type { RedisClientType, RedisClusterType } from 'redis';
import type { RedisClientType as Redis4ClientType, RedisClusterType as Redis4ClusterType } from 'redis4';
import type { Db as Mongo5Db } from 'mongodb5';
import type { Db as Mongo6Db } from 'mongodb6';
import type { Db as Mongo7Db } from 'mongodb';

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

const jobs = new JoSk({
  adapter,
  execute: 'one',
  lockLeaseTime: 30000,
  onError(_title: string, details: { description: string; uid: string | null }) {
    details.description;
    details.uid;
  },
  onExecuted(uid: string, details: { timestamp: number }) {
    uid;
    details.timestamp;
  }
});

void MongoAdapter;
void PostgresAdapter;
void RedisAdapter;

// Positive test: built-in adapters conform to JoSkAdapter
type _RedisAdapterIsAssignableToJoSkAdapter = RedisAdapter extends JoSkAdapter ? true : never;
type _MongoAdapterIsAssignableToJoSkAdapter = MongoAdapter extends JoSkAdapter ? true : never;
type _PostgresAdapterIsAssignableToJoSkAdapter = PostgresAdapter extends JoSkAdapter ? true : never;

const _redisOk: _RedisAdapterIsAssignableToJoSkAdapter = true;
const _mongoOk: _MongoAdapterIsAssignableToJoSkAdapter = true;
const _postgresOk: _PostgresAdapterIsAssignableToJoSkAdapter = true;
void _redisOk;
void _mongoOk;
void _postgresOk;
void new RedisAdapter({
  client: {} as RedisClientType,
  prefix: 'cluster',
  useHashTags: true
});

const redis5 = new RedisAdapter({ client: {} as RedisClientType });
const redis5Cluster = new RedisAdapter({ client: {} as RedisClusterType });
const redis4 = new RedisAdapter({ client: {} as Redis4ClientType });
const redis4Cluster = new RedisAdapter({ client: {} as Redis4ClusterType });
void redis5.client.hGet;
void redis5Cluster.client.hGet;
void redis4.client.hGet;
void redis4Cluster.client.hGet;

const mongo5 = new MongoAdapter({ db: {} as Mongo5Db });
const mongo6 = new MongoAdapter({ db: {} as Mongo6Db });
const mongo7 = new MongoAdapter({ db: {} as Mongo7Db });
const names: string[] = [mongo5.db.databaseName, mongo6.db.databaseName, mongo7.db.databaseName];
void names;
// @ts-expect-error MongoDB adapter requires a collection-capable database
new MongoAdapter({ db: { command: async () => ({ ok: 1 }) } });
// @ts-expect-error Redis adapter requires either standalone scan/ping or cluster node access
new RedisAdapter({ client: { del: async () => 0, eval: async () => null } });
const thenable: PromiseLike<boolean> = {
  then(onfulfilled) {
    return Promise.resolve(true).then(onfulfilled);
  }
};

// Hooks support async signatures
const _asyncErrorHook: JoSkOnError = async (_title, _details) => {};
const _asyncExecutedHook: JoSkOnExecuted = async (_uid, _details) => {};
void _asyncErrorHook;
void _asyncExecutedHook;

jobs.setInterval(async () => {}, 2048, 'interval-task');
jobs.setInterval(async () => true, 2048, 'promise-value-task');
jobs.setInterval(() => thenable, 2048, 'thenable-task');
jobs.setTimeout((ready: (nextExecuteAt?: Date | number | ((error?: Error, success?: boolean) => void)) => Promise<boolean>) => {
  void ready();
}, 2048, 'timeout-task');
jobs.setImmediate(() => {}, 'immediate-task');
jobs.clearInterval(Promise.resolve('interval-tasksetInterval'));
jobs.clearTimeout('timeout-tasksetTimeout');
jobs.pause();
jobs.pause('interval-tasksetInterval');
jobs.resume();
jobs.resume('interval-tasksetInterval');

// @ts-expect-error adapter required
new JoSk({});
