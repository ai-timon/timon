/** Stable entry point retained by already installed OS services. */
// First of all: it may replace this process to honour a corporate proxy.
import './env-proxy-boot.js';
// Before anything prints: the restore below already logs.
import './log-boot.js';
// Before any database is opened or any route served: the home restricted to its owner.
import './home-permissions-boot.js';
// Before anything reads or writes the data: another daemon may be serving them.
import './home-lock-boot.js';
import './rejection-boot.js';
import './data-restore-boot.js';
import { waitForDataUpdate } from './data-update-boot.js';
import { releaseDataOpenLock } from './data-open-lock.js';
import { DB_PATH, TIMON_HOME } from './paths.js';
import { freeBytes, holdOnStorageFailure, lowDiskWarning, storageFailureMonitor } from './storage-failure.js';

const lowDisk = lowDiskWarning(TIMON_HOME, freeBytes(TIMON_HOME));
if (lowDisk) console.warn(lowDisk);

let kernel: typeof import('./kernel-boot.js');
try {
  await waitForDataUpdate();
  kernel = await import('./kernel-boot.js');
  // db.ts releases it after its migrations; this only matters if it was evaluated before the wait
  // took the lock, which would otherwise hold every packaged CLI back for the daemon's lifetime.
  releaseDataOpenLock(TIMON_HOME);
} catch (error) {
  // Exits on a storage failure; anything else keeps its usual fatal path.
  await holdOnStorageFailure(error, { home: TIMON_HOME, dbPath: DB_PATH });
  throw error;
}
// After the boot, an uncaught storage failure waits too before the crash.
process.on('uncaughtExceptionMonitor', storageFailureMonitor({ home: TIMON_HOME, dbPath: DB_PATH }));
export const boot = kernel.boot;
