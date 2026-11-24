/**
 * Second import of `boot.ts`, right after the log: a daemon whose data directory another daemon
 * already serves stops here, before anything below can restore, migrate or sweep that data
 * (`home-lock.ts`). Daemon-only — the CLI and the desktop helpers run beside a live daemon.
 *
 * One line per refused start: the supervisor relaunches it for as long as the other one lives.
 */
import { HOME_HELD_EXIT_CODE, HomeHeldError, holdHomeLock, recordServiceHeldOut, releaseHomeLock } from './home-lock.js';
import { TIMON_HOME } from './paths.js';

try {
  holdHomeLock(TIMON_HOME);
} catch (error) {
  if (!(error instanceof HomeHeldError)) throw error;
  console.error(`[timon] ${error.message}`);
  recordServiceHeldOut(TIMON_HOME);
  process.exit(HOME_HELD_EXIT_CODE);
}
process.on('exit', () => releaseHomeLock(TIMON_HOME));
