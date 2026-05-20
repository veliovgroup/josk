const testApi = typeof globalThis.Bun === 'undefined'
  ? await import('@jest/globals')
  : await import('bun:test');
const { afterEach, beforeEach, describe, expect, it, jest } = testApi;

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
    expect(() => new JoSk({ adapter: new FakeAdapter(), concurrency: 0 })).toThrow('[josk] [concurrency] option must be a positive integer or Infinity');
    expect(() => new JoSk({ adapter: new FakeAdapter(), concurrency: 1.5 })).toThrow('[josk] [concurrency] option must be a positive integer or Infinity');
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

  it('uses crypto.randomUUID for lockOwnerId and lease tokens', () => {
    const { job } = createJob();
    expect(job.lockOwnerId).toMatch(/^josk-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    const lock = job.__getLock();
    expect(lock.leaseId).toContain(job.lockOwnerId);
    expect(lock.leaseId).toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('auto-calls ready() for sync handlers with zero arity', async () => {
    const { job, adapter } = createJob();
    const task = {
      uid: 'sync-no-readysetInterval',
      delay: 100,
      isInterval: true,
      isDeleted: false
    };
    let invoked = false;
    job.tasks[task.uid] = () => {
      invoked = true;
    };

    await job.__doExecute(task);

    expect(invoked).toBe(true);
    expect(adapter.updateCalls).toHaveLength(1);
    expect(+adapter.updateCalls[0].nextExecuteAt).toBeGreaterThanOrEqual(Date.now() + task.delay - 5);
  });

  it('skips auto-ready when handler declares ready param but never calls it', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    const { job, adapter } = createJob({ debug: true });
    const task = {
      uid: 'sync-with-readysetInterval',
      delay: 100,
      isInterval: true,
      isDeleted: false
    };
    job.tasks[task.uid] = (_ready) => {
      // declared ready but never invoked it
    };

    await job.__doExecute(task);

    expect(adapter.updateCalls).toHaveLength(0);
    expect(info).toHaveBeenCalled();
    info.mockRestore();
  });

  it('throttles concurrent executions when concurrency is set', async () => {
    const { job } = createJob({ concurrency: 2 });
    let active = 0;
    let peak = 0;
    const finishers = [];
    const handler = () => new Promise((resolve) => {
      active++;
      peak = Math.max(peak, active);
      finishers.push(() => {
        active--;
        resolve();
      });
    });

    const tasks = ['a', 'b', 'c', 'd', 'e'].map((id) => ({
      uid: `${id}setInterval`,
      delay: 100,
      isInterval: true,
      isDeleted: false
    }));

    const pending = [];
    for (const task of tasks) {
      job.tasks[task.uid] = handler;
      pending.push(job.__execute(task));
    }

    // Allow microtasks to settle so the first two handlers attach
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
    }
    expect(active).toBe(2);

    while (finishers.length > 0) {
      finishers.shift()();
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
      }
    }

    await Promise.all(pending);
    expect(peak).toBe(2);
  });

  it('validates scheduler method arguments', async () => {
    const { job } = createJob();

    await expect(job.setTimeout(null, 1, 'x')).rejects.toThrow('[josk] [setTimeout] the first argument must be a function!');
    await expect(job.setTimeout(() => {}, -1, 'x')).rejects.toThrow('[josk] [setTimeout] delay must be a finite non-negative Number!');
    await expect(job.setTimeout(() => {}, NaN, 'x')).rejects.toThrow('[josk] [setTimeout] delay must be a finite non-negative Number!');
    await expect(job.setTimeout(() => {}, Infinity, 'x')).rejects.toThrow('[josk] [setTimeout] delay must be a finite non-negative Number!');
    await expect(job.setTimeout(() => {}, '1', 'x')).rejects.toThrow('[josk] [setTimeout] delay must be a finite non-negative Number!');
    await expect(job.setTimeout(() => {}, 1)).rejects.toThrow('[josk] [setTimeout] uid (3rd argument) must be a string');
    await expect(job.setInterval(null, 1, 'x')).rejects.toThrow('[josk] [setInterval] the first argument must be a function!');
    await expect(job.setInterval(() => {}, -1, 'x')).rejects.toThrow('[josk] [setInterval] delay must be a finite non-negative Number!');
    await expect(job.setInterval(() => {}, NaN, 'x')).rejects.toThrow('[josk] [setInterval] delay must be a finite non-negative Number!');
    await expect(job.setInterval(() => {}, Infinity, 'x')).rejects.toThrow('[josk] [setInterval] delay must be a finite non-negative Number!');
    await expect(job.setInterval(() => {}, '1', 'x')).rejects.toThrow('[josk] [setInterval] delay must be a finite non-negative Number!');
    await expect(job.setInterval(() => {}, 1)).rejects.toThrow('[josk] [setInterval] uid (3rd argument) must be a string');
    await expect(job.setImmediate(null, 'x')).rejects.toThrow('[josk] [setImmediate] the first argument must be a function!');
    await expect(job.setImmediate(() => {})).rejects.toThrow('[josk] [setImmediate] uid (2nd argument) must be a string');
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

  it('pings storage after adapter readiness', async () => {
    const { job } = createJob();

    await expect(job.ping()).resolves.toEqual({
      status: 'OK',
      code: 200,
      statusCode: 200
    });
  });

  it('supports adapters without ready hook', async () => {
    const adapter = {
      acquireLock: async () => true,
      releaseLock: async () => {},
      remove: async () => true,
      add: async () => true,
      update: async () => true,
      iterate: async () => 0,
      ping: async () => ({
        status: 'OK',
        code: 200,
        statusCode: 200
      })
    };
    const { job } = createJob({}, adapter);

    await expect(job.__adapterReady()).resolves.toBeUndefined();
  });

  it('returns empty ids from destroyed interval and immediate registration', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    const { job, adapter } = createJob({
      debug: true
    });

    job.destroy();

    await expect(job.setInterval(() => {}, 1, 'destroyed-interval')).resolves.toBe('');
    await expect(job.setImmediate(() => {}, 'destroyed-immediate')).resolves.toBe('');

    expect(adapter.addCalls).toHaveLength(0);
    expect(info).toHaveBeenCalled();
    info.mockRestore();
  });

  it('clears interval promise ids', async () => {
    const { job, adapter } = createJob();
    adapter.stored.set('promise-intervalsetInterval', {});

    await expect(job.clearInterval(Promise.resolve('promise-intervalsetInterval'))).resolves.toBe(true);

    expect(adapter.removeCalls).toEqual(['promise-intervalsetInterval']);
  });

  it('skips private add when destroyed', async () => {
    const { job, adapter } = createJob();

    job.destroy();
    await job.__add('destroyed-add', false, 1);

    expect(adapter.addCalls).toHaveLength(0);
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

  it('routes release lock failures through onError', async () => {
    const error = new Error('release failed');
    const errors = [];
    const { job, adapter } = createJob({
      onError(title, details) {
        errors.push({ title, details });
      }
    });
    adapter.releaseLock = async () => {
      throw error;
    };

    await job.__iterate();

    expect(errors[0].title).toBe('[__iterate] [releaseLock] releaseError:');
    expect(errors[0].details.error).toBe(error);
  });

  it('skips iterate and tick after destruction', async () => {
    const { job, adapter } = createJob();

    job.destroy();
    await job.__iterate();
    job.__tick();

    expect(adapter.acquireCalls).toHaveLength(0);
    expect(job.nextRevolutionTimeout).toBeNull();
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

  it('skips deleted and already-missing tasks', async () => {
    const { job, adapter } = createJob();
    const deleted = {
      uid: 'deletedsetTimeout',
      delay: 1,
      isInterval: false,
      isDeleted: true
    };
    const missing = {
      uid: 'missing-marksetInterval',
      delay: 1,
      isInterval: true,
      isDeleted: false
    };
    job.tasks[missing.uid] = () => {};
    job.tasks[missing.uid].isMissing = true;

    await job.__execute(deleted);
    await job.__execute(missing);

    expect(adapter.updateCalls).toHaveLength(0);
  });

  it('debugs malformed tasks when onError is absent', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    const { job } = createJob({
      debug: true
    });

    await job.__execute(null);

    expect(info).toHaveBeenCalledWith('[DEBUG] [josk]', '[__execute] received malformed task', null);
    info.mockRestore();
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

  it('reschedules interval with timestamp and callback ready values', async () => {
    let callbackError;
    let callbackResult;
    const { job, adapter } = createJob();
    const timestamp = Date.now() + 5000;
    const timestampTask = {
      uid: 'timestamp-readysetInterval',
      delay: 100,
      isInterval: true,
      isDeleted: false
    };
    const callbackTask = {
      uid: 'callback-readysetInterval',
      delay: 100,
      isInterval: true,
      isDeleted: false
    };
    job.tasks[timestampTask.uid] = (ready) => {
      ready(timestamp);
    };
    job.tasks[callbackTask.uid] = (ready) => {
      ready((error, result) => {
        callbackError = error;
        callbackResult = result;
      });
    };

    await job.__execute(timestampTask);
    await job.__execute(callbackTask);

    expect(+adapter.updateCalls[0].nextExecuteAt).toBe(timestamp);
    expect(callbackError).toBeUndefined();
    expect(callbackResult).toBe(true);
    expect(adapter.updateCalls).toHaveLength(2);
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

  it('waits for returned thenables before implicit ready()', async () => {
    const { job, adapter } = createJob();
    const task = {
      uid: 'thenablesetInterval',
      delay: 250,
      isInterval: true,
      isDeleted: false
    };
    let thenableResolved = false;
    let updateSawResolved = false;
    adapter.update = async (...args) => {
      updateSawResolved = thenableResolved;
      return await FakeAdapter.prototype.update.call(adapter, ...args);
    };
    job.tasks[task.uid] = () => ({
      then(resolve) {
        Promise.resolve().then(() => {
          thenableResolved = true;
          resolve();
        });
      }
    });

    await job.__execute(task);

    expect(thenableResolved).toBe(true);
    expect(updateSawResolved).toBe(true);
    expect(adapter.updateCalls).toHaveLength(1);
  });

  it('isolates hook failures from task completion flow', async () => {
    const hookError = new Error('hook failed');
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { job, adapter } = createJob({
        onError() {
          return Promise.reject(hookError);
        },
        onExecuted() {
          throw hookError;
        }
      });
      const task = {
        uid: 'hooksetInterval',
        delay: 250,
        isInterval: true,
        isDeleted: false
      };
      job.tasks[task.uid] = () => {};

      await expect(job.__execute(task)).resolves.toBeUndefined();
      job.__errorHandler(new Error('internal'), 'Internal title', 'Internal description', task.uid);
      await Promise.resolve();

      expect(adapter.updateCalls).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('routes rejected thenables through onError and swallows hook rejections', async () => {
    const taskError = new Error('thenable rejected');
    const hookError = new Error('hook rejected');
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const onErrorCalls = [];
    try {
      const { job, adapter } = createJob({
        onError(title, details) {
          onErrorCalls.push({ title, details });
          return Promise.reject(hookError);
        }
      });
      const task = {
        uid: 'rejectedThenablesetInterval',
        delay: 250,
        isInterval: true,
        isDeleted: false
      };
      job.tasks[task.uid] = () => ({
        then(_resolve, reject) {
          Promise.resolve().then(() => reject(taskError));
        }
      });

      await expect(job.__execute(task)).resolves.toBeUndefined();
      await Promise.resolve();
      await Promise.resolve();

      expect(onErrorCalls).toHaveLength(1);
      expect(onErrorCalls[0].title).toBe('Exception during task execution');
      expect(onErrorCalls[0].details.error).toBe(taskError);
      expect(adapter.updateCalls).toHaveLength(1);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
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

  it('debugs remove failures while executing timeout tasks', async () => {
    const removeError = new Error('remove failed');
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    const { job, adapter } = createJob({
      debug: true
    });
    const task = {
      uid: 'remove-failsetTimeout',
      delay: 1,
      isInterval: false,
      isDeleted: false
    };
    job.tasks[task.uid] = jest.fn();
    adapter.remove = async () => {
      throw removeError;
    };

    await job.__execute(task);

    expect(job.tasks[task.uid]).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith('[DEBUG] [josk]', `[${task.uid}] [__execute] [__remove] has thrown an exception; Check connection with StorageAdapter; removeError:`, removeError);
    info.mockRestore();
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

  it('debugs autoClear remove failures for missing tasks', async () => {
    const removeError = new Error('auto clear failed');
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    const { job, adapter } = createJob({
      autoClear: true,
      debug: true
    });
    const task = {
      uid: 'auto-clear-failsetInterval',
      delay: 100,
      isInterval: true,
      isDeleted: false
    };
    adapter.remove = async () => {
      throw removeError;
    };

    await job.__execute(task);

    expect(adapter.updateCalls).toHaveLength(1);
    expect(info).toHaveBeenCalledWith('[DEBUG] [josk]', `[${task.uid}] [__execute] [this.autoClear] [__remove] has thrown an exception; removeError:`, removeError);
    info.mockRestore();
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

  it('debugs missing tasks when autoClear and onError are disabled', async () => {
    const info = jest.spyOn(console, 'info').mockImplementation(() => {});
    const { job, adapter } = createJob({
      debug: true
    });
    const task = {
      uid: 'missing-debugsetInterval',
      delay: 100,
      isInterval: true,
      isDeleted: false
    };

    await job.__execute(task);

    expect(adapter.updateCalls).toHaveLength(1);
    expect(info).toHaveBeenCalled();
    info.mockRestore();
  });

  it('logs internal errors when onError is absent', () => {
    const error = new Error('internal');
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { job } = createJob();

    job.__errorHandler(error, 'Internal title', 'Internal description', 'internal-id');

    expect(errorSpy).toHaveBeenCalledWith('Internal title', {
      description: 'Internal description',
      error,
      uid: 'internal-id'
    });
    errorSpy.mockRestore();
  });

  it('recovers across ticks when acquireLock transiently fails', async () => {
    let failureCount = 2;
    const adapter = new FakeAdapter();
    adapter.acquireLock = jest.fn(async (lock) => {
      adapter.acquireCalls.push(lock);
      if (failureCount > 0) {
        failureCount--;
        throw new Error('transient connection loss');
      }
      return true;
    });
    const errors = [];
    const { job } = createJob({
      onError(title, details) {
        errors.push({ title, details });
      }
    }, adapter);

    await job.__iterate();
    await job.__iterate();
    await job.__iterate();

    expect(adapter.acquireCalls.length).toBe(3);
    expect(adapter.iterateCalls.length).toBe(1);
    expect(errors.length).toBe(2);
  });

  it('keeps lock owner stable across ticks within the same instance', () => {
    const { job } = createJob({ lockOwnerId: 'fixed-owner' });
    const first = job.__getLock();
    const second = job.__getLock();
    expect(first.ownerId).toBe('fixed-owner');
    expect(second.ownerId).toBe('fixed-owner');
    expect(first.leaseId).not.toBe(second.leaseId);
  });

  it('clears placeholder when missing task is later removed via autoClear', async () => {
    const { job, adapter } = createJob({ autoClear: true });
    const task = {
      uid: 'placeholder-evictsetInterval',
      delay: 100,
      isInterval: true,
      isDeleted: false
    };
    adapter.stored.set(task.uid, task);

    await job.__doExecute(task);

    expect(job.tasks[task.uid]).toBeUndefined();
    expect(adapter.removeCalls).toContain(task.uid);
  });
});

describe('pause/resume', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('global pause skips acquireLock until resume', async () => {
    const { job, adapter } = createJob();
    expect(job.pause()).toBe(true);
    expect(job.pause()).toBe(false);

    jest.advanceTimersByTime(5);
    await Promise.resolve();

    expect(adapter.acquireCalls).toHaveLength(0);

    expect(job.resume()).toBe(true);
    expect(job.resume()).toBe(false);

    await job.__iterate();
    await Promise.resolve();

    expect(adapter.acquireCalls.length).toBeGreaterThan(0);
  });

  it('per-timer pause defers claimed interval without running handler', async () => {
    const { job, adapter } = createJob();
    let ran = false;

    const timerId = await job.setInterval(() => {
      ran = true;
    }, 5000, 'paused-task');

    adapter.iterateImpl = async () => {
      job.__execute({
        uid: timerId,
        delay: 5000,
        isInterval: true,
        isDeleted: false
      });
      return 1;
    };

    expect(job.pause(timerId)).toBe(true);

    await job.__iterate();
    await Promise.resolve();

    expect(ran).toBe(false);
    expect(adapter.updateCalls).toHaveLength(1);
    expect(adapter.updateCalls[0].task.uid).toBe(timerId);
    expect(+adapter.updateCalls[0].nextExecuteAt).toBeGreaterThan(Date.now() - 100);
  });

  it('resume(timerId) allows handler after claim', async () => {
    const { job, adapter } = createJob();
    let ran = false;

    const timerId = await job.setInterval(() => {
      ran = true;
    }, 5000, 'resume-task');

    job.pause(timerId);
    expect(job.resume(timerId)).toBe(true);
    expect(job.resume(timerId)).toBe(false);

    adapter.iterateImpl = async () => {
      job.__execute({
        uid: timerId,
        delay: 5000,
        isInterval: true,
        isDeleted: false
      });
      return 1;
    };

    await job.__iterate();
    await Promise.resolve();
    await Promise.resolve();

    expect(ran).toBe(true);
  });

  it('pause throws on invalid timerId type', () => {
    const { job } = createJob();
    expect(() => job.pause(1)).toThrow('[josk] [pause] timerId must be a non-empty string');
  });

  it('pause throws when timerId is not from set*', () => {
    const { job } = createJob();
    expect(() => job.pause('poll-1m')).toThrow('[josk] [pause] timerId must be the string returned from setInterval, setTimeout, or setImmediate');
  });

  it('destroy clears pause state', async () => {
    const { job } = createJob();
    const timerId = await job.setInterval(() => {}, 5000, 'x');
    job.pause();
    job.pause(timerId);
    job.destroy();
    expect(job.resume()).toBe(false);
    expect(job.resume(timerId)).toBe(false);
  });
});
