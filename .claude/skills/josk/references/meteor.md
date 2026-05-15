# JoSk in Meteor.js

JoSk is published as the Atmosphere package `ostrio:cron-jobs`. The runtime behavior, API surface, and option set are identical to the NPM package — only the import path differs. Use this when the user's project is a Meteor app and they prefer Atmosphere packages over raw NPM.

## Install

```sh
meteor add ostrio:cron-jobs
```

If you'd rather use the NPM package directly inside Meteor, `meteor npm install josk` works the same — Meteor's Node server can import either.

## Import

```js
import {
  JoSk,
  RedisAdapter,
  MongoAdapter,
  PostgresAdapter,
} from 'meteor/ostrio:cron-jobs';
```

## MongoDB via Meteor's built-in driver

When the app already runs against MongoDB (the default in Meteor), pull the `Db` instance off `MongoInternals` — no second client connection needed:

```js
import { MongoInternals } from 'meteor/mongo';
import { JoSk, MongoAdapter } from 'meteor/ostrio:cron-jobs';

const jobs = new JoSk({
  adapter: new MongoAdapter({
    db: MongoInternals.defaultRemoteCollectionDriver().mongo.db,
    prefix: 'cluster-scheduler',
  }),
  execute: 'batch',
  minRevolvingDelay: 128,
  maxRevolvingDelay: 768,
  onError(reason, details) {
    console.error('[josk]', reason, details.error);
  },
});

jobs.setInterval(async () => {
  // your work
}, 60_000, 'task-1m');

// Callback-API style is also fine
jobs.setInterval((ready) => {
  doAsyncWork(() => ready());
}, 60_000, 'task-1m-cb');
```

This is the lowest-friction setup for Meteor: zero extra connections, zero extra processes. The scheduler shares the app's Mongo replica set.

## Redis from Meteor

Install the Redis driver into the Meteor app first:

```sh
meteor npm install redis
```

```js
import { JoSk, RedisAdapter } from 'meteor/ostrio:cron-jobs';
import { createClient } from 'redis';

const redisClient = await createClient({
  url: process.env.REDIS_URL,
}).connect();

const jobs = new JoSk({
  adapter: new RedisAdapter({
    client: redisClient,
    prefix: 'cluster-scheduler',
  }),
});
```

## PostgreSQL from Meteor

```sh
meteor npm install pg
```

```js
import { JoSk, PostgresAdapter } from 'meteor/ostrio:cron-jobs';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.PG_URL });

const jobs = new JoSk({
  adapter: new PostgresAdapter({
    client: pool,
    prefix: 'cluster-scheduler',
  }),
});
```

## Meteor-specific notes

- **Server-only.** Put JoSk code in `server/` or behind `Meteor.isServer`. Never import it on the client.
- **Replica set guidance still applies.** Use `writeConcern: { j: true, w: 'majority' }` / `readConcern: { level: 'majority' }` / `readPreference: 'primary'` on the Mongo URL when configuring Meteor against a replica set. JoSk depends on primary-visibility for lease ownership.
- **Galaxy / autoscale.** When Galaxy scales the app horizontally, every container shares the same MongoDB. That's exactly what JoSk's `MongoAdapter` is for — each scheduled task fires once across all containers.
- **`destroy()` on shutdown.** Hook into `process.on('SIGTERM', …)` to call `jobs.destroy()` before Galaxy stops the container, so the scheduler releases its lease cleanly.

## Same options, same methods

Every option from the NPM API (`execute`, `concurrency`, `zombieTime`, `lockOwnerId`, `minRevolvingDelay`, `maxRevolvingDelay`, `autoClear`, `onError`, `onExecuted`, `debug`) and every method (`setInterval`, `setTimeout`, `setImmediate`, `clearInterval`, `clearTimeout`, `destroy`, `ping`) work identically here. Refer to `api.md` for signatures and to `patterns.md` for handler styles, CRON via `cron-parser`, and graceful shutdown.

## Migration to Meteor 3 / async

Meteor 3 made the server code path async-first. JoSk's handler API has supported both async functions and callback styles since long before that — no migration needed for handlers themselves. Prefer the async / Promise-returning style in new Meteor 3 code:

```js
jobs.setInterval(async () => {
  await Collection.rawCollection().updateOne(/* … */);
}, 60_000, 'cleanup-1m');
```
