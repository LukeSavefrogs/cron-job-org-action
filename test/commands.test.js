import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { CronJobOrgClient } from '../src/client.js';
import { applyJobs, deleteFolders, listFolders } from '../src/commands.js';
import { API_KEY, FakeApi, virtualClock } from './fake-api.js';

const FOLDER = '(Preview) PR-42';

const JOBS = [
  {
    title: 'Schedule run',
    url: 'https://pr-42.example.com/api/artisan/schedule/process',
    method: 'POST',
    schedule: '*/5 8-22 * * 1-5',
    headers: { 'X-Cron-Token': 'first-token' },
  },
  {
    title: 'Queue run',
    url: 'https://pr-42.example.com/api/artisan/queue/process',
    method: 'POST',
    schedule: '*/5 8-22 * * 1-5',
    headers: { 'X-Cron-Token': 'first-token' },
  },
];

describe('commands', () => {
  let api;
  let apiUrl;
  let client;
  let logs;
  let logger;

  before(async () => {
    api = new FakeApi();
    apiUrl = await api.start();
  });

  after(async () => {
    await api.stop();
  });

  beforeEach(() => {
    Object.assign(api, new FakeApi(), { server: api.server });
    const clock = virtualClock();
    client = new CronJobOrgClient({ apiKey: API_KEY, apiUrl, sleep: clock.sleep, now: clock.now });
    logs = [];
    logger = {
      info: (message) => logs.push(message),
      warning: (message) => logs.push(`WARNING: ${message}`),
    };
  });

  describe('applyJobs', () => {
    it('creates the folder and its jobs', async () => {
      const { folderId, jobIds } = await applyJobs(client, {
        folder: FOLDER,
        jobs: JOBS,
        timezone: 'Europe/Rome',
        prune: true,
        logger,
      });

      assert.deepEqual(api.folders, [{ folderId, title: FOLDER }]);
      assert.deepEqual(
        api.jobs.map((job) => [job.jobId, job.title, job.folderId]),
        [
          [jobIds['Schedule run'], 'Schedule run', folderId],
          [jobIds['Queue run'], 'Queue run', folderId],
        ],
      );

      const [schedule] = api.jobs;
      assert.equal(schedule.url, 'https://pr-42.example.com/api/artisan/schedule/process');
      assert.equal(schedule.enabled, true);
      assert.equal(schedule.requestMethod, 1);
      assert.deepEqual(schedule.extendedData, { headers: { 'X-Cron-Token': 'first-token' }, body: '' });
      assert.deepEqual(schedule.schedule, {
        timezone: 'Europe/Rome',
        expiresAt: 0,
        minutes: [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55],
        hours: [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22],
        mdays: [-1],
        months: [-1],
        wdays: [1, 2, 3, 4, 5],
      });

      assert.deepEqual(api.calls, ['GET /folders', 'PUT /folders', 'GET /jobs', 'PUT /jobs', 'PUT /jobs']);
      assert.deepEqual(logs, [
        `Created the folder "${FOLDER}" (#${folderId}).`,
        `Created the job "Schedule run" (#${jobIds['Schedule run']}).`,
        `Created the job "Queue run" (#${jobIds['Queue run']}).`,
      ]);
    });

    it('updates the existing jobs on the next runs, instead of creating them again', async () => {
      const first = await applyJobs(client, { folder: FOLDER, jobs: JOBS, timezone: 'UTC', prune: true, logger });
      api.requests = [];

      const jobs = JOBS.map((job) => ({ ...job, headers: { 'X-Cron-Token': 'second-token' } }));
      const second = await applyJobs(client, { folder: FOLDER, jobs, timezone: 'UTC', prune: true, logger });

      assert.deepEqual(second, first);
      assert.equal(api.folders.length, 1);
      assert.equal(api.jobs.length, 2);
      assert.deepEqual(
        api.jobs.map((job) => job.extendedData.headers),
        [{ 'X-Cron-Token': 'second-token' }, { 'X-Cron-Token': 'second-token' }],
      );
      assert.deepEqual(api.calls, [
        'GET /folders',
        'GET /jobs',
        `PATCH /jobs/${first.jobIds['Schedule run']}`,
        `PATCH /jobs/${first.jobIds['Queue run']}`,
      ]);
    });

    it('identifies the jobs by their title within the folder only', async () => {
      const other = api.addFolder('Other');
      const otherJob = api.addJob({ title: 'Schedule run', folderId: other.folderId });
      const rootJob = api.addJob({ title: 'Queue run', folderId: 0 });

      const { jobIds } = await applyJobs(client, { folder: FOLDER, jobs: JOBS, timezone: 'UTC', prune: true, logger });

      assert.notEqual(jobIds['Schedule run'], otherJob.jobId);
      assert.notEqual(jobIds['Queue run'], rootJob.jobId);
      assert.equal(api.jobs.length, 4);
      assert.equal(otherJob.url, 'https://example.com/');
    });

    it('deletes the jobs of the folder that are no longer listed, and the duplicates', async () => {
      const folder = api.addFolder(FOLDER);
      const kept = api.addJob({ title: 'Schedule run', folderId: folder.folderId });
      const duplicate = api.addJob({ title: 'Schedule run', folderId: folder.folderId });
      const removed = api.addJob({ title: 'Old job', folderId: folder.folderId });

      const { jobIds } = await applyJobs(client, {
        folder: FOLDER,
        jobs: [JOBS[0]],
        timezone: 'UTC',
        prune: true,
        logger,
      });

      assert.deepEqual(jobIds, { 'Schedule run': kept.jobId });
      assert.deepEqual(api.jobs.map((job) => job.jobId), [kept.jobId]);
      assert.ok(logs.includes(`Deleted the job "Schedule run" (#${duplicate.jobId}), no longer listed.`));
      assert.ok(logs.includes(`Deleted the job "Old job" (#${removed.jobId}), no longer listed.`));
    });

    it('keeps the jobs that are not listed without prune, with a warning', async () => {
      const folder = api.addFolder(FOLDER);
      const unlisted = api.addJob({ title: 'Manual job', folderId: folder.folderId });

      await applyJobs(client, { folder: FOLDER, jobs: JOBS, timezone: 'UTC', prune: false, logger });

      assert.equal(api.jobs.length, 3);
      assert.ok(api.jobs.includes(unlisted));
      assert.ok(logs.includes(`WARNING: The job "Manual job" (#${unlisted.jobId}) of the folder "${FOLDER}" is not listed: it is kept.`));
    });

    it('deletes every job of the folder when no job is listed', async () => {
      await applyJobs(client, { folder: FOLDER, jobs: JOBS, timezone: 'UTC', prune: true, logger });
      await applyJobs(client, { folder: FOLDER, jobs: [], timezone: 'UTC', prune: true, logger });

      assert.equal(api.folders.length, 1);
      assert.deepEqual(api.jobs, []);
    });

    it('uses the folder created in the meantime by another run', async () => {
      let concurrent;
      api.failNext('PUT', /^\/folders$/, 409, { effect: () => (concurrent = api.addFolder(FOLDER)) });

      const { folderId } = await applyJobs(client, { folder: FOLDER, jobs: JOBS, timezone: 'UTC', prune: true, logger });

      assert.equal(folderId, concurrent.folderId);
      assert.equal(api.folders.length, 1);
    });

    it('rejects an invalid folder title before any request', async () => {
      for (const folder of ['', 'x'.repeat(129)]) {
        await assert.rejects(applyJobs(client, { folder, jobs: JOBS, timezone: 'UTC', prune: true, logger }), /title of the folder/);
      }
      assert.deepEqual(api.requests, []);
    });
  });

  describe('deleteFolders', () => {
    it('deletes the folders together with their jobs', async () => {
      await applyJobs(client, { folder: FOLDER, jobs: JOBS, timezone: 'UTC', prune: true, logger });
      const other = api.addFolder('Other');
      const otherJob = api.addJob({ title: 'Schedule run', folderId: other.folderId });
      const rootJob = api.addJob({ title: 'Root job' });
      const folderId = api.folders[0].folderId;
      logs = [];

      const deleted = await deleteFolders(client, { folders: [FOLDER, FOLDER], logger });

      assert.deepEqual(deleted, [{ folderId, title: FOLDER }]);
      assert.deepEqual(api.folders, [other]);
      assert.deepEqual(api.jobs, [otherJob, rootJob]);
      assert.equal(logs.at(-1), `Deleted the folder "${FOLDER}" (#${folderId}).`);
    });

    it('skips the folders that do not exist', async () => {
      const folder = api.addFolder('(Preview) PR-1');
      api.addJob({ title: 'Ping', folderId: folder.folderId });

      const deleted = await deleteFolders(client, { folders: ['(Preview) PR-1', '(Preview) PR-2'], logger });

      assert.deepEqual(deleted, [folder]);
      assert.deepEqual(api.folders, []);
      assert.deepEqual(api.jobs, []);
      assert.ok(logs.includes('The folder "(Preview) PR-2" does not exist: nothing to delete.'));
    });

    it('sends no other request when no folder exists', async () => {
      assert.deepEqual(await deleteFolders(client, { folders: [FOLDER], logger }), []);
      assert.deepEqual(api.calls, ['GET /folders']);
    });

    it('ignores the jobs already deleted', async () => {
      await applyJobs(client, { folder: FOLDER, jobs: JOBS, timezone: 'UTC', prune: true, logger });
      api.failNext('DELETE', /^\/jobs\/\d+$/, 404);

      await deleteFolders(client, { folders: [FOLDER], logger });

      assert.deepEqual(api.folders, []);
    });

    it('does not delete the folder when one of its jobs cannot be deleted', async () => {
      await applyJobs(client, { folder: FOLDER, jobs: JOBS, timezone: 'UTC', prune: true, logger });
      api.failNext('DELETE', /^\/jobs\/\d+$/, 400);

      await assert.rejects(deleteFolders(client, { folders: [FOLDER], logger }), /HTTP 400/);

      // Otherwise its jobs would be moved to the root folder, out of reach of the next attempts
      assert.equal(api.folders.length, 1);
    });
  });

  describe('listFolders', () => {
    it('lists every folder of the account', async () => {
      const first = api.addFolder('First');
      const second = api.addFolder('Second');

      assert.deepEqual(await listFolders(client), [first, second]);
    });
  });
});
