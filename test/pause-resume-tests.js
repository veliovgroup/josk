import { assert } from 'chai';
import { destroyJobs, uniqueId, wait, waitUntil } from './helpers.js';

/** @type {import('../index.js').JoSkTaskHandler} */
const readyOnly = async (ready) => {
  await ready();
};

/** JoSk integration tests use ≥2048 ms task delay (storage + revolving jitter). */
const TASK_DELAY = 2048;

/**
 * @param {string} label
 * @param {{
 *   createJob: (prefix: string, resetOnInit: boolean) => import('../index.js').JoSk,
 *   initCounter: (prefix: string) => Promise<{
 *     incA: () => Promise<unknown>,
 *     incB: () => Promise<unknown>,
 *     incRuns: () => Promise<unknown>,
 *     incProcessed: () => Promise<unknown>,
 *     read: () => Promise<{ runsA: number, runsB: number, runs: number, processed: number }>,
 *     cleanup: () => Promise<unknown>
 *   }>
 * }} hooks
 */
export const registerPauseResumeTests = (label, hooks) => {
  const { createJob, initCounter } = hooks;
  const msg = (part) => `${label} pause/${part}`;

  describe(`${label} - pause/resume`, function () {
    this.slow(12000);
    this.timeout(20000);

    it('pause()/resume() return boolean state', function () {
      const prefix = uniqueId('pause-api');
      const job = createJob(prefix, true);
      try {
        assert.equal(job.pause(), true);
        assert.equal(job.pause(), false);
        assert.equal(job.resume(), true);
        assert.equal(job.resume(), false);
      } finally {
        destroyJobs(job);
      }
    });

    it('pause(timerId) rejects bare uid', async function () {
      const prefix = uniqueId('pause-bare-uid');
      const job = createJob(prefix, true);
      try {
        await job.setInterval(() => {}, TASK_DELAY, 'pause-bare-uid');
        assert.throws(
          () => job.pause('pause-bare-uid'),
          /timerId must be the string returned from setInterval, setTimeout, or setImmediate/
        );
      } finally {
        destroyJobs(job);
      }
    });

    it('global pause() stops this instance while peer keeps executing', async function () {
      const prefix = uniqueId('pause-global');
      const counter = await initCounter(prefix);
      const jobA = createJob(prefix, true);
      const jobB = createJob(prefix, false);
      const uidA = 'pause-global-a';
      const uidB = 'pause-global-b';

      try {
        await jobA.setInterval(async (ready) => {
          await counter.incA();
          await ready();
        }, TASK_DELAY, uidA);
        await jobA.setInterval(readyOnly, TASK_DELAY, uidB);

        await jobB.setInterval(readyOnly, TASK_DELAY, uidA);
        await jobB.setInterval(async (ready) => {
          await counter.incB();
          await ready();
        }, TASK_DELAY, uidB);

        await waitUntil(async () => {
          const v = await counter.read();
          return v.runsA >= 1 && v.runsB >= 1;
        }, { timeout: 12000, message: msg('global: both instances did not run before pause') });

        const before = await counter.read();
        assert.equal(jobA.pause(), true);

        await waitUntil(async () => {
          const mid = await counter.read();
          return mid.runsB > before.runsB && mid.runsA === before.runsA;
        }, {
          timeout: 8000,
          message: msg('global: peer should run while jobA paused')
        });

        assert.equal(jobA.resume(), true);
        await waitUntil(async () => {
          const v = await counter.read();
          return v.runsA > before.runsA;
        }, { timeout: 12000, message: msg('global: jobA did not resume competing') });
      } finally {
        destroyJobs(jobA, jobB);
        await counter.cleanup();
      }
    });

    it('pause(timerId) defers on this instance while peer executes shared interval', async function () {
      const prefix = uniqueId('pause-per-task');
      const counter = await initCounter(prefix);
      const jobA = createJob(prefix, true);
      const jobB = createJob(prefix, false);
      const sharedUid = 'pause-per-task-shared';

      try {
        const timerIdA = await jobA.setInterval(async (ready) => {
          await counter.incRuns();
          await ready();
        }, TASK_DELAY, sharedUid);

        await jobB.setInterval(async (ready) => {
          await counter.incRuns();
          await ready();
        }, TASK_DELAY, sharedUid);

        await waitUntil(async () => (await counter.read()).runs >= 1, {
          timeout: 12000,
          message: msg('per-task: interval did not run')
        });

        const before = await counter.read();
        assert.equal(jobA.pause(timerIdA), true);
        assert.equal(jobA.pause(timerIdA), false);
        assert.equal(jobA.pause(), true);

        await waitUntil(async () => (await counter.read()).runs > before.runs, {
          timeout: 12000,
          message: msg('per-task: peer should increment while jobA defers')
        });

        assert.equal(jobA.resume(), true);
        assert.equal(jobA.resume(timerIdA), true);
      } finally {
        destroyJobs(jobA, jobB);
        await counter.cleanup();
      }
    });

    it('handler pause() + ready() + resume() yields scheduler while work continues', async function () {
      const prefix = uniqueId('pause-handler');
      const counter = await initCounter(prefix);
      const jobA = createJob(prefix, true);
      const jobB = createJob(prefix, false);
      const uidQueue = 'pause-handler-queue';
      const uidPeer = 'pause-handler-peer';

      try {
        jobB.pause();

        await jobA.setInterval(async (ready) => {
          await counter.incA();
          jobA.pause();
          await ready();
          await wait(384);
          await counter.incProcessed();
          jobA.resume();
        }, TASK_DELAY, uidQueue);
        await jobA.setInterval(readyOnly, TASK_DELAY, uidPeer);

        await jobB.setInterval(readyOnly, TASK_DELAY, uidQueue);
        await jobB.setInterval(async (ready) => {
          await counter.incB();
          await ready();
        }, TASK_DELAY, uidPeer);

        await waitUntil(async () => (await counter.read()).runsA >= 1, {
          timeout: 12000,
          message: msg('handler: queue handler did not claim')
        });

        const afterClaim = await counter.read();
        assert.equal(afterClaim.processed, 0, 'ready() should release before processed increment');

        jobB.resume();

        await waitUntil(async () => {
          const v = await counter.read();
          return v.processed >= 1 && v.runsB > afterClaim.runsB;
        }, {
          timeout: 12000,
          message: msg('handler: peer should run while jobA paused after ready()')
        });
      } finally {
        destroyJobs(jobA, jobB);
        await counter.cleanup();
      }
    });
  });
};
