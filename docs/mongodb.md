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

`MongoAdapter` is **tested against the official `mongodb` driver only**. Other clients may work if they expose the same `Db.collection()`, `Db.command()`, and `Collection` APIs, but are unsupported. CosmosDB's Mongo API in particular omits operators the scheduler relies on for atomic claim semantics.
