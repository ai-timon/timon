/** One-shot helper run by a newly installed desktop bundle before its window opens. */
import { readFileSync } from 'node:fs';
import { loadConfig } from '../config/load.js';
import { BRAND } from '../brand.js';
import { serviceOptsFromEnvironment } from './service-environment.js';
import { createGenericHost } from './generic.js';
import { TIMON_HOME } from '../paths.js';
import { recordReleaseSource } from './packaged-handback.js';
import {
  instanceId,
  markActiveRelease,
  readActiveRelease,
  pruneInactiveReleases,
  stagePackagedRuntime,
} from './packaged-service.js';
import { DESKTOP_SESSION_INTENT_ENV, UPGRADE_SESSION_FALLBACK_LINE, upgradeDesktopService, upgradeSessionMode } from './packaged-upgrade.js';
import { readServiceSessionMode } from './service-session-mode.js';
import { serviceOfAnotherHome } from './service-ownership.js';
import {
  installService,
  readServiceDefinition,
  removeServiceDefinition,
  restoreServiceDefinition,
  retireBatchLauncher,
} from './service-install.js';

/** Cold boot of a packaged daemon, migrations and a restore included, stays well below this. */
const HEALTH_BUDGET_MS = 180_000;
// The runner must not import onboarding: its doctor dependency opens and migrates the database.
const cfg = loadConfig(undefined, { readonly: true });
/**
 * The package to move the service onto. The desktop runs this runner with the
 * executable it installed; a daemon handing the service back to an older
 * package runs it with its own, and names the package's executable here.
 */
const executable = process.env.TIMON_RELEASE_EXECUTABLE || process.execPath;
const previousRelease = await readActiveRelease(TIMON_HOME);

/**
 * Windows only: the instance alone does not prove the NEW task's daemon
 * answers. A revision-1 daemon, started detached and without the packaged
 * environment, can still hold the port for this instance; it has no update
 * routes, so the desktop's update window got a 401 (0.1.1-rc.7 → 0.1.2-rc.1).
 * The update status, mounted only by a packaged daemon, names its version.
 */
async function runsThisRelease(origin: string): Promise<boolean> {
  let token: string;
  // Imported here, on Windows only: the macOS and Linux runner stays as it was.
  const { updateTokenFile } = await import('../data-update.js');
  try { token = readFileSync(updateTokenFile(TIMON_HOME), 'utf8').trim(); } catch { return false; }
  const res = await fetch(`${origin}/api/update/status`, {
    signal: AbortSignal.timeout(3000), redirect: 'manual', headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return false;
  const body = await res.json() as { daemonVersion?: unknown };
  return body.daemonVersion === process.env.TIMON_DESKTOP_VERSION;
}

async function answersAsThisInstance(): Promise<boolean> {
  const { host, port } = cfg.daemon.listen;
  const target = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  const origin = `http://${target.includes(':') ? `[${target}]` : target}:${port}`;
  const deadline = Date.now() + HEALTH_BUDGET_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(1500), redirect: 'manual' });
      const body = res.ok ? await res.json() as { service?: unknown; instance?: unknown } : null;
      if (body?.service === BRAND.id && body.instance === instanceId(TIMON_HOME)
        && (process.platform !== 'win32' || await runsThisRelease(origin))) return true;
    } catch {
      // Not listening yet: the restarted service is still booting.
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

const result = await upgradeDesktopService({
  platform: process.platform,
  stage: () => stagePackagedRuntime(TIMON_HOME, executable, cfg.daemon.installDir),
  options: () => {
    const host = createGenericHost(cfg);
    // A revision-1 task left its detached daemon on the port (0.1.1-rc.7).
    // The batch of revision 5 stays until the new task answers: a rollback runs it.
    const sessionMode = process.platform === 'win32'
      ? upgradeSessionMode(process.env[DESKTOP_SESSION_INTENT_ENV], readServiceSessionMode(TIMON_HOME))
      : undefined;
    return {
      ...serviceOptsFromEnvironment(cfg, () => host), replacePortOwner: true, keepBatchLauncher: true,
      ...(sessionMode ? { sessionMode } : {}),
    };
  },
  foreign: serviceOfAnotherHome,
  install: installService,
  read: readServiceDefinition,
  restore: restoreServiceDefinition,
  remove: removeServiceDefinition,
  healthy: answersAsThisInstance,
  mark: async () => {
    await markActiveRelease(TIMON_HOME);
    if (process.platform !== 'linux') return;
    try {
      recordReleaseSource(TIMON_HOME, executable);
    } catch (error) {
      console.warn('[desktop-runtime] could not record where this release was installed', error);
    }
  },
  prune: () => pruneInactiveReleases(TIMON_HOME, undefined, previousRelease ? [previousRelease] : []),
  retire: (opts) => retireBatchLauncher(opts),
});
if (!result.ok) {
  console.error(result.reason ?? 'service upgrade failed');
  // 2 tells the desktop no service is left to boot on: start the embedded daemon.
  process.exitCode = result.fallback ? 2 : 1;
} else {
  console.log(result.lines.join('\n'));
  if (result.sessionFallback) console.log(UPGRADE_SESSION_FALLBACK_LINE);
}
