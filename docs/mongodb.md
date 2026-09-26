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
| `__JobTasks__.lock`     | `{ uniqueName: 1 }` UNIQUE | One lease document per `JoSk` instance prefix |
| `__JobTasks__.lock`     | `{ expireAt: 1 }` TTL (`expireAfterSeconds: 0`) | Auto-deletes leases past `expireAt`     |

Do not drop or modify these indexes manually — `__setup` recreates them on next startup.

## Mongoose, CosmosDB, DocumentDB

`MongoAdapter` default CI tests the official driver: `mongodb@5/6/7` with `mongo:8`, and `mongodb@7` with `mongo:6/7/8`. Cosmos DB for MongoDB and Amazon DocumentDB are not part of default CI. The manual [Mongo compatibility workflow](../.github/workflows/test-mongo-compatibility.yml) runs `npm run test:mongo` against `COSMOS_MONGO_URL` or `DOCDB_URL` only when that secret is configured; a passing run covers this test suite and endpoint, not every Mongo API feature or service version. Each secret must include the database path and the target service's required connection options; the DocumentDB job adds AWS's global CA bundle.

Microsoft's [current Linux emulator vNext](https://learn.microsoft.com/en-us/azure/cosmos-db/emulator-linux) supports only the NoSQL API. Microsoft [release notes](https://learn.microsoft.com/en-us/azure/cosmos-db/emulator-release-notes) also document local MongoDB endpoints through API 4.2, including a legacy Linux Docker endpoint; that limited emulator support does not establish parity with current cloud Cosmos Mongo API versions. AWS describes DocumentDB as a managed VPC service and publishes a versioned [MongoDB compatibility guide](https://docs.aws.amazon.com/documentdb/latest/devguide/compatibility.html); no AWS-provided local emulator was identified for CI. Cosmos/DocumentDB support remains endpoint- and version-specific. The adapter requires atomic `findOneAndUpdate` with sort/return-before, batched `bulkWrite` claims, update-pipeline interval upserts, and TTL indexes. Verify these operations against the target API; keep the service unverified until its optional workflow passes. Mongoose wrappers remain untested and unsupported.
