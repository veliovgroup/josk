import { MongoClient } from 'mongodb';
import { it, describe, before, after } from 'mocha';
import { assert } from 'chai';
import { MongoAdapter } from '../index.js';
import { MongoAdapter as MongoAdapterV5 } from 'josk5';
import { closeMongoClient, uniqueId, wait, waitUntil } from './helpers.js';
import { getMongoDatabaseName } from './mongo-url.js';

if (!process.env.MONGO_URL) {
  throw new Error('MONGO_URL env.var is not defined! Please run test with MONGO_URL, like `MONGO_URL=mongodb://127.0.0.1:27017/dbname npm test`');
}

const mongoAddr = process.env.MONGO_URL;

const describeIndexes = async (collection) => (await collection.indexes()).filter((i) => i.name !== '_id_').map((i) => ({
  name: i.name,
  key: i.key,
  unique: i.unique === true,
  ttl: i.expireAfterSeconds
})).sort((a, b) => a.name.localeCompare(b.name));

const UID = { name: 'uid_1', key: { uid: 1 }, unique: true, ttl: void 0 };
const DUE = { name: 'due_lookup', key: { isDeleted: 1, executeAt: 1 }, unique: false, ttl: void 0 };
const V5_UID_DELETED = { name: 'uid_1_isDeleted_1', key: { uid: 1, isDeleted: 1 }, unique: false, ttl: void 0 };
const V5_EXECUTE_AT = { name: 'executeAt_1', key: { executeAt: 1 }, unique: false, ttl: void 0 };
const LOCK_UNIQUE = { name: 'uniqueName_1', key: { uniqueName: 1 }, unique: true, ttl: void 0 };
const LOCK_TTL = { name: 'expireAt_1', key: { expireAt: 1 }, unique: false, ttl: 1 };

// Genuine JoSk 5.0.0 adapter (npm alias josk5). It creates indexes without awaiting, so wait for them.
const v5Ready = async (db, prefix, lockCollectionName) => {
  const adapter = new MongoAdapterV5({ db, prefix, lockCollectionName });
  const has = (indexes, key) => indexes.some((i) => JSON.stringify(i.key) === JSON.stringify(key));
  await waitUntil(async () => {
    const tasks = await db.collection(`__JobTasks__${prefix}`).indexes().catch(() => []);
    const locks = await db.collection(lockCollectionName).indexes().catch(() => []);
    return has(tasks, { uid: 1 }) && has(tasks, { uid: 1, isDeleted: 1 }) && has(tasks, { executeAt: 1 }) && has(locks, { expireAt: 1 }) && has(locks, { uniqueName: 1 });
  }, { timeout: 10000, message: 'JoSk 5 indexes were not created in time' });
  await wait(100);
  return adapter;
};

describe('MongoAdapter task collection indexes (JoSk 5 and 6 on one prefix)', function () {
  this.timeout(60000);
  let client;
  let db;
  const prefixes = [];
  const lockNames = [];
  const fresh = (label) => {
    const prefix = uniqueId(`taskidx-${label}`);
    const lock = `${prefix}-lock`;
    prefixes.push(prefix);
    lockNames.push(lock);
    return { prefix, lock, col: db.collection(`__JobTasks__${prefix}`), lockCol: db.collection(lock) };
  };
  const v6 = (ctx) => new MongoAdapter({ db, prefix: ctx.prefix, lockCollectionName: ctx.lock });
  const errors = [];
  const stubJosk = { __errorHandler: (e) => errors.push(e) };

  before(async () => {
    client = await MongoClient.connect(mongoAddr, { maxPoolSize: 32 });
    db = client.db(getMongoDatabaseName(mongoAddr));
  });

  after(async () => {
    for (const name of [...prefixes.map((p) => `__JobTasks__${p}`), ...lockNames]) {
      await db.collection(name).drop().catch(() => {});
    }
    await closeMongoClient(client);
  });

  it('creates a JoSk 5 compatible unique uid index on a fresh collection', async () => {
    const ctx = fresh('fresh');
    await v6(ctx).ready();
    assert.deepEqual(await describeIndexes(ctx.col), [DUE, UID]);
  });

  it('JoSk 6 first, then JoSk 5: nothing of 6 is dropped or renamed', async () => {
    const ctx = fresh('v6first');
    await v6(ctx).ready();
    await v5Ready(db, ctx.prefix, ctx.lock);
    assert.deepEqual(await describeIndexes(ctx.col), [DUE, V5_EXECUTE_AT, UID, V5_UID_DELETED].sort((a, b) => a.name.localeCompare(b.name)));
    await v6(ctx).ready();
    assert.deepEqual((await describeIndexes(ctx.col)).map((i) => i.name), ['due_lookup', 'executeAt_1', 'uid_1', 'uid_1_isDeleted_1']);
    assert.deepEqual(await describeIndexes(ctx.lockCol), [LOCK_TTL, LOCK_UNIQUE]);
  });

  it('JoSk 5 first, then JoSk 6: the 5.0.0 uid index is adopted unchanged', async () => {
    const ctx = fresh('v5first');
    await v5Ready(db, ctx.prefix, ctx.lock);
    const before = await describeIndexes(ctx.col);
    assert.include(before.map((i) => i.name), 'uid_1');
    await v6(ctx).ready();
    const after = await describeIndexes(ctx.col);
    assert.deepEqual(after.filter((i) => i.name !== 'due_lookup'), before);
    assert.include(after.map((i) => i.name), 'due_lookup');
    await v5Ready(db, ctx.prefix, ctx.lock);
    assert.deepEqual(await describeIndexes(ctx.col), after);
    assert.deepEqual(await describeIndexes(ctx.lockCol), [LOCK_TTL, LOCK_UNIQUE]);
  });

  it('adopts the uid_unique index created by 6.1-6.4.0 without dropping', async () => {
    const ctx = fresh('legacy');
    await ctx.col.createIndex({ uid: 1 }, { name: 'uid_unique', unique: true });
    await ctx.col.createIndex({ isDeleted: 1, executeAt: 1 }, { name: 'due_lookup' });
    await v6(ctx).ready();
    assert.deepEqual((await describeIndexes(ctx.col)).map((i) => i.name), ['due_lookup', 'uid_unique']);
  });

  it('replaces a non-unique uid index, which protects nothing', async () => {
    const ctx = fresh('nonunique');
    await ctx.col.createIndex({ uid: 1 }, { name: 'manual_uid' });
    await v6(ctx).ready();
    assert.deepEqual(await describeIndexes(ctx.col), [DUE, UID]);
  });

  it('keeps the unique uid index and unique uids while 5.0.0 and 6 restart during add() churn', async () => {
    const ctx = fresh('churn');
    const adapter = v6(ctx);
    adapter.joskInstance = stubJosk;
    await adapter.ready();
    errors.length = 0;

    const end = Date.now() + 4000;
    let samples = 0;
    let withoutUnique = 0;
    let running = true;

    const monitor = (async () => {
      while (running) {
        const indexes = await ctx.col.indexes();
        samples++;
        if (!indexes.some((i) => i.key?.uid === 1 && Object.keys(i.key).length === 1 && i.unique === true)) {
          withoutUnique++;
        }
      }
    })();

    const writer = async (n) => {
      let round = 0;
      while (Date.now() < end) {
        for (let u = 0; u < 20; u++) {
          const uid = `task-${u}`;
          await adapter.add(uid, (u + round + n) % 2 === 0, 1000 + u);
        }
        round++;
      }
    };
    const restarts = async () => {
      while (Date.now() < end) {
        new MongoAdapterV5({ db, prefix: ctx.prefix, lockCollectionName: ctx.lock });
        await v6(ctx).ready();
        await wait(20);
      }
    };

    await Promise.all([...Array.from({ length: 4 }, (_, n) => writer(n)), restarts(), restarts()]);
    running = false;
    await monitor;

    assert.equal(errors.length, 0, `add() reported errors: ${errors.map((e) => e?.message).join('; ')}`);
    assert.equal(withoutUnique, 0, `unique uid index missing in ${withoutUnique}/${samples} samples`);
    const duplicates = await ctx.col.aggregate([{ $group: { _id: '$uid', n: { $sum: 1 } } }, { $match: { n: { $gt: 1 } } }]).toArray();
    assert.lengthOf(duplicates, 0, 'duplicate uid documents');
    await v5Ready(db, ctx.prefix, ctx.lock);
    await v6(ctx).ready();
  });

  it('starts concurrently over a manual non-unique uid index: every start fulfils, one unique index remains', async () => {
    const ctx = fresh('race');
    await ctx.col.createIndex({ uid: 1 }, { name: 'manual_uid' });
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => v6(ctx).ready()));
    assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'], results.map((r) => r.reason?.message).join('; '));
    assert.deepEqual(await describeIndexes(ctx.col), [DUE, UID]);
  });

  it('keeps a non-unique uid index and throws when duplicate uid documents exist', async () => {
    const ctx = fresh('dups');
    await ctx.col.createIndex({ uid: 1 }, { name: 'manual_uid' });
    await ctx.col.insertMany([{ uid: 'same' }, { uid: 'same' }]);
    let error;
    try {
      await v6(ctx).ready();
    } catch (e) {
      error = e;
    }
    assert.match(error?.message || '', /duplicate "uid" documents.*manual_uid.*kept/s);
    assert.equal(error.code, 11000);
    assert.deepEqual((await describeIndexes(ctx.col)).map((i) => i.name), ['manual_uid']);
  });

  it('maps a duplicate-key failure on the unique uid index to an actionable error', async () => {
    const ctx = fresh('e11000');
    await ctx.col.insertMany([{ uid: 'same' }, { uid: 'same' }]);
    let error;
    try {
      await v6(ctx).ready();
    } catch (e) {
      error = e;
    }
    assert.match(error?.message || '', /duplicate "uid" documents in ".*"; dedupe before starting JoSk 6/);
    assert.equal(error.code, 11000);
    assert.equal(error.cause?.code, 11000, 'original driver error is kept as cause');
  });

  it('does not adopt a unique uid index with a non-simple collation', async () => {
    const ctx = fresh('collation');
    await ctx.col.createIndex({ uid: 1 }, { name: 'ci_uid', unique: true, collation: { locale: 'en', strength: 2 } });
    let error;
    try {
      await v6(ctx).ready();
    } catch (e) {
      error = e;
    }
    assert.match(error?.message || '', /ci_uid.*not a plain unique index/s);
    assert.deepEqual((await describeIndexes(ctx.col)).map((i) => i.name), ['ci_uid']);
  });

  it('does not drop a unique uid index another starter built after the first read', async () => {
    const ctx = fresh('recheck');
    await ctx.col.createIndex({ uid: 1 }, { name: 'uid_1' });
    const dropped = [];
    const col = new Proxy(ctx.col, {
      get(target, prop) {
        if (prop === 'aggregate') {
          return (...args) => ({
            toArray: async () => {
              // Another starter replaces the non-unique index while this one probes.
              await target.dropIndex('uid_1');
              await target.createIndex({ uid: 1 }, { name: 'uid_1', unique: true });
              return await target.aggregate(...args).toArray();
            }
          });
        }
        if (prop === 'dropIndex') {
          return async (name) => {
            dropped.push(name);
            return await target.dropIndex(name);
          };
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    const proxyDb = new Proxy(db, {
      get(target, prop) {
        if (prop === 'collection') {
          return (name) => (name === ctx.col.collectionName ? col : target.collection(name));
        }
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      }
    });
    await new MongoAdapter({ db: proxyDb, prefix: ctx.prefix, lockCollectionName: ctx.lock }).ready();
    assert.deepEqual(dropped, []);
    assert.deepEqual(await describeIndexes(ctx.col), [DUE, UID]);
  });

  it('never drops a non-unique TTL index on uid', async () => {
    const ctx = fresh('ttl');
    await ctx.col.createIndex({ uid: 1 }, { name: 'ttl_uid', expireAfterSeconds: 3600 });
    let error;
    try {
      await v6(ctx).ready();
    } catch (e) {
      error = e;
    }
    assert.match(error?.message || '', /ttl_uid.*not a plain unique index.*different \{prefix\}/s);
    assert.deepEqual((await describeIndexes(ctx.col)).map((i) => i.name), ['ttl_uid']);
  });
});
