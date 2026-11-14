/**
 * The action: reads its inputs, runs its command and sets its outputs.
 */
import { CronJobOrgClient, DEFAULT_API_URL } from './client.js';
import { applyJobs, deleteFolders, listFolders } from './commands.js';
import { getBooleanInput, getInput, group, info, setOutput, warning } from './github.js';
import { parseJobs, validateTimezone } from './jobs.js';

const COMMANDS = ['apply', 'delete', 'list'];

/**
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function run(env = process.env) {
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

  if (command === 'apply') {
    const folders = getFolders(env);
    if (folders.length !== 1) {
      throw new Error('The "apply" command needs exactly one folder in the "folder" input.');
    }

    const timezone = getInput('timezone', { env }) || 'UTC';
    validateTimezone(timezone);

    // Validated before any request, so that a mistake changes nothing
    const jobs = parseJobs(getInput('jobs', { required: true, env }));
    const prune = getBooleanInput('prune', { defaultValue: true, env });

    const { folderId, jobIds } = await group(`Applying the jobs of the folder "${folders[0]}"`, () =>
      applyJobs(client, { folder: folders[0], jobs, timezone, prune, logger }),
    );

    setOutput('folder-id', String(folderId), env);
    setOutput('job-ids', JSON.stringify(jobIds), env);
  } else if (command === 'delete') {
    const folders = getFolders(env);
    if (folders.length === 0) {
      throw new Error('The "delete" command needs at least one folder in the "folder" input.');
    }

    const deleted = await group('Deleting the folders and their jobs', () => deleteFolders(client, { folders, logger }));

    setOutput('folders', JSON.stringify(deleted), env);
  } else {
    setOutput('folders', JSON.stringify(await listFolders(client)), env);
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {string[]} The titles of the folders: one per line of the `folder` input.
 */
function getFolders(env) {
  return getInput('folder', { env })
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}
