import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import { CronJobOrgClient } from '../src/client.js';
import { applyJobs, deleteFolders, formatNextRuns, listFolders } from '../src/commands.js';
import { API_KEY, FakeApi, virtualClock } from './fake-api.js';

const FOLDER = '(Preview) PR-42';
// Saturday 14 November 2026, 22:58 in Rome
const NOW = Date.UTC(2026, 10, 14, 21, 58);

const JOBS = [
  {
    title: 'Schedule run',
    url: 'https://pr-42.example.com/cron/schedule',
    method: 'POST',
    schedule: '*/5 8-22 * * 1-5',
    headers: { 'X-Cron-Token': 'first-token' },
  },
  {
    title: 'Queue run',
    url: 'https://pr-42.example.com/cron/queue',
    method: 'POST',
    schedule: '*/5 8-22 * * 1-5',
    headers: { 'X-Cron-Token': 'first-token' },
  },
];

const ONLY_READS = (calls) => calls.every((call) => call.startsWith('GET '));

describe('commands', () => {
  let api;
  let apiUrl;
  let client;
  let logs;
  let logger;

  /** @param {Record<string, unknown>} [options] */
  const apply = (options = {}) =>
    applyJobs(client, { folder: FOLDER, jobs: JOBS, timezone: 'Europe/Rome', prune: true, now: NOW, logger, ...options });

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
      const result = await apply();
      const { folderId } = result.folder;

      assert.deepEqual(api.folders, [{ folderId, title: FOLDER }]);
      assert.deepEqual(result.folder, { title: FOLDER, folderId, created: true });
      assert.equal(result.dryRun, false);
      assert.deepEqual(
        api.jobs.map((job) => [job.title, job.folderId]),
        [
          ['Schedule run', folderId],
          ['Queue run', folderId],
        ],
      );

      const [schedule] = api.jobs;
      assert.equal(schedule.url, 'https://pr-42.example.com/cron/schedule');
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

      assert.deepEqual(result.jobs[0], {
        title: 'Schedule run',
        jobId: api.jobs[0].jobId,
        change: 'create',
        enabled: true,
        schedule: 'Every 5 minutes, between 08:00 and 22:59, Monday through Friday (Europe/Rome)',
        nextRuns: ['Mon 16 Nov 08:00', 'Mon 16 Nov 08:05', 'Mon 16 Nov 08:10'],
      });
      assert.deepEqual(api.calls, ['GET /folders', 'PUT /folders', 'GET /jobs', 'PUT /jobs', 'PUT /jobs']);
      assert.deepEqual(logs.slice(0, 4), [
        `Created the folder "${FOLDER}" (#${folderId}).`,
        `Created the job "Schedule run" (#${api.jobs[0].jobId}).`,
        '  Schedule: Every 5 minutes, between 08:00 and 22:59, Monday through Friday (Europe/Rome)',
        '  Next runs: Mon 16 Nov 08:00, Mon 16 Nov 08:05, Mon 16 Nov 08:10',
      ]);
    });

    it('updates the existing jobs on the next runs, instead of creating them again', async () => {
      const first = await apply();
      api.requests = [];

      const jobs = JOBS.map((job) => ({ ...job, headers: { 'X-Cron-Token': 'second-token' } }));
      const second = await apply({ jobs });

      assert.equal(second.folder.folderId, first.folder.folderId);
      assert.equal(second.folder.created, false);
      assert.deepEqual(
        second.jobs.map(({ jobId, change }) => [jobId, change]),
        first.jobs.map(({ jobId }) => [jobId, 'update']),
      );
      assert.equal(api.folders.length, 1);
      assert.deepEqual(
        api.jobs.map((job) => job.extendedData.headers),
        [{ 'X-Cron-Token': 'second-token' }, { 'X-Cron-Token': 'second-token' }],
      );
      assert.deepEqual(api.calls, [
        'GET /folders',
        'GET /jobs',
        `PATCH /jobs/${first.jobs[0].jobId}`,
        `PATCH /jobs/${first.jobs[1].jobId}`,
      ]);
    });

    it('identifies the jobs by their title within the folder only', async () => {
      const other = api.addFolder('Other');
      const otherJob = api.addJob({ title: 'Schedule run', folderId: other.folderId });
      const rootJob = api.addJob({ title: 'Queue run', folderId: 0 });

      const { jobs } = await apply();

      assert.deepEqual(jobs.map(({ change }) => change), ['create', 'create']);
      assert.ok(!jobs.some(({ jobId }) => jobId === otherJob.jobId || jobId === rootJob.jobId));
      assert.equal(api.jobs.length, 4);
      assert.equal(otherJob.url, 'https://example.com/');
    });

    it('deletes the jobs of the folder that are no longer listed, and the duplicates', async () => {
      const folder = api.addFolder(FOLDER);
      const kept = api.addJob({ title: 'Schedule run', folderId: folder.folderId });
      const duplicate = api.addJob({ title: 'Schedule run', folderId: folder.folderId });
      const removed = api.addJob({ title: 'Old job', folderId: folder.folderId });

      const { jobs } = await apply({ jobs: [JOBS[0]] });

      assert.deepEqual(
        jobs.map(({ title, jobId, change }) => [title, jobId, change]),
        [
          ['Schedule run', duplicate.jobId, 'delete'],
          ['Old job', removed.jobId, 'delete'],
          ['Schedule run', kept.jobId, 'update'],
        ],
      );
      assert.deepEqual(api.jobs.map((job) => job.jobId), [kept.jobId]);
      assert.ok(logs.includes(`Deleted the job "Old job" (#${removed.jobId}), no longer listed.`));
    });

    it('keeps the jobs that are not listed without prune, with a warning', async () => {
      const folder = api.addFolder(FOLDER);
      const unlisted = api.addJob({ title: 'Manual job', folderId: folder.folderId });

      const { jobs } = await apply({ prune: false });

      assert.equal(api.jobs.length, 3);
      assert.deepEqual(jobs[0], { title: 'Manual job', jobId: unlisted.jobId, change: 'keep' });
      assert.ok(logs.includes(`WARNING: The job "Manual job" (#${unlisted.jobId}) of the folder "${FOLDER}" is not listed: it is kept.`));
    });

    it('deletes every job of the folder when no job is listed', async () => {
      await apply();
      await apply({ jobs: [] });

      assert.equal(api.folders.length, 1);
      assert.deepEqual(api.jobs, []);
    });

    it('uses the folder created in the meantime by another run', async () => {
      let concurrent;
      api.failNext('PUT', /^\/folders$/, 409, { effect: () => (concurrent = api.addFolder(FOLDER)) });

      const { folder } = await apply();

      assert.deepEqual(folder, { title: FOLDER, folderId: concurrent.folderId, created: false });
      assert.equal(api.folders.length, 1);
    });

    it('describes the schedule objects, and the disabled jobs', async () => {
      const { jobs } = await apply({
        jobs: [
          { title: 'Nightly', url: 'https://a.b/', schedule: { minutes: [30], hours: [2] } },
          { title: 'Paused', url: 'https://a.b/', schedule: '0 * * * *', enabled: false, timezone: 'UTC' },
        ],
      });

      assert.equal(jobs[0].schedule, 'At 02:30 (Europe/Rome)');
      assert.deepEqual(jobs[0].nextRuns, ['Sun 15 Nov 02:30', 'Mon 16 Nov 02:30', 'Tue 17 Nov 02:30']);
      assert.equal(jobs[1].schedule, 'Every hour (UTC)');
      assert.equal(formatNextRuns(jobs[1]), 'none (disabled)');
    });

    describe('with dryRun', () => {
      it('only reads, and plans the creation of a missing folder and of its jobs', async () => {
        const result = await apply({ dryRun: true });

        assert.deepEqual(api.calls, ['GET /folders']);
        assert.deepEqual(api.folders, []);
        assert.deepEqual(result.folder, { title: FOLDER, folderId: null, created: true });
        assert.equal(result.dryRun, true);
        assert.deepEqual(
          result.jobs.map(({ title, jobId, change }) => [title, jobId, change]),
          [
            ['Schedule run', null, 'create'],
            ['Queue run', null, 'create'],
          ],
        );
        assert.deepEqual(result.jobs[0].nextRuns, ['Mon 16 Nov 08:00', 'Mon 16 Nov 08:05', 'Mon 16 Nov 08:10']);
        assert.deepEqual(logs.slice(0, 2), [`Would create the folder "${FOLDER}".`, 'Would create the job "Schedule run".']);
      });

      it('plans the updates and the deletions of an existing folder', async () => {
        await apply();
        const unlisted = api.addJob({ title: 'Old job', folderId: api.folders[0].folderId });
        const before = structuredClone(api.jobs);
        api.requests = [];

        const result = await apply({ dryRun: true, jobs: [JOBS[0], { ...JOBS[1], title: 'New job' }] });

        assert.ok(ONLY_READS(api.calls), api.calls.join(', '));
        assert.deepEqual(api.jobs, before);
        assert.deepEqual(
          result.jobs.map(({ title, change }) => [title, change]),
          [
            ['Queue run', 'delete'],
            ['Old job', 'delete'],
            ['Schedule run', 'update'],
            ['New job', 'create'],
          ],
        );
        assert.ok(logs.includes(`Would delete the job "Old job" (#${unlisted.jobId}), no longer listed.`));
      });
    });

    it('rejects an invalid folder title before any request', async () => {
      for (const [folder, message] of [
        ['', /title of the folder cannot be empty/],
        ['x'.repeat(129), /longer than 128 characters/],
        ['(Preview) PR-*', /wildcards are only supported by the delete command/],
      ]) {
        await assert.rejects(apply({ folder }), message);
      }
      assert.deepEqual(api.requests, []);
    });
  });

  describe('deleteFolders', () => {
    it('deletes the folders together with their jobs', async () => {
      await apply();
      const other = api.addFolder('Other');
      const otherJob = api.addJob({ title: 'Schedule run', folderId: other.folderId });
      const rootJob = api.addJob({ title: 'Root job' });
      const [folder] = api.folders;
      const jobs = api.jobs.filter((job) => job.folderId === folder.folderId).map(({ jobId, title }) => ({ jobId, title }));
      logs = [];

      const result = await deleteFolders(client, { folders: [FOLDER, FOLDER], logger });

      assert.deepEqual(result, { folders: [{ folderId: folder.folderId, title: FOLDER, jobs }], dryRun: false });
      assert.deepEqual(api.folders, [other]);
      assert.deepEqual(api.jobs, [otherJob, rootJob]);
      assert.equal(logs.at(-1), `Deleted the folder "${FOLDER}" (#${folder.folderId}).`);
    });

    it('skips the folders that do not exist', async () => {
      const folder = api.addFolder('(Preview) PR-1');
      api.addJob({ title: 'Ping', folderId: folder.folderId });

      const { folders } = await deleteFolders(client, { folders: ['(Preview) PR-1', '(Preview) PR-2'], logger });

      assert.deepEqual(folders.map(({ title }) => title), ['(Preview) PR-1']);
      assert.deepEqual(api.folders, []);
      assert.deepEqual(api.jobs, []);
      assert.ok(logs.includes('The folder "(Preview) PR-2" does not exist: nothing to delete.'));
    });

    it('sends no other request when no folder exists', async () => {
      assert.deepEqual(await deleteFolders(client, { folders: [FOLDER], logger }), { folders: [], dryRun: false });
      assert.deepEqual(api.calls, ['GET /folders']);
    });

    it('deletes the folders matching a wildcard, except the excluded ones', async () => {
      for (const title of ['(Preview) PR-1', '(Preview) PR-2', '(Preview) PR-10', 'Production', '(Preview)PR-3']) {
        api.addJob({ title: 'Ping', folderId: api.addFolder(title).folderId });
      }

      const { folders } = await deleteFolders(client, {
        folders: ['(Preview) PR-*'],
        exclude: ['(Preview) PR-2', '(Preview) PR-1?'],
        logger,
      });

      assert.deepEqual(folders.map(({ title }) => title), ['(Preview) PR-1', '(Preview) PR-10']);
      assert.deepEqual(api.folders.map(({ title }) => title), ['(Preview) PR-2', 'Production', '(Preview)PR-3']);
      assert.ok(logs.includes('Kept the folder "(Preview) PR-2" (excluded).'));
    });

    it('treats the other special characters of the titles literally', async () => {
      api.addFolder('Backups (old)');
      api.addFolder('Backups xoldx');

      const { folders } = await deleteFolders(client, { folders: ['Backups (old)', 'B.ckups*'], logger });

      assert.deepEqual(folders.map(({ title }) => title), ['Backups (old)']);
      assert.ok(logs.includes('No folder matches "B.ckups*": nothing to delete.'));
    });

    it('only reads with dryRun', async () => {
      await apply();
      const before = { folders: structuredClone(api.folders), jobs: structuredClone(api.jobs) };
      api.requests = [];
      logs = [];

      const result = await deleteFolders(client, { folders: ['(Preview) *'], dryRun: true, logger });

      assert.deepEqual(api.calls, ['GET /folders', 'GET /jobs']);
      assert.deepEqual({ folders: api.folders, jobs: api.jobs }, before);
      assert.equal(result.dryRun, true);
      assert.deepEqual(result.folders[0].jobs.map(({ title }) => title), ['Schedule run', 'Queue run']);
      assert.equal(logs.at(-1), `Would delete the folder "${FOLDER}" (#${before.folders[0].folderId}).`);
    });

    it('ignores the jobs already deleted', async () => {
      await apply();
      api.failNext('DELETE', /^\/jobs\/\d+$/, 404);

      await deleteFolders(client, { folders: [FOLDER], logger });

      assert.deepEqual(api.folders, []);
    });

    it('does not delete the folder when one of its jobs cannot be deleted', async () => {
      await apply();
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

  it('counts the requests sent, retries included', async () => {
    api.failNext('GET', /^\/folders$/, 429);

    await listFolders(client);

    assert.equal(client.requestCount, 2);
  });
});
