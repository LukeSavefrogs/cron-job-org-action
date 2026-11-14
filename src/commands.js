/**
 * The commands of the action: each folder of cron-job.org is owned by the action, which keeps its jobs in sync with
 * the ones it is given, identified by their title.
 */
import { CronJobOrgError } from './client.js';
import { describeSchedule, formatRun, nextRuns } from './cron.js';
import { buildJobPayload } from './jobs.js';

/** Maximum length of the title of a folder, set by the API. */
export const MAX_FOLDER_TITLE_LENGTH = 128;

/**
 * @typedef {import('./client.js').CronJobOrgClient} CronJobOrgClient
 * @typedef {import('./jobs.js').JobSpec} JobSpec
 * @typedef {{ info: (message: string) => void, warning: (message: string) => void }} Logger
 *
 * @typedef {object} JobResult
 * @property {string} title
 * @property {number|null} jobId `null` for a job that would be created (dry run).
 * @property {'create'|'update'|'delete'|'keep'} change `keep`: a job of the folder that is not listed, without `prune`.
 * @property {string} [schedule] Description of the schedule, with its time zone (created and updated jobs).
 * @property {string[]|null} [nextRuns] The next runs (`null` when they cannot be computed); empty for a disabled job.
 * @property {boolean} [enabled]
 *
 * @typedef {object} ApplyResult
 * @property {{ title: string, folderId: number|null, created: boolean }} folder `folderId` is `null` for a folder that
 *   would be created (dry run).
 * @property {JobResult[]} jobs
 * @property {boolean} dryRun
 *
 * @typedef {object} DeleteResult
 * @property {Array<{ folderId: number, title: string, jobs: Array<{ jobId: number, title: string }> }>} folders The
 *   deleted folders (or the ones that would be deleted), with their jobs.
 * @property {boolean} dryRun
 */

/**
 * Creates the folder if it does not exist, then creates or updates its jobs, and (with `prune`) deletes the jobs of
 * the folder that are not listed. With `dryRun`, only reads, and returns what would change.
 *
 * @param {CronJobOrgClient} client
 * @param {object} options
 * @param {string} options.folder Title of the folder.
 * @param {JobSpec[]} options.jobs
 * @param {string} options.timezone Time zone of the jobs that do not set theirs.
 * @param {boolean} options.prune
 * @param {boolean} [options.dryRun]
 * @param {number} [options.now] Time from which the next runs are computed.
 * @param {Logger} options.logger
 * @returns {Promise<ApplyResult>}
 */
export async function applyJobs(client, { folder, jobs, timezone, prune, dryRun = false, now = Date.now(), logger }) {
  validateFolderTitle(folder);
  if (folder.includes('*')) {
    throw new Error(`The folder "${folder}" contains "*": wildcards are only supported by the delete command.`);
  }

  const { folderId, created } = await findOrCreateFolder(client, folder, { dryRun, logger });

  // A folder that would be created has no jobs yet
  const existingJobs =
    folderId === null
      ? []
      : (await client.listJobs()).filter((job) => job.folderId === folderId).sort((a, b) => a.jobId - b.jobId);

  /** @type {Map<string, number>} The first job of the folder with each title; the others are duplicates. */
  const existingIds = new Map();
  const unlistedJobs = [];
  for (const job of existingJobs) {
    if (!existingIds.has(job.title) && jobs.some(({ title }) => title === job.title)) {
      existingIds.set(job.title, job.jobId);
    } else {
      unlistedJobs.push(job);
    }
  }

  /** @type {JobResult[]} */
  const results = [];

  // First, so that the account has room for the new jobs
  for (const job of unlistedJobs) {
    if (prune) {
      if (!dryRun) {
        await deleteJob(client, job.jobId);
      }
      logger.info(`${dryRun ? 'Would delete' : 'Deleted'} the job "${job.title}" (#${job.jobId}), no longer listed.`);
      results.push({ title: job.title, jobId: job.jobId, change: 'delete' });
    } else {
      logger.warning(`The job "${job.title}" (#${job.jobId}) of the folder "${folder}" is not listed: it is kept.`);
      results.push({ title: job.title, jobId: job.jobId, change: 'keep' });
    }
  }

  for (const job of jobs) {
    const payload = buildJobPayload(job, { folderId: folderId ?? 0, timezone });
    const existingId = existingIds.get(job.title);
    const change = existingId === undefined ? 'create' : 'update';

    let jobId = existingId ?? null;
    if (!dryRun && change === 'create') {
      jobId = await client.createJob(payload);
    } else if (!dryRun) {
      await client.updateJob(existingId, payload);
    }

    const result = { title: job.title, jobId, change, enabled: payload.enabled, ...describeJob(job, payload, now) };
    results.push(result);

    const verb = { create: dryRun ? 'Would create' : 'Created', update: dryRun ? 'Would update' : 'Updated' }[change];
    logger.info(`${verb} the job "${job.title}"${jobId === null ? '' : ` (#${jobId})`}.`);
    logger.info(`  Schedule: ${result.schedule}`);
    logger.info(`  Next runs: ${formatNextRuns(result)}`);
  }

  return { folder: { title: folder, folderId, created }, jobs: results, dryRun };
}

/**
 * Deletes the folders matching the patterns (`*` matching any characters), except the excluded ones, together with
 * their jobs (deleting only a folder would move its jobs to the root folder). With `dryRun`, only reads, and returns
 * what would be deleted.
 *
 * @param {CronJobOrgClient} client
 * @param {object} options
 * @param {string[]} options.folders Titles of the folders, or patterns.
 * @param {string[]} [options.exclude] Titles, or patterns, of the folders to keep.
 * @param {boolean} [options.dryRun]
 * @param {Logger} options.logger
 * @returns {Promise<DeleteResult>}
 */
export async function deleteFolders(client, { folders, exclude = [], dryRun = false, logger }) {
  folders.forEach(validateFolderTitle);

  const included = folders.map((pattern) => ({ pattern, regex: patternToRegex(pattern) }));
  const excluded = exclude.map(patternToRegex);

  const existingFolders = await client.listFolders();
  for (const { pattern, regex } of included) {
    if (!existingFolders.some(({ title }) => regex.test(title))) {
      logger.info(
        pattern.includes('*')
          ? `No folder matches "${pattern}": nothing to delete.`
          : `The folder "${pattern}" does not exist: nothing to delete.`,
      );
    }
  }

  const foldersToDelete = existingFolders.filter(({ title }) => {
    if (!included.some(({ regex }) => regex.test(title))) {
      return false;
    }
    if (excluded.some((regex) => regex.test(title))) {
      logger.info(`Kept the folder "${title}" (excluded).`);
      return false;
    }
    return true;
  });

  if (foldersToDelete.length === 0) {
    return { folders: [], dryRun };
  }

  const jobs = await client.listJobs();
  const deleted = [];
  for (const folder of foldersToDelete) {
    const folderJobs = jobs.filter(({ folderId }) => folderId === folder.folderId);

    for (const job of folderJobs) {
      if (!dryRun) {
        await deleteJob(client, job.jobId);
      }
      logger.info(`${dryRun ? 'Would delete' : 'Deleted'} the job "${job.title}" (#${job.jobId}) of the folder "${folder.title}".`);
    }

    if (!dryRun) {
      await client.deleteFolder(folder.folderId);
    }
    logger.info(`${dryRun ? 'Would delete' : 'Deleted'} the folder "${folder.title}" (#${folder.folderId}).`);

    deleted.push({
      folderId: folder.folderId,
      title: folder.title,
      jobs: folderJobs.map(({ jobId, title }) => ({ jobId, title })),
    });
  }

  return { folders: deleted, dryRun };
}

/**
 * @param {CronJobOrgClient} client
 * @returns {Promise<Array<{ folderId: number, title: string }>>} Every folder of the account.
 */
export async function listFolders(client) {
  return (await client.listFolders()).map(({ folderId, title }) => ({ folderId, title }));
}

/**
 * @param {JobResult} result
 * @returns {string} The next runs of a job, for the log and the summary.
 */
export function formatNextRuns(result) {
  if (result.enabled === false) {
    return 'none (disabled)';
  }
  if (result.nextRuns === null) {
    return 'see the console (days of month and days of week are both restricted)';
  }
  if (result.nextRuns.length === 0) {
    return 'none in the next year';
  }
  return result.nextRuns.join(', ');
}

/**
 * @param {JobSpec} job
 * @param {Record<string, any>} payload
 * @param {number} now
 * @returns {{ schedule: string, nextRuns: string[]|null }}
 */
function describeJob(job, payload, now) {
  const { timezone, expiresAt, ...schedule } = payload.schedule;
  const runs = payload.enabled ? nextRuns(schedule, { timezone, expiresAt }, now) : [];

  return {
    // An expression is described as written (e.g. "*/5" rather than its list of minutes)
    schedule: `${describeSchedule(typeof job.schedule === 'string' ? job.schedule : schedule)} (${timezone})`,
    nextRuns: runs === null ? null : runs.map((run) => formatRun(run, timezone)),
  };
}

/**
 * @param {CronJobOrgClient} client
 * @param {string} title
 * @param {{ dryRun: boolean, logger: Logger }} options
 * @returns {Promise<{ folderId: number|null, created: boolean }>}
 */
async function findOrCreateFolder(client, title, { dryRun, logger }) {
  const existing = (await client.listFolders()).find((folder) => folder.title === title);
  if (existing) {
    logger.info(`Found the folder "${title}" (#${existing.folderId}).`);
    return { folderId: existing.folderId, created: false };
  }

  if (dryRun) {
    logger.info(`Would create the folder "${title}".`);
    return { folderId: null, created: true };
  }

  try {
    const folderId = await client.createFolder(title);
    logger.info(`Created the folder "${title}" (#${folderId}).`);
    return { folderId, created: true };
  } catch (error) {
    // Created in the meantime (e.g. by a concurrent run)
    if (error instanceof CronJobOrgError && error.status === 409) {
      const created = (await client.listFolders()).find((folder) => folder.title === title);
      if (created) {
        logger.info(`Found the folder "${title}" (#${created.folderId}).`);
        return { folderId: created.folderId, created: false };
      }
    }
    throw error;
  }
}

/**
 * Deletes a job, ignoring the jobs already deleted (e.g. by a request retried after its response was lost).
 *
 * @param {CronJobOrgClient} client
 * @param {number} jobId
 */
async function deleteJob(client, jobId) {
  try {
    await client.deleteJob(jobId);
  } catch (error) {
    if (!(error instanceof CronJobOrgError && error.status === 404)) {
      throw error;
    }
  }
}

/**
 * @param {string} pattern A title, where `*` matches any characters.
 * @returns {RegExp}
 */
function patternToRegex(pattern) {
  const escaped = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`^${escaped.join('.*')}$`);
}

/**
 * @param {string} title
 */
function validateFolderTitle(title) {
  if (typeof title !== 'string' || title.trim() === '') {
    throw new Error('The title of the folder cannot be empty.');
  }
  if (title.length > MAX_FOLDER_TITLE_LENGTH) {
    throw new Error(`The title of the folder "${title}" is longer than ${MAX_FOLDER_TITLE_LENGTH} characters.`);
  }
}
