import cronParser from 'cron-parser';

/**
 * cron-parser v4: parseExpression(); v5: CronExpressionParser.parse().
 * Meteor package tests pin v4 for Meteor 2 (Node 14).
 * @param {string} expression
 */
export const parseCronExpression = (expression) => {
  if (typeof cronParser.parseExpression === 'function') {
    return cronParser.parseExpression(expression);
  }
  return cronParser.CronExpressionParser.parse(expression);
};
