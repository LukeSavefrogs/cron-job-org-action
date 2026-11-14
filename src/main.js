/**
 * The action: reads its inputs, runs its command and sets its outputs.
 */
import { CronJobOrgClient, DEFAULT_API_URL } from './client.js';
import { applyJobs, deleteFolders, listFolders } from './commands.js';
import { appendSummary, getBooleanInput, getInput, group, info, setOutput, warning } from './github.js';
import { parseJobDefaults, parseJobs, validateTimezone } from './jobs.js';
import { renderApplySummary, renderDeleteSummary } from './summary.js';

const COMMANDS = ['apply', 'delete', 'list'];

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ now?: number }} [options] `now`: time from which the next runs are computed.
 */
export async function run(env = process.env, { now = Date.now() } = {}) {
  const command = getInput('command', { env }) || 'apply';
  if (!COMMANDS.includes(command)) {
    throw new Error(`The "command" input must be one of ${COMMANDS.join(', ')}, not "${command}".`);
  }

  const client = new CronJobOrgClient({
    apiKey: getInput('api-key', { required: true, env }),
    apiUrl: getInput('api-url', { env }) || DEFAULT_API_URL,
    log: info,
  });
  const logger = { info, warning };
  const dryRun = getBooleanInput('dry-run', { env });

  if (command === 'apply') {
    const folders = getLines('folder', env);
    if (folders.length !== 1) {
      throw new Error('The "apply" command needs exactly one folder in the "folder" input.');
    }

    const timezone = getInput('timezone', { env }) || 'UTC';
    validateTimezone(timezone);

    // Validated before any request, so that a mistake changes nothing
    const defaults = parseJobDefaults({
      baseUrl: getInput('base-url', { env }),
      schedule: getInput('schedule', { env }),
      method: getInput('method', { env }),
      headers: getInput('headers', { env }),
    });
    const jobs = parseJobs(getInput('jobs', { required: true, env }), defaults);
    const prune = getBooleanInput('prune', { defaultValue: true, env });

    const result = await group(`${dryRun ? 'Planning' : 'Applying'} the jobs of the folder "${folders[0]}"`, () =>
      applyJobs(client, { folder: folders[0], jobs, timezone, prune, dryRun, now, logger }),
    );

    const titles = (change) => JSON.stringify(result.jobs.filter((job) => job.change === change).map((job) => job.title));
    const jobIds = result.jobs
      .filter((job) => (job.change === 'create' || job.change === 'update') && job.jobId !== null)
      .map((job) => [job.title, job.jobId]);

    setOutput('folder-id', result.folder.folderId === null ? '' : String(result.folder.folderId), env);
    setOutput('job-ids', JSON.stringify(Object.fromEntries(jobIds)), env);
    setOutput('created', titles('create'), env);
    setOutput('updated', titles('update'), env);
    setOutput('deleted', titles('delete'), env);
    appendSummary(renderApplySummary(result, client), env);
  } else if (command === 'delete') {
    const folders = getLines('folder', env);
    if (folders.length === 0) {
      throw new Error('The "delete" command needs at least one folder in the "folder" input.');
    }

    const result = await group(`${dryRun ? 'Planning the deletion of' : 'Deleting'} the folders and their jobs`, () =>
      deleteFolders(client, { folders, exclude: getLines('exclude', env), dryRun, logger }),
    );

    setOutput('folders', JSON.stringify(result.folders.map(({ folderId, title }) => ({ folderId, title }))), env);
    appendSummary(renderDeleteSummary(result, client), env);
  } else {
    setOutput('folders', JSON.stringify(await listFolders(client)), env);
  }

  info(`${client.requestCount} ${client.requestCount === 1 ? 'request' : 'requests'} sent to the cron-job.org API.`);
}

/**
 * @param {string} name
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]} The non-empty lines of the input, trimmed.
 */
function getLines(name, env) {
  return getInput(name, { env })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
