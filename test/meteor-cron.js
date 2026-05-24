import cronParser from 'cron-parser';

/**
 * @param {import('cron-parser').CronDate | Date} value
 * @returns {Date}
 */
const toNativeDate = (value) => {
  if (value instanceof Date) {
    return value;
  }

  if (value && typeof value.toDate === 'function') {
    return value.toDate();
  }

  return new Date(value);
};

/**
 * cron-parser v4: parseExpression(); v5: CronExpressionParser.parse().
 * Meteor package tests pin v4 for Meteor 2 (Node 14), v5 for Meteor 3 (Node 18+).
 *
 * The default ESM import shape differs per bundler:
 *   - Meteor 2 / npm with v4: `cronParser` is the CronParser fn with `.parseExpression`.
 *   - Meteor 3 with v5: `cronParser` is the CronExpressionParser class itself
 *     (resolves to `exports.default`) with `.parse`.
 *   - Node ESM with v5: `cronParser` is the module-exports namespace with
 *     `.CronExpressionParser`.
 *
 * Returns a thin iterator so tests can keep `parseCronExpression(expr).next().toDate()`.
 * Each `.next()` re-parses with `currentDate: new Date()` so v5 always schedules from
 * "now" (avoids stale anchors and negative delays when the handler runs late on CI).
 *
 * @param {string} expression
 * @param {{ currentDate?: Date }} [options]
 */
export const parseCronExpression = (expression, options) => {
  const resolve = () => {
    const opts = { currentDate: new Date(), ...options };

    if (typeof cronParser.parseExpression === 'function') {
      return cronParser.parseExpression(expression, opts);
    }

    if (typeof cronParser.parse === 'function') {
      return cronParser.parse(expression, opts);
    }

    return cronParser.CronExpressionParser.parse(expression, opts);
  };

  return {
    next() {
      return {
        toDate() {
          return toNativeDate(resolve().next());
        }
      };
    }
  };
};
