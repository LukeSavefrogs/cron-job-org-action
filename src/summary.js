/**
 * The step summaries of the commands (Markdown shown on the page of the workflow run).
 */
import { formatNextRuns } from './commands.js';

const CHANGES = {
  create: ['Created', 'Would create'],
  update: ['Updated', 'Would update'],
  delete: ['Deleted', 'Would delete'],
  keep: ['Kept (not listed)', 'Would keep (not listed)'],
};

/**
 * @param {import('./commands.js').ApplyResult} result
 * @param {{ requestCount: number }} stats
 * @returns {string}
 */
export function renderApplySummary({ folder, jobs, dryRun }, { requestCount }) {
  const folderState = folder.created
    ? dryRun
      ? 'would be created'
      : `created (#${folder.folderId})`
    : `#${folder.folderId}`;

  const rows = jobs.map((job) => {
    const isListed = job.change === 'create' || job.change === 'update';
    return [
      `${escape(job.title)}${job.jobId === null ? '' : ` (#${job.jobId})`}`,
      CHANGES[job.change][dryRun ? 1 : 0],
      isListed ? escape(job.schedule) : '',
      isListed ? escape(formatNextRuns(job)).replace(/, /g, '<br>') : '',
    ];
  });

  return [
    `### cron-job.org: ${escape(folder.title)}${dryRun ? ' (dry run)' : ''}`,
    '',
    `Folder: ${folderState}`,
    '',
    table(['Job', 'Change', 'Schedule', 'Next runs'], rows, 'No jobs.'),
    '',
    footer(requestCount),
    '',
  ].join('\n');
}

/**
 * @param {import('./commands.js').DeleteResult} result
 * @param {{ requestCount: number }} stats
 * @returns {string}
 */
export function renderDeleteSummary({ folders, dryRun }, { requestCount }) {
  const rows = folders.map((folder) => [
    `${escape(folder.title)} (#${folder.folderId})`,
    folder.jobs.length === 0 ? 'none' : folder.jobs.map((job) => `${escape(job.title)} (#${job.jobId})`).join('<br>'),
  ]);

  return [
    `### cron-job.org: ${dryRun ? 'folders that would be deleted (dry run)' : 'deleted folders'}`,
    '',
    table(['Folder', 'Jobs'], rows, 'No folder to delete.'),
    '',
    footer(requestCount),
    '',
  ].join('\n');
}

/**
 * @param {string[]} headers
 * @param {string[][]} rows
 * @param {string} empty Text shown instead of a table without rows.
 * @returns {string}
 */
function table(headers, rows, empty) {
  if (rows.length === 0) {
    return empty;
  }

  return [headers, headers.map(() => '---'), ...rows].map((cells) => `| ${cells.join(' | ')} |`).join('\n');
}

/**
 * @param {number} requestCount
 * @returns {string}
 */
function footer(requestCount) {
  return `<sub>${requestCount} ${requestCount === 1 ? 'request' : 'requests'} to the cron-job.org API (an API key can send 100 a day by default).</sub>`;
}

/**
 * Escapes a text for a cell of a Markdown table.
 *
 * @param {string} text
 * @returns {string}
 */
function escape(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\|/g, '\\|')
    .replace(/[*_`[\]]/g, '\\$&')
    .replace(/\r?\n/g, ' ');
}
