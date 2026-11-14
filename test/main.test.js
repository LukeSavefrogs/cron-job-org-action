import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { run } from '../src/main.js';
import { API_KEY, FakeApi } from './fake-api.js';

// The bundle run by GitHub (`npm run build`)
const ENTRY_POINT = fileURLToPath(new URL('../dist/index.js', import.meta.url));
// Saturday 14 November 2026, 22:58 in Rome
const NOW = Date.UTC(2026, 10, 14, 21, 58);

/**
 * Reads the outputs written to the `GITHUB_OUTPUT` file (`name<<delimiter`, value, `delimiter`).
 *
 * @param {string} file
 * @returns {Record<string, string>}
 */
function readOutputs(file) {
  const outputs = {};
  const pattern = /^(.+?)<<(ghadelimiter_[\w-]+)\r?\n([\s\S]*?)\r?\n\2\r?$/gm;
  for (const [, name, , value] of readFileSync(file, 'utf8').matchAll(pattern)) {
    outputs[name] = value;
  }
  return outputs;
}

describe('the action', () => {
  let api;
  let apiUrl;
  let directory;
  let outputFile;
  let summaryFile;

  /**
   * @param {Record<string, string>} inputs
   * @returns {NodeJS.ProcessEnv}
   */
  const environment = (inputs) => ({
    GITHUB_OUTPUT: outputFile,
    GITHUB_STEP_SUMMARY: summaryFile,
    'INPUT_API-KEY': API_KEY,
    'INPUT_API-URL': apiUrl,
    ...Object.fromEntries(Object.entries(inputs).map(([name, value]) => [`INPUT_${name.toUpperCase()}`, value])),
  });

  before(async () => {
    api = new FakeApi();
    apiUrl = await api.start();
    directory = mkdtempSync(join(tmpdir(), 'cron-job-org-action-'));
  });

  after(async () => {
    await api.stop();
    rmSync(directory, { recursive: true, force: true });
  });

  beforeEach(() => {
    Object.assign(api, new FakeApi(), { server: api.server });
    const suffix = `${Date.now()}-${Math.random()}`;
    outputFile = join(directory, `output-${suffix}`);
    summaryFile = join(directory, `summary-${suffix}`);
    writeFileSync(outputFile, '');
    writeFileSync(summaryFile, '');
  });

  it('applies YAML jobs with the shared settings, and reports them', async () => {
    await run(
      environment({
        folder: '  (Preview) PR-7  \n',
        'base-url': 'https://pr-7.example.com',
        schedule: '*/5 8-22 * * 1-5',
        method: 'POST',
        headers: 'X-Cron-Token: s3cr"et: #token',
        timezone: 'Europe/Rome',
        jobs: [
          '- title: Schedule run',
          '  url: /api/artisan/schedule/process',
          '- title: Report',
          '  url: https://reports.example.com/run',
          '  schedule: "0 7 * * MON"',
          '  method: GET',
          '  timezone: UTC',
        ].join('\n'),
      }),
      { now: NOW },
    );

    const [folder] = api.folders;
    const [schedule, report] = api.jobs;
    assert.equal(folder.title, '(Preview) PR-7');
    assert.equal(schedule.url, 'https://pr-7.example.com/api/artisan/schedule/process');
    assert.equal(schedule.requestMethod, 1);
    assert.deepEqual(schedule.extendedData.headers, { 'X-Cron-Token': 's3cr"et: #token' });
    assert.deepEqual(schedule.schedule.wdays, [1, 2, 3, 4, 5]);
    assert.equal(report.url, 'https://reports.example.com/run');
    assert.equal(report.requestMethod, 0);
    assert.equal(report.schedule.timezone, 'UTC');

    const outputs = readOutputs(outputFile);
    assert.equal(outputs['folder-id'], String(folder.folderId));
    assert.deepEqual(JSON.parse(outputs['job-ids']), { 'Schedule run': schedule.jobId, Report: report.jobId });
    assert.deepEqual(JSON.parse(outputs.created), ['Schedule run', 'Report']);
    assert.deepEqual(JSON.parse(outputs.updated), []);
    assert.deepEqual(JSON.parse(outputs.deleted), []);

    assert.equal(
      readFileSync(summaryFile, 'utf8'),
      [
        '### cron-job.org: (Preview) PR-7',
        '',
        `Folder: created (#${folder.folderId})`,
        '',
        '| Job | Change | Schedule | Next runs |',
        '| --- | --- | --- | --- |',
        `| Schedule run (#${schedule.jobId}) | Created | Every 5 minutes, between 08:00 and 22:59, Monday through Friday (Europe/Rome) | Mon 16 Nov 08:00<br>Mon 16 Nov 08:05<br>Mon 16 Nov 08:10 |`,
        `| Report (#${report.jobId}) | Created | At 07:00, only on Monday (UTC) | Mon 16 Nov 07:00<br>Mon 23 Nov 07:00<br>Mon 30 Nov 07:00 |`,
        '',
        '<sub>5 requests to the cron-job.org API (an API key can send 100 a day by default).</sub>',
        '',
        '',
      ].join('\n'),
    );
  });

  it('plans the changes with dry-run, without making them', async () => {
    await run(
      environment({ folder: 'Folder', jobs: '[{"title": "Ping", "url": "https://a.b", "schedule": "@hourly"}]', 'dry-run': 'true' }),
      { now: NOW },
    );

    assert.deepEqual(api.calls, ['GET /folders']);
    const outputs = readOutputs(outputFile);
    assert.equal(outputs['folder-id'], '');
    assert.deepEqual(JSON.parse(outputs['job-ids']), {});
    assert.deepEqual(JSON.parse(outputs.created), ['Ping']);

    const summary = readFileSync(summaryFile, 'utf8');
    assert.match(summary, /^### cron-job\.org: Folder \(dry run\)\n\nFolder: would be created\n/);
    assert.match(summary, /\| Ping \| Would create \| Every hour \(UTC\) \| Sat 14 Nov 22:00<br>Sat 14 Nov 23:00<br>Sun 15 Nov 00:00 \|/);
  });

  it('keeps the unlisted jobs when prune is false', async () => {
    const folder = api.addFolder('Folder');
    api.addJob({ title: 'Manual', folderId: folder.folderId });

    await run(environment({ folder: 'Folder', jobs: '[]', prune: 'false' }), { now: NOW });

    assert.equal(api.jobs.length, 1);
    assert.match(readFileSync(summaryFile, 'utf8'), /\| Manual \(#\d+\) \| Kept \(not listed\) \|  \|  \|/);
  });

  it('deletes the folders listed one per line, with wildcards and exclusions', async () => {
    const first = api.addFolder('(Preview) PR-1');
    const second = api.addFolder('(Preview) PR-2');
    const open = api.addFolder('(Preview) PR-3');
    const job = api.addJob({ title: 'Ping', folderId: first.folderId });
    const kept = api.addFolder('Kept');

    await run(environment({ command: 'delete', folder: '(Preview) PR-*\n\nMissing', exclude: '(Preview) PR-3' }));

    assert.deepEqual(api.folders, [open, kept]);
    assert.deepEqual(api.jobs, []);
    assert.deepEqual(JSON.parse(readOutputs(outputFile).folders), [first, second]);
    assert.match(readFileSync(summaryFile, 'utf8'), new RegExp(`\\| \\(Preview\\) PR-1 \\(#${first.folderId}\\) \\| Ping \\(#${job.jobId}\\) \\|`));
  });

  it('lists the folders', async () => {
    const folder = api.addFolder('Folder');

    await run(environment({ command: 'list' }));

    assert.deepEqual(JSON.parse(readOutputs(outputFile).folders), [folder]);
  });

  for (const [description, inputs, message] of [
    ['an unknown command', { command: 'sync' }, /"command" input must be one of apply, delete, list/],
    ['apply without folder', { jobs: '[]' }, /exactly one folder/],
    ['apply with several folders', { folder: 'A\nB', jobs: '[]' }, /exactly one folder/],
    ['apply without jobs', { folder: 'A' }, /"jobs" input is required/],
    ['invalid jobs', { folder: 'A', jobs: '- title: Ping' }, /Job #1 \("Ping", line 1\): "url" is required/],
    ['invalid YAML', { folder: 'A', jobs: '- title: A\n  title: B' }, /not valid YAML or JSON \(line 2, column 3\)/],
    ['an invalid time zone', { folder: 'A', jobs: '[]', timezone: 'Rome' }, /"Rome" is not a valid time zone/],
    ['an invalid prune', { folder: 'A', jobs: '[]', prune: 'yes' }, /"prune" input must be "true" or "false"/],
    ['an invalid dry-run', { folder: 'A', jobs: '[]', 'dry-run': '1' }, /"dry-run" input must be "true" or "false"/],
    ['an invalid base URL', { folder: 'A', jobs: '[]', 'base-url': 'example.com' }, /"base-url" input must be an HTTP\(S\) URL/],
    ['an invalid schedule', { folder: 'A', jobs: '[]', schedule: '* * *' }, /"schedule" input is not valid/],
    ['an invalid method', { folder: 'A', jobs: '[]', method: 'FETCH' }, /"method" input must be one of/],
    ['an invalid header', { folder: 'A', jobs: '[]', headers: 'no separator' }, /Line 1 of the "headers" input/],
    ['delete without folders', { command: 'delete', folder: '\n' }, /at least one folder/],
  ]) {
    it(`rejects ${description} before any request`, async () => {
      await assert.rejects(run(environment(inputs)), message);
      assert.deepEqual(api.requests, []);
    });
  }

  it('fails the step with an error annotation', async () => {
    await assert.rejects(
      promisify(execFile)(process.execPath, [ENTRY_POINT], {
        env: { ...environment({ command: 'list' }), 'INPUT_API-KEY': '' },
      }),
      (error) => {
        assert.equal(error.code, 1);
        assert.match(error.stdout, /^::error::The "api-key" input is required\.$/m);
        return true;
      },
    );
  });

  it('runs from the bundle', async () => {
    await promisify(execFile)(process.execPath, [ENTRY_POINT], {
      env: environment({
        folder: 'Folder',
        'base-url': 'https://example.com',
        jobs: '- title: Ping\n  url: /ping\n  schedule: "@daily"',
      }),
    });

    assert.deepEqual(api.jobs.map(({ title, url }) => [title, url]), [['Ping', 'https://example.com/ping']]);
    assert.deepEqual(JSON.parse(readOutputs(outputFile).created), ['Ping']);
    assert.match(readFileSync(summaryFile, 'utf8'), /\| Ping \(#\d+\) \| Created \| At 00:00 \(UTC\) \|/);
  });
});
