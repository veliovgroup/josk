import { JoSk, MongoAdapter, PostgresAdapter, RedisAdapter } from 'josk';

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

jobs.setInterval(async () => {}, 2048, 'interval-task');
jobs.setTimeout((ready: (nextExecuteAt?: Date | number | ((error?: Error, success?: boolean) => void)) => Promise<boolean>) => {
  void ready();
}, 2048, 'timeout-task');
jobs.setImmediate(() => {}, 'immediate-task');
jobs.clearInterval(Promise.resolve('interval-tasksetInterval'));
jobs.clearTimeout('timeout-tasksetTimeout');

// @ts-expect-error adapter required
new JoSk({});
