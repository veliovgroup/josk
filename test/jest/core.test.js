import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';

import { JoSk } from '../../index.js';

class FakeAdapter {
  constructor(opts = {}) {
    this.acquireResult = opts.acquireResult ?? true;
    this.iterateResult = opts.iterateResult ?? 0;
    this.readyPromise = opts.readyPromise || Promise.resolve();
    this.addCalls = [];
    this.removeCalls = [];
    this.updateCalls = [];
    this.iterateCalls = [];
    this.acquireCalls = [];
    this.releaseCalls = [];
    this.readyCalls = 0;
    this.stored = new Map();
  }

  async ready() {
    this.readyCalls++;
    return await this.readyPromise;
  }

  async ping() {
    await this.ready();
    return {
      status: 'OK',
      code: 200,
      statusCode: 200
    };
  }

  async acquireLock(lock) {
    this.acquireCalls.push(lock);
    return this.acquireResult;
  }

  async releaseLock(lock) {
    this.releaseCalls.push(lock);
  }

  async remove(uid) {
    this.removeCalls.push(uid);
    return this.stored.delete(uid);
  }

  async add(uid, isInterval, delay) {
    this.addCalls.push({ uid, isInterval, delay });
    this.stored.set(uid, {
      uid,
      isInterval,
      delay,
      isDeleted: false
    });
    return true;
  }

  async update(task, nextExecuteAt) {
    this.updateCalls.push({ task, nextExecuteAt });
    return true;
  }

  async iterate(nextExecuteAt, lock, executeMode) {
    this.iterateCalls.push({ nextExecuteAt, lock, executeMode });
    if (this.iterateImpl) {
      return await this.iterateImpl(nextExecuteAt, lock, executeMode);
    }
    return this.iterateResult;
  }
}

const jobs = new Set();

const createJob = (opts = {}, adapter = new FakeAdapter()) => {
  const job = new JoSk({
    adapter,
    minRevolvingDelay: 1,
    maxRevolvingDelay: 1,
    ...opts
  });
  jobs.add(job);
  return { job, adapter };
};

describe('JoSk core', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    for (const job of jobs) {
      job.destroy();
    }
    jobs.clear();
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('validates constructor adapter and execute mode', () => {
    expect(() => new JoSk()).toThrow('{adapter} option is required for JoSk');
    expect(() => new JoSk({ adapter: new FakeAdapter(), execute: 'bad' })).toThrow('[josk] [execute] option must be either "batch" or "one"!');
    expect(() => new JoSk({
      adapter: {
        acquireLock: async () => true,
        releaseLock: async () => {},
        remove: async () => true,
        add: async () => true,
        update: async () => true,
        iterate: async () => 0
      }
    })).toThrow('{adapter} instance is missing {ping} method that is required!');
  });

  it('validates scheduler method arguments', async () => {
    const { job } = createJob();

    await expect(job.setTimeout(null, 1, 'x')).rejects.toThrow('[josk] [setTimeout] the first argument must be a function!');
    await expect(job.setTimeout(() => {}, -1, 'x')).rejects.toThrow('[josk] [setTimeout] delay must be positive Number!');
    await expect(job.setTimeout(() => {}, 1)).rejects.toThrow('[josk] [setTimeout] [uid - task id must be specified (3rd argument)]');
    await expect(job.setInterval(null, 1, 'x')).rejects.toThrow('[josk] [setInterval] the first argument must be a function!');
    await expect(job.setInterval(() => {}, -1, 'x')).rejects.toThrow('[josk] [setInterval] delay must be positive Number!');
    await expect(job.setInterval(() => {}, 1)).rejects.toThrow('[josk] [setInterval] [uid - task id must be specified (3rd argument)]');
    await expect(job.setImmediate(null, 'x')).rejects.toThrow('[josk] [setImmediate] the first argument must be a function!');
    await expect(job.setImmediate(() => {})).rejects.toThrow('[josk] [setImmediate] [uid - task id must be specified (2nd argument)]');
  });

  it('adds timeout, interval, and immediate tasks with stable ids', async () => {
    const { job, adapter } = createJob();

    await expect(job.setTimeout(() => {}, 20, 'timeout')).resolves.toBe('timeoutsetTimeout');
    await expect(job.setInterval(() => {}, 30, 'interval')).resolves.toBe('intervalsetInterval');
    await expect(job.setImmediate(() => {}, 'immediate')).resolves.toBe('immediatesetImmediate');

    expect(adapter.addCalls).toEqual([{
      uid: 'timeoutsetTimeout',
      isInterval: false,
      delay: 20
    }, {
      uid: 'intervalsetInterval',
      isInterval: true,
      delay: 30
    }, {
      uid: 'immediatesetImmediate',
      isInterval: false,
      delay: 0
    }]);
  });

  it('clears timer ids and promise timer ids', async () => {
    const { job, adapter } = createJob();
    adapter.stored.set('timeoutsetTimeout', {});
    adapter.stored.set('intervalsetInterval', {});

    await expect(job.clearTimeout(Promise.resolve('timeoutsetTimeout'))).resolves.toBe(true);
    await expect(job.clearInterval('intervalsetInterval')).resolves.toBe(true);
    await expect(job.clearTimeout(null)).resolves.toBe(false);

    expect(adapter.removeCalls).toEqual(['timeoutsetTimeout', 'intervalsetInterval']);
  });

  it('caches adapter ready promise across storage operations', async () => {
    const { job, adapter } = createJob();

    await job.setTimeout(() => {}, 1, 'ready-timeout');
    await job.clearTimeout('ready-timeoutsetTimeout');
    await job.setInterval(() => {}, 1, 'ready-interval');

    expect(adapter.readyCalls).toBe(1);
  });

  it('acquires scheduler lock, iterates with selected mode, and releases same lease', async () => {
    const { job, adapter } = createJob({
      execute: 'one',
      lockOwnerId: 'owner-a',
      zombieTime: 5000
    });

    await job.__iterate();

    expect(adapter.acquireCalls).toHaveLength(1);
    expect(adapter.iterateCalls).toHaveLength(1);
    expect(adapter.releaseCalls).toEqual(adapter.acquireCalls);
    expect(adapter.iterateCalls[0].executeMode).toBe('one');
    expect(adapter.iterateCalls[0].lock.ownerId).toBe('owner-a');
    expect(adapter.iterateCalls[0].nextExecuteAt).toBeInstanceOf(Date);
  });

  it('does not iterate or release when scheduler lock is unavailable', async () => {
    const { job, adapter } = createJob({}, new FakeAdapter({
      acquireResult: false
    }));

    await job.__iterate();

    expect(adapter.acquireCalls).toHaveLength(1);
    expect(adapter.iterateCalls).toHaveLength(0);
    expect(adapter.releaseCalls).toHaveLength(0);
  });

  it('routes iterate failures through onError and still releases lock', async () => {
    const error = new Error('iterate failed');
    const errors = [];
    const { job, adapter } = createJob({
      onError(title, details) {
        errors.push({ title, details });
      }
    });
    adapter.iterateImpl = async () => {
      throw error;
    };

    await job.__iterate();

    expect(errors[0].title).toBe('[__iterate] runError:');
    expect(errors[0].details.error).toBe(error);
    expect(adapter.releaseCalls).toHaveLength(1);
  });

  it('destroys once and blocks future task registration', async () => {
    const errors = [];
    const { job, adapter } = createJob({
      onError(title, details) {
        errors.push({ title, details });
      }
    });

    expect(job.destroy()).toBe(true);
    expect(job.destroy()).toBe(false);
    await expect(job.setTimeout(() => {}, 1, 'destroyed')).resolves.toBe('');

    expect(adapter.addCalls).toHaveLength(0);
    expect(errors[0].title).toBe('JoSk instance destroyed');
  });

  it('executes timeout after removing storage record and emits onExecuted', async () => {
    const executed = [];
    const { job, adapter } = createJob({
      onExecuted(uid, details) {
        executed.push({ uid, details });
      }
    });
    const task = {
      uid: 'mailsetTimeout',
      delay: 10,
      isInterval: false,
      isDeleted: false
    };
    const handler = jest.fn((ready) => {
      ready();
    });
    adapter.stored.set(task.uid, task);
    job.tasks[task.uid] = handler;

    await job.__execute(task);

    expect(adapter.removeCalls).toEqual([task.uid]);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(executed[0].uid).toBe('mail');
    expect(executed[0].details.uid).toBe(task.uid);
    expect(executed[0].details.date).toBeInstanceOf(Date);
  });

  it('reschedules interval with custom Date from ready()', async () => {
    const { job, adapter } = createJob();
    const next = new Date(Date.now() + 5000);
    const task = {
      uid: 'pollsetInterval',
      delay: 100,
      isInterval: true,
      isDeleted: false
    };
    job.tasks[task.uid] = (ready) => {
      ready(next);
    };

    await job.__execute(task);

    expect(adapter.updateCalls).toHaveLength(1);
    expect(adapter.updateCalls[0].task).toBe(task);
    expect(adapter.updateCalls[0].nextExecuteAt).toBe(next);
  });

  it('resolves returned promises with implicit ready() for intervals', async () => {
    const { job, adapter } = createJob();
    const task = {
      uid: 'asyncsetInterval',
      delay: 250,
      isInterval: true,
      isDeleted: false
    };
    job.tasks[task.uid] = async () => true;

    await job.__execute(task);

    expect(adapter.updateCalls).toHaveLength(1);
    expect(+adapter.updateCalls[0].nextExecuteAt).toBeGreaterThanOrEqual(Date.now() + task.delay);
  });

  it('handles task exceptions through onError and reschedules interval zombies', async () => {
    const taskError = new Error('boom');
    const errors = [];
    const { job, adapter } = createJob({
      onError(title, details) {
        errors.push({ title, details });
      }
    });
    const task = {
      uid: 'failsetInterval',
      delay: 250,
      isInterval: true,
      isDeleted: false
    };
    job.tasks[task.uid] = async () => {
      throw taskError;
    };

    await job.__execute(task);

    expect(errors[0].title).toBe('Exception during task execution');
    expect(errors[0].details.error).toBe(taskError);
    expect(adapter.updateCalls).toHaveLength(1);
  });

  it('reports overspecified ready resolution to callback', async () => {
    let callbackError;
    let callbackResult;
    const { job, adapter } = createJob();
    const task = {
      uid: 'overspecifiedsetTimeout',
      delay: 1,
      isInterval: false,
      isDeleted: false
    };
    adapter.stored.set(task.uid, task);
    job.tasks[task.uid] = async (ready) => {
      await ready();
      return await ready((error, result) => {
        callbackError = error;
        callbackResult = result;
      });
    };

    await job.__execute(task);

    expect(callbackError).toBeInstanceOf(Error);
    expect(callbackError.message).toContain('Resolution method is overspecified');
    expect(callbackResult).toBe(false);
  });

  it('updates and auto-clears missing tasks', async () => {
    const { job, adapter } = createJob({
      autoClear: true
    });
    const task = {
      uid: 'missingsetInterval',
      delay: 100,
      isInterval: true,
      isDeleted: false
    };
    adapter.stored.set(task.uid, task);

    await job.__execute(task);

    expect(adapter.updateCalls).toHaveLength(1);
    expect(adapter.removeCalls).toEqual([task.uid]);
    expect(job.tasks[task.uid]).toBeUndefined();
  });

  it('reports missing tasks when autoClear is disabled', async () => {
    const errors = [];
    const { job, adapter } = createJob({
      autoClear: false,
      onError(title, details) {
        errors.push({ title, details });
      }
    });
    const task = {
      uid: 'missing-errorsetInterval',
      delay: 100,
      isInterval: true,
      isDeleted: false
    };

    await job.__execute(task);

    expect(adapter.updateCalls).toHaveLength(1);
    expect(errors[0].title).toBe('One of your tasks is missing');
    expect(errors[0].details.uid).toBe(task.uid);
  });
});
