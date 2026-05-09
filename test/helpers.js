import { assert } from 'chai';

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const waitUntil = async (predicate, opts = {}) => {
  const timeout = opts.timeout || 4000;
  const interval = opts.interval || 32;
  const message = opts.message || 'condition was not met in time';
  const startedAt = Date.now();
  let lastValue;

  while (Date.now() - startedAt < timeout) {
    lastValue = await predicate();
    if (lastValue) {
      return lastValue;
    }
    await wait(interval);
  }

  assert.fail(`${message}; last value: ${JSON.stringify(lastValue)}`);
};

const uniqueId = (prefix) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

const destroyJobs = (...jobs) => {
  for (const job of jobs.flat().filter(Boolean)) {
    if (typeof job.destroy === 'function' && !job.isDestroyed) {
      job.destroy();
    }
  }
};

const closeMongoClient = async (client) => {
  if (client && typeof client.close === 'function') {
    await client.close().catch(() => {});
  }
};

const quitRedisClient = async (client) => {
  if (!client) {
    return;
  }

  if (client.isOpen && typeof client.quit === 'function') {
    await client.quit().catch(async () => {
      if (typeof client.disconnect === 'function') {
        await client.disconnect();
      }
    });
    return;
  }

  if (typeof client.disconnect === 'function') {
    await client.disconnect().catch(() => {});
  }
};

export {
  closeMongoClient,
  destroyJobs,
  quitRedisClient,
  uniqueId,
  wait,
  waitUntil
};
