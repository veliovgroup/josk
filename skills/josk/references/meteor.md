# JoSk in Meteor.js

Atmosphere package `ostrio:cron-jobs`. Identical API to the NPM package — only the import path differs.

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

The scheduler shares the app's Mongo replica set — zero extra connections.

## Redis / PostgreSQL from Meteor

Same `RedisAdapter` / `PostgresAdapter` setup as `adapters.md`. Install drivers via `meteor npm install redis` or `meteor npm install pg`, then import from `meteor/ostrio:cron-jobs` instead of `josk`.

## Meteor-specific notes

- **Server-only.** Put JoSk code in `server/` or behind `Meteor.isServer`. Never import it on the client.
- **Replica set guidance still applies.** Use `writeConcern: { j: true, w: 'majority' }` / `readConcern: { level: 'majority' }` / `readPreference: 'primary'` on the Mongo URL when configuring Meteor against a replica set. JoSk depends on primary-visibility for lease ownership.
- **Galaxy / autoscale.** When Galaxy scales the app horizontally, every container shares the same MongoDB. That's what JoSk's `MongoAdapter` is for — each due tick is claimed by one container; method guarantees still apply.
- **`destroy()` on shutdown.** Hook into `process.on('SIGTERM', …)` to call `jobs.destroy()` before Galaxy stops the container, so the scheduler releases its lease cleanly.

All options and methods are identical to the NPM API — see `api.md` and `patterns.md`. Meteor 3's async-first server path needs no handler migration; the async / Promise-returning style is already supported.
