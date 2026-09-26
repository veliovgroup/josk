import { assert } from 'chai';
import { destroyJobs, uniqueId, wait, waitUntil } from './helpers.js';

/** JoSk integration tests use ≥2048 ms task delay (storage + revolving jitter). */
const TASK_DELAY = 2048;

/**
 * Simulates process restarts: instance A registers an interval and dies,
 * instance B boots on the same prefix and re-registers the same uid + delay.
 * @param {string} label
 * @param {{
 *   createJob: (prefix: string, resetOnInit: boolean) => import('../index.js').JoSk,
 *   cleanup: (prefix: string) => Promise<unknown>
 * }} hooks
 */
export const registerIntervalRestartTests = (label, hooks) => {
  const { createJob, cleanup } = hooks;

  describe(`${label} - setInterval re-registration after restart`, function () {
    this.slow(8000);
    this.timeout(15000);

    const restart = async (prefix, uid, gap, runs) => {
      const first = createJob(prefix, true);
      const registeredAt = Date.now();
      await first.setInterval(() => {}, TASK_DELAY, uid);
      first.destroy();

      await wait(gap);

      const second = createJob(prefix, false);
      const reRegisteredAt = Date.now();
      const timerId = await second.setInterval(() => {
        runs.push(Date.now());
      }, TASK_DELAY, uid);

      return { second, timerId, registeredAt, reRegisteredAt };
    };

    it('keeps the original schedule when an instance restarts before the task is due', async function () {
      const prefix = uniqueId('interval-restart');
      const runs = [];
      let ctx;

      try {
        ctx = await restart(prefix, uniqueId('restart-not-due'), 1500, runs);
        await waitUntil(() => runs.length >= 1, {
          timeout: TASK_DELAY * 3,
          message: 'interval did not run after restart'
        });

        const sinceFirstRegistration = runs[0] - ctx.registeredAt;
        assert.isAtLeast(sinceFirstRegistration, TASK_DELAY, 'interval does not run before its stored time');
        assert.isBelow(sinceFirstRegistration, TASK_DELAY + 1000, 'restart does not push the interval back by another delay');
        await ctx.second.clearInterval(ctx.timerId);
      } finally {
        destroyJobs(ctx?.second);
        await cleanup(prefix);
      }
    });

    it('runs a past-due interval right after the restart', async function () {
      const prefix = uniqueId('interval-restart-due');
      const runs = [];
      let ctx;

      try {
        ctx = await restart(prefix, uniqueId('restart-past-due'), TASK_DELAY + 1000, runs);
        await waitUntil(() => runs.length >= 1, {
          timeout: TASK_DELAY * 3,
          message: 'past-due interval did not run after restart'
        });

        assert.isBelow(runs[0] - ctx.reRegisteredAt, 1000, 'past-due interval runs on the first revolutions after boot');
        await ctx.second.clearInterval(ctx.timerId);
      } finally {
        destroyJobs(ctx?.second);
        await cleanup(prefix);
      }
    });
  });
};
