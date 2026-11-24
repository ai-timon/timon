/**
 * Service migration performed by a newly installed desktop bundle.
 *
 * macOS and Linux run the service from a copy under `desktop-runtime/releases`,
 * which installing a new version does not touch. Windows does not: its logon
 * task runs from the installation directory, and the NSIS update stops every
 * `Timon.exe` (the daemon included) before replacing those files.
 *
 * Proof, in `orchestrator/src/onboarding.ts`: `stagesPackagedRuntime` is true
 * for linux and darwin only, and gates both `packagedServiceOptions` (in
 * `serviceOptsForPlatform`) and `stagePackagedRuntime` (in
 * `installOnboardingService`). On win32 the task keeps `installDir` =
 * `TIMON_INSTALL_DIR` and `nodePath` = `process.execPath`, both in INSTDIR.
 * The onboarding test
 * `windows packagé : le service lance le dossier d'installation…` fails if
 * that ever changes; extend this migration then.
 *
 * What Windows does need migrating is the task itself: an update replaces the
 * files, never the registered task. A task whose recorded revision is not
 * `WINDOWS_SERVICE_REVISION` — the logon task of revision 1, recognised by its
 * launcher since it recorded none — is rewritten by the same runner, which
 * restores it if the new one does not answer. So is a task of the current
 * revision whose launcher does not mark its daemon as packaged (TIM-0087).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { DesktopConfig } from './config.js';
import { withRuntimeEnv } from './daemon-runtime.js';
import { shellText } from './shell-i18n.js';
import { startupText } from './startup-text.js';
import {
  WINDOWS_SERVICE_REVISION, windowsLauncherUnmarked, windowsLegacyLauncher, windowsRepairDeclinedFile, windowsRewriteDeclinedFile,
  windowsServiceRefusedFile, windowsServiceRevisionFile,
} from './service.js';
import type { WindowsTaskShape } from './windows-task-shape.js';

/** Copy of `DESKTOP_SESSION_INTENT_ENV` (orchestrator `host/packaged-upgrade.ts`), held together by `upgrade.test.ts`. */
export const DESKTOP_SESSION_INTENT_ENV = 'TIMON_DESKTOP_SESSION_INTENT';

/** Copy of `UPGRADE_SESSION_FALLBACK_LINE` (orchestrator `host/packaged-upgrade.ts`), held together by `upgrade.test.ts`. */
export const UPGRADE_SESSION_FALLBACK_LINE = 'timon-upgrade: session-fallback';

/** Copy of `ServiceSessionMode` (orchestrator `host/service-session-mode.ts`). */
export type ServiceSessionIntent = 'session' | 'always';

/**
 * What a task that opens a console was meant to do, for the runner that
 * rewrites it. Timon registered every boot-triggered task under S4U: one now
 * on the interactive token was switched by hand ("Run only when user is
 * logged on"), and its boot trigger still says the user wanted it to run
 * logged out (#116). The rewrite tries S4U again, and the host adapter falls
 * back on the session task if Windows still refuses it. Any other task: no
 * intent, the runner reads the recorded answer or the task as before.
 */
export function windowsSessionIntent(shape: WindowsTaskShape | null | undefined): ServiceSessionIntent | undefined {
  if (!shape?.consoleVisible) return undefined;
  return shape.triggers.includes('Boot') ? 'always' : 'session';
}

export function packagedReleaseId(version: string): string {
  const readable = version.trim().replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48) || 'unknown';
  const digest = createHash('sha256').update(version).digest('hex').slice(0, 12);
  return `${readable}-${digest}`;
}

export function activeReleaseFile(home: string): string {
  return join(home, 'desktop-runtime', 'active-release');
}

export function serviceUpgradeNeeded(
  home: string,
  version: string,
  facts: {
    platform?: NodeJS.Platform; packaged: boolean; serviceInstalled: boolean;
    /** Windows: Task Scheduler knows the boot task (`windowsTaskState().exists`). */
    taskExists?: boolean;
    /** Windows: what that task runs (`readWindowsTaskShape`), `null` when unreadable. */
    taskShape?: WindowsTaskShape | null;
  },
): boolean {
  const platform = facts.platform ?? process.platform;
  if (platform === 'win32') {
    if (!facts.packaged) return false;
    // Declined for this version: asked again at the next one, or by an explicit
    // install, rather than at every launch.
    if (windowsTaskRepair(home, facts) && windowsRewriteDeclined(home, version)) return false;
    // A task that opens a console on the desktop is outdated whatever its
    // revision says: it was changed after Timon wrote it (#116).
    if (facts.taskShape?.consoleVisible) return true;
    return windowsTaskOutdated(home, facts.taskExists === true);
  }
  if ((platform !== 'darwin' && platform !== 'linux') || !facts.packaged || !facts.serviceInstalled) return false;
  try {
    return readFileSync(activeReleaseFile(home), 'utf8').trim() !== packagedReleaseId(version);
  } catch {
    return true; // legacy service: its executable still lives inside the application
  }
}

function windowsTaskOutdated(home: string, taskExists: boolean): boolean {
  let recorded: string;
  try {
    recorded = readFileSync(windowsServiceRevisionFile(home), 'utf8').trim();
  } catch {
    // No revision, yet Task Scheduler has the task: one Timon did not record,
    // or whose revision a failed install verdict removed, then changed outside
    // Timon (#116, a task left on the interactive token that loops on a held
    // home). Rewriting a task that exists is not an install. Without a task
    // nor the revision-1 launcher, there is nothing to migrate: never install
    // one unasked.
    return taskExists || existsSync(windowsLegacyLauncher(home));
  }
  // Checked only once a task is known to exist: a launcher left behind by an
  // uninstall must not bring a task back.
  return recorded !== WINDOWS_SERVICE_REVISION || windowsLauncherUnmarked(home);
}

/**
 * Is the Windows rewrite at launch the repair of a task changed outside Timon
 * (#116) rather than the move to a new revision? A task that opens a console,
 * or one Task Scheduler has with no revision recorded. The revision-1 logon
 * task records none either, but its launcher marks it: moving it is a
 * migration, which an approved update still cannot skip.
 */
export function windowsTaskRepair(
  home: string,
  facts: { taskExists?: boolean; taskShape?: WindowsTaskShape | null },
): boolean {
  if (facts.taskShape?.consoleVisible) return true;
  return facts.taskExists === true && !existsSync(windowsServiceRevisionFile(home)) && !existsSync(windowsLegacyLauncher(home));
}

/**
 * The repair was declined (or failed) at a launch of this very version: it
 * is not asked again until the next version, or an explicit install
 * (Settings › Installation, `timon service install`), which removes the file.
 * Meanwhile the task in place serves and `timon doctor` still names it.
 */
export function windowsRewriteDeclined(home: string, version: string): boolean {
  try {
    return readFileSync(windowsRewriteDeclinedFile(home), 'utf8').trim() === version;
  } catch {
    return false;
  }
}

export function declineWindowsRewrite(home: string, version: string): void {
  const file = windowsRewriteDeclinedFile(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${version}\n`);
}

/**
 * "Not now" to the repair offer, recorded with the version it was given to:
 * the next version asks again, the same one stops asking at every launch.
 */
export function serviceRepairDeclinedFile(home: string): string {
  return windowsRepairDeclinedFile(home);
}

/**
 * Windows: a configured, packaged install whose boot task is gone. An
 * uninstall deletes the task and a reinstall never wrote it back, so the
 * desktop ran its embedded daemon unannounced: no start at boot, nothing left
 * after sign-out (0.1.4 tester report). The service is mandatory at first run,
 * so a configured install without it lost it; a first run (no configuration)
 * gets it from the setup wizard instead.
 */
export type ServiceRepairVerdict = 'wanted' | 'not-applicable' | 'not-configured' | 'task-exists' | 'refused' | 'declined';

/**
 * Why the repair offer is made or not. The reason is logged by the desktop: a
 * tester whose task was deleted and who was never offered it back (TIM-0108)
 * could not tell "declined for this version" from "refused by Windows".
 */
export function serviceRepairVerdict(
  home: string,
  version: string,
  facts: { platform?: NodeJS.Platform; packaged: boolean; configured: boolean; taskExists: boolean },
): ServiceRepairVerdict {
  if ((facts.platform ?? process.platform) !== 'win32' || !facts.packaged) return 'not-applicable';
  if (!facts.configured) return 'not-configured';
  if (facts.taskExists) return 'task-exists';
  // Windows never started the task for this account (TODO #342): reinstalling
  // it would ask for permission to register a task that will not run either.
  if (existsSync(windowsServiceRefusedFile(home))) return 'refused';
  try {
    return readFileSync(serviceRepairDeclinedFile(home), 'utf8').trim() !== version ? 'wanted' : 'declined';
  } catch {
    return 'wanted';
  }
}

export function serviceRepairWanted(
  home: string,
  version: string,
  facts: { platform?: NodeJS.Platform; packaged: boolean; configured: boolean; taskExists: boolean },
): boolean {
  return serviceRepairVerdict(home, version, facts) === 'wanted';
}

export function declineServiceRepair(home: string, version: string): void {
  const file = serviceRepairDeclinedFile(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${version}\n`);
}

/**
 * Windows registered the task but never started it for this account (TODO
 * #342). Recorded once, where the host adapter records the same verdict at
 * install: the setup wizard then offers the portable mode, and the repair
 * offer stays silent.
 */
export function recordServiceRefused(home: string): void {
  const file = windowsServiceRefusedFile(home);
  if (existsSync(file)) return;
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${new Date().toISOString()}\n`);
}

/** The task ran after all (`startDesktopService` → 'started'): the verdict no longer holds. */
export function clearServiceRefused(home: string): void {
  rmSync(windowsServiceRefusedFile(home), { force: true });
}

/** Where the version that last showed the "Windows does not start the service" notice is kept. */
export function serviceRefusedNoticeFile(home: string): string {
  return join(home, 'run', 'service-refused-notice');
}

/** Said once per version: at every launch, it would teach the user to dismiss it. */
export function serviceRefusedNoticeDue(home: string, version: string): boolean {
  try {
    return readFileSync(serviceRefusedNoticeFile(home), 'utf8').trim() !== version;
  } catch {
    return true;
  }
}

export function markServiceRefusedNotice(home: string, version: string): void {
  const file = serviceRefusedNoticeFile(home);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${version}\n`);
}

export function serviceRefusedMessage(locale: string): { message: string; detail: string } {
  const t = shellText(locale);
  return { message: t('service.refused'), detail: t('service.refusedDetail') };
}

export function serviceRepairPrompt(locale: string): { message: string; detail: string; buttons: [string, string] } {
  const t = shellText(locale);
  return { message: t('service.repair'), detail: t('service.repairDetail'), buttons: [t('service.repairConfirm'), t('service.repairLater')] };
}

export function serviceRepairFailureMessage(error: unknown, home: string, locale: string): { message: string; detail: string } {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const reason = (typeof stderr === 'string' && runnerFailureReason(stderr)) || (error as Error | null)?.message || String(error);
  const t = shellText(locale);
  return { message: t('service.repairFailed'), detail: `${t('service.repairFailedDetail', { home })}\n\n${reason}` };
}

export type UpgradeExec = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout: string; stderr: string }>;

/**
 * The runner's stderr without what Node prints around an uncaught error: the
 * throwing source line (the whole minified module, several KB, which pushed
 * the real message out of the dialog), its caret and the stack frames.
 */
export function runnerFailureReason(stderr: string): string {
  const lines = stderr.split(/\r?\n/).map(line => line.trimEnd());
  const thrown = lines.findIndex(line => /^[A-Za-z_$][\w$]*(Error|Exception)\b[^:]*:/.test(line));
  const kept = (thrown >= 0 ? lines.slice(thrown) : lines)
    .filter(line => line.trim() && line.length <= 500 && !/^\s+at\s/.test(line) && !/^\s*\^+\s*$/.test(line)
      && !/^(file|node):\S+:\d+$/.test(line) && !/^Node\.js v\d/.test(line));
  return kept.join('\n').trim();
}

/** Into the desktop log (TODO #343): the runner's output was read, then dropped. */
function logRunnerOutput(label: string, stdout: unknown, stderr: unknown): void {
  for (const [stream, text] of [['out', stdout], ['err', stderr]] as const) {
    for (const line of String(text ?? '').split(/\r?\n/)) if (line.trim()) console.log(`[desktop] ${label} ${stream}: ${line}`);
  }
}

const execUpgrade: UpgradeExec = (command, args, options) => new Promise((resolve, reject) => {
  execFile(command, args, { ...options, windowsHide: true }, (error, stdout, stderr) => {
    logRunnerOutput('service updater', stdout, stderr);
    if (error) {
      const reason = runnerFailureReason(stderr.toString());
      if (reason) error.message = `The service updater failed: ${reason}`;
      reject(Object.assign(error, { stdout, stderr }));
    }
    else resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
  });
});

/**
 * Stages this release and rewrites the service; the runner rolls back if it
 * does not answer. `sessionFallback`: Windows kept the rewritten task for the
 * session only, so it stops at logout (the runner's fixed line says so).
 */
export async function upgradePackagedService(
  cfg: DesktopConfig,
  input: {
    execPath: string; runtimeEnv?: Readonly<Record<string, string>>; resourcesPath: string; version: string;
    /** Windows: what the task in place was meant to do (`windowsSessionIntent`). */
    sessionIntent?: ServiceSessionIntent;
  },
  execute: UpgradeExec = execUpgrade,
): Promise<{ sessionFallback: boolean }> {
  const runner = join(input.resourcesPath, 'orchestrator', 'dist', 'host', 'packaged-upgrade-runner.js');
  if (!existsSync(runner)) throw new Error(`The packaged service updater is missing: ${runner}`);
  const { stdout } = await execute(input.execPath, [runner], {
    timeout: 300_000,
    env: {
      ...withRuntimeEnv(process.env, { execPath: input.execPath, env: input.runtimeEnv ?? { ELECTRON_RUN_AS_NODE: '1' } }),
      TIMON_DESKTOP_EMBEDDED: '1',
      TIMON_DESKTOP_SERVICE: '0',
      TIMON_DESKTOP_UPGRADE: '1',
      TIMON_DESKTOP_VERSION: input.version,
      TIMON_HOME: cfg.home,
      TIMON_INSTALL_DIR: join(input.resourcesPath, 'orchestrator'),
      TIMON_APP_ENABLED: cfg.app.enabled ? '1' : '0',
      TIMON_APP_PORT: String(cfg.app.listen.port),
      PORT: String(cfg.daemon.listen.port),
      ...(input.sessionIntent ? { [DESKTOP_SESSION_INTENT_ENV]: input.sessionIntent } : {}),
    },
  });
  return { sessionFallback: String(stdout ?? '').split(/\r?\n/).some(line => line.trim() === UPGRADE_SESSION_FALLBACK_LINE) };
}

/** Said once, when the rewrite kept the task for the session only (#116). */
export function sessionFallbackMessage(locale: string): { message: string; detail: string } {
  const t = shellText(locale);
  return { message: t('service.sessionFallback'), detail: t('service.sessionFallbackDetail') };
}

/**
 * Exit code 2 of the runner: the new service was not kept and no previous one
 * could be put back, so waiting on the supervisor would show nothing.
 */
export function upgradeNeedsFallback(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 2;
}

/** What the user reads when the service could not be moved to this release. */
export function upgradeFailureMessage(error: unknown, version: string, home: string, locale: string): { message: string; detail: string } {
  const stderr = (error as { stderr?: unknown } | null)?.stderr;
  const reason = (typeof stderr === 'string' && runnerFailureReason(stderr)) || (error as Error | null)?.message || String(error);
  const t = startupText(locale);
  return {
    message: t('startup.upgradeFailed', { version }),
    detail: upgradeNeedsFallback(error)
      ? t('startup.upgradeFallbackDetail', { home, reason })
      : t('startup.upgradeKeptDetail', { home, reason }),
  };
}
