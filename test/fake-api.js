/**
 * In-memory fake of the cron-job.org REST API (https://docs.cron-job.org/rest-api.html), served on localhost.
 */
import { createServer } from 'node:http';

export const API_KEY = 'test-api-key';

/** Fields of the `Job` objects returned by `GET /jobs` (the others are only in the job details). */
const JOB_FIELDS = [
  'jobId',
  'enabled',
  'title',
  'saveResponses',
  'url',
  'lastStatus',
  'lastDuration',
  'lastExecution',
  'nextExecution',
  'type',
  'requestTimeout',
  'redirectSuccess',
  'folderId',
  'schedule',
  'requestMethod',
];

export class FakeApi {
  constructor() {
    /** @type {Array<{ folderId: number, title: string }>} */
    this.folders = [];
    /** @type {Array<Record<string, any>>} */
    this.jobs = [];
    /** @type {Array<{ method: string, path: string, body: any }>} */
    this.requests = [];
    /** @type {Array<{ method: string, path: RegExp, status: number, headers: Record<string, string>, body: string, effect?: () => void }>} */
    this.failures = [];
    this.someFailed = false;
    this.nextId = 1000;
  }

  /** @returns {Promise<string>} The URL of the API. */
  async start() {
    this.server = createServer((request, response) => this.handle(request, response));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${this.server.address().port}`;
  }

  async stop() {
    await new Promise((resolve) => this.server.close(resolve));
  }

  addFolder(title) {
    const folder = { folderId: this.nextId++, title };
    this.folders.push(folder);
    return folder;
  }

  addJob(fields) {
    const job = {
      jobId: this.nextId++,
      enabled: false,
      title: '',
      folderId: 0,
      url: 'https://example.com/',
      extendedData: { headers: {}, body: '' },
      ...fields,
    };
    this.jobs.push(job);
    return job;
  }

  /**
   * Makes the next request matching the method and path fail with the status.
   *
   * @param {string} method
   * @param {RegExp} path
   * @param {number} status
   * @param {{ headers?: Record<string, string>, body?: string, effect?: () => void }} [options] The headers and body of
   *   the response, and a change of the state made when it is sent (e.g. by a concurrent client).
   */
  failNext(method, path, status, { headers = {}, body = '{"error": "simulated"}', effect } = {}) {
    this.failures.push({ method, path, status, headers, body, effect });
  }

  /** @returns {string[]} The requests received, as `METHOD /path`. */
  get calls() {
    return this.requests.map(({ method, path }) => `${method} ${path}`);
  }

  handle(request, response) {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const send = (status, payload, headers = {}) => {
        response.writeHead(status, { 'Content-Type': 'application/json', ...headers });
        response.end(typeof payload === 'string' ? payload : JSON.stringify(payload));
      };

      const { method } = request;
      const path = request.url;
      const body = raw && request.headers['content-type'] === 'application/json' ? JSON.parse(raw) : undefined;
      this.requests.push({ method, path, body });

      if (request.headers.authorization !== `Bearer ${API_KEY}`) {
        return send(401, { error: 'Unauthorized' });
      }

      const failure = this.failures.findIndex((item) => item.method === method && item.path.test(path));
      if (failure !== -1) {
        const [{ status, headers, body: failureBody, effect }] = this.failures.splice(failure, 1);
        effect?.();
        return send(status, failureBody, headers);
      }

      const [, collection, id] = /^\/(jobs|folders)(?:\/(\d+))?$/.exec(path) ?? [];
      const route = `${method} /${collection}${id ? '/:id' : ''}`;

      switch (route) {
        case 'GET /folders':
          return send(200, { folders: this.folders });
        case 'PUT /folders': {
          const title = body?.folder?.title;
          if (!title || title.length > 128) {
            return send(400, { error: 'Invalid title' });
          }
          if (this.folders.some((folder) => folder.title === title)) {
            return send(409, { error: 'Folder already exists' });
          }
          return send(200, { folderId: this.addFolder(title).folderId });
        }
        case 'DELETE /folders/:id': {
          const index = this.folders.findIndex((folder) => folder.folderId === Number(id));
          if (index === -1) {
            return send(404, { error: 'Not found' });
          }
          this.folders.splice(index, 1);
          // As documented: the jobs of the folder are moved to the root folder
          this.jobs.filter((job) => job.folderId === Number(id)).forEach((job) => (job.folderId = 0));
          return send(200, {});
        }
        case 'GET /jobs':
          return send(200, {
            jobs: this.jobs.map((job) => Object.fromEntries(JOB_FIELDS.filter((key) => key in job).map((key) => [key, job[key]]))),
            someFailed: this.someFailed,
          });
        case 'PUT /jobs': {
          if (!body?.job?.url) {
            return send(400, { error: 'URL is mandatory' });
          }
          return send(200, { jobId: this.addJob(body.job).jobId });
        }
        case 'PATCH /jobs/:id': {
          const job = this.jobs.find((item) => item.jobId === Number(id));
          if (!job) {
            return send(404, { error: 'Not found' });
          }
          Object.assign(job, body?.job ?? {}, { jobId: job.jobId });
          return send(200, {});
        }
        case 'DELETE /jobs/:id': {
          const index = this.jobs.findIndex((job) => job.jobId === Number(id));
          if (index === -1) {
            return send(404, { error: 'Not found' });
          }
          this.jobs.splice(index, 1);
          return send(200, {});
        }
        default:
          return send(404, { error: 'Unknown route' });
      }
    });
  }
}

/**
 * A clock that only moves when slept on, so that the rate limits of the client cost no time in the tests.
 *
 * @returns {{ now: () => number, sleep: (ms: number) => Promise<void>, slept: number[] }}
 */
export function virtualClock() {
  let time = 1_700_000_000_000;
  const slept = [];

  return {
    now: () => time,
    sleep: async (ms) => {
      slept.push(ms);
      time += ms;
    },
    slept,
  };
}
