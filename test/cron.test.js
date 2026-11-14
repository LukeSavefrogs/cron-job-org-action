import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCronExpression } from '../src/cron.js';

describe('parseCronExpression', () => {
  it('converts steps and ranges into the lists of values of cron-job.org', () => {
    assert.deepEqual(parseCronExpression('*/5 8-22 * * 1-5'), {
      minutes: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55],
      hours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22],
      mdays: [-1],
      months: [-1],
      wdays: [1, 2, 3, 4, 5],
    });
  });

  it('uses [-1] for the fields allowing every value', () => {
    assert.deepEqual(parseCronExpression('* * * * *'), {
      minutes: [-1],
      hours: [-1],
      mdays: [-1],
      months: [-1],
      wdays: [-1],
    });
    assert.deepEqual(parseCronExpression('0-59 */1 1-31 1,2,3,4,5,6,7,8,9,10,11,12 0-7').hours, [-1]);
    assert.deepEqual(parseCronExpression('0-59 */1 1-31 1,2,3,4,5,6,7,8,9,10,11,12 0-7').wdays, [-1]);
  });

  it('accepts lists, single values and steps from a value', () => {
    const schedule = parseCronExpression('0,30 12 1,15 6 3');

    assert.deepEqual(schedule.minutes, [0, 30]);
    assert.deepEqual(schedule.hours, [12]);
    assert.deepEqual(schedule.mdays, [1, 15]);
    assert.deepEqual(schedule.months, [6]);
    assert.deepEqual(schedule.wdays, [3]);
    assert.deepEqual(parseCronExpression('10/15 * * * *').minutes, [10, 25, 40, 55]);
    assert.deepEqual(parseCronExpression('* 8-20/4 * * *').hours, [8, 12, 16, 20]);
  });

  it('treats 7 as Sunday', () => {
    assert.deepEqual(parseCronExpression('0 0 * * 7').wdays, [0]);
    assert.deepEqual(parseCronExpression('0 0 * * 0,7').wdays, [0]);
    assert.deepEqual(parseCronExpression('0 0 * * 5-7').wdays, [0, 5, 6]);
  });

  it('accepts the names of months and days of week, in any case', () => {
    const schedule = parseCronExpression('0 12 * JAN,jul MON-fri');

    assert.deepEqual(schedule.months, [1, 7]);
    assert.deepEqual(schedule.wdays, [1, 2, 3, 4, 5]);
    assert.deepEqual(parseCronExpression('0 0 * * SUN').wdays, [0]);
  });

  it('accepts macros', () => {
    assert.deepEqual(parseCronExpression('@daily'), {
      minutes: [0],
      hours: [0],
      mdays: [-1],
      months: [-1],
      wdays: [-1],
    });
    assert.deepEqual(parseCronExpression('@hourly').minutes, [0]);
    assert.deepEqual(parseCronExpression('@weekly').wdays, [0]);
  });

  it('ignores extra whitespace', () => {
    assert.deepEqual(parseCronExpression('  */30   *  * *  *  ').minutes, [0, 30]);
  });

  for (const [expression, message] of [
    ['* * * *', /expected 5 fields/],
    ['* * * * * *', /expected 5 fields/],
    ['60 * * * *', /invalid minute "60"/],
    ['* 24 * * *', /invalid hour "24"/],
    ['* * 0 * *', /invalid day of month "0"/],
    ['* * * 13 *', /invalid month "13"/],
    ['* * * * 8', /invalid day of week "8"/],
    ['* * * * MON-XYZ', /invalid day of week "XYZ"/],
    ['* * * FOO *', /invalid month "FOO"/],
    ['JAN * * * *', /invalid minute "JAN"/],
    ['5-1 * * * *', /ends before it starts/],
    ['*/0 * * * *', /invalid step/],
    ['1-2-3 * * * *', /invalid minute range/],
    ['*/ * * * *', /invalid minute/],
    [', * * * *', /invalid minute/],
  ]) {
    it(`rejects "${expression}"`, () => {
      assert.throws(() => parseCronExpression(expression), message);
    });
  }
});
