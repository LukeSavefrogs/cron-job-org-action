/**
 * Entry point of the action.
 */
import { error } from './github.js';
import { run } from './main.js';

try {
  await run();
} catch (caught) {
  error(caught.message);
  process.exitCode = 1;
}
