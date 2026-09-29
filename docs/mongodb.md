# MongoDB Tuning for JoSk

This document collects MongoDB-specific guidance for users of the `MongoAdapter`. The README covers the basic setup — read that first.

## Connection options for a replica set

When `josk` shares a replica set with other workloads, configure the driver for durable, primary-routed writes so the scheduler's lease and claim operations are linearizable:

```js
import { MongoClient } from 'mongodb';
import { JoSk, MongoAdapter } from 'josk';

const options = {
  writeConcern: {
    j: true,            // wait for journal sync
    w: 'majority',      // wait for majority ack
    wtimeoutMS: 30000   // bail after 30s on a degraded RS
  },
  readConcern: { level: 'majority' },
  readPreference: 'primary'
};

const client = await MongoClient.connect('mongodb://url', options);

// Use a database dedicated to JoSk to avoid contention with your app DB.
const db = client.db('josk-db');

const jobs = new JoSk({
  adapter: new MongoAdapter({ db })
});
```

## Why a dedicated database?

The scheduler issues frequent atomic `findOneAndUpdate` calls against the task and lock collections. Sharing the database with chatty application workloads can cause lock contention and inflate JoSk's tick latency. A dedicated DB on the same cluster is the cheapest isolation.

## Cleaning up old tasks

Run from the MongoDB shell:

```js
// Default prefix `default`:
db.getCollection('__JobTasks__default').deleteMany({});

// Custom prefix:
db.getCollection('__JobTasks__PrefixHere').deleteMany({});

// Lock collection (shared across prefixes by default):
db.getCollection('__JobTasks__.lock').deleteMany({});
```

## Index inventory

`MongoAdapter#__setup` creates and maintains:

| Collection              | Index               | Purpose                                          |
|-------------------------|---------------------|--------------------------------------------------|
| `__JobTasks__<prefix>`  | `{ uid: 1 }` UNIQUE | Idempotent task add and direct removal by `uid`  |
| `__JobTasks__<prefix>`  | `{ isDeleted: 1, executeAt: 1 }` | Drives the "due now" scan in `iterate()`  |
| `__JobTasks__.lock`     | `{ uniqueName: 1 }` UNIQUE, name `uniqueName_1` | One lease document per `JoSk` instance prefix |
| `__JobTasks__.lock`     | `{ expireAt: 1 }` TTL, name `expireAt_1`, `expireAfterSeconds: 1` | Auto-deletes leases past `expireAt`     |

The task-collection indexes are recreated on next startup if dropped. On the lock collection, `__setup` adopts any existing index with the same key pattern, whatever its name or TTL value, and never drops one. It throws if the existing index on `uniqueName` is not plain unique, or the one on `expireAt` is not a TTL index. Fix or drop that index manually, or set another `lockCollectionName`.

### Sharing the lock collection between JoSk 5 and 6

JoSk 5.0.0 drops and recreates a same-key index that has a different name or options. Before 6.4.1, JoSk 6 used the names `uniqueName_unique` and `expireAt_ttl`, so each startup of one major version replaced the other's indexes. Between the drop and the re-create the collection has no unique index on `uniqueName`. Concurrent lock upserts then insert duplicate lease documents and two instances hold the same lock. If duplicates exist, the re-create fails and the collection stays without a unique index. Measured on MongoDB 4.2.2 with 5.x re-initialising every few milliseconds: the unique index was missing in 90% of samples, up to 8 lease documents existed for one name, and holders overlapped.

From 6.4.1 JoSk 6 creates the same names and options as JoSk 5 and never drops. With 5.x and 6.4.1+ the layout is stable in either startup order. A collection that already has the 6.0 to 6.4.0 names (`uniqueName_unique`, `expireAt_ttl`) stays as it is, and a JoSk 5 startup would still replace those indexes. Until every JoSk 5 service is gone, give JoSk 6 its own `lockCollectionName` (for example `__JobTasks__.lock.v6`). Do not delete lock documents to work around a duplicate-key error. Repair of a production collection is a separate, manual operation.

## Mongoose, CosmosDB, DocumentDB

`MongoAdapter` default CI tests the official driver: `mongodb@5/6/7` with `mongo:8`, and `mongodb@7` with `mongo:6/7/8`. Cosmos DB for MongoDB and Amazon DocumentDB are not part of default CI. The manual [Mongo compatibility workflow](../.github/workflows/test-mongo-compatibility.yml) runs `npm run test:mongo` against `COSMOS_MONGO_URL` or `DOCDB_URL` only when that secret is configured; a passing run covers this test suite and endpoint, not every Mongo API feature or service version. Each secret must include the database path and the target service's required connection options; the DocumentDB job adds AWS's global CA bundle. DocumentDB accepts connections only from inside its VPC, so GitHub-hosted runners can't reach it. Set the `DOCDB_RUNNER` repository variable to the label of a self-hosted runner in that VPC; without it the job runs on `ubuntu-latest` and fails to connect.

Microsoft's [current Linux emulator vNext](https://learn.microsoft.com/en-us/azure/cosmos-db/emulator-linux) supports only the NoSQL API. Microsoft [release notes](https://learn.microsoft.com/en-us/azure/cosmos-db/emulator-release-notes) also document local MongoDB endpoints through API 4.2, including a legacy Linux Docker endpoint; that limited emulator support does not establish parity with current cloud Cosmos Mongo API versions. AWS describes DocumentDB as a managed VPC service and publishes a versioned [MongoDB compatibility guide](https://docs.aws.amazon.com/documentdb/latest/devguide/compatibility.html); no AWS-provided local emulator was identified for CI. Cosmos/DocumentDB support remains endpoint- and version-specific. The adapter requires atomic `findOneAndUpdate` with sort/return-before, batched `bulkWrite` claims, update-pipeline interval upserts, and TTL indexes. Verify these operations against the target API; keep the service unverified until its optional workflow passes. Mongoose wrappers remain untested and unsupported.
