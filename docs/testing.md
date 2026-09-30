# Running Tests

JoSk's test suite combines:

- **Mocha** (`test/npm.js`, `test/npm-redis.js`, `test/npm-mongo.js`, `test/npm-postgres.js`) — historical adapter-specific integration tests that run against live servers.
- **Jest** (`test/jest/core.test.js`, `test/jest/adapters.test.js`) — core scheduler tests plus live adapter contract tests. Doubles as the **Bun** test suite via `bun:test` (`npm run test:bun`).
- **`tsc`** — TypeScript declaration smoke test (`npm run test:types`).

## Setup

1. Clone this repository.
2. From the repo root, install dev dependencies:

   ```shell
   npm install --save-dev
   ```

3. Provide live Redis, MongoDB, and PostgreSQL servers. The test harness reads connection strings from:
   - `REDIS_URL` — e.g. `redis://127.0.0.1:6379`
   - `MONGO_URL` — e.g. `mongodb://127.0.0.1:27017/npm-josk-test-001`
   - `PG_URL` — e.g. `postgres://postgres:postgres@localhost:5432/npm-josk-test-001`

## Run all tests

```shell
REDIS_URL="redis://127.0.0.1:6379" \
MONGO_URL="mongodb://127.0.0.1:27017/npm-josk-test-001" \
PG_URL="postgres://postgres:postgres@localhost:5432/npm-josk-test-001" \
npm test
```

The full suite (Mocha + Jest + tsc) takes ~6 minutes.

## Targeted runs

```shell
# Jest core + live adapter contract tests
npm run test:jest

# Same Jest suite under Bun (bun:test)
npm run test:bun

# Coverage (Jest only — Mocha suites add to coverage when run separately)
npm run test:coverage

# TypeScript declaration smoke test
npm run test:types

# Per-adapter Mocha runs (require live servers)
REDIS_URL="redis://127.0.0.1:6379"        npm run test:redis    # ~3 min
MONGO_URL="mongodb://127.0.0.1:27017/db"  npm run test:mongo    # ~3 min
PG_URL="postgres://postgres@localhost/db" npm run test:postgres # ~3 min
```

## Verbose mode

```shell
DEBUG=true REDIS_URL="…" MONGO_URL="…" PG_URL="…" npm test
```

## Tested runtimes

JoSk requires `node@>=14.21.3` and is tested on Node 14.21.3, 16.20.2, 18.19.1, 20.11.1, 22.21.1, and 24.16.0. Each driver sets its own Node floor:

| Driver | Minimum Node |
|---|---|
| `mongodb@5` | 14.20.1 |
| `mongodb@6` | 16.20.1 |
| `mongodb@7` | 20.19 |
| `redis@5` | 18.19 |
| `pg@8.20` | 16 |

`RedisAdapter` and `PostgresAdapter` are covered by mock-client tests only on Node below 20; live Redis and PostgreSQL runs stay on Node 20, 22, and 24.

## Clean up old tasks

For development and tests.

### Clean up Redis

```shell
redis-cli --no-auth-warning --scan --pattern "josk:default:*" | xargs redis-cli --raw --no-auth-warning DEL

# If you're using multiple JoSk instances with prefix:
redis-cli --no-auth-warning --scan --pattern "josk:prefix:*" | xargs redis-cli --raw --no-auth-warning DEL

# If useHashTags is true:
redis-cli --no-auth-warning --scan --pattern "josk:{prefix}:*" | xargs redis-cli --raw --no-auth-warning DEL
```

### Clean up MongoDB

```js
// Run directly in MongoDB console (default prefix `default`):
db.getCollection('__JobTasks__default').deleteMany({});
// If you're using a custom prefix:
db.getCollection('__JobTasks__PrefixHere').deleteMany({});
// Lock collection (shared across prefixes by default):
db.getCollection('__JobTasks__.lock').deleteMany({});
```

### Clean up PostgreSQL

```sql
DELETE FROM josk_tasks WHERE prefix = 'default';
DELETE FROM josk_locks WHERE lock_key = 'josk-default.lock';

-- If you're using custom prefix:
DELETE FROM josk_tasks WHERE prefix = 'cluster-scheduler';
DELETE FROM josk_locks WHERE lock_key = 'josk-cluster-scheduler.lock';
```
