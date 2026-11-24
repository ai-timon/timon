/**
 * How this Timon runs on this machine — the Settings › System › Installation
 * pane (TODO #333). Superadmin only (`GET /api/admin/system`).
 *
 * Every field answers a question a tester gets asked when something breaks:
 * which version, which data directory, where the log is, whether the daemon
 * is the service or the one inside the app, whether that service is stale.
 * No secret ever enters this object: no token, no licence id, no key, no
 * environment beyond the named markers below.
 */
import { fstatSync, readFileSync } from 'node:fs';
import { arch, release, version as osVersion } from 'node:os';
import { join } from 'node:path';
import { apiPort, boundAddress } from './api-url.js';
import { buildInfo } from './build-info.js';
import { CONFIG_FILE, config } from './config/load.js';
import { compareVersions, packagedDaemon, readDataVersion, timonVersion } from './data-version.js';
import { diagnose, systemdPresent } from './doctor.js';
import { buildDiagnosticReport, doctorSummary, type Finding } from './host/diagnostic-report.js';
import { packagedRuntime } from './host/bundled-node.js';
import { getHost } from './host/index.js';
import { logDir } from './log-file.js';
import { linuxRelease, readOsRelease, supervisorFor, type SupervisorKind } from './host/machine.js';
import { readServiceSessionMode, sessionModeSupported, type ServiceSessionMode } from './host/service-session-mode.js';
import { serviceOptsFromEnvironment } from './onboarding.js';
import {
  LINUX_UNIT, MACOS_LABEL, shQuote, statusService, WINDOWS_SERVICE_REVISION, WINDOWS_TASK,
  windowsConsoleTaskTrap, windowsLauncherMarked, windowsServiceFiles, type ServiceOpts,
} from './host/service-install.js';
import type { WindowsTaskShape } from './host/windows-task-shape.js';
import { effectiveEdition } from './license/license.js';
import { licenseState } from './license/runtime.js';
import { TIMON_HOME } from './paths.js';

/** Who started this daemon. `process` = a terminal, a dev script, anything else. */
export type DaemonMode = 'embedded' | 'service' | 'process';

export type DaemonLog =
  | { kind: 'file'; path: string }
  | { kind: 'journal'; command: string }
  /** Written to the standard output of whatever started it (the app, a terminal). */
  | { kind: 'console' };

export type ServiceAction = 'install' | 'repair' | null;

export type ServiceReport = {
  supervisor: SupervisorKind;
  /** Unit, launchd label or scheduled task name. */
  name: string | null;
  installed: boolean;
  running: boolean;
  /** The supervisor's refusal or warning, verbatim (paths only, no secret). */
  reason: string | null;
  /** `opensConsole`: the registered task opens a console window that a
   *  reinstall removes (#116, `windowsConsoleTaskTrap`). */
  windows: { revision: string | null; expected: string; launcherMarked: boolean | null; opensConsole: boolean } | null;
  stale: boolean;
  action: ServiceAction;
  /**
   * The action can run from the UI. False when this daemon IS the service:
   * reinstalling stops the very process answering the request (Windows stops
   * its launcher, systemd restarts the unit), so the CLI command is shown.
   */
  actionHere: boolean;
  command: string;
  /** Keeps running once the user logs out, read from the machine; `null` when not registered or unreadable. */
  offSession: boolean | null;
  /** The user's recorded answer (`service-session-mode.ts`), `null` when never asked. */
  sessionMode: ServiceSessionMode | null;
  /** The answer can be changed on this OS. */
  sessionModeSupported: boolean;
};

export type SystemInfo = {
  version: string;
  /** Version that last opened the database (`<home>/data-version`). */
  dataVersion: string | null;
  /** -1 / 0 / 1 against `version`, `null` when either cannot be parsed. */
  dataVersionOrder: number | null;
  os: { platform: NodeJS.Platform; name: string | null; release: string; arch: string };
  runtime: { node: string; electron: string | null };
  daemon: {
    mode: DaemonMode;
    /** Carries the desktop marker (`TIMON_DESKTOP_EMBEDDED`/`_SERVICE`). */
    packaged: boolean;
    /** Runs on the app's Electron runtime: a packaged install, marked or not. */
    packagedRuntime: boolean;
    pid: number;
    listen: { address: string | null; port: number };
    app: { servedByDaemon: boolean; host: string; port: number };
  };
  /** `logs`: the folder of the dated files (daemon, desktop, prompts) and the supervisor's `daemon.log`. */
  paths: { installDir: string; home: string; configFile: string; log: DaemonLog; logs: string };
  service: ServiceReport;
  license: { edition: string; plan: string | null; status: string; channel: string };
  /** Restoring an export: the database is replaced, never while the daemon runs. */
  importCommands: string[];
};

/**
 * systemd's own test for "my stdout is the journal": `JOURNAL_STREAM` holds
 * the `dev:ino` of the stream it connected. The variable alone proves
 * nothing — a shell opened from a terminal that is itself a user service
 * (GNOME Terminal) inherits it, and so does `INVOCATION_ID`.
 */
export function stdoutIsJournal(env: NodeJS.ProcessEnv, stat: () => { dev: number; ino: number } = () => fstatSync(1)): boolean {
  if (!env.JOURNAL_STREAM) return false;
  try {
    const { dev, ino } = stat();
    return env.JOURNAL_STREAM === `${dev}:${ino}`;
  } catch {
    return false;
  }
}

/** Reads only the named markers, never the rest of the environment. */
export function daemonMode(env: NodeJS.ProcessEnv, platform: NodeJS.Platform, journal: boolean): DaemonMode {
  if (env.TIMON_DESKTOP_EMBEDDED === '1') return 'embedded';
  if (env.TIMON_DESKTOP_SERVICE === '1') return 'service';
  // An unmarked service still leaves its supervisor's trace (TIM-0087): the
  // Windows launcher sets its log, the shipped unit writes to the journal,
  // launchd sets the job label.
  if (platform === 'win32' && env.TIMON_SERVICE_LOG) return 'service';
  if (platform === 'linux' && journal) return 'service';
  if (platform === 'darwin' && env.XPC_SERVICE_NAME === MACOS_LABEL) return 'service';
  return 'process';
}

export function daemonLog(input: {
  mode: DaemonMode;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  journal: boolean;
  home: string;
  unit: string;
}): DaemonLog {
  if (input.mode !== 'service') return { kind: 'console' };
  if (input.platform === 'win32' && input.env.TIMON_SERVICE_LOG) {
    return { kind: 'file', path: input.env.TIMON_SERVICE_LOG };
  }
  if (input.platform === 'linux' && input.journal) {
    return { kind: 'journal', command: `journalctl --user -u ${input.unit}` };
  }
  // Same file the launchd plist and the Windows launcher write.
  return { kind: 'file', path: join(input.home, 'tmp', 'daemon.log') };
}

/** Same definition as the desktop's outdated-task check (TIM-0087): a
 *  different revision, or a packaged launcher without its marker. Plus a
 *  task of the current revision switched to a console after Timon wrote it
 *  (#116): `timon service status` and doctor send its user to Settings ›
 *  Installation, which must then offer the repair. `shape` is `null` when the
 *  definition could not be read: nothing is claimed about it. */
export function windowsTaskStale(input: {
  revision: string | null;
  launcherMarked: boolean | null;
  packagedRuntime: boolean;
  shape?: WindowsTaskShape | null;
}): boolean {
  if (input.revision !== WINDOWS_SERVICE_REVISION) return true;
  if (input.shape && windowsConsoleTaskTrap(input.shape, input.packagedRuntime)) return true;
  return input.packagedRuntime && input.launcherMarked === false;
}

export function serviceAction(input: {
  supervisor: SupervisorKind;
  installed: boolean;
  stale: boolean;
  mode: DaemonMode;
  /** The supervisor refused to vouch for the definition it found (a unit of
   *  another installation or home): installing over it is not ours to offer. */
  refused: boolean;
}): { action: ServiceAction; actionHere: boolean } {
  if (input.supervisor === null || input.refused) return { action: null, actionHere: false };
  const action: ServiceAction = !input.installed ? 'install' : input.stale ? 'repair' : null;
  return { action, actionHere: action !== null && input.mode !== 'service' };
}

/**
 * `timon import` writes the database the daemon holds open: the service is
 * removed first and put back after (data untouched both ways), the app quit
 * before — it would start its own daemon once the service is gone. The
 * placeholder carries no `<>`: a redirection in a shell, pasted as is.
 * `--to` is explicit so the CLI cannot aim at another home than this one.
 */
export function importCommands(platform: NodeJS.Platform, home: string, serviceInstalled: boolean): string[] {
  const target = platform === 'win32' ? `"${home}"` : shQuote(home);
  return [
    ...(serviceInstalled ? ['timon service uninstall'] : []),
    `timon import ARCHIVE.tar.gz --to ${target} --force`,
    ...(serviceInstalled ? ['timon service install'] : []),
  ];
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function serviceName(supervisor: SupervisorKind, opts: ServiceOpts): string | null {
  if (supervisor === 'systemd-user') return opts.unitName ?? LINUX_UNIT;
  if (supervisor === 'launchd') return MACOS_LABEL;
  if (supervisor === 'windows') return WINDOWS_TASK;
  return null;
}

function serviceReport(opts: ServiceOpts, mode: DaemonMode, packagedRuntime: boolean): ServiceReport {
  const platform = opts.platform;
  const supervisor = supervisorFor(platform, { systemd: platform === 'linux' && systemdPresent() });
  const name = serviceName(supervisor, opts);
  const command = 'timon service install';
  const session = {
    sessionMode: readServiceSessionMode(opts.timonHome),
    sessionModeSupported: supervisor !== null && sessionModeSupported(platform),
  };
  if (supervisor === null) {
    return {
      supervisor, name, installed: false, running: false, reason: null, windows: null,
      stale: false, action: null, actionHere: false, command, offSession: null, ...session,
    };
  }
  const status = statusService(opts);
  const installed = status.installed === true;
  let windows: ServiceReport['windows'] = null;
  let stale = false;
  if (platform === 'win32' && installed) {
    const files = windowsServiceFiles(opts.timonHome, join);
    const revision = readText(files.revision)?.trim() || null;
    const launcherMarked = windowsLauncherMarked(opts.timonHome);
    // The shape `statusService` already read: no second schtasks query.
    const shape = status.taskShape ?? null;
    const opensConsole = shape !== null && windowsConsoleTaskTrap(shape, packagedRuntime);
    windows = { revision, expected: WINDOWS_SERVICE_REVISION, launcherMarked, opensConsole };
    stale = windowsTaskStale({ revision, launcherMarked, packagedRuntime, shape });
  }
  // Any OS: the service started the app's runtime without the desktop marker.
  if (installed && mode === 'service' && packagedRuntime && !packagedDaemon()) stale = true;
  return {
    supervisor, name, installed, running: status.ok, reason: status.reason ?? null, windows, stale,
    ...serviceAction({ supervisor, installed, stale, mode, refused: !installed && Boolean(status.reason) }), command,
    offSession: status.offSession ?? null, ...session,
  };
}

function osName(platform: NodeJS.Platform): string | null {
  if (platform === 'linux') return linuxRelease(readOsRelease())?.prettyName ?? null;
  try {
    return osVersion() || null;
  } catch {
    return null;
  }
}

export function systemInfo(): SystemInfo {
  const cfg = config();
  const platform = process.platform;
  const version = timonVersion();
  const dataVersion = readDataVersion(TIMON_HOME);
  const journal = platform === 'linux' && stdoutIsJournal(process.env);
  const mode = daemonMode(process.env, platform, journal);
  const packaged = packagedRuntime();
  const opts = serviceOptsFromEnvironment();
  const service = serviceReport(opts, mode, packaged);
  const license = licenseState();
  return {
    version,
    dataVersion,
    dataVersionOrder: dataVersion === null ? null : compareVersions(dataVersion, version),
    os: { platform, name: osName(platform), release: release(), arch: arch() },
    runtime: { node: process.versions.node, electron: process.versions.electron ?? null },
    daemon: {
      mode,
      packaged: packagedDaemon(),
      packagedRuntime: packaged,
      pid: process.pid,
      listen: { address: boundAddress(), port: apiPort() },
      app: { servedByDaemon: cfg.app.enabled, host: cfg.app.listen.host, port: cfg.app.listen.port },
    },
    paths: {
      installDir: cfg.daemon.installDir,
      home: TIMON_HOME,
      configFile: CONFIG_FILE,
      log: daemonLog({ mode, platform, env: process.env, journal, home: TIMON_HOME, unit: service.name ?? LINUX_UNIT }),
      logs: logDir(TIMON_HOME),
    },
    service,
    license: {
      edition: effectiveEdition(cfg.edition, license.edition),
      plan: license.plan,
      status: license.status,
      channel: buildInfo().channel,
    },
    importCommands: importCommands(platform, TIMON_HOME, service.installed),
  };
}


/**
 * The support report of Settings › System (TODO #343), from inside the
 * daemon: the same text as the desktop's error boxes and `timon doctor
 * --report`, plus what only the running daemon knows (its mode, its licence
 * state, its own doctor). `appVersion` is the desktop's, when the pane has it.
 */
export async function daemonDiagnosticReport(appVersion: string | null): Promise<{ text: string; findings: Finding[] }> {
  const info = systemInfo();
  const { daemon, license } = info;
  return buildDiagnosticReport({
    source: 'daemon',
    home: TIMON_HOME,
    cfg: config(),
    host: getHost(),
    serviceOpts: serviceOptsFromEnvironment(),
    appVersion,
    daemonVersion: info.version,
    runningUnmarked: daemon.mode === 'service' && daemon.packagedRuntime && !daemon.packaged,
    sections: [{
      title: 'Daemon process',
      lines: [
        `mode      ${daemon.mode}${daemon.packaged ? ' (packaged)' : ''}, pid ${daemon.pid}`,
        `listening ${daemon.listen.address ?? '?'}:${daemon.listen.port}`,
        `log       ${info.paths.log.kind === 'file' ? info.paths.log.path : info.paths.log.kind === 'journal' ? info.paths.log.command : 'standard output'}; dated files in ${logDir(TIMON_HOME)}`,
        `licence   ${license.edition}, plan ${license.plan ?? '—'}, ${license.status}, channel ${license.channel}`,
      ],
    }],
    doctor: async () => doctorSummary(diagnose()),
  });
}
