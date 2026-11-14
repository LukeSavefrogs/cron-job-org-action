/**
 * Validation of the jobs given to the action, and their conversion into the jobs of the cron-job.org API.
 */
import { LineCounter, parseDocument } from 'yaml';

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

/** Names of HTTP headers (RFC 9110 tokens). */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

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
 * @property {string} url Absolute once resolved; may be relative to the `base-url` input when given.
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
 * @typedef {object} JobDefaults Settings applied to every job that does not set its own.
 * @property {string} [baseUrl] Prefix of the relative URLs of the jobs.
 * @property {string} [schedule] Crontab expression.
 * @property {string} [method]
 * @property {Record<string, string>} [headers] Merged with the headers of each job.
 */

/**
 * Parses and validates the inputs applying to every job (`base-url`, `schedule`, `method` and `headers`).
 *
 * @param {{ baseUrl?: string, schedule?: string, method?: string, headers?: string }} inputs The raw inputs.
 * @returns {JobDefaults}
 */
export function parseJobDefaults({ baseUrl = '', schedule = '', method = '', headers = '' }) {
  if (baseUrl && !/^https?:\/\/\S+$/i.test(baseUrl)) {
    throw new Error('The "base-url" input must be an HTTP(S) URL.');
  }
  if (schedule) {
    try {
      parseCronExpression(schedule);
    } catch (error) {
      throw new Error(`The "schedule" input is not valid: ${error.message}`);
    }
  }
  if (method && !(method.toUpperCase() in REQUEST_METHODS)) {
    throw new Error(`The "method" input must be one of ${Object.keys(REQUEST_METHODS).join(', ')}.`);
  }

  return {
    ...(baseUrl ? { baseUrl } : {}),
    ...(schedule ? { schedule } : {}),
    ...(method ? { method: method.toUpperCase() } : {}),
    headers: parseHeaders(headers),
  };
}

/**
 * Parses the `headers` input: one `Name: value` header per line. The value is the rest of the line, as is, so that it
 * needs no quoting (e.g. a secret); it is never shown in the errors.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseHeaders(text) {
  /** @type {Record<string, string>} */
  const headers = {};

  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') {
      return;
    }

    const separator = line.indexOf(':');
    const name = separator === -1 ? '' : line.slice(0, separator).trim();
    if (!HEADER_NAME.test(name)) {
      throw new Error(`Line ${index + 1} of the "headers" input must be a "Name: value" header.`);
    }
    if (Object.keys(headers).some((existing) => existing.toLowerCase() === name.toLowerCase())) {
      throw new Error(`The "headers" input sets the "${name}" header more than once.`);
    }

    headers[name] = line.slice(separator + 1).trim();
  });

  return headers;
}

/**
 * Parses and validates the `jobs` input, a YAML (or JSON) list of jobs, and applies the defaults to them.
 *
 * @param {string} text
 * @param {JobDefaults} [defaults]
 * @returns {JobSpec[]} The jobs, with their absolute URL, schedule, method and headers.
 */
export function parseJobs(text, defaults = {}) {
  const lineCounter = new LineCounter();
  const document = parseDocument(text, { prettyErrors: false, uniqueKeys: true, lineCounter });

  if (document.errors.length > 0) {
    const [error] = document.errors;
    const { line, col } = lineCounter.linePos(error.pos[0]);
    // The text of the input is never shown: it may hold secrets
    const isUnquotedCron = /^\s*(-\s+)?["']?schedule["']?\s*:\s*\*/.test(text.split(/\r?\n/)[line - 1] ?? '');
    const hint = isUnquotedCron
      ? ' Quote the cron expressions starting with "*" (e.g. schedule: "*/5 * * * *"): YAML reads "*" as an alias.'
      : '';
    throw new Error(
      `The "jobs" input is not valid YAML or JSON (line ${line}, column ${col}): ${error.message.replace(/\.?$/, '.')}${hint}`,
    );
  }

  const jobs = document.toJS({ maxAliasCount: 100 });
  if (jobs === null || jobs === undefined) {
    throw new Error('The "jobs" input has no jobs: use [] for none.');
  }
  if (!Array.isArray(jobs)) {
    throw new Error('The "jobs" input must be a list of jobs: start each job with "- " (e.g. "- title: Ping").');
  }

  const items = document.contents?.items ?? [];
  const titles = new Set();

  return jobs.map((job, index) => {
    const offset = items[index]?.range?.[0];
    const line = offset === undefined ? undefined : lineCounter.linePos(offset).line;
    const resolved = resolveJob(job, index, line, defaults);

    if (titles.has(resolved.title)) {
      throw new Error(`${jobLabel(job, index, line)}: another job has the same title (titles identify the jobs).`);
    }
    titles.add(resolved.title);

    return resolved;
  });
}

/**
 * @param {unknown} job
 * @param {number} index
 * @param {number|undefined} line
 * @returns {string} E.g. `Job #2 ("Queue run", line 7)`.
 */
function jobLabel(job, index, line) {
  const details = [
    typeof job?.title === 'string' ? `"${job.title}"` : '',
    line === undefined ? '' : `line ${line}`,
  ].filter(Boolean);

  return `Job #${index + 1}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
}

/**
 * Validates a job and applies the defaults to it.
 *
 * @param {unknown} job
 * @param {number} index
 * @param {number|undefined} line
 * @param {JobDefaults} defaults
 * @returns {JobSpec}
 */
function resolveJob(job, index, line, defaults) {
  const fail = (message) => {
    throw new Error(`${jobLabel(job, index, line)}: ${message}`);
  };

  validateJob(job, fail);

  const url = resolveUrl(job.url, defaults.baseUrl, fail);
  const schedule = job.schedule ?? defaults.schedule;
  if (schedule === undefined) {
    fail('"schedule" is required: set it on the job, or in the "schedule" input for every job.');
  }

  return {
    ...job,
    url,
    schedule,
    ...(job.method ?? defaults.method ? { method: (job.method ?? defaults.method).toUpperCase() } : {}),
    headers: mergeHeaders(defaults.headers ?? {}, job.headers ?? {}),
  };
}

/**
 * @param {unknown} url
 * @param {string|undefined} baseUrl
 * @param {(message: string) => never} fail
 * @returns {string} The absolute URL.
 */
function resolveUrl(url, baseUrl, fail) {
  if (typeof url !== 'string' || url.trim() === '') {
    fail('"url" is required.');
  }
  if (/\s/.test(url.trim())) {
    fail('"url" cannot contain spaces.');
  }

  // With a scheme: an absolute URL
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) {
    if (!/^https?:\/\/\S+$/i.test(url)) {
      fail('"url" must be an HTTP(S) URL.');
    }
    return url;
  }

  if (!baseUrl) {
    fail('"url" is relative: set the "base-url" input, or give the full URL (https://...).');
  }

  return `${baseUrl.replace(/\/+$/, '')}/${url.trim().replace(/^\/+/, '')}`;
}

/**
 * Merges the headers of a job into the default ones: a header of the job replaces the default one with the same name,
 * whatever its case.
 *
 * @param {Record<string, string>} defaults
 * @param {Record<string, string>} headers
 * @returns {Record<string, string>}
 */
function mergeHeaders(defaults, headers) {
  const names = Object.keys(headers).map((name) => name.toLowerCase());
  const kept = Object.entries(defaults).filter(([name]) => !names.includes(name.toLowerCase()));

  return { ...Object.fromEntries(kept), ...headers };
}

/**
 * Validates the fields of a job, before the defaults are applied (`url` and `schedule` may be missing).
 *
 * @param {unknown} job
 * @param {(message: string) => never} fail
 */
function validateJob(job, fail) {
  if (typeof job !== 'object' || job === null || Array.isArray(job)) {
    fail('must be an object with the fields of the job (e.g. "title: Ping").');
  }

  const unknownKeys = Object.keys(job).filter((key) => !JOB_KEYS.includes(key));
  if (unknownKeys.length > 0) {
    fail(`unknown field(s) ${unknownKeys.map((key) => `"${key}"`).join(', ')} (allowed: ${JOB_KEYS.join(', ')}).`);
  }

  if (typeof job.title !== 'string' || job.title.trim() === '') {
    fail('"title" is required (a text), since it identifies the job.');
  }

  if (typeof job.schedule === 'string') {
    try {
      parseCronExpression(job.schedule);
    } catch (error) {
      fail(error.message);
    }
  } else if (typeof job.schedule === 'object' && job.schedule !== null && !Array.isArray(job.schedule)) {
    validateScheduleObject(job.schedule, fail);
  } else if (job.schedule !== undefined) {
    fail('"schedule" must be a crontab expression (e.g. "*/5 * * * *") or a schedule object.');
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
    fail('"headers" must be a map of texts (e.g. "X-Token: abc"); quote the values that YAML reads as numbers.');
  }
  if (job.body !== undefined && typeof job.body !== 'string') {
    fail('"body" must be a text (e.g. a JSON document in a "|" block).');
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
    fail('"auth" must have the "user" and "password" of the HTTP basic authentication.');
  }
  if (
    job.notification !== undefined &&
    (typeof job.notification !== 'object' || job.notification === null || Array.isArray(job.notification))
  ) {
    fail('"notification" must be a map (the notification settings of the cron-job.org API).');
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
