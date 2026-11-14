/**
 * Client of the cron-job.org REST API (https://docs.cron-job.org/rest-api.html), respecting its rate limits.
 */
import { setTimeout as delay } from 'node:timers/promises';

export const DEFAULT_API_URL = 'https://api.cron-job.org';

/**
 * Rate limits of the API methods, by method and collection: at most `count` requests every `period` milliseconds.
 * The other methods allow 5 requests per second.
 *
 * @type {Record<string, Array<{ count: number, period: number }>>}
 */
const RATE_LIMITS = {
  'PUT /jobs': [
    { count: 1, period: 1_000 },
    { count: 5, period: 60_000 },
  ],
  'PUT /folders': [
    { count: 1, period: 1_000 },
    { count: 10, period: 60_000 },
  ],
  'PATCH /folders': [{ count: 1, period: 1_000 }],
  'DELETE /folders': [{ count: 1, period: 1_000 }],
};
const DEFAULT_RATE_LIMITS = [{ count: 5, period: 1_000 }];

/** Margin added to the waits, against the clock skew between the runner and the API. */
const RATE_LIMIT_MARGIN = 100;

const STATUS_DESCRIPTIONS = {
  400: 'invalid request or input data',
  401: 'invalid API key',
  403: 'the API key cannot be used from this IP address',
  404: 'not found',
  409: 'conflict, e.g. the resource already exists',
  429: 'API key quota, resource quota or rate limit exceeded',
  500: 'internal server error of cron-job.org',
};

const RETRYABLE_STATUSES = [429, 500, 502, 503, 504];

export class CronJobOrgError extends Error {
  /**
   * @param {string} method
   * @param {string} path
   * @param {number} status
   * @param {string} body
   */
  constructor(method, path, status, body) {
    const description = STATUS_DESCRIPTIONS[status] ? ` (${STATUS_DESCRIPTIONS[status]})` : '';
    const details = body.trim() ? `: ${body.trim().slice(0, 500)}` : '';
    super(`cron-job.org API: ${method} ${path} failed with HTTP ${status}${description}${details}`);
    this.name = 'CronJobOrgError';
    this.method = method;
    this.path = path;
    this.status = status;
    this.body = body;
  }
}

export class CronJobOrgClient {
  /**
   * @param {object} options
   * @param {string} options.apiKey
   * @param {string} [options.apiUrl]
   * @param {number} [options.retries] How many times a request rejected by a rate limit (or by a temporary error) is
   *   retried.
   * @param {number} [options.timeout] Timeout of each request, in milliseconds.
   * @param {(ms: number) => Promise<unknown>} [options.sleep]
   * @param {() => number} [options.now]
   * @param {(message: string) => void} [options.log]
   */
  constructor({
    apiKey,
    apiUrl = DEFAULT_API_URL,
    retries = 4,
    timeout = 30_000,
    sleep = delay,
    now = Date.now,
    log = () => {},
  }) {
    if (!apiKey) {
      throw new Error('The API key of cron-job.org is missing.');
    }

    this.apiKey = apiKey;
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.retries = retries;
    this.timeout = timeout;
    this.sleep = sleep;
    this.now = now;
    this.log = log;
    /** @type {Map<string, number[]>} Times of the latest requests, by rate limit. */
    this.history = new Map();
  }

  /** @returns {Promise<Array<{ folderId: number, title: string }>>} */
  async listFolders() {
    const { folders } = await this.request('GET', '/folders');
    return folders ?? [];
  }

  /**
   * @param {string} title
   * @returns {Promise<number>} The identifier of the new folder.
   */
  async createFolder(title) {
    const { folderId } = await this.request('PUT', '/folders', { folder: { title } });
    return folderId;
  }

  /** @param {number} folderId */
  async deleteFolder(folderId) {
    await this.request('DELETE', `/folders/${folderId}`);
  }

  /**
   * Lists every job of the account. Fails when the API reports that the list is incomplete, since a missing job would
   * be created again (or left behind when deleting its folder).
   *
   * @returns {Promise<Array<{ jobId: number, title: string, folderId: number, enabled: boolean }>>}
   */
  async listJobs() {
    const { jobs, someFailed } = await this.request('GET', '/jobs');

    if (someFailed) {
      throw new Error('cron-job.org could not list all the jobs of the account (internal error): try again later.');
    }

    return jobs ?? [];
  }

  /**
   * @param {Record<string, unknown>} job
   * @returns {Promise<number>} The identifier of the new job.
   */
  async createJob(job) {
    const { jobId } = await this.request('PUT', '/jobs', { job });
    return jobId;
  }

  /**
   * @param {number} jobId
   * @param {Record<string, unknown>} job The fields to change.
   */
  async updateJob(jobId, job) {
    await this.request('PATCH', `/jobs/${jobId}`, { job });
  }

  /** @param {number} jobId */
  async deleteJob(jobId) {
    await this.request('DELETE', `/jobs/${jobId}`);
  }

  /**
   * Sends a request to the API, waiting for its rate limits first, and retrying it when it is rejected by a rate
   * limit or by a temporary error. A creation (`PUT`) is retried only when rejected by a rate limit, since after
   * other errors it may have succeeded, and would then be duplicated.
   *
   * @param {string} method
   * @param {string} path
   * @param {unknown} [payload]
   * @returns {Promise<any>} The decoded response.
   */
  async request(method, path, payload) {
    const isCreation = method === 'PUT';

    for (let attempt = 0; ; attempt++) {
      await this.waitForRateLimits(method, path);

      let response;
      try {
        response = await fetch(`${this.apiUrl}${path}`, {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: payload === undefined ? undefined : JSON.stringify(payload),
          signal: AbortSignal.timeout(this.timeout),
        });
      } catch (error) {
        if (isCreation || attempt >= this.retries) {
          throw new Error(`cron-job.org API: ${method} ${path} failed: ${error.message}`, { cause: error });
        }

        const wait = backoff(attempt);
        this.log(`${method} ${path} failed (${error.message}): retrying in ${wait / 1000}s...`);
        await this.sleep(wait);
        continue;
      }

      const body = await response.text();

      if (response.ok) {
        try {
          return body.trim() ? JSON.parse(body) : {};
        } catch {
          throw new Error(`cron-job.org API: ${method} ${path} returned an invalid response: ${body.slice(0, 500)}`);
        }
      }

      const isRetryable = response.status === 429 || (!isCreation && RETRYABLE_STATUSES.includes(response.status));
      if (!isRetryable || attempt >= this.retries) {
        throw new CronJobOrgError(method, path, response.status, body);
      }

      const wait = retryAfter(response.headers.get('retry-after'), this.now()) ?? backoff(attempt);
      this.log(`${method} ${path} was rejected with HTTP ${response.status}: retrying in ${wait / 1000}s...`);
      await this.sleep(wait);
    }
  }

  /**
   * Waits until a request can be sent without exceeding the rate limits of its method, then records it.
   *
   * @param {string} method
   * @param {string} path
   */
  async waitForRateLimits(method, path) {
    const key = `${method} ${path.replace(/^(\/[^/]+).*$/, '$1')}`;
    const limits = RATE_LIMITS[key] ?? DEFAULT_RATE_LIMITS;
    const longestPeriod = Math.max(...limits.map(({ period }) => period));
    const history = this.history.get(key) ?? [];

    for (;;) {
      const now = this.now();
      let wait = 0;

      for (const { count, period } of limits) {
        const recent = history.filter((time) => time > now - period - RATE_LIMIT_MARGIN);
        if (recent.length >= count) {
          wait = Math.max(wait, recent[recent.length - count] + period + RATE_LIMIT_MARGIN - now);
        }
      }

      if (wait <= 0) {
        break;
      }
      await this.sleep(wait);
    }

    const now = this.now();
    this.history.set(key, [...history.filter((time) => time > now - longestPeriod - RATE_LIMIT_MARGIN), now]);
  }
}

/**
 * @param {number} attempt
 * @returns {number} The wait before the next attempt, in milliseconds: 2, 4, 8, 16... seconds, at most a minute.
 */
function backoff(attempt) {
  return Math.min(2_000 * 2 ** attempt, 60_000);
}

/**
 * @param {string|null} header The `Retry-After` header: a number of seconds, or a date.
 * @param {number} now
 * @returns {number|undefined} The wait it asks for, in milliseconds (at most 2 minutes).
 */
function retryAfter(header, now) {
  if (!header) {
    return undefined;
  }

  const seconds = Number(header);
  const wait = Number.isFinite(seconds) ? seconds * 1_000 : Date.parse(header) - now;

  return Number.isFinite(wait) ? Math.min(Math.max(wait, 1_000), 120_000) : undefined;
}
