import { MongoClient } from 'mongodb';
import { it, describe, before, after } from 'mocha';
import { assert } from 'chai';
import { MongoAdapter } from '../index.js';
import { closeMongoClient, uniqueId, wait } from './helpers.js';
import { getMongoDatabaseName } from './mongo-url.js';

if (!process.env.MONGO_URL) {
  throw new Error('MONGO_URL env.var is not defined! Please run test with MONGO_URL, like `MONGO_URL=mongodb://127.0.0.1:27017/dbname npm test`');
}

const mongoAddr = process.env.MONGO_URL;

// Same DDL as JoSk 5.0.0 adapters/mongo.js: default index names, drop on conflict 85
const v5EnsureIndex = async (collection, keys, opts) => {
  try {
    await collection.createIndex(keys, opts);
  } catch (e) {
    if (e.code !== 85) {
      throw e;
    }

    const indexes = await collection.indexes();
    const index = indexes.find((i) => Object.keys(keys).every((k) => i.key[k] !== undefined) && Object.keys(i.key).every((k) => keys[k] !== undefined));
    if (index) {
      await collection.dropIndex(index.name);
      await collection.createIndex(keys, opts);
    }
  }
};

const v5Init = async (collection) => {
  await v5EnsureIndex(collection, { expireAt: 1 }, { background: false, expireAfterSeconds: 1 });
  await v5EnsureIndex(collection, { uniqueName: 1 }, { background: false, unique: true });
};

const describeIndexes = async (collection) => (await collection.indexes()).filter((i) => i.name !== '_id_').map((i) => ({
  name: i.name,
  key: i.key,
  unique: i.unique === true,
  ttl: i.expireAfterSeconds
})).sort((a, b) => a.name.localeCompare(b.name));

const UNIQUE = { name: 'uniqueName_1', key: { uniqueName: 1 }, unique: true, ttl: void 0 };
const TTL = { name: 'expireAt_1', key: { expireAt: 1 }, unique: false, ttl: 1 };

describe('MongoAdapter shared lock collection indexes', function () {
  this.timeout(30000);
  let client;
  let db;
  const created = [];
  const lockName = (label) => {
    const name = uniqueId(`josk-lockidx-${label}`);
    created.push(name);
    return name;
  };
  const adapterFor = (lockCollectionName, prefix = 'lockidx') => new MongoAdapter({ db, lockCollectionName, prefix });
  const stubJosk = { __errorHandler: () => {} };

  before(async () => {
    client = await MongoClient.connect(mongoAddr, { maxPoolSize: 32 });
    db = client.db(getMongoDatabaseName(mongoAddr));
  });

  after(async () => {
    for (const name of created) {
      await db.collection(name).drop().catch(() => {});
      await db.collection(`__JobTasks__${name}`).drop().catch(() => {});
    }
    await db.collection('__JobTasks__lockidx').drop().catch(() => {});
    await closeMongoClient(client);
  });

  it('creates JoSk 5 compatible names and options on a fresh collection', async () => {
    const name = lockName('fresh');
    await adapterFor(name).ready();
    assert.deepEqual(await describeIndexes(db.collection(name)), [TTL, UNIQUE]);
  });

  it('is idempotent across repeated restarts', async () => {
    const name = lockName('repeat');
    for (let i = 0; i < 3; i++) {
      await adapterFor(name).ready();
    }
    assert.deepEqual(await describeIndexes(db.collection(name)), [TTL, UNIQUE]);
  });

  it('leaves a JoSk 5 created layout untouched, in both startup orders', async () => {
    const name = lockName('order');
    const col = db.collection(name);
    await v5Init(col);
    const before = await describeIndexes(col);
    await adapterFor(name).ready();
    assert.deepEqual(await describeIndexes(col), before);
    await v5Init(col);
    assert.deepEqual(await describeIndexes(col), before);
    await adapterFor(name).ready();
    assert.deepEqual(await describeIndexes(col), [TTL, UNIQUE]);
  });

  it('never drops the unique index while 5.x and 6.x initialise alternately', async () => {
    const name = lockName('alt');
    const col = db.collection(name);
    for (let i = 0; i < 3; i++) {
      await adapterFor(name).ready();
      await v5Init(col);
      await adapterFor(name).ready();
    }
    assert.deepEqual(await describeIndexes(col), [TTL, UNIQUE]);
  });

  it('adopts indexes created by 6.0-6.4 under their own names and TTL, without dropping', async () => {
    const name = lockName('legacy6');
    const col = db.collection(name);
    await col.createIndex({ uniqueName: 1 }, { name: 'uniqueName_unique', unique: true });
    await col.createIndex({ expireAt: 1 }, { name: 'expireAt_ttl', expireAfterSeconds: 0 });
    await adapterFor(name).ready();
    assert.deepEqual((await describeIndexes(col)).map((i) => i.name), ['expireAt_ttl', 'uniqueName_unique']);
  });

  it('converges under overlapping initialisation', async () => {
    const name = lockName('overlap');
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => adapterFor(name, `overlap${i % 3}`).ready()));
    const rejected = results.filter((r) => r.status === 'rejected');
    assert.lengthOf(rejected, 0, rejected.map((r) => r.reason?.message).join('; '));
    assert.deepEqual(await describeIndexes(db.collection(name)), [TTL, UNIQUE]);
    for (let i = 0; i < 3; i++) {
      await db.collection(`__JobTasks__overlap${i}`).drop().catch(() => {});
    }
  });

  it('fails with an actionable error and drops nothing when a non-unique index owns the key', async () => {
    const name = lockName('nonunique');
    const col = db.collection(name);
    await col.createIndex({ uniqueName: 1 }, { name: 'manual_uniqueName' });
    const adapter = adapterFor(name);
    let error;
    try {
      await adapter.ready();
    } catch (e) {
      error = e;
    }
    assert.match(error?.message || '', /manual_uniqueName.*not a plain unique index.*never drops.*lockCollectionName/s);
    assert.deepEqual((await describeIndexes(col)).map((i) => i.name), ['manual_uniqueName']);
  });

  it('fails with an actionable error when a non-TTL index owns the expireAt key', async () => {
    const name = lockName('nottl');
    const col = db.collection(name);
    await col.createIndex({ expireAt: 1 }, { name: 'manual_expireAt' });
    let error;
    try {
      await adapterFor(name).ready();
    } catch (e) {
      error = e;
    }
    assert.match(error?.message || '', /manual_expireAt.*not a TTL index/s);
    assert.deepEqual((await describeIndexes(col)).map((i) => i.name), ['manual_expireAt', 'uniqueName_1']);
  });

  it('keeps exactly one lock holder while other adapters keep re-initialising', async function () {
    const name = lockName('exclusion');
    const col = db.collection(name);
    const adapter = adapterFor(name, 'exclusion');
    adapter.joskInstance = stubJosk;
    await adapter.ready();

    const end = Date.now() + 3000;
    const holders = new Set();
    let overlaps = 0;
    let acquisitions = 0;
    let samples = 0;
    let withoutUnique = 0;
    let maxDocs = 0;
    let running = true;

    const monitor = (async () => {
      while (running) {
        const indexes = await col.indexes();
        samples++;
        if (!indexes.some((i) => i.key?.uniqueName === 1 && i.unique === true)) {
          withoutUnique++;
        }
        maxDocs = Math.max(maxDocs, await col.countDocuments({ uniqueName: adapter.uniqueName }));
      }
    })();

    const contender = async (n) => {
      while (Date.now() < end) {
        const lock = { ownerId: `owner${n}`, leaseId: `lease${n}-${Math.random()}`, expireAt: new Date(Date.now() + 30000) };
        if (await adapter.acquireLock(lock)) {
          acquisitions++;
          holders.add(lock.leaseId);
          if (holders.size > 1) {
            overlaps++;
          }
          await wait(10);
          holders.delete(lock.leaseId);
          await adapter.releaseLock(lock);
        } else {
          await wait(1);
        }
      }
    };

    const churn = async () => {
      while (Date.now() < end) {
        await v5Init(col).catch(() => {});
        await adapterFor(name, 'exclusion').ready();
        await wait(5);
      }
    };

    await Promise.all([...Array.from({ length: 6 }, (_, n) => contender(n)), churn()]);
    running = false;
    await monitor;

    assert.isAbove(acquisitions, 0);
    assert.equal(overlaps, 0, 'two holders overlapped');
    assert.equal(withoutUnique, 0, `unique index missing in ${withoutUnique}/${samples} samples`);
    assert.equal(maxDocs, 1, 'duplicate lock documents');
  });

  it('honours lease ownership, expiry and takeover', async () => {
    const name = lockName('lease');
    const a = adapterFor(name, 'lease');
    a.joskInstance = stubJosk;
    await a.ready();
    const leaseA = { ownerId: 'a', leaseId: 'lease-a', expireAt: new Date(Date.now() + 30000) };
    const leaseB = { ownerId: 'b', leaseId: 'lease-b', expireAt: new Date(Date.now() + 30000) };
    assert.isTrue(await a.acquireLock(leaseA));
    assert.isFalse(await a.acquireLock(leaseB), 'live lease must exclude');
    await a.releaseLock(leaseB);
    assert.isFalse(await a.acquireLock(leaseB), 'foreign release must not free the lock');
    await db.collection(name).updateOne({ uniqueName: a.uniqueName }, { $set: { expireAt: new Date(Date.now() - 1000) } });
    assert.isTrue(await a.acquireLock(leaseB), 'expired lease (crashed owner) must be taken over');
    assert.equal(await db.collection(name).countDocuments({ uniqueName: a.uniqueName }), 1);
    await a.releaseLock(leaseB);
    assert.equal(await db.collection(name).countDocuments({ uniqueName: a.uniqueName }), 0);
  });
});
