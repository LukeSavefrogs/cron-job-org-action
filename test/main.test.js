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

const ENTRY_POINT = fileURLToPath(new URL('../src/index.js', import.meta.url));

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

  /**
   * @param {Record<string, string>} inputs
   * @returns {NodeJS.ProcessEnv}
   */
  const environment = (inputs) => ({
    GITHUB_OUTPUT: outputFile,
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
    outputFile = join(directory, `output-${Date.now()}-${Math.random()}`);
    writeFileSync(outputFile, '');
  });

  it('applies the jobs of a folder, and sets the identifiers as outputs', async () => {
    const jobs = [
      { title: 'Ping', url: 'https://example.com/ping', schedule: '*/5 8-22 * * 1-5' },
      { title: 'Report', url: 'https://example.com/report', schedule: '0 7 * * MON', timezone: 'UTC' },
    ];

    await run(environment({ folder: '  (Preview) PR-7  \n', jobs: JSON.stringify(jobs), timezone: 'Europe/Rome' }));

    const outputs = readOutputs(outputFile);
    const [folder] = api.folders;
    assert.equal(folder.title, '(Preview) PR-7');
    assert.equal(outputs['folder-id'], String(folder.folderId));
    assert.deepEqual(JSON.parse(outputs['job-ids']), Object.fromEntries(api.jobs.map((job) => [job.title, job.jobId])));
    assert.deepEqual(
      api.jobs.map((job) => job.schedule.timezone),
      ['Europe/Rome', 'UTC'],
    );
  });

  it('keeps the unlisted jobs when prune is false', async () => {
    const folder = api.addFolder('Folder');
    api.addJob({ title: 'Manual', folderId: folder.folderId });

    await run(environment({ folder: 'Folder', jobs: '[]', prune: 'false' }));

    assert.equal(api.jobs.length, 1);
  });

  it('deletes the folders listed one per line', async () => {
    const first = api.addFolder('(Preview) PR-1');
    const second = api.addFolder('(Preview) PR-2');
    api.addJob({ title: 'Ping', folderId: first.folderId });
    const kept = api.addFolder('Kept');

    await run(environment({ command: 'delete', folder: '(Preview) PR-1\n\n(Preview) PR-2\n(Preview) PR-3' }));

    assert.deepEqual(api.folders, [kept]);
    assert.deepEqual(api.jobs, []);
    assert.deepEqual(JSON.parse(readOutputs(outputFile).folders), [first, second]);
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
    ['invalid jobs', { folder: 'A', jobs: '[{"title": "Ping"}]' }, /"url" is required/],
    ['an invalid time zone', { folder: 'A', jobs: '[]', timezone: 'Rome' }, /"Rome" is not a valid time zone/],
    ['an invalid prune', { folder: 'A', jobs: '[]', prune: 'yes' }, /"prune" input must be "true" or "false"/],
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

  it('runs as the entry point of the action', async () => {
    const folder = api.addFolder('Folder');

    await promisify(execFile)(process.execPath, [ENTRY_POINT], { env: environment({ command: 'list' }) });

    assert.deepEqual(JSON.parse(readOutputs(outputFile).folders), [folder]);
  });
});
