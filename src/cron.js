/**
 * Conversion of crontab expressions (`*\/5 8-22 * * 1-5`) into the schedules of cron-job.org, which list the allowed
 * values of each field (`[-1]` meaning every value).
 */

const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * The fields of a crontab expression, in order, with the name of their key in the schedules of cron-job.org.
 *
 * @type {Array<{ key: 'minutes'|'hours'|'mdays'|'months'|'wdays', label: string, min: number, max: number, names?: string[], namesStart?: number }>}
 */
const FIELDS = [
  { key: 'minutes', label: 'minute', min: 0, max: 59 },
  { key: 'hours', label: 'hour', min: 0, max: 23 },
  { key: 'mdays', label: 'day of month', min: 1, max: 31 },
  { key: 'months', label: 'month', min: 1, max: 12, names: MONTH_NAMES, namesStart: 1 },
  // 7 is Sunday too, as in most cron implementations: folded into 0 below
  { key: 'wdays', label: 'day of week', min: 0, max: 7, names: WEEKDAY_NAMES, namesStart: 0 },
];

const MACROS = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

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
 * `@daily`. Each field accepts `*`, values, ranges (`1-5`), steps (`*\/5`, `8-22/2`, `10/15`) and lists of them
 * (`0,30`); months and days of week also accept their English names (`JAN`, `MON-FRI`).
 *
 * @param {string} expression
 * @returns {CronSchedule}
 */
export function parseCronExpression(expression) {
  const source = String(expression).trim();
  const expanded = MACROS[source.toLowerCase()] ?? source;
  const parts = expanded.split(/\s+/).filter(Boolean);

  if (parts.length !== FIELDS.length) {
    throw new Error(
      `Invalid cron expression "${source}": expected 5 fields (minute, hour, day of month, month, day of week), found ${parts.length}.`,
    );
  }

  /** @type {Partial<CronSchedule>} */
  const schedule = {};
  FIELDS.forEach((field, index) => {
    try {
      schedule[field.key] = parseField(parts[index], field);
    } catch (error) {
      throw new Error(`Invalid cron expression "${source}": ${error.message}`);
    }
  });

  return /** @type {CronSchedule} */ (schedule);
}

/**
 * @param {string} text
 * @param {(typeof FIELDS)[number]} field
 * @returns {number[]}
 */
function parseField(text, field) {
  const values = new Set();

  for (const item of text.split(',')) {
    const match = /^([^/]+)(?:\/(\d+))?$/.exec(item);
    if (!match) {
      throw new Error(`invalid ${field.label} "${item}".`);
    }

    const [, range, stepText] = match;
    const step = stepText === undefined ? 1 : Number(stepText);
    if (step < 1) {
      throw new Error(`invalid step in the ${field.label} "${item}".`);
    }

    let start;
    let end;
    if (range === '*') {
      start = field.min;
      end = field.max;
    } else if (range.includes('-')) {
      const [startText, endText, ...rest] = range.split('-');
      if (rest.length > 0) {
        throw new Error(`invalid ${field.label} range "${range}".`);
      }
      start = parseValue(startText, field);
      end = parseValue(endText, field);
      if (start > end) {
        throw new Error(`the ${field.label} range "${range}" ends before it starts.`);
      }
    } else {
      start = parseValue(range, field);
      // `10/15` means from 10 to the end, every 15
      end = stepText === undefined ? start : field.max;
    }

    for (let value = start; value <= end; value += step) {
      values.add(field.key === 'wdays' && value === 7 ? 0 : value);
    }
  }

  const sorted = [...values].sort((a, b) => a - b);
  const allValues = field.key === 'wdays' ? 7 : field.max - field.min + 1;

  return sorted.length === allValues ? [-1] : sorted;
}

/**
 * @param {string} text
 * @param {(typeof FIELDS)[number]} field
 * @returns {number}
 */
function parseValue(text, field) {
  let value;

  if (/^\d+$/.test(text)) {
    value = Number(text);
  } else if (field.names) {
    const index = field.names.indexOf(text.toUpperCase());
    value = index === -1 ? NaN : index + field.namesStart;
  } else {
    value = NaN;
  }

  if (Number.isNaN(value) || value < field.min || value > field.max) {
    throw new Error(`invalid ${field.label} "${text}" (allowed: ${field.min}-${field.max}).`);
  }

  return value;
}
