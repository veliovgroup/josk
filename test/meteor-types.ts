import { MongoInternals } from 'meteor/mongo';
import { assert } from 'chai';
import { JoSk, MongoAdapter } from 'meteor/ostrio:cron-jobs';
import type {
  JoSkAdapter,
  JoSkExecuteMode,
  JoSkLock,
  JoSkOnError,
  JoSkOnExecuted,
  JoSkOption,
  JoSkPingResult,
  JoSkReady,
  JoSkTask,
  JoSkTaskHandler
} from 'meteor/ostrio:cron-jobs';

const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;

let typedJobs: JoSk | undefined;

after(function () {
  if (typedJobs && !typedJobs.isDestroyed) {
    typedJobs.destroy();
  }
});

describe('Meteor TypeScript — types compile-time checks', () => {
  it('Built-in adapters satisfy JoSkAdapter contract', () => {
    type _MongoAdapterIsJoSkAdapter = MongoAdapter extends JoSkAdapter ? true : never;
    const _mongoOk: _MongoAdapterIsJoSkAdapter = true;
    assert.equal(_mongoOk, true, 'MongoAdapter assignable to JoSkAdapter');
  });

  it('Hook aliases accept sync and async signatures', () => {
    const onErrorSync: JoSkOnError = (_title, _details) => { void _title; void _details; };
    const onErrorAsync: JoSkOnError = async (_title, _details) => { void _title; void _details; };
    const onExecutedSync: JoSkOnExecuted = (_uid, _details) => { void _uid; void _details; };
    const onExecutedAsync: JoSkOnExecuted = async (_uid, _details) => { void _uid; void _details; };

    assert.isFunction(onErrorSync, 'onErrorSync is function');
    assert.isFunction(onErrorAsync, 'onErrorAsync is function');
    assert.isFunction(onExecutedSync, 'onExecutedSync is function');
    assert.isFunction(onExecutedAsync, 'onExecutedAsync is function');
  });

  it('Structural types export shape correctly', () => {
    const lock: JoSkLock = {
      ownerId: 'owner',
      leaseId: 'lease',
      expireAt: new Date(),
      expiresAtMs: Date.now()
    };
    const task: JoSkTask = {
      uid: 'task-uid',
      delay: 1024,
      isInterval: false,
      isDeleted: false
    };
    const execute: JoSkExecuteMode = 'one';

    assert.isString(lock.ownerId, 'lock.ownerId is string');
    assert.isString(task.uid, 'task.uid is string');
    assert.oneOf(execute, ['one', 'batch'], 'execute mode is valid');
  });
});

describe('Meteor TypeScript — runtime', function () {
  this.slow(8192);
  this.timeout(12288);

  it('Constructs JoSk with typed options and exposes typed API', async function () {
    const onError: JoSkOnError = (title, details) => {
      void title;
      void details;
    };
    const onExecuted: JoSkOnExecuted = (uid, details) => {
      void uid;
      void details;
    };

    const opts: JoSkOption = {
      adapter: new MongoAdapter({
        db,
        prefix: 'testCaseMeteorTs',
        resetOnInit: true
      }),
      execute: 'one',
      minRevolvingDelay: 32,
      maxRevolvingDelay: 256,
      zombieTime: 8000,
      autoClear: true,
      onError,
      onExecuted
    };

    typedJobs = new JoSk(opts);
    assert.instanceOf(typedJobs, JoSk, 'typedJobs is JoSk');
    assert.instanceOf(typedJobs.adapter, MongoAdapter, 'adapter is MongoAdapter');

    const pingRes: JoSkPingResult = await typedJobs.ping();
    assert.equal(pingRes.status, 'OK', 'ping.status');
    assert.equal(pingRes.code, 200, 'ping.code');
    assert.equal(pingRes.statusCode, 200, 'ping.statusCode');
  });

  it('setImmediate runs typed handler', function (done) {
    if (!typedJobs) {
      assert.fail('typedJobs not initialized');
      return;
    }

    const handler: JoSkTaskHandler = (ready: JoSkReady) => {
      void ready();
      done();
    };

    typedJobs.setImmediate(handler, 'ts-immediate-task');
  });

  it('setTimeout/setInterval return Promise<string>', async function () {
    if (!typedJobs) {
      assert.fail('typedJobs not initialized');
      return;
    }

    const valuePromiseHandler: JoSkTaskHandler = async () => true;
    const timeoutId: string = await typedJobs.setTimeout(() => {}, 2048, 'ts-timeout-task');
    const intervalId: string = await typedJobs.setInterval(valuePromiseHandler, 2048, 'ts-interval-task');

    assert.isString(timeoutId, 'setTimeout returns string id');
    assert.isString(intervalId, 'setInterval returns string id');

    const cleared1: boolean = await typedJobs.clearTimeout(timeoutId);
    const cleared2: boolean = await typedJobs.clearInterval(intervalId);
    assert.isBoolean(cleared1, 'clearTimeout returns boolean');
    assert.isBoolean(cleared2, 'clearInterval returns boolean');

    assert.equal(typedJobs.pause(), true, 'pause() returns boolean');
    assert.equal(typedJobs.pause(intervalId), true, 'pause(timerId) returns boolean');
    assert.equal(typedJobs.resume(intervalId), true, 'resume(timerId) returns boolean');
    assert.equal(typedJobs.resume(), true, 'resume() returns boolean');
  });
});
