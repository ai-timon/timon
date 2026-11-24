/** Instance-scoped discovery; never reuse the development unit or another home. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, win32 as winPath } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DesktopConfig } from './config.js';
import { withRuntimeEnv } from './daemon-runtime.js';
import { shellText } from './shell-i18n.js';
import { startupText } from './startup-text.js';
import { windowsTaskShape, type WindowsTaskShape } from './windows-task-shape.js';

export function instanceId(home: string): string {
  return createHash('sha256').update(resolve(home)).digest('hex').slice(0, 24);
}
export function packagedUnit(home: string): string { return `timon-desktop-${instanceId(home)}`; }
export const MACOS_SERVICE_LABEL = 'com.timon.daemon';
/** Copy of `launchDaemonPath()` (orchestrator `host/service-install.ts`):
 *  installed instead of the LaunchAgent once a claude token is configured. */
export const MACOS_LAUNCH_DAEMONS_DIR = '/Library/LaunchDaemons';
function macosLaunchDaemon(dir: string): string { return join(dir, `${MACOS_SERVICE_LABEL}.plist`); }

/** macOS seams: tests point the LaunchDaemons directory elsewhere and record signals. */
export type MacServiceSeams = { daemonsDir?: string; kill?: (pid: number) => void; userHome?: string };

/**
 * Copies of the #734 reading (orchestrator `host/orphan-services.ts`,
 * `host/service-ownership.ts`), so the desktop and its runners agree on whose
 * service this is: `packaging.test.ts` holds them together.
 */
function unescapeXml(value: string): string {
  return value.replace(/&(lt|gt|quot|apos|amp);/g, (_, entity: string) => (
    { lt: '<', gt: '>', quot: '"', apos: '\'', amp: '&' } as Record<string, string>)[entity]!);
}
function homeOfPlist(text: string): string | null {
  const match = /<key>TIMON_HOME<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
  return match ? unescapeXml(match[1]!) : null;
}
function unquoteShell(value: string): string {
  return value.replace(/'\\''/g, '\'');
}
function realOrNull(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}
function normalized(path: string, platform: NodeJS.Platform): string {
  const absolute = platform === 'win32' ? winPath.resolve(path) : resolve(path);
  return platform === 'linux' ? absolute : absolute.toLowerCase();
}
function samePath(a: string, b: string, platform: NodeJS.Platform): boolean {
  const forms = (path: string) => [path, realOrNull(path)].filter((p): p is string => Boolean(p)).map((p) => normalized(p, platform));
  const others = forms(b);
  return forms(a).some((form) => others.includes(form));
}

function readOrNull(file: string): string | null {
  try { return readFileSync(file, 'utf8'); } catch { return null; }
}

/**
 * Whose is this plist? `null`: there is none. A file that exists but cannot be
 * read proves nothing, and stays this home's as it always was. The LaunchDaemon's
 * launcher sets the home again, after the plist: both have to name this one.
 */
function macDefinition(file: string, home: string, userHome: string): 'ours' | { other: string } | null {
  if (!existsSync(file)) return null;
  const plist = readOrNull(file);
  if (plist === null) return 'ours';
  const launcherFile = /<string>([^<]*\/run\/timon-service\.sh)<\/string>/.exec(plist)?.[1];
  const launcher = launcherFile === undefined ? null : readOrNull(unescapeXml(launcherFile));
  const exported = launcher === null ? undefined : /^export TIMON_HOME='((?:[^']|'\\'')*)'$/m.exec(launcher)?.[1];
  const homes = [homeOfPlist(plist) ?? join(userHome, '.timon'), ...(exported === undefined ? [] : [unquoteShell(exported)])];
  const other = homes.find((named) => !samePath(named, home, 'darwin'));
  return other === undefined ? 'ours' : { other };
}

/**
 * The one label can hold a service of another home: launchd knows nothing of
 * homes. Same order as the host adapter, the LaunchDaemon first; an agent of
 * this home beside another home's LaunchDaemon is still this home's service.
 */
function macService(home: string, mac: MacServiceSeams): { kind: 'daemon' | 'agent' | 'none' } | { kind: 'foreign'; home: string } {
  const userHome = mac.userHome ?? homedir();
  const daemon = macDefinition(macosLaunchDaemon(mac.daemonsDir ?? MACOS_LAUNCH_DAEMONS_DIR), home, userHome);
  if (daemon === 'ours') return { kind: 'daemon' };
  const agent = macDefinition(join(userHome, 'Library', 'LaunchAgents', `${MACOS_SERVICE_LABEL}.plist`), home, userHome);
  if (agent === 'ours') return { kind: 'agent' };
  const other = agent ?? daemon;
  return other ? { kind: 'foreign', home: other.other } : { kind: 'none' };
}
/** Copies of `WINDOWS_TASK`, `WINDOWS_SERVICE_REVISION` and the file names of
 *  `windowsServiceFiles` (orchestrator `host/service-install.ts`): the two
 *  packages build separately, `packaging.test.ts` holds them together. */
export const WINDOWS_TASK = 'TimonOrchestrator';
export const WINDOWS_SERVICE_REVISION = '6';
export function windowsServiceRevisionFile(home: string): string { return join(home, 'run', 'service-revision'); }
export function windowsLegacyLauncher(home: string): string { return join(home, 'run', 'timon-service.vbs'); }
export function windowsRepairDeclinedFile(home: string): string { return join(home, 'run', 'service-repair-declined'); }
export function windowsRewriteDeclinedFile(home: string): string { return join(home, 'run', 'service-rewrite-declined'); }
/** The launcher configuration the task names (revision 6 and later). */
export function windowsLauncher(home: string): string { return join(home, 'run', 'timon-service.json'); }
/** The batch launcher of revisions 2 to 5, until the upgrade retires it. */
export function windowsBatchLauncher(home: string): string { return join(home, 'run', 'timon-service.cmd'); }
/** Copy of `windowsServiceFiles().refused`: Windows registered the task but never started it for this account. */
export function windowsServiceRefusedFile(home: string): string { return join(home, 'run', 'service-refused'); }
/** Copy of `serviceHeldOutFile` (orchestrator `home-lock.ts`): a service daemon refused the home writes it. */
export function serviceHeldOutFile(home: string): string { return join(home, 'run', 'service-held-out'); }
/** The installed service was refused the home at or after `since`: it runs, and waits for the home. */
export function serviceHeldOutSince(home: string, since: number): boolean {
  const text = readOrNull(serviceHeldOutFile(home));
  if (text === null) return false;
  try {
    const at = (JSON.parse(text) as { at?: unknown } | null)?.at;
    return typeof at === 'number' && Number.isFinite(at) && at >= since;
  } catch { return false; }
}
/** Copy of `WINDOWS_TASK_NEVER_RAN` (`LastTaskResult` of a task that was registered and never started). */
export const WINDOWS_TASK_NEVER_RAN = 0x41303;

/**
 * A launcher that does not mark its daemon as packaged. `timon service install`
 * run from the CLI of 0.1.3 and earlier wrote one while recording revision 3
 * (TIM-0087): its daemon skipped the update approval, served no update route
 * and migrated the data without a copy. Unreadable or absent: nothing to say.
 */
export function windowsLauncherUnmarked(home: string): boolean {
  // The configuration first, as the host adapter reads it (`windowsLauncherMarked`).
  const config = readOrNull(windowsLauncher(home));
  if (config !== null) {
    try {
      const env = (JSON.parse(config) as { env?: Record<string, unknown> } | null)?.env;
      return env?.TIMON_DESKTOP_SERVICE !== '1';
    } catch { return false; }
  }
  const batch = readOrNull(windowsBatchLauncher(home));
  if (batch === null) return false;
  return !/^set "TIMON_DESKTOP_SERVICE=1"\r?$/m.test(batch);
}

/**
 * Copies of what the host adapter seals the Windows launcher's session witness
 * with (`SESSION_WITNESS_TEXT`, `sealSessionWitnessCommand`, the read in
 * `sessionWitnessReadStatements`, file name in `windowsServiceFiles`):
 * `packaging.test.ts` holds them together.
 */
export const SESSION_WITNESS_TEXT = 'timon-session-witness';
export function windowsSessionWitnessFile(home: string): string { return join(home, 'run', 'session-witness.dpapi'); }
function powershellLiteral(value: string): string { return `'${value.replace(/'/g, "''")}'`; }
const WITNESS_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command'];
/** Exit 0: DPAPI opens the witness. 2: the file is missing. 1: it cannot be opened. */
export function readSessionWitnessArgs(file: string): string[] {
  return [...WITNESS_FLAGS, [
    `$f = ${powershellLiteral(file)}`,
    'if (-not (Test-Path -LiteralPath $f)) { exit 2 }',
    `try { $s = ConvertTo-SecureString -String (Get-Content -LiteralPath $f -Raw -ErrorAction Stop).Trim() -ErrorAction Stop; $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); if ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) -eq '${SESSION_WITNESS_TEXT}') { exit 0 } } catch {}`,
    'exit 1',
  ].join('; ')];
}
export function sealSessionWitnessArgs(file: string): string[] {
  return [...WITNESS_FLAGS,
    `try { $t = ConvertTo-SecureString -String '${SESSION_WITNESS_TEXT}' -AsPlainText -Force | ConvertFrom-SecureString -ErrorAction Stop; [IO.File]::WriteAllText(${powershellLiteral(file)}, $t); exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`];
}

/** Runs PowerShell with these arguments; resolves on exit 0, rejects otherwise with the exit code. */
type WitnessExec = (args: string[]) => Promise<unknown>;

/**
 * Windows: the boot task's launcher holds the daemon until DPAPI opens its
 * session witness. The key that protects it changes when the account password
 * is reset or the profile is rebuilt, and the witness then stays on disk
 * unreadable: the daemon never binds, and the launcher only logs "waiting for
 * the first logon" (TIM-0107). This process runs in the user's own session,
 * where DPAPI works, so a witness it cannot open is genuinely invalid, not just
 * early: seal it again, no elevation and no change to the task. A missing
 * witness is sealed again too. A check that could not run (no PowerShell,
 * timeout) changes nothing.
 */
export async function repairSessionWitness(
  home: string,
  exec: WitnessExec = (args) => promisify(execFile)('powershell', args, { timeout: 30_000, windowsHide: true }),
  platform: NodeJS.Platform = process.platform,
): Promise<'ok' | 'resealed' | 'failed' | 'skipped'> {
  if (platform !== 'win32' || (!existsSync(windowsLauncher(home)) && !existsSync(windowsBatchLauncher(home)))) return 'skipped';
  const file = windowsSessionWitnessFile(home);
  try {
    await exec(readSessionWitnessArgs(file));
    return 'ok';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (code !== 1 && code !== 2) return 'skipped';
  }
  try {
    await exec(sealSessionWitnessArgs(file));
    return 'resealed';
  } catch {
    return 'failed';
  }
}

export function hasDesktopService(
  home: string,
  platform: NodeJS.Platform = process.platform,
  userHome: string = homedir(),
  daemonsDir: string = MACOS_LAUNCH_DAEMONS_DIR,
): boolean {
  // Only the boot task records a revision. The logon task before it is left
  // out on purpose: it did not supervise its daemon, so the desktop kept
  // starting its own, exactly as it did before that task existed.
  if (platform === 'win32') return existsSync(windowsServiceRevisionFile(home));
  if (platform === 'darwin') {
    const { kind } = macService(home, { userHome, daemonsDir });
    return kind === 'daemon' || kind === 'agent';
  }
  return platform === 'linux' && existsSync(join(home, 'desktop-runtime', 'installed'));
}
/**
 * What the "daemon does not answer" dialog tells the user to look at. The log
 * of a Windows/macOS service is only named once it exists: a service that never
 * launched its daemon (task disabled, revision file left behind) has written
 * nothing, and pointing at a missing file sends the user hunting for it.
 */
export function daemonLogHint(
  locale: string,
  home: string,
  serviceInstalled: boolean,
  platform: NodeJS.Platform = process.platform,
  fileExists: (path: string) => boolean = existsSync,
): string {
  const t = startupText(locale);
  if (!serviceInstalled) return t('startup.logSupervisor');
  if (platform === 'win32' || platform === 'darwin') {
    const log = join(home, 'tmp', 'daemon.log');
    if (fileExists(log)) return t('startup.logFile', { path: log });
    return platform === 'win32'
      ? t('startup.logMissingWindows', { task: WINDOWS_TASK })
      : t('startup.logMissingMac', { service: MACOS_SERVICE_LABEL });
  }
  return t('startup.logJournal', { unit: packagedUnit(home) });
}

/** Where the packaged host adapter's Windows restart runner is launched from. */
export type WindowsRestartSeams = { execPath: string; resourcesPath: string; env: NodeJS.ProcessEnv };
/** Same environment as the update runner (`upgradePackagedService`), so the runner reads the same home and ports. */
export function windowsRestartSeams(
  cfg: DesktopConfig,
  input: { execPath: string; runtimeEnv?: Readonly<Record<string, string>>; resourcesPath: string; version: string },
  baseEnv: NodeJS.ProcessEnv = process.env,
): WindowsRestartSeams {
  return {
    execPath: input.execPath,
    resourcesPath: input.resourcesPath,
    env: {
      ...withRuntimeEnv(baseEnv, { execPath: input.execPath, env: input.runtimeEnv ?? { ELECTRON_RUN_AS_NODE: '1' } }),
      TIMON_DESKTOP_EMBEDDED: '1',
      TIMON_DESKTOP_SERVICE: '0',
      TIMON_DESKTOP_VERSION: input.version,
      TIMON_HOME: cfg.home,
      TIMON_INSTALL_DIR: join(input.resourcesPath, 'orchestrator'),
      TIMON_APP_ENABLED: cfg.app.enabled ? '1' : '0',
      TIMON_APP_PORT: String(cfg.app.listen.port),
      PORT: String(cfg.daemon.listen.port),
    },
  };
}
export function windowsRestartRunner(resourcesPath: string): string {
  return join(resourcesPath, 'orchestrator', 'dist', 'host', 'windows-restart-runner.js');
}
async function execServiceRunner(win: WindowsRestartSeams, args: string[], what: string): Promise<{ stdout: string }> {
  try {
    // Long budget: the elevation prompt waits for the user.
    return await promisify(execFile)(win.execPath, args, { env: win.env, timeout: 300_000, windowsHide: true });
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim();
    throw new Error(stderr ? `The service ${what} failed: ${stderr}` : (error as Error).message);
  }
}
const execWindowsRestartRunner = (win: WindowsRestartSeams, args: string[]): Promise<{ stdout: string }> => execServiceRunner(win, args, 'restart');

/** Copy of `serviceStoppedMarker()` (orchestrator `host/service-install.ts`): left by `timon service stop`, removed by `start`. */
export function serviceStoppedMarkerFile(home: string): string { return join(home, 'run', 'service-stopped'); }
/** The user chose "Quit and stop the background service": this launch starts it again before waiting on the daemon. */
export function serviceStoppedByUser(home: string): boolean { return existsSync(serviceStoppedMarkerFile(home)); }
/** The daemon answers anyway (`timon service start`, a boot that loaded the service): never prompt for a start that happened. */
export function forgetServiceStopped(home: string): void { rmSync(serviceStoppedMarkerFile(home), { force: true }); }

/** The host adapter's `stop|start|restart` runner, launched from the packaged resources like the restart runner. */
export function desktopServiceRunner(resourcesPath: string): string {
  return join(resourcesPath, 'orchestrator', 'dist', 'host', 'desktop-service-runner.js');
}
export type ServiceControl = 'stop' | 'start' | 'restart';
/**
 * `stop`, `start` or `restart` of the installed service, through the host
 * adapter: the commands live there only. Windows prompts once (the task is
 * elevated), a LaunchDaemon asks for an administrator, the agent and systemd
 * ask nothing. The same environment as the restart runner, so it reads the
 * same home. `restart` also ends a daemon no launcher holds any more: the one
 * an update left running on the previous version (`finishUpdate`).
 */
export async function controlDesktopService(
  action: ServiceControl,
  seams: WindowsRestartSeams,
  exec: ServiceExec = (args) => execServiceRunner(seams, args, action),
): Promise<string> {
  const { stdout } = await exec([desktopServiceRunner(seams.resourcesPath), action]);
  return stdout.trim();
}

/** The tray item and its confirmation. The prompt names the OS's own permission step, when there is one. */
export function stopServiceCopy(locale: string, platform: NodeJS.Platform = process.platform): { trayItem: string; message: string; detail: string; buttons: [string, string] } {
  const t = shellText(locale);
  const permission = platform === 'win32' ? t('service.stopPermissionWindows')
    : platform === 'darwin' ? t('service.stopPermissionMac') : '';
  return {
    trayItem: t('service.stopItem'),
    message: t('service.stopMessage'),
    detail: permission ? `${t('service.stopDetail')} ${permission}` : t('service.stopDetail'),
    buttons: [t('service.stopConfirm'), t('service.cancel')],
  };
}

export function stopServiceFailureMessage(error: unknown, locale: string): { message: string; detail: string } {
  const reason = (error as Error | null)?.message || String(error);
  const t = shellText(locale);
  return { message: t('service.stopFailed'), detail: `${t('service.stopFailedDetail')}\n\n${reason}` };
}

export function startStoppedServiceFailureMessage(error: unknown, home: string, locale: string): { message: string; detail: string } {
  const reason = (error as Error | null)?.message || String(error);
  const t = shellText(locale);
  return { message: t('service.startFailed'), detail: `${t('service.startFailedDetail', { home })}\n\n${reason}` };
}
type ServiceExec = (args: string[]) => Promise<{ stdout: string }>;
const execSystemctl: ServiceExec = (args) => promisify(execFile)('systemctl', args, { timeout: 15_000 });
const execLaunchctl: ServiceExec = (args) => promisify(execFile)('launchctl', args, { timeout: 15_000 });
// Both are console programs: started from the windowed shell without
// `windowsHide`, each call flashes a console on the user's desktop (#116).
const execSchtasks: ServiceExec = (args) => promisify(execFile)('schtasks', args, { timeout: 15_000, windowsHide: true });
const execPowershell: ServiceExec = (args) => promisify(execFile)('powershell', args, { timeout: 30_000, windowsHide: true });

/**
 * `kickstart -k` fails when launchd has not loaded the agent yet (first run
 * right after the installer wrote the plist) or has throttled it after a crash
 * loop. Load it, then start it without killing; only that last failure counts.
 */
async function kickstartMacAgent(run: ServiceExec, uid: number, mac: MacServiceSeams): Promise<void> {
  const target = `gui/${uid}/${MACOS_SERVICE_LABEL}`;
  try {
    await run(['kickstart', '-k', target]);
    return;
  } catch { /* fall through to the load-then-start path */ }
  const plist = join(mac.userHome ?? homedir(), 'Library', 'LaunchAgents', `${MACOS_SERVICE_LABEL}.plist`);
  // "already bootstrapped" is the normal answer when the agent is loaded.
  await run(['bootstrap', `gui/${uid}`, plist]).catch(() => undefined);
  await run(['kickstart', target]);
}

/** Whether Task Scheduler knows the boot task. A failed query counts as absent: both leave nothing to wait on. */
export async function windowsTaskExists(exec: ServiceExec = execSchtasks): Promise<boolean> {
  return exec(['/Query', '/TN', WINDOWS_TASK]).then(() => true, () => false);
}

/**
 * What the registered task runs (`windowsTaskShape`), read without elevation
 * the way the host adapter reads it (`readWindowsTaskShape`): `schtasks /XML`
 * starts far faster than PowerShell, and loses only non-ASCII characters,
 * which neither the logon, the program name nor a trigger holds. `null` when
 * the task is missing or its definition cannot be read.
 */
export async function readWindowsTaskShape(exec: ServiceExec = execSchtasks): Promise<WindowsTaskShape | null> {
  try {
    const { stdout } = await exec(['/Query', '/TN', WINDOWS_TASK, '/XML', 'ONE']);
    return windowsTaskShape(stdout);
  } catch { return null; }
}

/**
 * Switches the task off, without elevation: Windows never starts it for this
 * account, and its five-minute trigger would keep knocking on the home the
 * embedded daemon holds (#116). Allowed when the task is the user's own; an
 * S4U task registered from an elevated prompt may refuse, and the caller
 * only logs it. Rejects with what schtasks said.
 */
export async function disableWindowsTask(exec: ServiceExec = execSchtasks): Promise<void> {
  await exec(['/Change', '/TN', WINDOWS_TASK, '/DISABLE']);
}

/** `ScheduledTasks` module lookup: the call `Unregister-ScheduledTask` answers to, unlike `schtasks`. */
const TASK_LOOKUP = ['-NoProfile', '-NonInteractive', '-Command',
  `if (Get-ScheduledTask -TaskName '${WINDOWS_TASK}' -TaskPath '\\' -ErrorAction SilentlyContinue) { 'present' } else { 'absent' }`];

export type WindowsTaskLookup = 'present' | 'absent' | 'unknown';

/**
 * What the two ways of asking Task Scheduler say about the boot task.
 * `exists` is lenient — either one seeing it is enough, so a `schtasks` that
 * fails on a localised console or a timeout does not send the user to a repair
 * offer for a task that is there. `confirmedAbsent` needs both to agree, and is
 * the only verdict allowed to delete anything (TIM-0108): a failed lookup is
 * `unknown`, never "gone".
 */
export async function windowsTaskState(
  query: ServiceExec = execSchtasks,
  lookup: ServiceExec = execPowershell,
): Promise<{ schtasks: boolean; lookup: WindowsTaskLookup; exists: boolean; confirmedAbsent: boolean }> {
  const schtasks = await windowsTaskExists(query);
  const found: WindowsTaskLookup = await lookup(TASK_LOOKUP).then(
    ({ stdout }) => /^present\s*$/m.test(stdout) ? 'present' : /^absent\s*$/m.test(stdout) ? 'absent' : 'unknown',
    () => 'unknown',
  );
  return {
    schtasks,
    lookup: found,
    exists: schtasks || found === 'present',
    confirmedAbsent: !schtasks && found === 'absent',
  };
}

/**
 * A task deleted outside Timon (`Unregister-ScheduledTask`, Task Scheduler's
 * own screen) leaves the files Timon wrote for it: the revision, which makes
 * `hasDesktopService` believe a service exists, and a "not now" to the
 * repair offer that was given for an earlier version of that task. Both go
 * (only when a revision says the task existed), so
 * the desktop stops waiting on a daemon nothing starts and the offer to put the
 * task back speaks again (TIM-0108). The launcher and witness stay: a
 * reinstall rewrites them. Returns what it removed.
 */
export function forgetMissingWindowsService(home: string): string[] {
  // Only when a revision says a task was there: without one, the task was
  // already gone and a "not now" given since then is still the user's answer.
  if (!existsSync(windowsServiceRevisionFile(home))) return [];
  const removed: string[] = [];
  for (const file of [windowsServiceRevisionFile(home), windowsRepairDeclinedFile(home)]) {
    if (!existsSync(file)) continue;
    rmSync(file, { force: true });
    removed.push(file);
  }
  return removed;
}

/**
 * `Get-ScheduledTaskInfo` output says the task has never run: `LastTaskResult`
 * 0x41303 AND no run since 2000 (Task Scheduler reports 30/11/1999 for
 * "never"). Anything unreadable is not "never": that verdict sends the
 * user to the built-in daemon, never on a guess.
 */
export function windowsTaskNeverRan(stdout: string): boolean {
  const result = /^LastTaskResult=(\d+)\s*$/m.exec(stdout)?.[1];
  const ranAt = /^LastRunTime=(.*)$/m.exec(stdout);
  if (result === undefined || !ranAt) return false;
  const year = /^(\d{4})-/.exec(ranAt[1]!.trim())?.[1];
  return Number(result) === WINDOWS_TASK_NEVER_RAN && (year === undefined || Number(year) < 2000);
}

/** Windows seams of `startDesktopService`: the task state query and the pause between two reads. */
export type WindowsStartSeams = { query?: ServiceExec; pause?: (ms: number) => Promise<void>; budgetMs?: number };
/** A task Windows accepts starts within a second of `/Run`; the margin is for a slow machine. */
export const WINDOWS_START_BUDGET_MS = 10_000;

const TASK_INFO_QUERY = ['-NoProfile', '-NonInteractive', '-Command',
  `$i = Get-ScheduledTaskInfo -TaskName '${WINDOWS_TASK}' -TaskPath '\\' -ErrorAction Stop; `
  + "'LastTaskResult=' + $i.LastTaskResult; 'LastRunTime=' + $(if ($i.LastRunTime) { $i.LastRunTime.ToString('s') } else { '' })"];

/**
 * Has the task started since `/Run`? `/Run` answers "SUCCESS: Attempted"
 * even when Windows then refuses the task's S4U logon — on a PC joined to
 * Microsoft Entra ID it never runs, writes no log, and the desktop waited 30 s
 * before "The Timon daemon does not answer" (TODO #342).
 */
async function windowsTaskStarted(win: WindowsStartSeams): Promise<boolean> {
  const query = win.query ?? execPowershell;
  const pause = win.pause ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const deadline = Date.now() + (win.budgetMs ?? WINDOWS_START_BUDGET_MS);
  for (;;) {
    let stdout: string;
    try { ({ stdout } = await query(TASK_INFO_QUERY)); } catch { return true; }
    if (!windowsTaskNeverRan(stdout)) return true;
    if (Date.now() >= deadline) return false;
    await pause(1000);
  }
}

export async function startDesktopService(
  home: string,
  firstRun = false,
  exec?: ServiceExec,
  platform: NodeJS.Platform = process.platform,
  uid: number = process.getuid?.() ?? 0,
  mac: MacServiceSeams = {},
  win: WindowsStartSeams = {},
): Promise<'started' | 'needs-repair' | 'never-ran'> {
  if (platform === 'darwin') {
    const service = macService(home, mac);
    // Another home's service is not this one's to start or wait on: the
    // embedded daemon serves this session (TODO #735).
    if (service.kind === 'foreign') return 'needs-repair';
    // A LaunchDaemon is already up (RunAtLoad + KeepAlive), and kickstarting
    // the system domain would need root: there is nothing to do but wait on it.
    if (service.kind === 'daemon') return 'started';
    // A failed start is not fatal: the caller waits on the daemon's health and
    // offers the service repair when it never answers, which says more than a
    // launchctl exit code.
    await kickstartMacAgent(exec ?? execLaunchctl, uid, mac).catch(() => undefined);
    return 'started';
  }
  if (platform === 'win32') {
    // `/Run` only saves the wait: the task starts itself at boot and every 5
    // minutes, and it may already be holding the daemon until the user's
    // first logon opens DPAPI. A refusal is therefore not a failure.
    const run = exec ?? execSchtasks;
    // An uninstall that deleted the task could leave its revision file, and the
    // desktop then waited on a daemon nothing would start (0.1.2-rc.5 reinstall,
    // 27/09/2026). Without a task, the embedded daemon serves this session; if
    // the query merely failed, the embedded start finds the task's daemon first.
    if (!await windowsTaskExists(run)) return 'needs-repair';
    await run(['/Run', '/TN', WINDOWS_TASK]).catch(() => undefined);
    return await windowsTaskStarted(win) ? 'started' : 'never-ran';
  }
  const run = exec ?? execSystemctl;
  if (firstRun) {
    const status = await run(['--user', 'show', packagedUnit(home), '--property=LoadState', '--value']);
    // A previous installer could leave an enabled but invalid unit. Keep the
    // first-run UI reachable so its installer can validate and repair it.
    if (status.stdout.trim() === 'bad-setting') return 'needs-repair';
  }
  // Same contract as macOS: the health wait decides, not the exit code.
  await run(['--user', 'start', packagedUnit(home)]).catch(() => undefined);
  return 'started';
}

const TASK_STATE_QUERY = ['-NoProfile', '-NonInteractive', '-Command',
  `'State=' + (Get-ScheduledTask -TaskName '${WINDOWS_TASK}' -TaskPath '\\' -ErrorAction Stop).State`];

/**
 * Is the task's launcher still running? Read past the handover's first wait:
 * a daemon still booting under its launcher is worth waiting for, a launcher
 * that ended will not answer. Unreadable is "no": the wait ends as before.
 */
export async function windowsTaskRunning(query: ServiceExec = execPowershell): Promise<boolean> {
  try {
    const { stdout } = await query(TASK_STATE_QUERY);
    return /^State=Running\s*$/m.test(stdout);
  } catch { return false; }
}

/**
 * Ends the task's launcher and the daemon under it, the way the host
 * adapter's `stopLauncherStep` does, without elevation: the launcher runs as
 * this account. Only when the handover gives up on a launcher still running,
 * so the embedded daemon that takes over is not refused the home.
 */
export async function endWindowsLauncher(home: string, run: ServiceExec = execPowershell): Promise<void> {
  // Both forms, as `launcherProcessFilter` matches them: the batch of revision 5 and what names the configuration.
  const needles = [windowsLauncher(home), windowsBatchLauncher(home)]
    .map((file) => `$_.CommandLine.ToLowerInvariant().Contains('${file.toLowerCase().replace(/'/g, "''")}')`);
  const programs = WINDOWS_LAUNCHER_PROGRAMS.map((name) => `'${name}'`).join(', ');
  await run(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `Get-CimInstance Win32_Process | Where-Object { @(${programs}) -contains $_.Name -and $_.ProcessId -ne $PID -and $_.CommandLine -and (${needles.join(' -or ')}) } | ForEach-Object { & taskkill.exe /F /T /PID $_.ProcessId | Out-Null }; exit 0`]);
}

/** Copy of `LAUNCHER_PROGRAMS` (orchestrator `host/service-install.ts`): what may run a launcher of the task. */
export const WINDOWS_LAUNCHER_PROGRAMS = ['cmd.exe', 'node.exe', 'timon.exe', 'powershell.exe', 'electron.exe'];

/**
 * Restarts the installed service so it reads the configuration the first-run
 * wizard just wrote. Unlike `start`, this replaces a daemon that is already
 * running: on a fresh install it is the service, not an embedded child, that
 * served the whole wizard.
 */
export async function restartDesktopService(
  home: string,
  exec?: ServiceExec,
  platform: NodeJS.Platform = process.platform,
  uid: number = process.getuid?.() ?? 0,
  mac: MacServiceSeams = {},
  win?: WindowsRestartSeams,
): Promise<void> {
  if (platform === 'darwin') {
    const service = macService(home, mac);
    if (service.kind === 'foreign') {
      throw new Error(`The service ${MACOS_SERVICE_LABEL} runs for ${service.home}, not for ${home}: it was left in place.`);
    }
    if (service.kind === 'daemon') {
      // `kickstart -k system/…` needs root. The daemon runs as this user, so
      // signalling it does not, and KeepAlive starts it again — the same
      // restart `timon service install` does after an update.
      const { stdout } = await (exec ?? execLaunchctl)(['print', `system/${MACOS_SERVICE_LABEL}`]);
      const pid = /^\s*pid = (\d+)\s*$/m.exec(stdout)?.[1];
      if (!pid) throw new Error('The Timon service is not running; launchd will start it again shortly.');
      (mac.kill ?? ((p: number) => process.kill(p, 'SIGTERM')))(Number(pid));
      return;
    }
    await kickstartMacAgent(exec ?? execLaunchctl, uid, mac);
    return;
  }
  if (platform === 'linux') {
    await (exec ?? execSystemctl)(['--user', 'restart', packagedUnit(home)]);
    return;
  }
  if (platform === 'win32') {
    // The daemon runs in session 0 under S4U: this process cannot end it, and
    // a `/Run` while it lives is dropped by IgnoreNew. The host adapter ends
    // the launcher's tree and restarts the task under one elevation prompt;
    // the commands live there only.
    if (!win) throw new Error('The Windows restart needs the packaged service runner.');
    await (exec ?? ((args) => execWindowsRestartRunner(win, args)))([windowsRestartRunner(win.resourcesPath)]);
    return;
  }
  throw new Error(`No desktop service to restart on ${platform}.`);
}
