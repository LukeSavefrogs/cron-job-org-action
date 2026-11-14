/**
 * Minimal replacements for the `@actions/core` helpers, so that the action has no dependencies to bundle.
 */
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { EOL } from 'node:os';

/**
 * Escapes the data of a workflow command (see `@actions/core`).
 *
 * @param {string} value
 * @returns {string}
 */
function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/**
 * Reads an input of the action: GitHub passes it as `INPUT_<NAME>`, uppercased, with spaces replaced by underscores.
 *
 * @param {string} name
 * @param {{ required?: boolean, env?: NodeJS.ProcessEnv }} [options]
 * @returns {string} The trimmed value, or an empty string when the input is not set.
 */
export function getInput(name, { required = false, env = process.env } = {}) {
  const value = (env[`INPUT_${name.replace(/ /g, '_').toUpperCase()}`] ?? '').trim();

  if (required && value === '') {
    throw new Error(`The "${name}" input is required.`);
  }

  return value;
}

/**
 * Reads a boolean input, following the YAML 1.2 core schema like `@actions/core` (`true`/`True`/`TRUE`, `false`/...).
 *
 * @param {string} name
 * @param {{ defaultValue?: boolean, env?: NodeJS.ProcessEnv }} [options]
 * @returns {boolean}
 */
export function getBooleanInput(name, { defaultValue = false, env = process.env } = {}) {
  const value = getInput(name, { env });

  if (value === '') {
    return defaultValue;
  }
  if (['true', 'True', 'TRUE'].includes(value)) {
    return true;
  }
  if (['false', 'False', 'FALSE'].includes(value)) {
    return false;
  }

  throw new Error(`The "${name}" input must be "true" or "false", not "${value}".`);
}

/**
 * Sets an output of the step, through the file named by `GITHUB_OUTPUT`.
 *
 * @param {string} name
 * @param {string} value
 * @param {NodeJS.ProcessEnv} [env]
 */
export function setOutput(name, value, env = process.env) {
  const file = env.GITHUB_OUTPUT;

  if (!file) {
    info(`Output ${name}: ${value}`);
    return;
  }

  const delimiter = `ghadelimiter_${randomUUID()}`;
  appendFileSync(file, `${name}<<${delimiter}${EOL}${value}${EOL}${delimiter}${EOL}`, { encoding: 'utf8' });
}

/**
 * @param {string} message
 */
export function info(message) {
  process.stdout.write(`${message}${EOL}`);
}

/**
 * @param {string} message
 */
export function warning(message) {
  process.stdout.write(`::warning::${escapeData(message)}${EOL}`);
}

/**
 * @param {string} message
 */
export function error(message) {
  process.stdout.write(`::error::${escapeData(message)}${EOL}`);
}

/**
 * Runs a function inside a collapsible group of the log.
 *
 * @template T
 * @param {string} name
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function group(name, fn) {
  process.stdout.write(`::group::${escapeData(name)}${EOL}`);
  try {
    return await fn();
  } finally {
    process.stdout.write(`::endgroup::${EOL}`);
  }
}
