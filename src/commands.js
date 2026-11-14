/**
 * The commands of the action: each folder of cron-job.org is owned by the action, which keeps its jobs in sync with
 * the ones it is given, identified by their title.
 */
import { CronJobOrgError } from './client.js';
import { buildJobPayload } from './jobs.js';

/** Maximum length of the title of a folder, set by the API. */
export const MAX_FOLDER_TITLE_LENGTH = 128;

/**
 * @typedef {import('./client.js').CronJobOrgClient} CronJobOrgClient
 * @typedef {import('./jobs.js').JobSpec} JobSpec
 * @typedef {{ info: (message: string) => void, warning: (message: string) => void }} Logger
 */

/**
 * Creates the folder if it does not exist, then creates or updates its jobs, and (with `prune`) deletes the jobs of
 * the folder that are not listed.
 *
 * @param {CronJobOrgClient} client
 * @param {object} options
 * @param {string} options.folder Title of the folder.
 * @param {JobSpec[]} options.jobs
 * @param {string} options.timezone Time zone of the jobs that do not set theirs.
 * @param {boolean} options.prune
 * @param {Logger} options.logger
 * @returns {Promise<{ folderId: number, jobIds: Record<string, number> }>}
 */
export async function applyJobs(client, { folder, jobs, timezone, prune, logger }) {
  validateFolderTitle(folder);

  const folderId = await findOrCreateFolder(client, folder, logger);

  const existingJobs = (await client.listJobs())
    .filter((job) => job.folderId === folderId)
    .sort((a, b) => a.jobId - b.jobId);

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

  // First, so that the account has room for the new jobs
  for (const job of unlistedJobs) {
    if (prune) {
      await deleteJob(client, job.jobId);
      logger.info(`Deleted the job "${job.title}" (#${job.jobId}), no longer listed.`);
    } else {
      logger.warning(`The job "${job.title}" (#${job.jobId}) of the folder "${folder}" is not listed: it is kept.`);
    }
  }

  /** @type {Record<string, number>} */
  const jobIds = {};
  for (const job of jobs) {
    const payload = buildJobPayload(job, { folderId, timezone });
    const jobId = existingIds.get(job.title);

    if (jobId === undefined) {
      jobIds[job.title] = await client.createJob(payload);
      logger.info(`Created the job "${job.title}" (#${jobIds[job.title]}).`);
    } else {
      await client.updateJob(jobId, payload);
      jobIds[job.title] = jobId;
      logger.info(`Updated the job "${job.title}" (#${jobId}).`);
    }
  }

  return { folderId, jobIds };
}

/**
 * Deletes folders together with their jobs (deleting only a folder would move its jobs to the root folder). The
 * folders that do not exist are skipped.
 *
 * @param {CronJobOrgClient} client
 * @param {object} options
 * @param {string[]} options.folders Titles of the folders.
 * @param {Logger} options.logger
 * @returns {Promise<Array<{ folderId: number, title: string }>>} The deleted folders.
 */
export async function deleteFolders(client, { folders, logger }) {
  folders.forEach(validateFolderTitle);

  const existingFolders = await client.listFolders();
  const foldersToDelete = [];
  for (const title of new Set(folders)) {
    const folder = existingFolders.find((existing) => existing.title === title);
    if (folder) {
      foldersToDelete.push(folder);
    } else {
      logger.info(`The folder "${title}" does not exist: nothing to delete.`);
    }
  }

  if (foldersToDelete.length === 0) {
    return [];
  }

  const jobs = await client.listJobs();
  for (const folder of foldersToDelete) {
    for (const job of jobs.filter(({ folderId }) => folderId === folder.folderId)) {
      await deleteJob(client, job.jobId);
      logger.info(`Deleted the job "${job.title}" (#${job.jobId}) of the folder "${folder.title}".`);
    }

    await client.deleteFolder(folder.folderId);
    logger.info(`Deleted the folder "${folder.title}" (#${folder.folderId}).`);
  }

  return foldersToDelete.map(({ folderId, title }) => ({ folderId, title }));
}

/**
 * @param {CronJobOrgClient} client
 * @returns {Promise<Array<{ folderId: number, title: string }>>} Every folder of the account.
 */
export async function listFolders(client) {
  return (await client.listFolders()).map(({ folderId, title }) => ({ folderId, title }));
}

/**
 * @param {CronJobOrgClient} client
 * @param {string} title
 * @param {Logger} logger
 * @returns {Promise<number>}
 */
async function findOrCreateFolder(client, title, logger) {
  const existing = (await client.listFolders()).find((folder) => folder.title === title);
  if (existing) {
    logger.info(`Found the folder "${title}" (#${existing.folderId}).`);
    return existing.folderId;
  }

  try {
    const folderId = await client.createFolder(title);
    logger.info(`Created the folder "${title}" (#${folderId}).`);
    return folderId;
  } catch (error) {
    // Created in the meantime (e.g. by a concurrent run)
    if (error instanceof CronJobOrgError && error.status === 409) {
      const created = (await client.listFolders()).find((folder) => folder.title === title);
      if (created) {
        logger.info(`Found the folder "${title}" (#${created.folderId}).`);
        return created.folderId;
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
