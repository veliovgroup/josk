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
 * Meteor package tests pin v4 for Meteor 2 (Node 14).
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
