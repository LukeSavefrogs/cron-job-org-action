/**
 * Crontab expressions (`*\/5 8-22 * * 1-5`), parsed by `cron-parser`, converted to and from the schedules of
 * cron-job.org (which list the allowed values of each field, `[-1]` meaning every value), described by `cronstrue`.
 */
import { CronExpressionParser } from 'cron-parser';
import cronstrue from 'cronstrue';

/** Keys of the schedules of cron-job.org, in the order of the fields of a crontab expression. */
const SCHEDULE_KEYS = ['minutes', 'hours', 'mdays', 'months', 'wdays'];

/** The fields of `cron-parser` matching each key, and the number of values meaning "every value". */
const FIELDS = {
  minutes: { field: 'minute', size: 60 },
  hours: { field: 'hour', size: 24 },
  mdays: { field: 'dayOfMonth', size: 31 },
  months: { field: 'month', size: 12 },
  wdays: { field: 'dayOfWeek', size: 7 },
};

/** The values allowed in each field of the schedules of cron-job.org. */
const RANGES = {
  minutes: [0, 59],
  hours: [0, 23],
  mdays: [1, 31],
  months: [1, 12],
  wdays: [0, 6],
};

/** The macros supported by `cron-parser`. */
const MACROS = ['@yearly', '@annually', '@monthly', '@weekly', '@daily', '@hourly'];

const UNSUPPORTED_CHARACTERS =
  'cron-job.org supports numbers, the names of months and days, and the * , - / ? characters (not L, W, # or H).';

/** Names of the months and of the days of week, allowed in their fields. */
const NAMES = /JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC|SUN|MON|TUE|WED|THU|FRI|SAT/gi;

/**
 * @typedef {object} CronSchedule
 * @property {number[]} minutes
 * @property {number[]} hours
 * @property {number[]} mdays
 * @property {number[]} months
 * @property {number[]} wdays
 */

/**
 * Parses a crontab expression with 5 fields (minute, hour, day of month, month, day of week), or a macro such as
 * `@daily`, into the schedule of cron-job.org.
 *
 * The extensions that the schedules of cron-job.org cannot hold are rejected: seconds and years fields, and the
 * `L` (last), `W` (weekday), `#` (nth day of week) and `H` (hash) characters.
 *
 * @param {string} expression
 * @returns {CronSchedule}
 */
export function parseCronExpression(expression) {
  const source = String(expression).trim();
  const fail = (message) => {
    throw new Error(`Invalid cron expression "${source}": ${message}`);
  };

  if (source.startsWith('@')) {
    if (!MACROS.includes(source.toLowerCase())) {
      fail(`unsupported macro (supported: ${MACROS.join(', ')}).`);
    }
  } else {
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length !== SCHEDULE_KEYS.length) {
      fail(
        `expected 5 fields (minute, hour, day of month, month, day of week), found ${parts.length}: cron-job.org has no seconds or years fields.`,
      );
    }
    if (parts.some((part) => /[^0-9*,\-/?]/.test(part.replace(NAMES, '')))) {
      fail(UNSUPPORTED_CHARACTERS);
    }
  }

  let fields;
  try {
    ({ fields } = CronExpressionParser.parse(source.startsWith('@') ? source.toLowerCase() : source));
  } catch (error) {
    // Some errors of cron-parser have no message
    const message = error?.message && error.message !== 'undefined' ? error.message.replace(/\.+$/, '') : '';
    fail(message ? `${message}.` : 'not a valid crontab expression.');
  }

  /** @type {Partial<CronSchedule>} */
  const schedule = {};
  for (const key of SCHEDULE_KEYS) {
    const { field, size } = FIELDS[key];
    const values = fields[field].values;

    if (values.some((value) => !Number.isInteger(value))) {
      fail(UNSUPPORTED_CHARACTERS);
    }

    // Sunday is both 0 and 7
    const unique = [...new Set(values.map((value) => (key === 'wdays' && value === 7 ? 0 : value)))].sort((a, b) => a - b);
    schedule[key] = unique.length === size ? [-1] : unique;
  }

  return /** @type {CronSchedule} */ (schedule);
}

/**
 * Converts a schedule of cron-job.org into a crontab expression, with steps and ranges where the values allow them
 * (e.g. `[0, 5, ..., 55]` → `*\/5`, `[8, 9, ..., 22]` → `8-22`), so that its description stays short.
 *
 * @param {CronSchedule} schedule
 * @returns {string}
 */
export function toCronExpression(schedule) {
  return SCHEDULE_KEYS.map((key) => {
    const values = schedule[key] ?? [-1];
    return values.includes(-1) ? '*' : compressValues(values, RANGES[key]);
  }).join(' ');
}

/**
 * Describes a schedule in English, e.g. "Every 5 minutes, between 08:00 and 22:59, Monday through Friday".
 *
 * @param {CronSchedule|string} schedule A schedule, or the crontab expression it comes from (described as written).
 * @returns {string}
 */
export function describeSchedule(schedule) {
  const expression = typeof schedule === 'string' ? schedule.trim() : toCronExpression(schedule);
  return cronstrue.toString(expression, { use24HourTimeFormat: true });
}

/**
 * @param {number[]} values Sorted values of a field.
 * @param {[number, number]} range The values allowed in the field.
 * @returns {string} The values as a step (`*\/5`, `10/15`, `8-20/4`), or as a list of ranges and values (`1-5,7`).
 */
function compressValues(values, [min, max]) {
  const step = values.length >= 3 ? values[1] - values[0] : 0;
  const isProgression = step > 1 && values.every((value, index) => index === 0 || value - values[index - 1] === step);

  if (isProgression) {
    const [first] = values;
    const last = values.at(-1);
    if (last + step > max) {
      return first === min ? `*/${step}` : `${first}/${step}`;
    }
    return `${first}-${last}/${step}`;
  }

  const parts = [];
  for (let index = 0; index < values.length; ) {
    let end = index;
    while (end + 1 < values.length && values[end + 1] === values[end] + 1) {
      end++;
    }
    parts.push(end - index >= 2 ? `${values[index]}-${values[end]}` : values.slice(index, end + 1).join(','));
    index = end + 1;
  }

  return parts.join(',');
}

/**
 * Computes the next runs of a schedule, in its time zone.
 *
 * @param {CronSchedule} schedule
 * @param {{ timezone: string, expiresAt?: number }} options `expiresAt`: date after which the job no longer runs, as
 *   `YYYYMMDDhhmmss` in its time zone (`0` for never).
 * @param {number} now
 * @param {number} [count]
 * @returns {Date[]|null} `null` when both the days of month and the days of week are restricted, since how
 *   cron-job.org combines them is not documented.
 */
export function nextRuns(schedule, { timezone, expiresAt = 0 }, now, count = 3) {
  if (!schedule.mdays.includes(-1) && !schedule.wdays.includes(-1)) {
    return null;
  }

  let iterator;
  try {
    iterator = CronExpressionParser.parse(toCronExpression(schedule), { tz: timezone, currentDate: new Date(now) });
  } catch {
    // A date that never exists, e.g. February 30
    return [];
  }

  const runs = [];
  try {
    while (runs.length < count && iterator.hasNext()) {
      const run = new Date(iterator.next().getTime());
      if (expiresAt && localTimestamp(run, timezone) > expiresAt) {
        break;
      }
      runs.push(run);
    }
  } catch {
    // No further run within the search limit of cron-parser
  }

  return runs;
}

/**
 * Formats a run in the time zone of its job, e.g. "Mon 17 Nov 08:00".
 *
 * @param {Date} date
 * @param {string} timezone
 * @returns {string}
 */
export function formatRun(date, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: timezone,
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );

  return `${parts.weekday} ${parts.day} ${parts.month} ${parts.hour}:${parts.minute}`;
}

/**
 * @param {Date} date
 * @param {string} timezone
 * @returns {number} The date as `YYYYMMDDhhmmss` in the time zone.
 */
function localTimestamp(date, timezone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    })
      .formatToParts(date)
      .map(({ type, value }) => [type, value]),
  );

  return Number(`${parts.year}${parts.month}${parts.day}${parts.hour}${parts.minute}${parts.second}`);
}
