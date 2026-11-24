/**
 * Moves an installed desktop service onto the release that was just installed.
 *
 * The service runs from a copy under `desktop-runtime/releases/`, so replacing
 * the application leaves it on the previous release until this runs. Order is
 * load-bearing: the previous release is marked inactive and pruned only once
 * the new daemon has ANSWERED. Any earlier failure puts the previous
 * definition back, so the daemon the user had keeps serving their data; when
 * there is none to put back, the new one is removed and the result asks for
 * the embedded daemon instead. `TIMON_HOME` is never read or written here.
 *
 * Windows has no release copy to stage, mark or prune: its task runs straight
 * from the installation directory, and the NSIS update stops every `Timon.exe`
 * before replacing those files. What an update can leave behind there is the
 * task DEFINITION (revision 1 died at logoff, backlog #141), so on Windows this
 * only rewrites the task, with the same restore-or-remove on failure; the
 * revision `installService` records is what marks it done.
 */
import type { ServiceOpts, ServiceResult } from './service-install.js';
import { isServiceSessionMode, type ServiceSessionMode } from './service-session-mode.js';

/**
 * Windows: what the desktop read the task in place was meant to do, handed to
 * the runner it starts. A task switched to the interactive token by hand
 * still carries the boot trigger of an off-session task (#116): read back,
 * its logon alone would rewrite it for the session. The desktop's copy lives
 * in `desktop/src/upgrade.ts`.
 */
export const DESKTOP_SESSION_INTENT_ENV = 'TIMON_DESKTOP_SESSION_INTENT';

/**
 * The line the runner prints when the rewrite kept the task for the session
 * only (`UpgradeResult.sessionFallback`): the desktop reads it from the
 * runner's output to say it once. Its copy lives in `desktop/src/upgrade.ts`.
 */
export const UPGRADE_SESSION_FALLBACK_LINE = 'timon-upgrade: session-fallback';

/**
 * The session mode the rewrite should use: the desktop's intent, only when
 * the user never answered the question (`service-session-mode`), whose answer
 * always wins. `undefined` leaves the install to read the recorded answer or
 * the task in place, as before.
 */
export function upgradeSessionMode(intent: string | undefined, recorded: ServiceSessionMode | null): ServiceSessionMode | undefined {
  if (recorded !== null || !isServiceSessionMode(intent)) return undefined;
  return intent;
}

export type UpgradeDeps = {
  platform: NodeJS.Platform;
  stage: () => Promise<void>;
  options: () => ServiceOpts;
  install: (opts: ServiceOpts) => ServiceResult;
  read: (opts: ServiceOpts) => string | null;
  restore: (opts: ServiceOpts, previous: string) => ServiceResult;
  /** Stops and deletes the definition `install` wrote, when none preceded it. */
  remove: (opts: ServiceOpts) => ServiceResult;
  /** Why the service in place is not this data directory's to rewrite (`serviceOfAnotherHome`). */
  foreign?: (opts: ServiceOpts) => string | null;
  /** Resolves once the rewritten service answers as this instance, or `false` after its budget. */
  healthy: () => Promise<boolean>;
  mark: () => Promise<void>;
  prune: () => Promise<void>;
  /** Windows: what the previous task ran and the new one does not, removed
   *  once the new one answers (`retireBatchLauncher`). Never before: a
   *  rollback restores the previous task. */
  retire?: (opts: ServiceOpts) => void;
  warn?: (message: string, error: unknown) => void;
};

/**
 * `fallback`: no service can be trusted to serve this instance any more (the
 * previous one could not be put back), so the desktop must start its embedded
 * daemon rather than wait on a supervisor.
 */
export type UpgradeResult = {
  ok: boolean; lines: string[]; reason: string | null; fallback: boolean;
  /**
   * Windows: the task was asked to run logged out, Windows kept it for the
   * session only, and the session task now serves (`ServiceResult.sessionFallback`).
   */
  sessionFallback?: boolean;
};

const detail = (result: ServiceResult, otherwise: string): string =>
  result.reason ?? result.lines.at(-1) ?? otherwise;

export async function upgradeDesktopService(deps: UpgradeDeps): Promise<UpgradeResult> {
  if (deps.platform !== 'linux' && deps.platform !== 'darwin' && deps.platform !== 'win32') {
    return { ok: false, lines: [], reason: `no packaged service to upgrade on ${deps.platform}`, fallback: false };
  }
  const releases = deps.platform !== 'win32';
  const lines: string[] = [];
  const failed = (reason: string, fallback = false): UpgradeResult => ({ ok: false, lines, reason, fallback });
  // Staging failures happen before anything the running service depends on changed.
  try {
    if (releases) await deps.stage();
  } catch (error) {
    return failed(`could not copy the new release: ${(error as Error).message}`);
  }
  const opts = deps.options();
  // The label and the task name are shared by every home. A desktop opened on
  // another one has no service of its own: it runs its built-in daemon.
  const foreign = deps.foreign?.(opts);
  if (foreign) return failed(foreign, true);
  const previous = deps.read(opts);
  // Set from what `install` reports, never guessed from the file afterwards:
  // only an explicit `written: false` proves the running service was left alone.
  let written = false;

  const rollback = (reason: string): UpgradeResult => {
    if (!written) return failed(`${reason}. The previous service was left in place.`);
    if (previous !== null) {
      const restored = deps.restore(opts, previous);
      lines.push(...restored.lines);
      return restored.ok
        ? failed(`${reason}. The previous service was restored.`)
        : failed(`${reason}. Restoring the previous service also failed: ${detail(restored, 'unknown error')}`, true);
    }
    // Nothing to put back: leaving the new definition would have the
    // supervisor restart a daemon that does not answer, forever.
    const removed = deps.remove(opts);
    lines.push(...removed.lines);
    return failed(removed.ok
      ? `${reason}. There was no previous service definition to restore, so the new one was removed.`
      : `${reason}. There was no previous service definition to restore, and removing the new one failed: ${detail(removed, 'unknown error')}`, true);
  };

  let installed: ServiceResult;
  try {
    written = true;
    installed = deps.install(opts);
  } catch (error) {
    return rollback(`the service could not be rewritten: ${(error as Error).message}`);
  }
  written = installed.written !== false;
  lines.push(...installed.lines);
  // Windows never started the new task for this account: the previous
  // definition runs under the same S4U logon and would be refused the same
  // way, yet its `/Run` answers success and the desktop would wait on it.
  if (installed.refused) return failed(detail(installed, 'Windows never started the service'), true);
  if (!installed.ok) return rollback(`the service could not be rewritten: ${detail(installed, 'refused')}`);
  if (!await deps.healthy()) return rollback('the new release of the service did not answer');
  if (!releases) {
    // Best effort, like the prune: a leftover file must not fail an upgrade that succeeded.
    try {
      deps.retire?.(opts);
    } catch (error) {
      (deps.warn ?? console.warn)('[desktop-runtime] could not remove the previous launcher', error);
    }
    return { ok: true, lines, reason: null, fallback: false, ...(installed.sessionFallback ? { sessionFallback: true } : {}) };
  }

  try {
    await deps.mark();
  } catch (error) {
    // The new daemon serves: rolling it back would interrupt a working
    // service. Pruning is skipped so the recorded release keeps its files.
    return failed(`the new release answers, but it could not be recorded as active: ${(error as Error).message}. `
      + 'Nothing was removed; the update will be retried at the next launch.');
  }
  // Best effort: a stale copy on disk must not fail an upgrade that succeeded.
  await deps.prune().catch((error: unknown) => {
    (deps.warn ?? console.warn)('[desktop-runtime] could not remove an inactive release', error);
  });
  return { ok: true, lines, reason: null, fallback: false };
}
