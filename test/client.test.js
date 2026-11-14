import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { CronJobOrgClient, CronJobOrgError } from '../src/client.js';
import { API_KEY, FakeApi, virtualClock } from './fake-api.js';

describe('CronJobOrgClient', () => {
  let api;
  let apiUrl;
  let clock;
  let client;

  before(async () => {
    api = new FakeApi();
    apiUrl = await api.start();
  });

  after(async () => {
    await api.stop();
  });

  beforeEach(() => {
    Object.assign(api, new FakeApi(), { server: api.server });
    clock = virtualClock();
    client = new CronJobOrgClient({ apiKey: API_KEY, apiUrl: `${apiUrl}/`, sleep: clock.sleep, now: clock.now });
  });

  it('requires an API key', () => {
    assert.throws(() => new CronJobOrgClient({ apiKey: '' }), /API key of cron-job.org is missing/);
  });

  it('authenticates with the API key and sends JSON', async () => {
    const folderId = await client.createFolder('Backups');

    assert.deepEqual(api.folders, [{ folderId, title: 'Backups' }]);
    assert.deepEqual(api.requests, [{ method: 'PUT', path: '/folders', body: { folder: { title: 'Backups' } } }]);
  });

  it('reports the errors of the API with their status', async () => {
    const unauthorized = new CronJobOrgClient({ apiKey: 'wrong', apiUrl, sleep: clock.sleep, now: clock.now });

    await assert.rejects(unauthorized.listFolders(), (error) => {
      assert.ok(error instanceof CronJobOrgError);
      assert.equal(error.status, 401);
      assert.match(error.message, /GET \/folders failed with HTTP 401 \(invalid API key\): \{"error":"Unauthorized"\}/);
      return true;
    });
  });

  it('retries the requests rejected by a rate limit, waiting as asked by Retry-After', async () => {
    api.failNext('GET', /^\/jobs$/, 429, { headers: { 'Retry-After': '7' } });
    api.failNext('GET', /^\/jobs$/, 429);
    api.addJob({ title: 'Ping' });

    const jobs = await client.listJobs();

    assert.deepEqual(jobs.map(({ title }) => title), ['Ping']);
    assert.deepEqual(api.calls, ['GET /jobs', 'GET /jobs', 'GET /jobs']);
    // Retry-After first, then the backoff
    assert.ok(clock.slept.includes(7_000));
    assert.ok(clock.slept.includes(4_000));
  });

  it('retries a creation rejected by a rate limit', async () => {
    api.failNext('PUT', /^\/jobs$/, 429);

    const jobId = await client.createJob({ url: 'https://example.com/' });

    assert.deepEqual(api.jobs.map((job) => job.jobId), [jobId]);
    assert.deepEqual(api.calls, ['PUT /jobs', 'PUT /jobs']);
  });

  it('retries the other requests after temporary errors, but not the creations', async () => {
    api.failNext('GET', /^\/folders$/, 503);
    assert.deepEqual(await client.listFolders(), []);
    assert.deepEqual(api.calls, ['GET /folders', 'GET /folders']);

    api.failNext('PUT', /^\/jobs$/, 500);
    await assert.rejects(client.createJob({ url: 'https://example.com/' }), (error) => error.status === 500);
    assert.equal(api.jobs.length, 0);
  });

  it('gives up after the last retry', async () => {
    for (let i = 0; i < 5; i++) {
      api.failNext('GET', /^\/folders$/, 429);
    }

    await assert.rejects(client.listFolders(), (error) => error.status === 429);
    assert.equal(api.calls.length, 5);
  });

  it('does not retry the other errors', async () => {
    api.failNext('PATCH', /^\/jobs\/1$/, 400);

    await assert.rejects(client.updateJob(1, { enabled: true }), (error) => error.status === 400);
    assert.deepEqual(api.calls, ['PATCH /jobs/1']);
  });

  it('fails when the API reports that the list of jobs is incomplete', async () => {
    api.someFailed = true;

    await assert.rejects(client.listJobs(), /could not list all the jobs/);
  });

  it('respects the rate limits of the job creations: 1 per second and 5 per minute', async () => {
    const start = clock.now();
    const times = [];

    for (let i = 0; i < 6; i++) {
      await client.createJob({ url: `https://example.com/${i}` });
      times.push(clock.now() - start);
    }

    for (let i = 1; i < times.length; i++) {
      assert.ok(times[i] - times[i - 1] >= 1_000, `creation #${i + 1} only ${times[i] - times[i - 1]}ms after the previous one`);
    }
    assert.ok(times[5] - times[0] >= 60_000, `6th creation only ${times[5] - times[0]}ms after the first one`);
    assert.equal(api.jobs.length, 6);
  });

  it('respects the rate limit of the other methods: 5 per second', async () => {
    const start = clock.now();

    for (let i = 0; i < 6; i++) {
      await client.listFolders();
    }

    assert.ok(clock.now() - start >= 1_000);
    assert.ok(clock.now() - start < 2_000);
  });

  it('does not slow down the methods that have no common rate limit', async () => {
    await client.createFolder('A');
    await client.listFolders();
    await client.listJobs();

    assert.deepEqual(clock.slept, []);
  });
});
