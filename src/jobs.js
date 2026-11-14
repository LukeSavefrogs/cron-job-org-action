/**
 * Validation of the jobs given to the action, and their conversion into the jobs of the cron-job.org API.
 */
import { parseCronExpression } from './cron.js';

/** Values of the `requestMethod` field of the API. */
export const REQUEST_METHODS = {
  GET: 0,
  POST: 1,
  OPTIONS: 2,
  HEAD: 3,
  PUT: 4,
  DELETE: 5,
  TRACE: 6,
  CONNECT: 7,
  PATCH: 8,
};

const SCHEDULE_KEYS = ['minutes', 'hours', 'mdays', 'months', 'wdays'];

const SCHEDULE_RANGES = {
  minutes: [0, 59],
  hours: [0, 23],
  mdays: [1, 31],
  months: [1, 12],
  wdays: [0, 6],
};

const JOB_KEYS = [
  'title',
  'url',
  'schedule',
  'timezone',
  'expiresAt',
  'enabled',
  'method',
  'headers',
  'body',
  'timeout',
  'saveResponses',
  'redirectSuccess',
  'auth',
  'notification',
];

/**
 * @typedef {object} JobSpec A job, as given to the action.
 * @property {string} title Title of the job, unique within its folder: it identifies the job between runs.
 * @property {string} url
 * @property {string|Record<string, number[]>} schedule A crontab expression, or the schedule object of the API.
 * @property {string} [timezone]
 * @property {number} [expiresAt]
 * @property {boolean} [enabled]
 * @property {string} [method]
 * @property {Record<string, string>} [headers]
 * @property {string} [body]
 * @property {number} [timeout]
 * @property {boolean} [saveResponses]
 * @property {boolean} [redirectSuccess]
 * @property {{ user: string, password: string }} [auth]
 * @property {Record<string, unknown>} [notification]
 */

/**
 * Parses and validates the `jobs` input: a JSON array of jobs.
 *
 * @param {string} text
 * @returns {JobSpec[]}
 */
export function parseJobs(text) {
  let jobs;
  try {
    jobs = JSON.parse(text);
  } catch (error) {
    throw new Error(`The "jobs" input is not valid JSON: ${error.message}`);
  }

  if (!Array.isArray(jobs)) {
    throw new Error('The "jobs" input must be a JSON array of jobs.');
  }

  const titles = new Set();
  jobs.forEach((job, index) => {
    validateJob(job, index);

    if (titles.has(job.title)) {
      throw new Error(`Job #${index + 1} ("${job.title}"): another job has the same title (titles identify the jobs).`);
    }
    titles.add(job.title);
  });

  return jobs;
}

/**
 * @param {unknown} job
 * @param {number} index
 */
function validateJob(job, index) {
  const fail = (message) => {
    throw new Error(`Job #${index + 1}${typeof job?.title === 'string' ? ` ("${job.title}")` : ''}: ${message}`);
  };

  if (typeof job !== 'object' || job === null || Array.isArray(job)) {
    fail('must be an object.');
  }

  const unknownKeys = Object.keys(job).filter((key) => !JOB_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    fail(`unknown field(s) ${unknownKeys.map((key) => `"${key}"`).join(', ')} (allowed: ${JOB_KEYS.join(', ')}).`);
  }

  if (typeof job.title !== 'string' || job.title.trim() === '') {
    fail('"title" is required, since it identifies the job.');
  }
  if (typeof job.url !== 'string' || !/^https?:\/\/\S+$/i.test(job.url)) {
    fail('"url" is required and must be an HTTP(S) URL.');
  }

  if (typeof job.schedule === 'string') {
    try {
      parseCronExpression(job.schedule);
    } catch (error) {
      fail(error.message);
    }
  } else if (typeof job.schedule === 'object' && job.schedule !== null && !Array.isArray(job.schedule)) {
    validateScheduleObject(job.schedule, fail);
  } else {
    fail('"schedule" is required: a crontab expression (e.g. "*/5 * * * *") or a schedule object.');
  }

  if (job.timezone !== undefined) {
    validateTimezone(job.timezone, fail);
  }
  if (job.expiresAt !== undefined && !(Number.isInteger(job.expiresAt) && job.expiresAt >= 0)) {
    fail('"expiresAt" must be a date as a number in the YYYYMMDDhhmmss format, or 0.');
  }
  for (const key of ['enabled', 'saveResponses', 'redirectSuccess']) {
    if (job[key] !== undefined && typeof job[key] !== 'boolean') {
      fail(`"${key}" must be true or false.`);
    }
  }
  if (job.method !== undefined && !(typeof job.method === 'string' && job.method.toUpperCase() in REQUEST_METHODS)) {
    fail(`"method" must be one of ${Object.keys(REQUEST_METHODS).join(', ')}.`);
  }
  if (
    job.headers !== undefined &&
    (typeof job.headers !== 'object' ||
      job.headers === null ||
      Array.isArray(job.headers) ||
      Object.values(job.headers).some((value) => typeof value !== 'string'))
  ) {
    fail('"headers" must be an object of strings (e.g. {"X-Token": "..."}).');
  }
  if (job.body !== undefined && typeof job.body !== 'string') {
    fail('"body" must be a string (e.g. JSON.stringify-ed data).');
  }
  if (job.timeout !== undefined && !(Number.isInteger(job.timeout) && (job.timeout > 0 || job.timeout === -1))) {
    fail('"timeout" must be a number of seconds (or -1 for the default timeout of cron-job.org).');
  }
  if (
    job.auth !== undefined &&
    (typeof job.auth !== 'object' ||
      job.auth === null ||
      typeof job.auth.user !== 'string' ||
      typeof job.auth.password !== 'string')
  ) {
    fail('"auth" must be an object with the "user" and "password" of the HTTP basic authentication.');
  }
  if (
    job.notification !== undefined &&
    (typeof job.notification !== 'object' || job.notification === null || Array.isArray(job.notification))
  ) {
    fail('"notification" must be an object (the notification settings of the cron-job.org API).');
  }
}

/**
 * @param {Record<string, unknown>} schedule
 * @param {(message: string) => never} fail
 */
function validateScheduleObject(schedule, fail) {
  for (const [key, values] of Object.entries(schedule)) {
    if (key === 'timezone' || key === 'expiresAt') {
      fail(`set "${key}" on the job, not in its schedule.`);
    }
    if (!SCHEDULE_KEYS.includes(key)) {
      fail(`unknown schedule field "${key}" (allowed: ${SCHEDULE_KEYS.join(', ')}).`);
    }

    const [min, max] = SCHEDULE_RANGES[key];
    const isEvery = Array.isArray(values) && values.length === 1 && values[0] === -1;
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      (!isEvery && values.some((value) => !Number.isInteger(value) || value < min || value > max))
    ) {
      fail(`the schedule field "${key}" must be [-1] (every value) or a list of values from ${min} to ${max}.`);
    }
  }
}

/**
 * @param {unknown} timezone
 * @param {(message: string) => never} fail
 */
export function validateTimezone(timezone, fail = (message) => {
  throw new Error(message);
}) {
  try {
    if (typeof timezone !== 'string' || timezone === '') {
      throw new RangeError();
    }
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch {
    fail(`"${timezone}" is not a valid time zone (e.g. "UTC", "Europe/Rome").`);
  }
}

/**
 * Builds the job sent to the API, to create a job or to update an existing one. Every field is sent, so that removing
 * a setting from the job (e.g. a header) also removes it on cron-job.org; except `notification`, left as it is when
 * not given (e.g. set in the console).
 *
 * @param {JobSpec} job
 * @param {{ folderId: number, timezone: string }} defaults
 * @returns {Record<string, unknown>}
 */
export function buildJobPayload(job, { folderId, timezone }) {
  const schedule =
    typeof job.schedule === 'string'
      ? parseCronExpression(job.schedule)
      : Object.fromEntries(SCHEDULE_KEYS.map((key) => [key, job.schedule[key] ?? [-1]]));

  return {
    title: job.title,
    url: job.url,
    enabled: job.enabled ?? true,
    folderId,
    schedule: {
      timezone: job.timezone ?? timezone,
      expiresAt: job.expiresAt ?? 0,
      ...schedule,
    },
    requestMethod: REQUEST_METHODS[(job.method ?? 'GET').toUpperCase()],
    requestTimeout: job.timeout ?? -1,
    saveResponses: job.saveResponses ?? false,
    redirectSuccess: job.redirectSuccess ?? false,
    auth: job.auth ? { enable: true, user: job.auth.user, password: job.auth.password } : { enable: false, user: '', password: '' },
    extendedData: {
      headers: job.headers ?? {},
      body: job.body ?? '',
    },
    ...(job.notification ? { notification: job.notification } : {}),
  };
}
