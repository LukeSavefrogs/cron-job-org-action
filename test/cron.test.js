import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeSchedule, formatRun, nextRuns, parseCronExpression, toCronExpression } from '../src/cron.js';

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
    assert.deepEqual(parseCronExpression('0-59 */1 1-31 1-12 0-7').hours, [-1]);
    assert.deepEqual(parseCronExpression('0-59 */1 1-31 1-12 0-7').wdays, [-1]);
    assert.deepEqual(parseCronExpression('0 0 ? * *').mdays, [-1]);
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
    assert.deepEqual(parseCronExpression('0 0 * * 5-7').wdays, [0, 5, 6]);
  });

  it('accepts the names of months and days of week, in any case', () => {
    const schedule = parseCronExpression('0 12 * JAN,jul MON-fri');

    assert.deepEqual(schedule.months, [1, 7]);
    assert.deepEqual(schedule.wdays, [1, 2, 3, 4, 5]);
    // Names containing L, W or H are not mistaken for the extensions of cron
    assert.deepEqual(parseCronExpression('0 0 * * WED,THU').wdays, [3, 4]);
    assert.deepEqual(parseCronExpression('0 0 * JUL *').months, [7]);
  });

  it('accepts the macros of cron-parser', () => {
    assert.deepEqual(parseCronExpression('@daily'), {
      minutes: [0],
      hours: [0],
      mdays: [-1],
      months: [-1],
      wdays: [-1],
    });
    assert.deepEqual(parseCronExpression('@hourly').minutes, [0]);
    assert.deepEqual(parseCronExpression('@weekly').wdays, [0]);
    assert.deepEqual(parseCronExpression('@monthly').mdays, [1]);
    assert.deepEqual(parseCronExpression('@YEARLY').months, [1]);
  });

  it('ignores extra whitespace', () => {
    assert.deepEqual(parseCronExpression('  */30   *  * *  *  ').minutes, [0, 30]);
  });

  for (const [expression, message] of [
    ['* * * *', /expected 5 fields .*found 4/],
    ['0 * * * * *', /found 6: cron-job.org has no seconds or years fields/],
    ['0 0 0 * * * 2030', /found 7/],
    ['60 * * * *', /got value 60 expected range 0-59\.$/],
    ['* 24 * * *', /got value 24 expected range 0-23/],
    ['* * 0 * *', /got value 0 expected range 1-31/],
    ['* * * 13 *', /got value 13 expected range 1-12/],
    ['* * * * 8', /got value 8 expected range 0-7/],
    ['0 0 30 2 *', /Invalid explicit day of month definition/],
    ['5-1 * * * *', /Invalid range/],
    ['*/0 * * * *', /cannot repeat at every 0 time\.$/],
    ['JAN * * * *', /Invalid characters/],
    ['0 0 L * *', /not L, W, # or H/],
    ['0 0 * * 5L', /not L, W, # or H/],
    ['0 0 15W * *', /not L, W, # or H/],
    ['0 0 * * 1#2', /not L, W, # or H/],
    ['H * * * *', /not L, W, # or H/],
    ['* * * * MON-XYZ', /cron-job.org supports numbers/],
    ['@midnight', /unsupported macro \(supported: @yearly, @annually, @monthly, @weekly, @daily, @hourly\)/],
    ['@reboot', /unsupported macro/],
  ]) {
    it(`rejects "${expression}"`, () => {
      assert.throws(() => parseCronExpression(expression), (error) => {
        assert.match(error.message, new RegExp(`^Invalid cron expression "${expression.replace(/[*?]/g, '\\$&')}": `));
        assert.match(error.message, message);
        return true;
      });
    });
  }
});

describe('toCronExpression', () => {
  for (const [expression, expected] of [
    ['*/5 8-22 * * 1-5', '*/5 8-22 * * 1-5'],
    ['* * * * *', '* * * * *'],
    ['10/15 * * * *', '10/15 * * * *'],
    ['0 8-16/4 * * *', '0 8-16/4 * * *'],
    ['0,30 8-12,14-18 1,15 JAN,JUL MON-FRI', '0,30 8-12,14-18 1,15 1,7 1-5'],
    ['0,45 * * * *', '0,45 * * * *'],
    ['0 0 * * 5-7', '0 0 * * 0,5,6'],
  ]) {
    it(`converts "${expression}" back to "${expected}"`, () => {
      const schedule = parseCronExpression(expression);

      assert.equal(toCronExpression(schedule), expected);
      assert.deepEqual(parseCronExpression(toCronExpression(schedule)), schedule);
    });
  }

  it('treats the missing fields as every value', () => {
    assert.equal(toCronExpression({ minutes: [0], hours: [3] }), '0 3 * * *');
  });
});

describe('describeSchedule', () => {
  it('describes an expression as written', () => {
    assert.equal(describeSchedule('*/5 8-22 * * 1-5'), 'Every 5 minutes, between 08:00 and 22:59, Monday through Friday');
  });

  it('describes a schedule with steps and ranges', () => {
    assert.equal(
      describeSchedule(parseCronExpression('*/5 8-22 * * 1-5')),
      'Every 5 minutes, between 08:00 and 22:59, Monday through Friday',
    );
    assert.equal(describeSchedule({ minutes: [0], hours: [9], mdays: [-1], months: [-1], wdays: [-1] }), 'At 09:00');
  });
});

describe('nextRuns', () => {
  const ROME = 'Europe/Rome';
  // Saturday 14 November 2026, 22:58 in Rome
  const SATURDAY_NIGHT = Date.UTC(2026, 10, 14, 21, 58);

  it('computes the next runs in the time zone of the job', () => {
    const runs = nextRuns(parseCronExpression('*/5 8-22 * * 1-5'), { timezone: ROME }, SATURDAY_NIGHT);

    assert.deepEqual(
      runs.map((run) => formatRun(run, ROME)),
      ['Mon 16 Nov 08:00', 'Mon 16 Nov 08:05', 'Mon 16 Nov 08:10'],
    );
    assert.equal(runs[0].toISOString(), '2026-11-16T07:00:00.000Z');
  });

  it('follows the changes of daylight saving time', () => {
    const runs = nextRuns(parseCronExpression('0 8 * * *'), { timezone: ROME }, Date.UTC(2026, 2, 27, 12));

    // 08:00 is 07:00 UTC before the change of 29 March, 06:00 UTC after it
    assert.deepEqual(
      runs.map((run) => run.toISOString()),
      ['2026-03-28T07:00:00.000Z', '2026-03-29T06:00:00.000Z', '2026-03-30T06:00:00.000Z'],
    );
  });

  it('stops at the expiry of the job, in its time zone', () => {
    const schedule = parseCronExpression('0 8 * * *');
    const now = Date.UTC(2026, 2, 27, 12);

    assert.equal(nextRuns(schedule, { timezone: ROME, expiresAt: 20260329080000 }, now).length, 2);
    assert.equal(nextRuns(schedule, { timezone: ROME, expiresAt: 20260329075959 }, now).length, 1);
  });

  it('returns the requested number of runs', () => {
    assert.equal(nextRuns(parseCronExpression('* * * * *'), { timezone: 'UTC' }, SATURDAY_NIGHT, 5).length, 5);
  });

  it('gives up when both the days of month and the days of week are restricted', () => {
    assert.equal(nextRuns(parseCronExpression('0 0 1 * 1'), { timezone: ROME }, SATURDAY_NIGHT), null);
  });

  it('returns no run for a date that never exists', () => {
    const february30 = { minutes: [0], hours: [0], mdays: [30], months: [2], wdays: [-1] };

    assert.deepEqual(nextRuns(february30, { timezone: 'UTC' }, SATURDAY_NIGHT), []);
  });
});
