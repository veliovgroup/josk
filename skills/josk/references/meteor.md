# JoSk in Meteor

Atmosphere package `ostrio:cron-jobs`, Meteor 2.14+ or 3.2+. Same API as npm `josk`; only the import path differs. Server-only: keep it under `server/`.

```sh
meteor add ostrio:cron-jobs
```

```js
import { JoSk, MongoAdapter, RedisAdapter, PostgresAdapter } from 'meteor/ostrio:cron-jobs';
```

## MongoDB through Meteor's driver

Reuse the app's connection; no second client:

```js
import { MongoInternals } from 'meteor/mongo';
import { JoSk, MongoAdapter } from 'meteor/ostrio:cron-jobs';

const jobs = new JoSk({
  adapter: new MongoAdapter({
    db: MongoInternals.defaultRemoteCollectionDriver().mongo.db,
    prefix: 'app',
  }),
  onError: (title, { error, uid }) => console.error(title, uid, error),
});

jobs.setInterval(async () => { /* work */ }, 60_000, 'task-1m');
```

Set `w=majority` and `readPreference=primary` on `MONGO_URL` for a replica set.

## Redis and PostgreSQL

`meteor npm install redis` or `meteor npm install pg`, then configure `RedisAdapter` / `PostgresAdapter` exactly as in [adapters.md](adapters.md).

## Notes

- Every Galaxy or autoscaled container shares the storage, so each due tick runs on one container.
- `await jobs.shutdown({ timeout })` on `SIGTERM` before the container stops; see [patterns.md](patterns.md).
- Meteor 2.x runs Node 14: use `cron-parser@4` (`parser.parseExpression`) there; `cron-parser@5` needs Node 18+.
- TypeScript: types resolve through `zodern:types`.
