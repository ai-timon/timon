/**
 * Service installers — `timon service install|uninstall|status` (plan §5.3).
 *
 * This is the one piece of the desktop client that must NOT live in the
 * desktop client: installing a service is a host gesture, the CLI needs it on
 * a headless server, and the Electron shell only calls it. It lives with the
 * host adapter for the same reason `systemd.ts` does.
 *
 * Two invariants, both load-bearing:
 *
 *  - **`uninstall` never touches `TIMON_HOME`.** Removing the supervisor of a
 *    daemon is not removing the user's missions, agents and database. A user
 *    who uninstalls a service to reinstall it differently must find their data
 *    where they left it.
 *  - **Nothing here spawns the daemon directly.** It writes a unit or a plist
 *    and hands it to systemd/launchd. A "service" that the installer started
 *    itself would die with the terminal that ran the command.
 *
 * Windows IS supported since step 5.7.2 — an amendment to plan §5.3, which had
 * it print "not supported in v1". Installing the daemon as a service is now
 * mandatory on the three OSes, so the refusal had to go. It is a SCHEDULED
 * TASK: a real Windows service would need a third-party wrapper, a dependency
 * outside plan §0.5. Since backlog #141 it starts at BOOT and runs under an S4U
 * logon, so it survives the user logging off (docs/SERVICE-HORS-SESSION.md).
 *
 * That task WAS believed to need no administrator rights — this file, the
 * README and `desktop/build/installer.nsh` all said so. Windows disagrees: a
 * task carrying a LogonTrigger is refused to a caller who is not elevated,
 * even when it runs as that very caller, even in a subfolder of the library
 * (`schtasks /Create` answers "Access denied"; the same task with a `ONCE`
 * trigger registers without a prompt — verified 12/09/2026 on Windows 11). A
 * user who was not an administrator could therefore never get past the
 * first-run screen. The install now asks for elevation, once, through
 * `runElevated`; the trade the old comment described was never available.
 * That is also why S4U costs nothing more: registering it needs the same
 * elevation, and no stored password.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, posix, relative, resolve, sep, win32 as winPath } from 'node:path';
import { runtimeDir } from './packaged-service.js';
import type { ExecResult } from './types.js';
import { isBundledNode, packagedRuntime } from './bundled-node.js';
import { readServiceSessionMode, serviceS4uRefusedPath, sessionModeSupported, writeServiceSessionMode, type ServiceSessionMode } from './service-session-mode.js';
import { parseLauncherConfig, WINDOWS_LAUNCHER_FORMAT, type WindowsLauncherConfig } from './windows-service-launcher.js';
import { windowsTaskShape, type WindowsTaskShape } from './windows-task-shape.js';

export const LINUX_UNIT = 'timon-orchestrator';
export const MACOS_LABEL = 'com.timon.daemon';
/** No space in the task name: it travels through `schtasks`, NSIS and a shell,
 *  and each of the three would quote it differently. */
export const WINDOWS_TASK = 'TimonOrchestrator';

export type ServiceAction = 'install' | 'uninstall' | 'status';

export type ServiceOpts = {
  platform: NodeJS.Platform;
  /** User home — the tests point it at a temporary directory. */
  homeDir: string;
  /** `TIMON_HOME`, only ever READ (log paths, env of the child). */
  timonHome: string;
  /** Directory holding `dist/` — `config.daemon.installDir`. */
  installDir: string;
  userName: string;
  /** Windows: `USERDOMAIN`, the fallback qualifier of the task principal
   *  when the account SID cannot be read (`windowsTaskUserId`). */
  userDomain?: string;
  uid: number;
  heapMb: number;
  port: number;
  /** `node` (or the Electron binary run as node) that launches the daemon. */
  nodePath: string;
  /** Extra environment required by a packaged runtime (for example Electron
   *  running as Node). Generic CLI-installed services leave this empty. */
  environment?: Record<string, string>;
  /** Linux: directories of the agent CLIs the installing shell resolved
   *  (for example `~/.npm-global/bin`), prepended to the unit's `PATH`. The
   *  unit's fixed `PATH` does not contain them, so the daemon would otherwise
   *  resolve a different (older) binary than the user's shell, or none. */
  agentBinDirs?: readonly string[];
  /** Injected: `host.exec`. Tests pass a recorder. `timeout` overrides the
   *  caller's own budget for one call (the elevated Windows batch). */
  exec: (name: string, args: string[], options?: { timeout?: number }) => ExecResult;
  /** Bounded launchd shutdown polling; tests replace the synchronous pause. */
  pause?: (milliseconds: number) => void;
  /** Reads the elevated helper's transcript; tests replace the filesystem. */
  readFile?: (file: string) => string;
  /** `true` = print what would happen, write nothing, call nothing. */
  dryRun?: boolean;
  /** Packaged instances use an isolated unit and a durable Electron runtime. */
  unitName?: string;
  unitContent?: string;
  /** Exact previous packaged template, used only to repair its invalid directory syntax. */
  legacyUnitContent?: string;
  pendingHandover?: boolean;
  /** Windows: also end this installation's daemon that holds the port without
   *  a launcher (`stopPortOwnerStep`). Only the desktop upgrade runner sets it:
   *  during onboarding that daemon is the embedded one serving the wizard. */
  replacePortOwner?: boolean;
  /** Windows: leave the batch launcher of revisions 2 to 5 on disk. The
   *  desktop upgrade runner sets it, and retires the batch once the new task
   *  answers (`retireBatchLauncher`): until then, a rollback restores a task
   *  that runs it. */
  keepBatchLauncher?: boolean;
  /** Durable runtime copies of this instance. A packaged unit whose working
   *  directory is one of them is ours, even when it names an older release. */
  releasesRoot?: string;
  /** Replace a daemon that is already running: `enable --now` leaves it alone. */
  restart?: boolean;
  /**
   * `--force`: the service in place belongs to another installation
   * (`service-ownership.ts`), and the user asked to replace or remove it anyway.
   * Its `home` names the launcher to end on Windows; `null` when unreadable.
   * `units`: on Linux, the units of other names on this home, to take down too
   * (`servicesSharingHome`).
   */
  replacing?: { home: string | null; units?: string[] };
  /**
   * macOS: install the LaunchDaemon, which keeps running with no session open.
   * Left out, the claude token marker decides (`claudeTokenMarkerPath`): the
   * daemon never reaches the login keychain, so without that token claude
   * would be broken in it, open session or not.
   */
  offSession?: boolean;
  /**
   * The user's answer to "keep running when logged out?"
   * (`service-session-mode.ts`). Left out, the recorded one is read; `null` =
   * never asked, and the supervisor's off-session behaviour is left as found.
   */
  sessionMode?: ServiceSessionMode | null;
  /** macOS: where LaunchDaemons live. Tests point it at a temporary directory. */
  launchDaemonsDir?: string;
  /** macOS: how the administrator prompt is shown. Default: `sudo` in a
   *  terminal, the system dialog (`osascript`) otherwise. */
  elevation?: 'osascript' | 'sudo';
  /** macOS: signals the daemon to restart it; tests record the call. */
  kill?: (pid: number) => void;
};

export type ServiceResult = {
  ok: boolean;
  /** Process exit code the CLI should use. */
  code: number;
  lines: string[];
  /**
   * `status` only: is a unit/plist/task REGISTERED here? Distinct from `ok`,
   * which says it is running (step 5.7.6). The two differ exactly when it
   * matters: during a packaged first launch the embedded daemon still holds
   * the port, so the freshly installed service cannot start until the user
   * relaunches. Blocking the onboarding screen on `ok` would deadlock there.
   */
  installed?: boolean;
  /**
   * `install` only: `false` promises the supervisor definition on disk was not
   * touched. Absent means it may have been, so a caller undoing a failed
   * install must assume it was.
   */
  written?: boolean;
  /**
   * Windows `install` only: the task was registered but Windows never started
   * it for this account (S4U logon refused, TODO #342). No service can serve
   * this account; the caller runs the built-in daemon instead of restoring a
   * definition that would be refused the same way.
   */
  refused?: boolean;
  /**
   * Windows `install` and restore: the task was asked to run off session (S4U)
   * but Windows kept it for the session only, so the session task was
   * registered instead (`WINDOWS_SESSION_FALLBACK_NOTICE`, which `lines`
   * carries). The service works, and stops at logout.
   */
  sessionFallback?: boolean;
  /**
   * Windows `status` only: what the registered task runs (`windowsTaskShape`),
   * absent when its definition could not be read.
   */
  taskShape?: WindowsTaskShape;
  /**
   * `status` only: does the registered service keep running once the user
   * logs out? Linux: lingering is on for the account. macOS: the LaunchDaemon.
   * Windows: the task runs under S4U rather than the interactive token.
   * Absent when no service is registered or the answer could not be read.
   */
  offSession?: boolean;
  /**
   * Linux `status` only: lingering is on for the account, service or not. A
   * "stop with the session" answer turns it off, which also stops the user's
   * other services at logout: the onboarding says so before the click.
   */
  lingering?: boolean;
  reason?: string;
};

/** Where the systemd user unit is written. */
export function unitPath(homeDir: string, name = LINUX_UNIT): string {
  return join(homeDir, '.config', 'systemd', 'user', `${name}.service`);
}

/** Written by the daemon while a long-lived claude token is stored
 *  (the official Claude provider plugin). The supervisor code runs without the
 *  database, so this file is how it learns the token exists. No value inside. */
export function claudeTokenMarkerPath(timonHome: string): string {
  return join(timonHome, 'run', 'claude-token-configured');
}

/** Where the launchd agent is written (without a claude token, see `installDarwin`). */
export function plistPath(homeDir: string): string {
  return join(homeDir, 'Library', 'LaunchAgents', `${MACOS_LABEL}.plist`);
}

/** Repo root — the systemd template appends `/orchestrator` itself. */
function repoOf(installDir: string): string {
  return dirname(installDir);
}

function templatePath(installDir: string): string {
  return join(installDir, 'scripts', `${LINUX_UNIT}.service.template`);
}

/** `PATH` entries of the shipped unit, which `agentBinDirs` must not repeat. */
const UNIT_BASE_PATH = ['/usr/local/bin', '/usr/bin', '/bin'];

/** A `PATH` prefix for the unit: absolute, systemd-safe, deduplicated. */
export function unitPathPrefix(homeDir: string, dirs: readonly string[] | undefined): string {
  const known = new Set([join(homeDir, '.local', 'bin'), ...UNIT_BASE_PATH]);
  const out: string[] = [];
  for (const dir of dirs ?? []) {
    if (!isAbsolute(dir) || /[\r\n\0:"]/.test(dir) || known.has(dir)) continue;
    known.add(dir);
    out.push(dir.replaceAll('%', '%%'));
  }
  return out.length ? `${out.join(':')}:` : '';
}

/** Renders the shipped systemd template. Never invents a unit of its own:
 *  the template is the reference, and `install-linux.sh` renders the same one. */
export function renderUnit(
  opts: Pick<ServiceOpts, 'installDir' | 'userName' | 'port' | 'heapMb' | 'timonHome'> & Partial<Pick<ServiceOpts, 'homeDir' | 'agentBinDirs'>>,
): string {
  if (/[\r\n\0]/.test(opts.timonHome)) throw new Error('Invalid daemon data directory');
  const template = templatePath(opts.installDir);
  if (!existsSync(template)) {
    throw new Error(`systemd template not found — ${template}`);
  }
  // `@PORT@`/`@HEAP@` since step 5.7.6. The template used to pin `PORT=3000`,
  // so a packaged install — which runs on 3010 to avoid the v1 — got a service
  // listening somewhere the desktop client never looks. The unit must carry
  // the port the config actually asks for.
  return readFileSync(template, 'utf8')
    .replaceAll('@REPO@', repoOf(opts.installDir))
    .replaceAll('@USER@', opts.userName)
    .replaceAll('@PORT@', String(opts.port))
    .replaceAll('@HEAP@', String(opts.heapMb))
    .replace(/^Environment=PATH=/m, (line) => `${line}${unitPathPrefix(opts.homeDir ?? '', opts.agentBinDirs)}`)
    // The section header itself: the shipped template also names it in a comment,
    // above the section. Placed there, the line landed in `[Unit]`, which systemd
    // ignores, and the daemon ran on the default home.
    .replace(/^\[Service\]$/m, () => `[Service]\nEnvironment="TIMON_HOME=${opts.timonHome.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`);
}

function escapeXml(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]!));
}

/**
 * Renders the launchd agent.
 *
 * `PATH` is written out explicitly: a launchd agent inherits a minimal
 * environment where `~/.local/bin` is absent, and the daemon's first act is to
 * spawn `claude` from there — exactly the trap the systemd unit documents.
 */
export function renderPlist(
  opts: Pick<ServiceOpts, 'homeDir' | 'timonHome' | 'installDir' | 'heapMb' | 'port' | 'nodePath' | 'environment'>,
): string {
  const logDir = join(opts.timonHome, 'tmp');
  const args = [opts.nodePath, `--max-old-space-size=${opts.heapMb}`, join(opts.installDir, 'dist', 'boot.js')];
  const path = `${join(opts.homeDir, '.local', 'bin')}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin`;
  const environment = {
    PATH: path,
    NODE_ENV: 'production',
    PORT: String(opts.port),
    TIMON_HOME: opts.timonHome,
    ...opts.environment,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MACOS_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args.map((a) => `    <string>${escapeXml(a)}</string>`).join('\n')}
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(opts.installDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment).map(([key, value]) => `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`).join('\n')}
  </dict>
  <key>StandardOutPath</key><string>${escapeXml(join(logDir, 'daemon.log'))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(join(logDir, 'daemon.log'))}</string>
</dict>
</plist>
`;
}

/** Where the task definition is staged before `schtasks /XML` reads it.
 *  Never under `TIMON_HOME`: that directory belongs to the user's data. */
export function taskXmlPath(dir: string = tmpdir()): string {
  return join(dir, `${WINDOWS_TASK}.xml`);
}

/** Where the session task is staged next to an off-session one, for the
 *  fallback of `logonCheckStep` and `verifyTaskStartedStep`. */
export function sessionTaskXmlPath(dir: string = tmpdir()): string {
  return join(dir, `${WINDOWS_TASK}-session.xml`);
}

/** Marks an exit code in the elevated transcript; `runElevated` reads them back. */
const ELEVATED_STEP = 'TIMON-STEP';

/**
 * Budget of the elevated batch, permission prompt included. The default 30 s
 * of the button and the updater ran out on the refused-task path (prompt,
 * then up to `TASK_VERIFY_SECONDS` of checking): the outer PowerShell was
 * killed while the batch went on, and an install it was about to undo read
 * as a success.
 */
const ELEVATED_TIMEOUT_MS = 180_000;

/** `ERROR_CANCELLED` — what Windows returns when a UAC prompt is dismissed. */
const UAC_CANCELLED = 1223;

/** Where the elevated helper and its transcript are staged.
 *  Never under `TIMON_HOME`: that directory belongs to the user's data. */
export function elevatedScriptPath(dir: string = tmpdir()): string {
  return join(dir, `${WINDOWS_TASK}-elevate.cmd`);
}
export function elevatedLogPath(dir: string = tmpdir()): string {
  return join(dir, `${WINDOWS_TASK}-elevate.log`);
}

/** One call of an elevated batch, `schtasks` unless `program` says otherwise.
 *  `stopOnFailure` guards what must not be attempted after a failure — `/Run`
 *  on a task `/Create` never made. */
export type ElevatedStep = { label: string; args: string[]; stopOnFailure?: boolean; program?: string };

function cmdQuote(s: string): string {
  // `%` is expanded by cmd even between quotes: a batch literal doubles it.
  const literal = s.replace(/%/g, '%%');
  return /[\s&|<>^"]/.test(literal) ? `"${literal.replace(/"/g, '""')}"` : literal;
}

/**
 * The batch the elevated process runs.
 *
 * `Start-Process -Verb RunAs` and `-RedirectStandardOutput` belong to two
 * exclusive parameter sets, so the elevated side redirects its own streams and
 * states each exit code on a `TIMON-STEP` line, which `runElevated` reads
 * back. `chcp 65001` comes first: schtasks answers in the machine's language,
 * and its OEM code page reaches the UI as mojibake otherwise — "Accès refusé"
 * was displayed as "Acc?s refus?" (french-ok: a French Windows' error, quoted).
 *
 * `%ERRORLEVEL%` is captured into `RC` before being echoed: `echo` succeeds,
 * and would reset it before the guard could read it. The space before each
 * `>>` is not cosmetic either — `echo x=%ERRORLEVEL%>>file` ends on a digit,
 * which cmd reads as the redirection handle it precedes.
 */
export function renderElevatedScript(steps: readonly ElevatedStep[], log: string): string {
  const body = steps.flatMap(({ label, args, stopOnFailure, program }) => [
    `${program ?? 'schtasks'} ${args.map(cmdQuote).join(' ')} >>${cmdQuote(log)} 2>&1`,
    'set RC=%ERRORLEVEL%',
    `echo ${ELEVATED_STEP} ${label}=%RC% >>${cmdQuote(log)}`,
    ...(stopOnFailure ? ['if not "%RC%"=="0" goto :done'] : []),
  ]);
  return ['@echo off', 'chcp 65001 >nul', ...body, ':done', 'exit /b 0', ''].join('\r\n');
}

/** The exit codes the elevated batch reported, by step label. */
export function parseElevatedTranscript(text: string): Map<string, number> {
  const codes = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const m = /^TIMON-STEP (\w+)=(-?\d+)/.exec(line.trim());
    if (m) codes.set(m[1]!, Number(m[2]));
  }
  return codes;
}

/**
 * Runs a batch of `schtasks` calls under a SINGLE elevation prompt.
 *
 * One prompt, not one per call: an install registers the task and starts it,
 * an uninstall stops it and deletes it, and asking twice for one gesture
 * teaches a user to dismiss the second prompt.
 */
function runElevated(
  opts: ServiceOpts,
  lines: string[],
  steps: readonly ElevatedStep[],
): { codes: Map<string, number>; output: string; cancelled: boolean } {
  if (opts.dryRun) {
    lines.push(`(dry-run) would elevate: ${steps.map((s) => `${s.program ?? 'schtasks'} ${s.args.join(' ')}`).join(', then ')}`);
    return { codes: new Map(steps.map((s) => [s.label, 0])), output: '', cancelled: false };
  }
  const log = elevatedLogPath();
  const script = elevatedScriptPath();
  rmSync(log, { force: true });
  writeFileSync(script, renderElevatedScript(steps, log));
  const res = run(opts, lines, 'powershell', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `try { $p = Start-Process -FilePath '${script.replace(/'/g, "''")}' -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode } catch { exit ${UAC_CANCELLED} }`,
  ], { timeout: ELEVATED_TIMEOUT_MS });
  let output = '';
  try {
    output = (opts.readFile ?? ((f: string) => readFileSync(f, 'utf8')))(log);
  } catch {
    // No transcript at all: the elevated side never ran. The exit code carried
    // by `cancelled` is what says why.
  }
  return { codes: parseElevatedTranscript(output), output, cancelled: res.code === UAC_CANCELLED };
}

function escapeXmlText(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

/**
 * Revision of the task definition. The desktop rewrites a task whose recorded
 * revision differs (`desktop/src/upgrade.ts`, which keeps a copy of this value):
 * a Windows update replaces the application files, never the task.
 * 2 = boot trigger + S4U + launcher that holds the daemon (backlog #141).
 * 3 = the launcher marks its daemon as packaged (`TIMON_DESKTOP_SERVICE=1`),
 *     so it waits for update approval and serves the update routes.
 * 4 = the task names its account by SID (`windowsTaskUserId`), which only new
 *     installs had: a bare name can be one Windows never runs the task for
 *     (TODO #342, #564). The rewrite also carries the launcher of this build.
 * 5 = the launcher runs the daemon on the Node the package ships
 *     (`resources\node\node.exe`) instead of `Timon.exe` as Node.
 * 6 = no batch, no PowerShell, no `<Hidden>` in the task: its action starts a
 *     program of the package directly (`windowsTaskAction`), which Avast and
 *     AVG no longer quarantine as a hidden persistence script. The batch
 *     launcher becomes a configuration (`renderWindowsLauncherConfig`).
 */
export const WINDOWS_SERVICE_REVISION = '6';

/** Recorded after a rollback: never a revision, so the rewrite stays due, and readable in `timon doctor`. */
const WINDOWS_REVISION_RESTORED = 'restored';

/** Past this size the daemon log is moved aside, once, at the next start. */
export const WINDOWS_LOG_ROTATE_BYTES = 10 * 1024 * 1024;

/** What the session witness decrypts to. Not a secret: only whether DPAPI
 *  can decrypt it matters. */
const SESSION_WITNESS_TEXT = 'timon-session-witness';

/**
 * Every file the task owns. `joinPath` is `win32.join` for what Windows reads
 * (the launcher, the task XML) and the host's `join` for what this process
 * writes — the tests run on Linux, where `win32.join` would name a literal
 * file in the working directory.
 */
export function windowsServiceFiles(timonHome: string, joinPath: (...parts: string[]) => string = winPath.join) {
  const run = joinPath(timonHome, 'run');
  return {
    /** What the task names: the launcher's configuration (`renderWindowsLauncherConfig`). */
    launcher: joinPath(run, 'timon-service.json'),
    /** The batch of revisions 2 to 5. Kept until the task that replaces it has
     *  answered: a failed upgrade restores a task that runs it
     *  (`retireBatchLauncher`). */
    batchLauncher: joinPath(run, 'timon-service.cmd'),
    /** Launcher of revision 1, kept so a restored revision-1 task still starts. */
    legacyLauncher: joinPath(run, 'timon-service.vbs'),
    sessionWitness: joinPath(run, 'session-witness.dpapi'),
    revision: joinPath(run, 'service-revision'),
    /** Written by the desktop when the user declines the offer to reinstall the task. */
    repairDeclined: joinPath(run, 'service-repair-declined'),
    /** Written by the desktop when the rewrite that repairs a task changed
     *  outside Timon (#116) is declined or fails at launch, with the app's
     *  version: the same version stops asking. Removed by an install that
     *  succeeds (Settings › Installation, `timon service install`) and by an
     *  uninstall. */
    rewriteDeclined: joinPath(run, 'service-rewrite-declined'),
    /** Written when Windows registered the task but never started it for this
     *  account (`verifyTaskStartedStep`); removed by an install whose task runs
     *  and by an uninstall. */
    refused: joinPath(run, 'service-refused'),
    log: joinPath(timonHome, 'tmp', 'daemon.log'),
  };
}

/** Where the launcher configuration the task names lives. */
export function windowsLauncherPath(timonHome: string): string {
  return windowsServiceFiles(timonHome).launcher;
}

/** Where the batch launcher of revisions 2 to 5 lives. */
export function windowsBatchLauncherPath(timonHome: string): string {
  return windowsServiceFiles(timonHome).batchLauncher;
}

/** A value the task's action carries between double quotes: a quote or a line
 *  break would end the argument it sits in (Windows forbids both in a path). */
function taskValue(value: string): string {
  if (/[\r\n\0"]/.test(value)) throw new Error('Invalid service value');
  return value;
}

/**
 * PowerShell statements that exit 0 when DPAPI decrypts the witness at
 * `pathExpression` (PowerShell syntax), 2 when the file is missing, and fall
 * through when it cannot be decrypted, with the cause in `$why`. Shared by the
 * launcher and by `repairSessionWitness`, so both judge the witness the same
 * way; each reports `$why` where its reader looks.
 *
 * `$why` holds the exception type and message only, never the blob nor what
 * it decrypted to: the message of a DPAPI or format failure does not echo its
 * input. Bounded, and on one line, because the launcher writes it to a log.
 */
function sessionWitnessReadStatements(pathExpression: string): string[] {
  return [
    `$f = ${pathExpression}`,
    'if (-not (Test-Path -LiteralPath $f)) { exit 2 }',
    "$why = 'decrypted to an unexpected value'",
    // `.Trim()` is load-bearing: the trailing newline makes ConvertTo-SecureString
    // refuse the blob (checked on Windows 11, 23/09/2026).
    `try { $s = ConvertTo-SecureString -String (Get-Content -LiteralPath $f -Raw -ErrorAction Stop).Trim() -ErrorAction Stop; $b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); if ([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) -eq '${SESSION_WITNESS_TEXT}') { exit 0 } } catch { $why = ($_.Exception.GetType().Name + ': ' + $_.Exception.Message) -replace '\\s+', ' ' }`,
    'if ($why.Length -gt 300) { $why = $why.Substring(0, 300) }',
  ];
}

/**
 * The executable of the desktop package, a GUI-subsystem program: started by
 * the task, it opens no console window. `productName` in
 * `desktop/electron-builder.yml`, which `packaging.test.ts` holds to this.
 */
export const WINDOWS_APP_EXECUTABLE = 'Timon.exe';

/** The switch that makes `WINDOWS_APP_EXECUTABLE` start the service launcher
 *  and nothing else (`desktop/src/windows-service-shell.ts` keeps a copy). */
export const WINDOWS_SERVICE_FLAG = '--timon-service';

/** The launcher script of an installation (`host/windows-service-launcher.ts`, built). */
export function windowsLauncherScript(installDir: string): string {
  return winPath.join(installDir, 'dist', 'host', 'windows-service-launcher.js');
}

/** `Timon.exe` of the package whose Node is `nodePath` (`<root>\resources\node\node.exe`). */
export function windowsAppExecutable(nodePath: string): string {
  return winPath.join(winPath.dirname(winPath.dirname(winPath.dirname(nodePath))), WINDOWS_APP_EXECUTABLE);
}

/**
 * What the launcher reads (`host/windows-service-launcher.ts`): the daemon's
 * command line and environment, its log and the session witness to wait on.
 * A task action cannot set an environment variable, so everything the batch
 * of revision 5 `set` lives here.
 *
 * The environment is set on the PROCESS only: `ELECTRON_RUN_AS_NODE` on the
 * user would make every Electron application of the machine behave as Node.
 * Electron run as Node (a package before its Node travelled) needs the flag;
 * the Node the package ships ignores it and must not pass it on.
 */
export function renderWindowsLauncherConfig(
  opts: Pick<ServiceOpts, 'timonHome' | 'installDir' | 'heapMb' | 'port' | 'nodePath' | 'environment'>,
): string {
  const files = windowsServiceFiles(opts.timonHome);
  const env: Record<string, string> = {
    ...(opts.environment ?? {}),
    ...(isBundledNode(opts.nodePath, 'win32') ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
    TIMON_HOME: opts.timonHome,
    PORT: String(opts.port),
  };
  for (const key of Object.keys(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid service environment name');
  }
  const config: WindowsLauncherConfig = {
    format: WINDOWS_LAUNCHER_FORMAT,
    node: taskValue(opts.nodePath),
    args: [`--max-old-space-size=${opts.heapMb}`, winPath.join(opts.installDir, 'dist', 'boot.js')],
    cwd: opts.installDir,
    env,
    log: files.log,
    rotateBytes: WINDOWS_LOG_ROTATE_BYTES,
    witness: { file: files.sessionWitness, args: readSessionWitnessCommand(files.sessionWitness) },
  };
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** The launcher configuration of this home, `null` when absent or not one. */
export function readWindowsLauncherConfig(timonHome: string, readFile: (file: string) => string = (file) => readFileSync(file, 'utf8')): WindowsLauncherConfig | null {
  const file = windowsServiceFiles(timonHome, join).launcher;
  try {
    return parseLauncherConfig(readFile(file), file);
  } catch {
    return null;
  }
}

/**
 * Does the launcher in place mark its daemon as packaged
 * (`TIMON_DESKTOP_SERVICE=1`)? Read from the configuration, or from the batch
 * of revisions 2 to 5 when no configuration is there yet. `null`: neither.
 */
export function windowsLauncherMarked(timonHome: string, readFile: (file: string) => string = (file) => readFileSync(file, 'utf8')): boolean | null {
  const config = readWindowsLauncherConfig(timonHome, readFile);
  if (config) return config.env.TIMON_DESKTOP_SERVICE === '1';
  let batch: string;
  try { batch = readFile(windowsServiceFiles(timonHome, join).batchLauncher); } catch { return null; }
  return /^set "TIMON_DESKTOP_SERVICE=1"\r?$/m.test(batch);
}

/** The Node the launcher in place runs the daemon on: the configuration's, or the batch's. */
export function windowsLauncherRuntime(timonHome: string, readFile: (file: string) => string = (file) => readFileSync(file, 'utf8')): string | null {
  const config = readWindowsLauncherConfig(timonHome, readFile);
  if (config) return config.node;
  let batch: string;
  try { batch = readFile(windowsServiceFiles(timonHome, join).batchLauncher); } catch { return null; }
  const daemon = /^"([^"]+)" --max-old-space-size/m.exec(batch)?.[1];
  return daemon === undefined ? null : daemon.replaceAll('%%', '%');
}

/**
 * The task's action: a program of the package, started directly. No
 * `cmd.exe`, no PowerShell — a batch or a hidden PowerShell started at boot or
 * logon is what Avast and AVG quarantine the task for
 * (`CMD:Heur.BZC.WBO.Boxter`).
 *
 * - Off session (S4U, session 0): the launcher script on the Node that runs
 *   the daemon. Nobody sees session 0, so a console program opens no window.
 * - In the session (InteractiveToken), packaged: `Timon.exe --timon-service`.
 *   A console program would open a window on the user's desktop, and closing
 *   it would kill Timon; `Timon.exe` is a GUI program that starts the launcher
 *   with no console at all (`desktop/src/windows-service-shell.ts`).
 * - Otherwise — a source checkout in the session, which has no `Timon.exe`,
 *   or Electron run as Node, which needs `ELECTRON_RUN_AS_NODE` that an action
 *   cannot set — PowerShell starts the launcher hidden
 *   (`windowsScriptedTaskArguments`). Never in a package.
 *
 * Both packaged forms name the configuration between double quotes, which is
 * what `homeOfTask` and `stopLauncherStep` look for.
 */
export function windowsTaskAction(
  opts: Pick<ServiceOpts, 'timonHome' | 'installDir' | 'nodePath'>,
  offSession: boolean,
): { command: string; args: string } {
  const config = taskValue(windowsLauncherPath(opts.timonHome));
  const node = taskValue(opts.nodePath);
  const runsNode = winPath.basename(node).toLowerCase() === 'node.exe';
  if (!offSession && isBundledNode(node, 'win32')) {
    return { command: windowsAppExecutable(node), args: `${WINDOWS_SERVICE_FLAG} "${config}"` };
  }
  if (offSession && runsNode) {
    return { command: node, args: `"${taskValue(windowsLauncherScript(opts.installDir))}" "${config}"` };
  }
  return { command: 'powershell.exe', args: windowsScriptedTaskArguments(opts) };
}

/**
 * The PowerShell of the action when no program of a package can be started
 * directly (`windowsTaskAction`): hidden, it starts the launcher with
 * `CreateNoWindow` and waits for it alone (`Start-Process -Wait` would also
 * wait for the detached terminal host and keep `IgnoreNew` dropping the
 * restart of a daemon that died). Paths sit in PowerShell literals, never
 * between double quotes: Windows passes the arguments to PowerShell through
 * its own quoting rules.
 */
export function windowsScriptedTaskArguments(opts: Pick<ServiceOpts, 'timonHome' | 'installDir' | 'nodePath'>): string {
  const quoted = (value: string) => `[char]34 + ${powershellLiteral(value)} + [char]34`;
  const electron = winPath.basename(opts.nodePath).toLowerCase() !== 'node.exe';
  return '-NoProfile -NonInteractive -WindowStyle Hidden -Command "'
    + `$i = New-Object Diagnostics.ProcessStartInfo; $i.FileName = ${powershellLiteral(opts.nodePath)}; `
    + `$i.Arguments = ${quoted(windowsLauncherScript(opts.installDir))} + ' ' + ${quoted(windowsLauncherPath(opts.timonHome))}; `
    + (electron ? "$i.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'; " : '')
    + '$i.UseShellExecute = $false; $i.CreateNoWindow = $true; '
    + '$p = [Diagnostics.Process]::Start($i); $p.WaitForExit(); exit $p.ExitCode"';
}

/**
 * Who the task runs as: the account SID, read in the user's own session (an
 * elevation may belong to another account). The bare `userInfo().username`
 * is ambiguous: on a PC joined to Microsoft Entra ID, `guilldu` named an
 * account Windows knows as `EUROPE\guilldu`, whose task then never ran (TODO
 * #342). A SID names it exactly; whether Windows can open an S4U logon for it
 * at all is a separate question, answered after `/Run` (`TASK_VERIFY`).
 * `whoami /fo csv` rather than PowerShell: it starts in milliseconds and the
 * SID it prints is ASCII whatever the console code page. Fallbacks:
 * `DOMAIN\user`, then the bare name, as before.
 */
export function windowsTaskUserId(opts: Pick<ServiceOpts, 'userName' | 'userDomain' | 'exec'>): string {
  try {
    const res = opts.exec('whoami', ['/user', '/fo', 'csv', '/nh']);
    const sid = /"(S-1-\d+(?:-\d+)+)"/.exec(res.stdout)?.[1];
    if (res.code === 0 && sid) return sid;
  } catch { /* No whoami: the name below. */ }
  return opts.userDomain ? `${opts.userDomain}\\${opts.userName}` : opts.userName;
}

/**
 * Task definition, in the XML `schtasks /Create /XML` reads. `offSession` is
 * the user's answer to "keep running when logged out?" (`windowsKeepsRunning`).
 *
 * Off session (`always`):
 * - `BootTrigger` + `S4U`: starts without anyone logging on, and survives the
 *   user logging off — an InteractiveToken task died with the session. S4U
 *   stores no password; registering it needs the elevation the install
 *   already asks for.
 *
 * Session only (`session`):
 * - `LogonTrigger` for this account + `InteractiveToken`: starts when the user
 *   logs on and runs in their session, which Windows ends at logoff — the
 *   very behaviour the S4U task was introduced to avoid (SERVICE-HORS-SESSION
 *   W3). A trigger that fires with nobody logged on does nothing. Its action
 *   opens no console (`windowsTaskAction`).
 *
 * Both:
 * - The `TimeTrigger` repeating every 5 minutes, forever, is the supervisor:
 *   while the launcher holds a live daemon, `IgnoreNew` drops the repetition;
 *   once it has exited, the next one starts it again. It also covers the time
 *   between an install and the next boot, which the BootTrigger does not.
 *   Its start boundary is in the past on purpose: the repetition runs from it.
 * - `RestartOnFailure` only covers a launch that fails (W5); kept for that.
 * - Not `<Hidden>`: it only hid the task from the Task Scheduler window, and
 *   a hidden task is one of the marks antivirus heuristics score.
 */
export function renderTaskXml(
  opts: Pick<ServiceOpts, 'userName' | 'timonHome' | 'installDir' | 'nodePath'> & { userId?: string; offSession?: boolean },
): string {
  const userId = escapeXmlText(opts.userId ?? opts.userName);
  const offSession = opts.offSession ?? true;
  const description = offSession
    ? 'Timon orchestrator — local daemon, started at boot, runs without an open session.'
    : 'Timon orchestrator — local daemon, started at logon, stops when the user logs off.';
  const startTrigger = offSession
    ? '<BootTrigger><Enabled>true</Enabled></BootTrigger>'
    : `<LogonTrigger><Enabled>true</Enabled><UserId>${userId}</UserId></LogonTrigger>`;
  const action = windowsTaskAction(opts, offSession);
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${description}</Description>
  </RegistrationInfo>
  <Triggers>
    ${startTrigger}
    <TimeTrigger>
      <StartBoundary>2026-01-01T00:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <Repetition>
        <Interval>PT5M</Interval>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
    </TimeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${userId}</UserId>
      <LogonType>${offSession ? 'S4U' : 'InteractiveToken'}</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>5</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXmlText(action.command)}</Command>
      <Arguments>${escapeXmlText(action.args)}</Arguments>
      <WorkingDirectory>${escapeXmlText(opts.installDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * Does the registered task keep running with nobody logged on? Read from its
 * definition: S4U (or a stored password) does, an interactive token does not.
 * `null` when no task is registered or its definition cannot be read.
 * `schtasks /XML` loses non-ASCII characters (`readWindowsDefinition`), which
 * the logon type never holds, and starts far faster than PowerShell.
 */
export function windowsTaskOffSession(opts: Pick<ServiceOpts, 'exec'>): boolean | null {
  let res: ExecResult;
  try {
    res = opts.exec('schtasks', ['/Query', '/TN', WINDOWS_TASK, '/XML', 'ONE']);
  } catch {
    return null;
  }
  if (res.code !== 0) return null;
  const type = /<LogonType>\s*([A-Za-z0-9]+)\s*<\/LogonType>/.exec(res.stdout)?.[1];
  if (type === 'InteractiveToken') return false;
  if (type === 'S4U' || type === 'Password') return true;
  return null;
}

/**
 * Does the task about to be written keep running when the user logs out? The
 * answer when there is one; otherwise the task in place is kept as found (an
 * install, or an upgrade's rewrite, from before the question), and a first
 * install with nobody asked stops with the session, as on Linux and macOS.
 * A task registered but unreadable is kept off session: every release before
 * the question registered the boot task, and silently turning an upgraded
 * user's night tasks off is the worse mistake.
 *
 * A task in place that opens a console was switched by hand to "Run only when
 * user is logged on" (#116): its logon type no longer says what the user
 * wanted, its boot trigger still does. Same rule as the desktop's rewrite
 * (`windowsSessionIntent`, desktop `upgrade.ts`), so a reinstall from the CLI
 * and a repair from the app register the same task.
 */
function windowsWantsOffSession(opts: ServiceOpts): boolean {
  const mode = sessionModeOf(opts);
  if (mode !== null) return mode === 'always';
  const shape = readWindowsTaskShape(opts);
  if (shape?.consoleVisible) return shape.triggers.includes('Boot');
  const found = windowsTaskOffSession(opts);
  if (found !== null) return found;
  try {
    return opts.exec('schtasks', ['/Query', '/TN', WINDOWS_TASK]).code === 0;
  } catch {
    return false;
  }
}

/**
 * Off session (S4U) or not, once a past refusal is counted: Windows already
 * kept the S4U task for the session only on this account (`service-s4u-refused`),
 * so trying again would only fall back the same way, after the same wait. The
 * explicit "always" (`writeServiceSessionMode`) removes the marker first.
 */
function windowsKeepsRunning(opts: ServiceOpts, lines: string[]): boolean {
  if (!windowsWantsOffSession(opts)) return false;
  const marker = serviceS4uRefusedPath(opts.timonHome);
  if (!existsSync(marker)) return true;
  let since = '';
  try {
    since = readFileSync(marker, 'utf8').trim();
  } catch {
    // Unreadable: the refusal still holds, only its date is lost.
  }
  lines.push(`Windows kept the ${WINDOWS_TASK} task for the session only on this account before${since ? ` (recorded ${since})` : ''}: `
    + 'registering the session task directly. Run `timon service session-mode always` to try running with no session open again.');
  return false;
}

/** Remembers that this account refuses the S4U task (`windowsKeepsRunning`). */
function recordS4uRefused(opts: ServiceOpts, lines: string[]): void {
  write(serviceS4uRefusedPath(opts.timonHome), `${new Date().toISOString()}\n`, opts.dryRun ?? false, lines);
}

function powershellLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Seals the witness the launcher waits on, with the user's DPAPI key. Runs in
 * the user's own session, NOT elevated: an elevation may belong to another
 * account, whose key would never open under the task's S4U logon.
 */
export function sealSessionWitnessCommand(file: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    `try { $t = ConvertTo-SecureString -String '${SESSION_WITNESS_TEXT}' -AsPlainText -Force | ConvertFrom-SecureString -ErrorAction Stop; [IO.File]::WriteAllText(${powershellLiteral(file)}, $t); exit 0 } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`];
}

/** Arguments of the PowerShell that tells whether the witness opens: exit 0 yes, 2 missing, 1 unreadable. */
export function readSessionWitnessCommand(file: string): string[] {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
    [...sessionWitnessReadStatements(powershellLiteral(file)), '[Console]::Error.WriteLine($why)', 'exit 1'].join('; ')];
}

/**
 * `timon service repair`: seals the session witness again when it cannot be
 * opened. The key DPAPI protects it with changes when the account password is
 * reset or the profile is rebuilt; the witness then stays on disk, unreadable,
 * and the launcher waits for a logon that will never make it readable (TIM-0107:
 * daemon never bound, log stuck on "waiting for the first logon"). Run in the
 * user's own session, not elevated, like the seal at install: no task is
 * touched, the launcher reads the new witness on its next 10-second pass.
 */
export function repairSessionWitness(opts: ServiceOpts): ServiceResult {
  const lines: string[] = [];
  if (opts.platform !== 'win32') return { ok: true, code: 0, lines: [`nothing to repair on ${opts.platform}: only the Windows task keeps a session witness`] };
  const files = windowsServiceFiles(opts.timonHome, join);
  if (!opts.dryRun && !existsSync(files.launcher) && !existsSync(files.batchLauncher)) {
    return { ok: false, code: 1, lines: ['no Timon service is installed here: run `timon service install`'] };
  }
  const read = run(opts, lines, 'powershell', readSessionWitnessCommand(files.sessionWitness));
  if (read.code === 0 && !opts.dryRun) {
    lines.push('the session witness opens: nothing to repair');
    return { ok: true, code: 0, lines };
  }
  if (read.code === 1) lines.push(`the session witness cannot be opened${witnessCause(read.stderr)}`);
  const sealed = run(opts, lines, 'powershell', sealSessionWitnessCommand(files.sessionWitness));
  if (sealed.code !== 0) {
    lines.push(`could not seal the session witness ${files.sessionWitness}: ${sealed.stderr.trim() || `exit ${sealed.code}`}`);
    return { ok: false, code: 1, lines };
  }
  lines.push('session witness sealed again; the service picks it up within seconds');
  return { ok: true, code: 0, lines };
}

/** What may run a launcher of this home: the batch's `cmd.exe` (revisions 2
 *  to 5), the Node of the launcher script, `Timon.exe --timon-service`, and
 *  the PowerShell of a source checkout's logon task (`windowsTaskAction`). */
const LAUNCHER_PROGRAMS = ['cmd.exe', 'node.exe', WINDOWS_APP_EXECUTABLE.toLowerCase(), 'powershell.exe', 'electron.exe'];

/**
 * The PowerShell condition, on `$_` of `Win32_Process`, that names a launcher
 * of this home, in either form: the batch of revisions 2 to 5, or a program
 * whose command line names the launcher configuration (revision 6). Never
 * the PowerShell that evaluates it, whose own command line holds the needles.
 */
export function launcherProcessFilter(timonHome: string): string {
  const needles = [windowsLauncherPath(timonHome), windowsBatchLauncherPath(timonHome)]
    .map((needle) => `$_.CommandLine.ToLowerInvariant().Contains(${powershellLiteral(needle.toLowerCase())})`);
  const programs = LAUNCHER_PROGRAMS.map(powershellLiteral).join(', ');
  return `@(${programs}) -contains $_.Name -and $_.ProcessId -ne $PID -and $_.CommandLine -and (${needles.join(' -or ')})`;
}

/**
 * Ends the daemon a launcher holds. `schtasks /End` does not: it kills the
 * launcher and leaves the daemon running, orphaned (checked on Windows 11,
 * 23/09/2026). Found by command line, since the launcher's configuration path
 * is unique to this instance; `/T` takes the daemon's own children with it,
 * as stopping a systemd unit does. A daemon not started by a launcher
 * (revision 1, or the desktop's embedded one) is not matched. The batch of
 * revision 5 is matched too: an upgrade to revision 6 must end the daemon it
 * holds, or `IgnoreNew` would drop the `/Run` of the new task.
 */
export function stopLauncherStep(timonHome: string): ElevatedStep {
  return {
    label: 'stop',
    program: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { ${launcherProcessFilter(timonHome)} } | ForEach-Object { & taskkill.exe /F /T /PID $_.ProcessId | Out-Null }; exit 0`],
  };
}

/**
 * Ends the daemon of this installation that holds the service port without a
 * launcher: the one a revision-1 task started through `wscript` (detached, so
 * neither `/End` nor `stopLauncherStep` reaches it), or an embedded one. Left
 * running, it keeps the port, the new task's daemon cannot bind, and the
 * desktop talks to a daemon started without the packaged environment — which
 * has no update routes and answers 401 (0.1.1-rc.7 → 0.1.2-rc.1, 27/09/2026).
 * Only the listener of this port whose command line runs this installation's
 * `boot.js` is ended: a foreign program on the port is left alone.
 */
export function stopPortOwnerStep(opts: Pick<ServiceOpts, 'installDir' | 'port'>): ElevatedStep {
  const needle = winPath.join(opts.installDir, 'dist', 'boot.js').toLowerCase();
  return {
    label: 'stop-port',
    program: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `Get-NetTCPConnection -State Listen -LocalPort ${opts.port} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_); if ($p -and $p.CommandLine -and $p.CommandLine.ToLowerInvariant().Contains(${powershellLiteral(needle)})) { & taskkill.exe /F /T /PID $_ | Out-Null } }; exit 0`],
  };
}

/** `stopInstallationProcessesStep` exit code: a process of this installation survived the sweep. */
export const PROCESSES_REMAIN = 5;
/** What `uninstall` and `stop` say when the sweep left something behind. */
const PROCESSES_REMAIN_NOTICE = 'some Timon programs are still running after the stop (the daemon\'s own children, a terminal host): end them from Task Manager';

/**
 * What a background process of this installation carries on its command line
 * and the window never does: the daemon, the terminal host, the browser helper
 * a mission's CLI starts (`bin/browser-mcp.mjs`) and the web server, which runs
 * the sibling `app` directory (`resources\app\…\server.cjs`; the trailing
 * separator keeps Electron's own `--app-path=…\resources\app.asar` out).
 * After the user quit the app, these are what kept the installer looping on
 * "Timon cannot be closed" (tester report, 22/10/2026). Never the directory
 * alone: the CLI that runs an uninstall and the desktop share it.
 */
export function installationProcessNeedles(installDir: string): string[] {
  return [
    winPath.join(installDir, 'dist', 'boot.js'),
    winPath.join(installDir, 'dist', 'terminal-host', 'main.js'),
    winPath.join(installDir, 'bin', 'browser-mcp.mjs'),
    `${winPath.join(winPath.dirname(installDir), 'app')}${winPath.sep}`,
  ];
}

/**
 * Ends what `stopLauncherStep` cannot reach, for an uninstall: the daemon and
 * the terminal host of THIS installation, wherever they hang. `taskkill /T`
 * only follows the live parent chain, so a daemon whose launcher is already
 * gone (a task ended by hand, a revision-1 task, the desktop's embedded one),
 * and the terminal host that is detached on purpose (`host/detached.ts`),
 * survived an uninstall (TIM-0115). Matched on the installation's own
 * `dist\boot.js` and `dist\terminal-host\main.js` — never on the directory
 * alone, which the desktop and the uninstaller itself run from — and never on
 * this very PowerShell, whose command line holds the needles. Exits
 * `PROCESSES_REMAIN` when something is still there a second later.
 */
export function stopInstallationProcessesStep(opts: Pick<ServiceOpts, 'installDir' | 'nodePath'>): ElevatedStep {
  const needles = installationProcessNeedles(opts.installDir).map((needle) => powershellLiteral(needle.toLowerCase()));
  // Only the runtimes that run this installation (`node.exe` the package
  // ships, `Timon.exe` of a package before it — both during the update that
  // moves from one to the other —, or node for a CLI-installed service): an
  // editor or a shell whose command line names a file under the installation
  // is not ours to end (review of 22/10/2026). Nor Electron's helpers
  // (`--type=`), which belong to the window.
  const runtimes = [...new Set([winPath.basename(opts.nodePath), 'node.exe', 'Timon.exe'])].map(powershellLiteral).join(', ');
  const find = `Get-CimInstance Win32_Process | Where-Object { @(${runtimes}) -contains $_.Name -and $_.ProcessId -ne $PID -and $_.CommandLine `
    + `-and -not $_.CommandLine.Contains('--type=') -and (${needles
    .map((needle) => `$_.CommandLine.ToLowerInvariant().Contains(${needle})`).join(' -or ')}) }`;
  return {
    label: 'sweep',
    program: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `${find} | ForEach-Object { & taskkill.exe /F /T /PID $_.ProcessId | Out-Null }; Start-Sleep -Seconds 1; `
      + `if (@(${find}).Count -gt 0) { exit ${PROCESSES_REMAIN} }; exit 0`],
  };
}

/** `verifyTaskStartedStep` exit codes: Windows never started the task, which was then deleted, or could not be. */
export const TASK_NEVER_RAN_REMOVED = 3;
export const TASK_NEVER_RAN_KEPT = 4;
/** How long the elevated batch waits for the task to start after `/Run`. A
 *  task Windows accepts starts within a second; the margin is for a slow
 *  machine, where a false verdict would delete a working task. */
export const TASK_VERIFY_SECONDS = 15;

/**
 * `logonCheckStep` and `verifyTaskStartedStep` exit codes: the off-session
 * task was replaced by the session task, which runs; the stored logon could
 * not be read (the task is kept as registered); the session task could not
 * be registered over a task stored for the session, which was then deleted.
 */
export const TASK_SESSION_FALLBACK = 6;
export const TASK_LOGON_UNREADABLE = 7;
export const TASK_LOGON_FALLBACK_FAILED = 8;

/**
 * PowerShell that sets `$l` to the logon type of the registered task, `''`
 * when it cannot be read. `schtasks /XML` as `windowsTaskOffSession` reads it:
 * the logon type is ASCII, and the ScheduledTasks module names it differently
 * (`Interactive`).
 */
function storedLogonStatements(task: string): string {
  return `$x = (& schtasks.exe /Query /TN ${task} /XML ONE) -join ' '; $l = ''; `
    + `if ($LASTEXITCODE -eq 0 -and $x -match '<LogonType>\\s*(\\w+)\\s*</LogonType>') { $l = $Matches[1] }`;
}

/** PowerShell that waits up to `TASK_VERIFY_SECONDS` for the task to start, and sets `$ran`. */
function taskStartedStatements(task: string): string {
  return `$end = (Get-Date).AddSeconds(${TASK_VERIFY_SECONDS}); $ran = $false; do { `
    + `$i = Get-ScheduledTaskInfo -TaskName ${task} -TaskPath '\\' -ErrorAction SilentlyContinue; `
    + `if (-not $i -or $i.LastTaskResult -ne ${WINDOWS_TASK_NEVER_RAN} -or ($i.LastRunTime -and $i.LastRunTime.Year -ge 2000)) { $ran = $true; break }; `
    + 'Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $end)';
}

/**
 * Right after `/Create` of an off-session task, before `/Run`: reads back
 * the logon Windows stored. Stored for the session, the task would start its
 * console program on the user's desktop (issue #116), so the session task
 * staged at `sessionFile` is registered over it, in the same elevation. A
 * logon it cannot read or does not judge passes, and nothing is deleted:
 * the install goes on with the task as registered.
 */
export function logonCheckStep(sessionFile: string): ElevatedStep {
  const task = powershellLiteral(WINDOWS_TASK);
  return {
    label: 'logon',
    program: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `${storedLogonStatements(task)}; if ($l -eq 'S4U' -or $l -eq 'Password') { exit 0 }; `
      + `if ($l -ne 'InteractiveToken') { exit ${TASK_LOGON_UNREADABLE} }; `
      + `& schtasks.exe /Create /TN ${task} /XML ${powershellLiteral(sessionFile)} /F | Out-Null; if ($LASTEXITCODE -eq 0) { exit ${TASK_SESSION_FALLBACK} }; `
      + `& schtasks.exe /Delete /TN ${task} /F | Out-Null; exit ${TASK_LOGON_FALLBACK_FAILED}`],
  };
}

/**
 * After `/Run`, proves the task really started: `/Run` answers "SUCCESS:
 * Attempted" even when Windows then refuses the S4U logon, and the task
 * stays Ready with `LastTaskResult` 0x41303 and `LastRunTime` in 1999 — on
 * a PC joined to Microsoft Entra ID, every 5-minute repetition silently
 * skipped (TODO #342). Both signals are required, and an unreadable state
 * passes: a false verdict would replace a working task.
 *
 * An off-session task that never started is replaced, in the same elevation,
 * by the session task staged at `sessionFile`, which Windows runs on any
 * account: such an account then gets a service that stops at logout instead
 * of the built-in daemon. Only a task that still runs off session is
 * replaced. When that one does not start either, or there is no fallback,
 * the task is deleted, so nothing is left that the desktop would wait on.
 */
export function verifyTaskStartedStep(sessionFile?: string): ElevatedStep {
  const task = powershellLiteral(WINDOWS_TASK);
  const fallback = sessionFile === undefined ? '' : `${storedLogonStatements(task)}; if ($l -eq 'S4U' -or $l -eq 'Password') { `
    + `& schtasks.exe /Create /TN ${task} /XML ${powershellLiteral(sessionFile)} /F | Out-Null; if ($LASTEXITCODE -eq 0) { `
    + `& schtasks.exe /Run /TN ${task} | Out-Null; ${taskStartedStatements(task)}; if ($ran) { exit ${TASK_SESSION_FALLBACK} } } }; `;
  return {
    label: 'verify',
    program: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `${taskStartedStatements(task)}; if ($ran) { exit 0 }; ${fallback}`
      + `& schtasks.exe /Delete /TN ${task} /F | Out-Null; if ($LASTEXITCODE -eq 0) { exit ${TASK_NEVER_RAN_REMOVED} }; exit ${TASK_NEVER_RAN_KEPT}`],
  };
}

/** What `lines` carries when the session task replaced the off-session one (`ServiceResult.sessionFallback`). */
export const WINDOWS_SESSION_FALLBACK_NOTICE = `Windows did not keep the ${WINDOWS_TASK} task running without an open session for this account, `
  + 'so Timon registered it for your session instead: it stops at logout and starts again at your next logon.';

/** What a user reads when Windows will not start the task for their account. */
export const WINDOWS_TASK_REFUSED_REASON = `Windows registered the ${WINDOWS_TASK} task but never started it for this account. `
  + 'This happens with work or school accounts on a PC joined to Microsoft Entra ID, where Windows cannot run a task '
  + 'without an open session. Timon runs its built-in daemon instead: it starts with the app and stops when you close it.';

function writeRevision(opts: ServiceOpts, lines: string[]): void {
  const file = windowsServiceFiles(opts.timonHome, join).revision;
  write(file, `${WINDOWS_SERVICE_REVISION}\n`, opts.dryRun ?? false, lines);
}

function clearRevision(opts: ServiceOpts): void {
  if (!opts.dryRun) rmSync(windowsServiceFiles(opts.timonHome, join).revision, { force: true });
}

/**
 * The launcher of the installation being replaced: left alive, it keeps its
 * daemon on the port, and `IgnoreNew` drops the `/Run` that follows.
 */
function replacedLauncherSteps(opts: ServiceOpts): ElevatedStep[] {
  const home = opts.replacing?.home;
  if (!home || windowsLauncherPath(home).toLowerCase() === windowsLauncherPath(opts.timonHome).toLowerCase()) return [];
  return [{ ...stopLauncherStep(home), label: 'stop-replaced' }];
}

/**
 * Removes the batch launcher of revisions 2 to 5 once nothing can run it any
 * more: the task in place is revision 6 and answers. Never before — a failed
 * upgrade restores the previous task, which runs the batch.
 */
export function retireBatchLauncher(opts: Pick<ServiceOpts, 'timonHome' | 'dryRun'>, lines: string[] = []): void {
  const file = windowsServiceFiles(opts.timonHome, join).batchLauncher;
  if (!existsSync(file)) return;
  try {
    if (!opts.dryRun) rmSync(file, { force: true });
  } catch (error) {
    // Held by an antivirus scan, say: the task no longer runs it, so it only
    // costs a stale file, which the next install or the uninstall removes.
    lines.push(`could not remove the batch launcher of the previous task (${file}): ${(error as Error).message}`);
    return;
  }
  lines.push(`${opts.dryRun ? '(dry-run) would remove' : 'removed'} the batch launcher of the previous task (${file})`);
}

function installWindows(opts: ServiceOpts, lines: string[]): ServiceResult {
  // Filesystem writes use the host's separators, including in cross-platform
  // tests. Only what Windows itself reads requires Windows separators.
  const files = windowsServiceFiles(opts.timonHome, join);
  let launcher: string;
  try {
    launcher = renderWindowsLauncherConfig(opts);
    // Checked before anything is written: a path the action cannot carry.
    windowsTaskAction(opts, true);
    windowsTaskAction(opts, false);
  } catch (e) {
    return { ok: false, code: 1, lines: [...lines, (e as Error).message], written: false };
  }
  write(files.launcher, launcher, opts.dryRun ?? false, lines);
  // Before any elevation: without its witness, the launcher would never start
  // the daemon, and the task would look installed while doing nothing.
  const sealed = run(opts, lines, 'powershell', sealSessionWitnessCommand(files.sessionWitness));
  if (sealed.code !== 0) {
    lines.push(`could not seal the session witness ${files.sessionWitness}: ${sealed.stderr.trim() || `exit ${sealed.code}`}`);
    return { ok: false, code: 1, lines, written: false };
  }
  const file = taskXmlPath();
  const offSession = windowsKeepsRunning(opts, lines);
  const userId = windowsTaskUserId(opts);
  // UTF-16 with a BOM: `schtasks /XML` rejects a UTF-8 file with a parse error
  // that names neither the encoding nor the file.
  writeTaskXml(file, renderTaskXml({ ...opts, userId, offSession }), opts.dryRun ?? false, lines);
  // Staged before the elevation so the batch can fall back to it without a
  // second prompt: stored for the session, or never started, the off-session
  // task is replaced by this one (`logonCheckStep`, `verifyTaskStartedStep`).
  const sessionFile = offSession ? sessionTaskXmlPath() : null;
  if (sessionFile) writeTaskXml(sessionFile, renderTaskXml({ ...opts, userId, offSession: false }), opts.dryRun ?? false, lines);
  const { codes, output, cancelled } = runElevated(opts, lines, [
    { label: 'create', args: ['/Create', '/TN', WINDOWS_TASK, '/XML', file, '/F'], stopOnFailure: true },
    ...(sessionFile ? [logonCheckStep(sessionFile)] : []),
    // A reinstall replaces a daemon this launcher already holds: `/Run` alone
    // would be dropped by IgnoreNew and leave the old one serving.
    stopLauncherStep(opts.timonHome),
    ...replacedLauncherSteps(opts),
    // Never during onboarding: it ended the embedded daemon answering the
    // wizard, whose request then failed ("Failed to fetch", 0.1.2-rc.5).
    ...(opts.replacePortOwner ? [stopPortOwnerStep(opts)] : []),
    { label: 'run', args: ['/Run', '/TN', WINDOWS_TASK], stopOnFailure: true },
    verifyTaskStartedStep(sessionFile ?? undefined),
  ]);
  if (cancelled) {
    lines.push(`elevation refused: Windows will not register a ${offSession ? 'boot' : 'logon'} task for a caller that is not elevated`);
    return { ok: false, code: 1, lines, written: false };
  }
  const created = codes.get('create');
  if (created !== 0) {
    lines.push(`schtasks refused: ${output.trim() || `exit ${created ?? 'unknown'}`}`);
    return { ok: false, code: 1, lines, written: false };
  }
  const logon = codes.get('logon');
  if (logon === TASK_LOGON_FALLBACK_FAILED) {
    // A task stored for the session would have opened its console on the
    // user's desktop at every start: it was deleted rather than started.
    lines.push(`scheduled task ${WINDOWS_TASK} was stored to run only in the session, and the session task could not replace it: it was removed`);
    clearRevision(opts);
    return { ok: false, code: 1, lines, reason: `Windows stored the ${WINDOWS_TASK} task for the session only, and Timon could not register its session task instead. Try again, or run \`timon service install\` from the app's terminal.` };
  }
  if (logon === TASK_LOGON_UNREADABLE) {
    lines.push(`could not read back the logon type of scheduled task ${WINDOWS_TASK}: it is kept as registered`);
  }
  const verified = codes.get('verify');
  const fellBack = logon === TASK_SESSION_FALLBACK || verified === TASK_SESSION_FALLBACK;
  if (codes.get('run') === 0 && verified === undefined) {
    // The batch was cut before its check (the outer call timed out): it may
    // still delete the task. No revision, so the desktop does not wait on a
    // task that may be gone; a running task's daemon is found on the port.
    lines.push(`scheduled task ${WINDOWS_TASK} was started but Windows did not confirm it ran: ${output.trim() || 'no answer'}`);
    return { ok: false, code: 1, lines, reason: `Windows did not confirm that the ${WINDOWS_TASK} task started. Try again, or run \`timon service install\` from the app's terminal.` };
  }
  if (verified === TASK_NEVER_RAN_REMOVED || verified === TASK_NEVER_RAN_KEPT) {
    // Recorded so the setup wizard and the desktop stop offering a service
    // this account cannot run; a later install whose task runs removes it.
    write(files.refused, `${new Date().toISOString()}\n`, opts.dryRun ?? false, lines);
    if (verified === TASK_NEVER_RAN_REMOVED) clearRevision(opts);
    else writeRevision(opts, lines);
    lines.push(verified === TASK_NEVER_RAN_REMOVED
      ? `scheduled task ${WINDOWS_TASK} never started and was removed`
      : `scheduled task ${WINDOWS_TASK} never started and could not be removed`);
    // `timon service install` prints the lines, not the reason.
    lines.push(WINDOWS_TASK_REFUSED_REASON);
    return { ok: false, code: 1, lines, refused: true, reason: WINDOWS_TASK_REFUSED_REASON };
  }
  writeRevision(opts, lines);
  // `/Create` REGISTERS the task; the BootTrigger only fires at the NEXT
  // boot. The first-run screen blocks until `service-status` answers, so a
  // task that is merely registered leaves a Windows user staring at a wizard
  // waiting for a daemon — while `systemctl --user enable --now` and
  // `launchctl bootstrap gui/<uid>` both start it on the spot. Start it here,
  // and treat a failure to start as a failure to install: the alternative is
  // reporting success over a daemon that never came up.
  const started = codes.get('run');
  if (started !== 0) {
    lines.push(`scheduled task ${WINDOWS_TASK} was created but could not be started: ${output.trim() || `exit ${started ?? 'unknown'}`}`);
    return { ok: false, code: 1, lines };
  }
  if (!opts.dryRun) {
    rmSync(files.refused, { force: true });
    // The task is now the one this release writes: nothing is left to decline.
    rmSync(files.rewriteDeclined, { force: true });
  }
  // An upgrade keeps it until its new task answers (`keepBatchLauncher`).
  if (!opts.keepBatchLauncher) retireBatchLauncher(opts, lines);
  const when = offSession && !fellBack ? 'starts at boot and keeps running after logoff' : 'starts at logon and stops when you log off';
  lines.push(`${opts.dryRun ? '(dry-run) would install and start the service' : 'service installed and started'} (scheduled task ${WINDOWS_TASK}, ${when})`);
  if (!fellBack) return { ok: true, code: 0, lines };
  recordS4uRefused(opts, lines);
  lines.push(WINDOWS_SESSION_FALLBACK_NOTICE);
  return { ok: true, code: 0, lines, sessionFallback: true };
}

function uninstallWindows(opts: ServiceOpts, lines: string[]): ServiceResult | null {
  // Deleted BEFORE its daemon is stopped: the other way round, the repeating
  // trigger could start it again in between. `/End` ends the launcher, the
  // stop step the daemon it held, the sweep what no launcher holds any more.
  // No step guards another: a task that is not running fails `/End` and must
  // still be deleted.
  const { codes, output, cancelled } = runElevated(opts, lines, [
    { label: 'end', args: ['/End', '/TN', WINDOWS_TASK] },
    { label: 'delete', args: ['/Delete', '/TN', WINDOWS_TASK, '/F'] },
    stopLauncherStep(opts.timonHome),
    ...replacedLauncherSteps(opts),
    stopInstallationProcessesStep(opts),
  ]);
  // Said out loud: "removed" over a task that is still there, and its daemon
  // still running, is what TIM-0115 reported.
  if (cancelled) {
    return { ok: false, code: 1, lines, reason: `elevation refused: the ${WINDOWS_TASK} task and the Timon daemon are still there` };
  }
  if (codes.get('sweep') === PROCESSES_REMAIN) lines.push(PROCESSES_REMAIN_NOTICE);
  // The task's own files, never the user's data — and only once the task is
  // gone: a task left in place would be left without its launcher.
  if (codes.get('delete') !== 0) {
    lines.push(`scheduled task ${WINDOWS_TASK} was not deleted (not registered, or Windows refused): ${output.trim() || 'no detail'}`);
    return null;
  }
  const files = windowsServiceFiles(opts.timonHome, join);
  // `repairDeclined` goes too: kept, it would silence the offer to bring the
  // task back after a reinstall of the very version that was declined. So does
  // `refused`: kept, doctor would report no supervisor and the setup would
  // offer only the portable mode, after the very command the notice names.
  for (const file of [files.launcher, files.batchLauncher, files.legacyLauncher, files.sessionWitness, files.revision, files.repairDeclined, files.rewriteDeclined, files.refused]) {
    if (!opts.dryRun) rmSync(file, { force: true });
  }
  lines.push(`${opts.dryRun ? '(dry-run) would remove' : 'removed'} the task launcher and its session witness`);
  return null;
}

/**
 * The shape of the registered task (`windowsTaskShape`), `null` when none is
 * registered or its definition cannot be read. `schtasks /XML`, as
 * `windowsTaskOffSession`: what the shape reads is ASCII.
 */
export function readWindowsTaskShape(opts: Pick<ServiceOpts, 'exec'>): WindowsTaskShape | null {
  let res: ExecResult;
  try {
    res = opts.exec('schtasks', ['/Query', '/TN', WINDOWS_TASK, '/XML', 'ONE']);
  } catch {
    return null;
  }
  return res.code === 0 ? windowsTaskShape(res.stdout) : null;
}

/** What a reader of `timon service status` and the diagnostic report should do about a task that shows a console. */
export function windowsConsoleTaskAdvice(shape: WindowsTaskShape): string {
  return `${WINDOWS_TASK} starts ${shape.program ?? 'a console program'} in your session: Windows opens a console window at every start, `
    + 'and closing it stops Timon. It was switched to "Run only when user is logged on" after Timon registered it. '
    + 'Reinstall the service (Settings > Installation, or `timon service install` from the app\'s terminal): Timon then registers a task that opens no window.';
}

/**
 * Is a console this task opens the trap of #116, which a reinstall fixes?
 * A source checkout has no `Timon.exe`: its session task is a hidden
 * PowerShell by design (`windowsTaskAction`), and reinstalling would register
 * the same one. A package never starts PowerShell. Shared by
 * `timon service status` and the diagnostic report, so both say the same.
 */
export function windowsConsoleTaskTrap(shape: WindowsTaskShape, packaged: boolean = packagedRuntime()): boolean {
  return shape.consoleVisible && (packaged || shape.program !== 'powershell.exe');
}

function statusWindows(opts: ServiceOpts): ServiceResult {
  const res = opts.exec('schtasks', ['/Query', '/TN', WINDOWS_TASK, '/FO', 'LIST']);
  const installed = res.code === 0;
  // `Status: Running` in the locale of the machine — we read the value after
  // the colon of the line that carries it, and fall back to the raw output
  // rather than pretending to know every translation of "Ready".
  // french-ok: the label schtasks prints on a French Windows
  const statusLine = res.stdout.split('\n').find((l) => /^\s*(status|statut|état)\s*:/i.test(l));
  const state = statusLine?.split(':').slice(1).join(':').trim() || (installed ? 'unknown' : 'not installed');
  const running = /running|en cours/i.test(state);
  const lines = [
    `task      : ${WINDOWS_TASK}`,
    `registered: ${installed ? 'yes' : 'no'}`,
    `state     : ${state}`,
  ];
  const shape = installed ? readWindowsTaskShape(opts) : null;
  if (shape) {
    lines.push(`logon     : ${shape.logon}`, `action    : ${shape.program ?? 'unknown'}`);
    if (windowsConsoleTaskTrap(shape)) lines.push(`console   : visible - ${windowsConsoleTaskAdvice(shape)}`);
  }
  return { ok: running, code: running ? 0 : 3, installed, lines, ...(shape ? { taskShape: shape } : {}) };
}

/**
 * The registered task, as XML. `Export-ScheduledTask` rather than
 * `schtasks /Query /XML`: schtasks writes through the console code page and
 * loses every non-ASCII character — an accented user name in a path included.
 */
function readWindowsDefinition(opts: ServiceOpts): string | null {
  const res = opts.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
    `[Console]::OutputEncoding = [Text.Encoding]::UTF8; Export-ScheduledTask -TaskName ${powershellLiteral(WINDOWS_TASK)} -TaskPath '\\'`]);
  return res.code === 0 && res.stdout.includes('<Task') ? res.stdout : null;
}

/**
 * What a rollback registers in place of `previous`. Never a task that starts
 * a console program in the user's session (issue #116): it would open a
 * window at every start, so the session task of this installation, which
 * opens none, goes in its place (`windowsConsoleTaskTrap`: a source
 * checkout's hidden PowerShell is no such task). A shape that cannot be read is put back as
 * it was. `sessionFile`: the session task to fall back to when the previous
 * task asks for S4U and Windows stores it for the session only.
 */
function windowsRestoreDefinition(opts: ServiceOpts, previous: string, lines: string[]): { definition: string; sessionFile: string | null } {
  const shape = windowsTaskShape(previous);
  if (!shape || shape.logon === 'unknown') {
    lines.push(`could not read the logon of the previous ${WINDOWS_TASK} task: it is put back as it was`);
    return { definition: previous, sessionFile: null };
  }
  let session: string;
  try {
    session = renderTaskXml({ ...opts, userId: windowsTaskUserId(opts), offSession: false });
  } catch (error) {
    lines.push(`could not render the session task (${(error as Error).message}): the previous ${WINDOWS_TASK} task is put back as it was`);
    return { definition: previous, sessionFile: null };
  }
  // The shared rule, not `consoleVisible` alone: the session task of a source
  // checkout is a hidden PowerShell, and replacing it would register the same.
  if (windowsConsoleTaskTrap(shape)) {
    lines.push(`the previous ${WINDOWS_TASK} task started ${shape.program} in the session, which opens a console window: the session task is registered instead`);
    return { definition: session, sessionFile: null };
  }
  if (shape.logon === 'InteractiveToken') return { definition: previous, sessionFile: null };
  const sessionFile = sessionTaskXmlPath();
  writeTaskXml(sessionFile, session, opts.dryRun ?? false, lines);
  return { definition: previous, sessionFile };
}

function restoreWindowsDefinition(opts: ServiceOpts, previous: string, lines: string[]): ServiceResult {
  const file = taskXmlPath();
  const { definition, sessionFile } = windowsRestoreDefinition(opts, previous, lines);
  writeTaskXml(file, definition, opts.dryRun ?? false, lines);
  const { codes, output, cancelled } = runElevated(opts, lines, [
    { label: 'create', args: ['/Create', '/TN', WINDOWS_TASK, '/XML', file, '/F'], stopOnFailure: true },
    ...(sessionFile ? [logonCheckStep(sessionFile)] : []),
    stopLauncherStep(opts.timonHome),
    { label: 'run', args: ['/Run', '/TN', WINDOWS_TASK] },
  ]);
  if (cancelled) return { ok: false, code: 1, lines, reason: 'elevation refused' };
  if (codes.get('create') !== 0) return { ok: false, code: 1, lines, reason: output.trim() || 'schtasks refused the previous task' };
  const logon = codes.get('logon');
  if (logon === TASK_LOGON_FALLBACK_FAILED) {
    // Removed rather than left to open a console at every start.
    clearRevision(opts);
    lines.push(`the previous ${WINDOWS_TASK} task was stored for the session only, and the session task could not replace it: it was removed`);
    return { ok: false, code: 1, lines, reason: `Windows stored the previous ${WINDOWS_TASK} task for the session only, and Timon could not register its session task instead` };
  }
  if (logon === TASK_LOGON_UNREADABLE) {
    lines.push(`could not read back the logon type of scheduled task ${WINDOWS_TASK}: it is kept as restored`);
  }
  const fellBack = logon === TASK_SESSION_FALLBACK;
  if (fellBack) {
    recordS4uRefused(opts, lines);
    lines.push(WINDOWS_SESSION_FALLBACK_NOTICE);
  }
  // The revision `installWindows` just recorded describes the definition that
  // was taken away: left, the migration would never run again. Not cleared
  // either: to the desktop, no revision file means no task at all — a
  // restored revision-5 task would keep its batch, which Avast quarantines,
  // and never be offered the rewrite. `restored` is no revision, so the
  // desktop tries again at its next launch.
  write(windowsServiceFiles(opts.timonHome, join).revision, `${WINDOWS_REVISION_RESTORED}\n`, opts.dryRun ?? false, lines);
  const ok = codes.get('run') === 0;
  return {
    ok, code: ok ? 0 : 1, lines,
    ...(fellBack ? { sessionFallback: true } : {}),
    ...(ok ? {} : { reason: output.trim() || 'the previous task could not be started' }),
  };
}

function removeWindowsDefinition(opts: ServiceOpts, lines: string[]): ServiceResult {
  const { codes, output, cancelled } = runElevated(opts, lines, [
    { label: 'end', args: ['/End', '/TN', WINDOWS_TASK] },
    { label: 'delete', args: ['/Delete', '/TN', WINDOWS_TASK, '/F'] },
    stopLauncherStep(opts.timonHome),
  ]);
  const ok = !cancelled && codes.get('delete') === 0;
  if (ok) clearRevision(opts);
  return { ok, code: ok ? 0 : 1, lines, ...(ok ? {} : { reason: cancelled ? 'elevation refused' : output.trim() || 'the task could not be deleted' }) };
}

/**
 * Ends the daemon the launcher holds, then starts the task again. Elevated
 * because the daemon runs in session 0 under S4U: a process that is not
 * elevated cannot kill it, and without that the `/Run` is dropped by
 * `IgnoreNew` while the old daemon still lives. The task is not deleted or
 * rewritten, so nothing here depends on the revision.
 *
 * The launcher's tree is not the whole of it: a daemon whose launcher is
 * already gone has no tree to be ended with. An update that replaced the
 * application under a running daemon left exactly that — the task had been
 * stopped, its daemon lived on with the previous version, and the restart
 * started a launcher whose daemon found the port and the data directory taken
 * (0.1.7 to 0.1.8). So the daemon of this installation that holds the port is
 * ended too, then every background program of the installation, as a stop
 * does; a foreign program on the port is left alone.
 *
 * The sweep guards `/Run`: it is the only step that looks again once
 * everything was ended. A task run over a daemon that outlived it starts a
 * second one that finds the port and the data directory taken, while the
 * restart reads as done and the previous version goes on answering.
 */
export function windowsRestartSteps(opts: Pick<ServiceOpts, 'timonHome' | 'installDir' | 'port' | 'nodePath'>): ElevatedStep[] {
  return [
    stopLauncherStep(opts.timonHome),
    stopPortOwnerStep(opts),
    { ...stopInstallationProcessesStep(opts), stopOnFailure: true },
    { label: 'run', args: ['/Run', '/TN', WINDOWS_TASK] },
  ];
}

/** Why a restart did not run the task again: the sweep's own answer, in words the person can act on. */
function restartSweepRefusal(swept: number | undefined): string {
  const next = 'end the Timon programs that still run (node.exe, Timon.exe) from Task Manager or restart the computer, then open Timon again';
  if (swept === PROCESSES_REMAIN) {
    return `a Timon program of this installation is still running and could not be ended, so the service was not started again: ${next}`;
  }
  // Neither verdict: PowerShell did not run the check, or the batch stopped before it.
  return `Timon could not check that its previous daemon had ended (exit ${swept ?? 'unknown'}), so the service was not started again: ${next}`;
}

export function restartWindowsService(opts: ServiceOpts): ServiceResult {
  const lines: string[] = [];
  if (opts.platform !== 'win32') return { ok: false, code: 1, lines, reason: `no Windows task to restart on ${opts.platform}` };
  const { codes, output, cancelled } = runElevated(opts, lines, windowsRestartSteps(opts));
  if (cancelled) return { ok: false, code: 1, lines, reason: 'elevation refused' };
  // Only a sweep that found nothing left lets the restart be called one: the
  // batch did not reach `/Run` otherwise, and a transcript that says it did is
  // not believed over it.
  const swept = codes.get('sweep');
  if (swept !== 0) return { ok: false, code: 1, lines, reason: restartSweepRefusal(swept) };
  const started = codes.get('run');
  if (started !== 0) {
    return { ok: false, code: 1, lines, reason: output.trim() || `the scheduled task ${WINDOWS_TASK} could not be started (exit ${started ?? 'unknown'})` };
  }
  lines.push(`service restarted (scheduled task ${WINDOWS_TASK})`);
  return { ok: true, code: 0, lines };
}

/**
 * Left by `stopService`, removed by `startService`: the user stopped the
 * service on purpose. The desktop reads it at launch and starts the service
 * again before waiting on the daemon — a stopped Windows task is disabled, so
 * nothing else would. Under `run/`, with the task's own files; not a secret.
 */
export function serviceStoppedMarker(timonHome: string): string {
  return join(timonHome, 'run', 'service-stopped');
}

function writeStoppedMarker(opts: ServiceOpts, lines: string[]): void {
  write(serviceStoppedMarker(opts.timonHome), `${new Date().toISOString()}\n`, opts.dryRun ?? false, lines);
}

function clearStoppedMarker(opts: ServiceOpts): void {
  if (!opts.dryRun) rmSync(serviceStoppedMarker(opts.timonHome), { force: true });
}

/**
 * `timon service stop` on Windows, under one elevation: the task is disabled,
 * then its launcher's tree and every background program of the installation
 * are ended. Disabled, not deleted: ending the task alone leaves its repeating
 * trigger to start the daemon again within five minutes (the Known issue of
 * 0.1.5), and `start` only has to enable it again. The task's files stay.
 */
export function windowsStopSteps(opts: Pick<ServiceOpts, 'timonHome' | 'installDir' | 'nodePath'>): ElevatedStep[] {
  return [
    { label: 'disable', args: ['/Change', '/TN', WINDOWS_TASK, '/DISABLE'], stopOnFailure: true },
    { label: 'end', args: ['/End', '/TN', WINDOWS_TASK] },
    stopLauncherStep(opts.timonHome),
    stopInstallationProcessesStep(opts),
  ];
}

function stopWindows(opts: ServiceOpts, lines: string[]): ServiceResult {
  // Read without elevation first: a prompt for a task that does not exist
  // (the daemon is the desktop's embedded one) would teach the user to refuse.
  if (!opts.dryRun && !statusWindows(opts).installed) return { ok: false, code: 1, lines, reason: `no service installed (scheduled task ${WINDOWS_TASK} not registered)` };
  const { codes, output, cancelled } = runElevated(opts, lines, windowsStopSteps(opts));
  if (cancelled) return { ok: false, code: 1, lines, reason: `elevation refused: the ${WINDOWS_TASK} task and the Timon daemon keep running` };
  if (codes.get('disable') !== 0) {
    return { ok: false, code: 1, lines, reason: `the scheduled task ${WINDOWS_TASK} could not be disabled: ${output.trim() || 'no detail'}` };
  }
  if (codes.get('sweep') === PROCESSES_REMAIN) lines.push(PROCESSES_REMAIN_NOTICE);
  writeStoppedMarker(opts, lines);
  lines.push(`service stopped (scheduled task ${WINDOWS_TASK} disabled): it starts again when you open Timon, or with timon service start`);
  return { ok: true, code: 0, lines };
}

/** `timon service start` on Windows: the task is enabled again, then run. Elevated, like every change to the task. */
export function windowsStartSteps(): ElevatedStep[] {
  return [
    { label: 'enable', args: ['/Change', '/TN', WINDOWS_TASK, '/ENABLE'], stopOnFailure: true },
    { label: 'run', args: ['/Run', '/TN', WINDOWS_TASK] },
  ];
}

function startWindows(opts: ServiceOpts, lines: string[]): ServiceResult {
  if (!opts.dryRun && !statusWindows(opts).installed) return { ok: false, code: 1, lines, reason: `no service installed (scheduled task ${WINDOWS_TASK} not registered)` };
  const { codes, output, cancelled } = runElevated(opts, lines, windowsStartSteps());
  if (cancelled) return { ok: false, code: 1, lines, reason: `elevation refused: the ${WINDOWS_TASK} task stays disabled` };
  if (codes.get('enable') !== 0) return { ok: false, code: 1, lines, reason: `the scheduled task ${WINDOWS_TASK} could not be enabled: ${output.trim() || 'no detail'}` };
  if (codes.get('run') !== 0) {
    return { ok: false, code: 1, lines, reason: output.trim() || `the scheduled task ${WINDOWS_TASK} could not be started (exit ${codes.get('run') ?? 'unknown'})` };
  }
  clearStoppedMarker(opts);
  lines.push(`service started (scheduled task ${WINDOWS_TASK})`);
  return { ok: true, code: 0, lines };
}

function writeTaskXml(file: string, content: string, dryRun: boolean, lines: string[]): void {
  if (dryRun) {
    lines.push(`(dry-run) would write ${file}`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `\ufeff${content}`, 'utf16le');
  lines.push(`wrote ${file}`);
}

function write(file: string, content: string, dryRun: boolean, lines: string[]): void {
  if (dryRun) {
    lines.push(`(dry-run) would write ${file}`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content, 'utf8');
  lines.push(`wrote ${file}`);
}

function run(opts: ServiceOpts, lines: string[], name: string, args: string[], options?: { timeout?: number }): ExecResult {
  if (opts.dryRun) {
    lines.push(`(dry-run) would run ${name} ${args.join(' ')}`);
    return { code: 0, stdout: '', stderr: '' };
  }
  const res = options ? opts.exec(name, args, options) : opts.exec(name, args);
  lines.push(`${name} ${args.join(' ')} → ${res.code}`);
  return res;
}

/**
 * A unit as systemd runs it, drop-ins included, where the file alone can lie.
 * `home` and `directory` are `null` when systemd's answer cannot be read as a
 * path. `namesHome`: without it, `home` is the default one the daemon falls to.
 */
export type EffectiveUnit =
  | { kind: 'absent' }
  | { kind: 'unverified'; reason: string }
  | { kind: 'loaded'; fields: Map<string, string>; home: string | null; namesHome: boolean; directory: string | null };

export function readEffectiveUnit(opts: ServiceOpts, name: string): EffectiveUnit {
  let result: ExecResult;
  try {
    result = opts.exec('systemctl', ['--user', 'show', name,
      '--property=LoadState,ActiveState,Environment,WorkingDirectory,NeedDaemonReload,UnitFileState']);
  } catch {
    return { kind: 'unverified', reason: 'Cannot verify the daemon service identity. No service will be modified.' };
  }
  const fields = new Map(result.stdout.split('\n').map((line) => {
    const i = line.indexOf('=');
    return [line.slice(0, i), line.slice(i + 1)];
  }));
  if (fields.get('LoadState') === 'not-found' && !existsSync(unitPath(opts.homeDir, name))) {
    return { kind: 'absent' };
  }
  if (result.code !== 0 || fields.get('LoadState') !== 'loaded'
    || fields.get('NeedDaemonReload') !== 'no') {
    return { kind: 'unverified', reason: 'Cannot verify the daemon service identity (unavailable or stale unit). No service will be modified.' };
  }
  // systemctl serializes Environment as quoted words. Decode only its path
  // escapes, never evaluate shell syntax or expose the rest of the environment.
  const environment = fields.get('Environment') ?? '';
  const match = environment.match(/(?:^|\s)(?:"TIMON_HOME=((?:\\.|[^"\\])*)"|TIMON_HOME=([^\s"\\]*))(?=\s|$)/);
  let home = match ? (match[1] ?? match[2] ?? '') : join(opts.homeDir, '.timon');
  home = home.replace(/\\(x[0-9a-fA-F]{2}|[\\"])/g, (_, escape: string) =>
    escape.startsWith('x') ? String.fromCharCode(parseInt(escape.slice(1), 16)) : escape);
  const directory = fields.get('WorkingDirectory') ?? '';
  const expand = (path: string) => resolve(path.replaceAll('%h', opts.homeDir));
  const homeRead = !((environment.includes('TIMON_HOME=') && !match) || home.includes('\\')
    || !(home.startsWith('/') || home.startsWith('%h/')));
  const directoryRead = directory.startsWith('/') || directory.startsWith('%h/');
  return {
    kind: 'loaded',
    fields,
    home: homeRead ? expand(home) : null,
    namesHome: match !== null,
    directory: directoryRead ? expand(directory) : null,
  };
}

/** Read the effective unit, including drop-ins; a shared name is not an identity. */
function linuxService(opts: ServiceOpts): ServiceResult {
  const name = opts.unitName ?? LINUX_UNIT;
  const refusal = (reason: string): ServiceResult => ({
    ok: false, code: 3, installed: false, reason, lines: [reason],
  });
  const unit = readEffectiveUnit(opts, name);
  if (unit.kind === 'absent') {
    return { ok: false, code: 3, installed: false, lines: ['service not installed', 'state     : inactive'] };
  }
  if (unit.kind === 'unverified') return refusal(unit.reason);
  const { fields, home, directory } = unit;
  if (home === null || directory === null
    || home !== resolve(opts.timonHome)
    || (directory !== resolve(opts.installDir) && !ownRelease(opts, directory))) {
    return refusal('The timon-orchestrator service belongs to another installation or data directory. It will not be replaced or stopped.');
  }
  const enabled = !opts.unitName || fields.get('UnitFileState') === 'enabled';
  const running = enabled && fields.get('ActiveState') === 'active' && !opts.pendingHandover;
  return {
    ok: running, code: running ? 0 : 3, installed: enabled,
    lines: [`unit      : ${name}`, `state     : ${fields.get('ActiveState') ?? 'unknown'}`],
  };
}

/** `<releasesRoot>/<release>/resources/orchestrator`, exactly: the layout
 *  `stagePackagedRuntime` writes on Linux. Anything else is not ours to replace. */
function ownRelease(opts: ServiceOpts, directory: string): boolean {
  if (!opts.unitName || !opts.releasesRoot) return false;
  const parts = relative(resolve(opts.releasesRoot), directory).split(sep);
  return parts.length === 3 && parts[0] !== '..' && parts[0] !== '' && !isAbsolute(parts[0]!)
    && parts[1] === 'resources' && parts[2] === 'orchestrator';
}

/** Recover only our known malformed template, with no operator drop-ins. */
function repairLegacyPackagedUnit(opts: ServiceOpts): boolean {
  if (!opts.unitName || !opts.unitContent || !opts.legacyUnitContent) return false;
  const file = unitPath(opts.homeDir, opts.unitName);
  if (!existsSync(file)) return false;
  // The AppImage mount changes between launches, and it is included in PATH.
  // Every other byte (home, executable, ports, directives) must match.
  const withoutPath = (unit: string) => unit.split('\n')
    .filter((line) => !/^Environment="PATH=(?:\\.|[^"\\])*"$/.test(line)).join('\n');
  if (withoutPath(readFileSync(file, 'utf8')) !== withoutPath(opts.legacyUnitContent)) return false;
  const result = opts.exec('systemctl', ['--user', 'show', opts.unitName,
    '--property=LoadState,FragmentPath,DropInPaths']);
  const fields = new Map(result.stdout.split('\n').map((line) => {
    const i = line.indexOf('=');
    return [line.slice(0, i), line.slice(i + 1)];
  }));
  if (result.code !== 0 || fields.get('LoadState') !== 'bad-setting'
    || fields.get('FragmentPath') !== file || fields.get('DropInPaths') !== '') return false;
  writeFileSync(file, opts.unitContent, 'utf8');
  return true;
}

/** Replaces the loaded launchd agent with the plist on disk. */
function bootstrapAgent(opts: ServiceOpts, lines: string[], file: string): ServiceResult {
  // `bootout` first: bootstrapping an already-loaded label fails with EEXIST,
  // which would make a reinstall look like a broken install.
  const target = `gui/${opts.uid}/${MACOS_LABEL}`;
  const removed = run(opts, lines, 'launchctl', ['bootout', target]);
  if (!opts.dryRun && removed.code === 0) {
    // bootout acknowledges removal before launchd actually forgets the job.
    // An immediate bootstrap then reports EIO (internally EINPROGRESS).
    const pause = opts.pause ?? ((ms: number) => {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    });
    let gone = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = opts.exec('launchctl', ['print', target]);
      if (state.code === 113) { gone = true; break; } // service not found
      if (state.code !== 0) {
        const reason = `Cannot verify the previous launchd service stopped: ${state.stderr.trim()}`;
        return { ok: false, code: 1, reason, lines: [...lines, reason] };
      }
      pause(100);
    }
    if (!gone) {
      const reason = 'The previous Timon service is still stopping. Try again in a moment.';
      return { ok: false, code: 1, reason, lines: [...lines, reason] };
    }
  }
  const res = run(opts, lines, 'launchctl', ['bootstrap', `gui/${opts.uid}`, file]);
  const ok = res.code === 0;
  lines.push(!ok ? `launchctl refused: ${res.stderr.trim()}`
    : opts.dryRun ? `(dry-run) would install the service (${MACOS_LABEL})`
      : `service installed (${MACOS_LABEL})`);
  return { ok, code: ok ? 0 : 1, lines };
}

/* ─── macOS LaunchDaemon (backlog #141, volet 3) ───────────────────────────
 *
 * A LaunchAgent lives in `gui/<uid>`, a domain created by the graphical logon
 * and destroyed with it: Timon stopped at logout and waited for the next
 * logon after a reboot. A LaunchDaemon (`system` domain, `UserName` = the
 * user) starts at boot and survives logout. It runs outside the user's
 * security session, where the login keychain is out of reach even with the
 * session open (docs/SERVICE-HORS-SESSION.md, M2) — hence installed only once
 * a long-lived claude token exists (`offSession`), decision of 23/09/2026.
 *
 * The plist carries nothing that changes between releases: it runs a
 * launcher under `TIMON_HOME/run`, owned by the user, which holds the release
 * paths and the daemon's environment. A desktop update rewrites the launcher
 * and restarts the daemon without asking for an administrator password; only
 * the first install, a change of the plist itself and removal do.
 */

export const MACOS_LAUNCH_DAEMONS_DIR = '/Library/LaunchDaemons';
/** Exported for the official Claude provider plugin, which reads it in the daemon. */
export const LAUNCHD_SYSTEM_KIND = 'launchd-system';

/** Where the LaunchDaemon is written. `posix`: this path only exists on macOS. */
export function launchDaemonPath(dir: string = MACOS_LAUNCH_DAEMONS_DIR): string {
  return posix.join(dir, `${MACOS_LABEL}.plist`);
}

function daemonPlistOf(opts: Pick<ServiceOpts, 'launchDaemonsDir'>): string {
  return launchDaemonPath(opts.launchDaemonsDir);
}

/** The launcher the LaunchDaemon runs. */
export function macosLauncherPath(timonHome: string): string {
  return join(timonHome, 'run', 'timon-service.sh');
}

function sessionModeOf(opts: ServiceOpts): ServiceSessionMode | null {
  return opts.sessionMode !== undefined ? opts.sessionMode : readServiceSessionMode(opts.timonHome);
}

/** The user's answer first; an install from before the question keeps the claude token rule. */
function wantsLaunchDaemon(opts: ServiceOpts): boolean {
  if (opts.offSession !== undefined) return opts.offSession;
  const mode = sessionModeOf(opts);
  if (mode !== null) return mode === 'always';
  return existsSync(claudeTokenMarkerPath(opts.timonHome));
}

const SYSTEM_TARGET = `system/${MACOS_LABEL}`;
const guiTarget = (uid: number) => `gui/${uid}/${MACOS_LABEL}`;

/** A literal for `/bin/sh`: single quotes, each inner one closed and escaped. */
export function shQuote(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error('Invalid service value');
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function daemonPath(homeDir: string): string {
  return `${join(homeDir, '.local', 'bin')}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
}

/**
 * The LaunchDaemon. `HOME`, `USER`, `LOGNAME` and `PATH` are explicit: launchd
 * gives a daemon none of them, and `claude`, `git` and `os.homedir()` read
 * them. No `StandardOutPath`: launchd would open it itself, possibly as root,
 * inside the user's home; the launcher redirects its own output instead.
 */
export function renderLaunchDaemonPlist(
  opts: Pick<ServiceOpts, 'homeDir' | 'timonHome' | 'userName'>,
): string {
  const environment = {
    HOME: opts.homeDir,
    USER: opts.userName,
    LOGNAME: opts.userName,
    PATH: daemonPath(opts.homeDir),
    TIMON_HOME: opts.timonHome,
    TIMON_SERVICE_KIND: LAUNCHD_SYSTEM_KIND,
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${MACOS_LABEL}</string>
  <key>UserName</key><string>${escapeXml(opts.userName)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>${escapeXml(macosLauncherPath(opts.timonHome))}</string>
  </array>
  <key>WorkingDirectory</key><string>${escapeXml(opts.homeDir)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>EnvironmentVariables</key>
  <dict>
${Object.entries(environment).map(([key, value]) => `    <key>${escapeXml(key)}</key><string>${escapeXml(value)}</string>`).join('\n')}
  </dict>
</dict>
</plist>
`;
}

/**
 * The launcher: the daemon's environment, its log, then `exec` so launchd
 * supervises the daemon itself. Rewritten at every install and update.
 */
export function renderMacLauncher(
  opts: Pick<ServiceOpts, 'homeDir' | 'timonHome' | 'installDir' | 'heapMb' | 'port' | 'nodePath' | 'environment'>,
): string {
  const log = join(opts.timonHome, 'tmp', 'daemon.log');
  const environment: Record<string, string> = {
    PATH: daemonPath(opts.homeDir),
    NODE_ENV: 'production',
    PORT: String(opts.port),
    ...(opts.environment ?? {}),
    TIMON_HOME: opts.timonHome,
    TIMON_SERVICE_KIND: LAUNCHD_SYSTEM_KIND,
  };
  for (const key of Object.keys(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid service environment name');
  }
  return [
    '#!/bin/sh',
    '# Timon service launcher - written by `timon service install`, never by hand.',
    '# Why each line is here: renderMacLauncher (host/service-install.ts).',
    `mkdir -p ${shQuote(dirname(log))}`,
    `exec >>${shQuote(log)} 2>&1`,
    ...Object.entries(environment).map(([key, value]) => `export ${key}=${shQuote(value)}`),
    `cd ${shQuote(opts.installDir)} || exit 1`,
    'echo "[timon-service] $(date) starting the daemon"',
    `exec ${shQuote(opts.nodePath)} --max-old-space-size=${opts.heapMb} ${shQuote(join(opts.installDir, 'dist', 'boot.js'))}`,
    '',
  ].join('\n');
}

/**
 * One command of the elevated script, already quoted for `/bin/sh`. `when` is
 * a shell condition over earlier steps' `$rc_<label>`: a skipped step reports
 * nothing and leaves its own variable unset.
 */
export type MacElevatedStep = { label: string; command: string; stopOnFailure?: boolean; when?: string };

const rcVar = (label: string): string => `rc_${label.replace(/\W/g, '_')}`;

/**
 * The script run as root. It is passed INLINE, never as a file: a script, a
 * plist or a transcript sitting in a directory the user owns could be swapped
 * by any process of that user — an agent included — between our write and
 * root's read, and root would then run or install what it found. Each step
 * reports on stdout, which `runElevatedMac` reads back.
 */
export function renderMacElevatedScript(steps: readonly MacElevatedStep[]): string {
  return [
    'umask 022',
    ...steps.flatMap(({ label, command, stopOnFailure, when }) => [
      ...(when ? [`if ${when}; then`] : []),
      `( ${command} ) 2>&1`,
      'rc=$?',
      `${rcVar(label)}=$rc`,
      `echo "${ELEVATED_STEP} ${label}=$rc"`,
      ...(stopOnFailure ? ['[ "$rc" -eq 0 ] || exit 0'] : []),
      ...(when ? ['fi'] : []),
    ]),
    'exit 0',
    '',
  ].join('\n');
}

/** Heredoc delimiter the plist cannot contain: it is our own rendering. */
const PLIST_EOF = 'TIMON_PLIST_EOF';

/** Root writes the plist from the script itself, owner `root:wheel`, mode 644:
 *  launchd refuses a daemon plist anyone else could write. */
function writeDaemonPlistCommand(file: string, content: string): string {
  if (content.split('\n').includes(PLIST_EOF)) throw new Error('Invalid service definition');
  const staged = `${file}.timon-new`;
  return `mkdir -p ${shQuote(dirname(file))} && cat > ${shQuote(staged)} <<'${PLIST_EOF}'\n${content.replace(/\n$/, '')}\n${PLIST_EOF}\n`
    + `chown root:wheel ${shQuote(staged)} && chmod 644 ${shQuote(staged)} && mv -f ${shQuote(staged)} ${shQuote(file)}`;
}

/** Waits until launchd has forgotten the job: bootstrapping over a job still
 *  being removed fails with EIO (`bootstrapAgent` documents the same race). */
function waitGoneCommand(targets: readonly string[]): string {
  const loaded = targets.map((target) => `/bin/launchctl print ${shQuote(target)} >/dev/null 2>&1`).join(' || ');
  return `i=0; while ${loaded}; do i=$((i+1)); [ "$i" -ge 150 ] && exit 1; sleep 0.2; done; exit 0`;
}

function waitGoneStep(targets: readonly string[]): MacElevatedStep {
  return { label: 'wait', stopOnFailure: true, command: waitGoneCommand(targets) };
}

/**
 * The install is all-or-nothing: once the previous service has been booted
 * out, a stuck stop or a refused bootstrap must not leave a half-installed
 * LaunchDaemon behind. `rollback` runs in the same root script, so the
 * daemon side is undone before the user side (`applyLaunchDaemon`) starts the
 * previous LaunchAgent again — never two services on one port.
 */
function installDaemonSteps(opts: ServiceOpts, plist: string, previousDaemon: string | null): MacElevatedStep[] {
  const file = daemonPlistOf(opts);
  const system = shQuote(SYSTEM_TARGET);
  const restore = previousDaemon === null
    ? `rm -f ${shQuote(file)}`
    : `${writeDaemonPlistCommand(file, previousDaemon)} && /bin/launchctl bootstrap system ${shQuote(file)}`;
  return [
    { label: 'write', stopOnFailure: true, command: writeDaemonPlistCommand(file, plist) },
    // Root may boot out the user's agent: the migration happens under the one
    // prompt, and a refused prompt leaves the agent running untouched.
    { label: 'bootout-agent', command: `/bin/launchctl bootout ${shQuote(guiTarget(opts.uid))}` },
    { label: 'bootout', command: `/bin/launchctl bootout ${system}` },
    { label: 'wait', command: waitGoneCommand([guiTarget(opts.uid), SYSTEM_TARGET]) },
    { label: 'bootstrap', when: `[ "$${rcVar('wait')}" -eq 0 ]`, command: `/bin/launchctl bootstrap system ${shQuote(file)}` },
    {
      label: 'rollback',
      when: `[ "\${${rcVar('bootstrap')}:-1}" -ne 0 ]`,
      command: `/bin/launchctl bootout ${system} >/dev/null 2>&1; ( ${waitGoneCommand([SYSTEM_TARGET])} ) || true; ${restore}`,
    },
  ];
}

function removeDaemonSteps(opts: ServiceOpts): MacElevatedStep[] {
  return [
    { label: 'bootout', command: `/bin/launchctl bootout ${shQuote(SYSTEM_TARGET)}` },
    waitGoneStep([SYSTEM_TARGET]),
    { label: 'remove', command: `rm -f ${shQuote(daemonPlistOf(opts))}` },
  ];
}

/** `ERROR_USER_CANCELED` of AppleScript, in osascript's error text. */
const OSASCRIPT_CANCELLED = /\(-128\)/;

/**
 * Runs the steps as root, under ONE administrator prompt: the system dialog
 * from the desktop, `sudo` in a terminal (where there may be no graphical
 * session to show a dialog in, over SSH).
 */
function runElevatedMac(
  opts: ServiceOpts,
  lines: string[],
  steps: readonly MacElevatedStep[],
): { codes: Map<string, number>; output: string; cancelled: boolean } {
  if (opts.dryRun) {
    lines.push(`(dry-run) would run as administrator: ${steps.map((s) => s.label).join(', ')}`);
    return { codes: new Map(steps.map((s) => [s.label, 0])), output: '', cancelled: false };
  }
  const script = renderMacElevatedScript(steps);
  const elevation = opts.elevation ?? (process.stdin.isTTY ? 'sudo' : 'osascript');
  const res = elevation === 'sudo'
    ? opts.exec('sudo', ['/bin/sh', '-c', script])
    : opts.exec('osascript', [
      '-e', 'on run argv',
      '-e', 'do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator privileges without altering line endings',
      '-e', 'end run',
      script,
      'Timon installs or removes its background service.',
    ]);
  const codes = parseElevatedTranscript(res.stdout);
  lines.push(`${elevation} (administrator) → ${res.code}`);
  const cancelled = res.code !== 0 && (OSASCRIPT_CANCELLED.test(res.stderr) || codes.size === 0);
  return { codes, output: `${res.stdout}${res.stderr}`, cancelled };
}

/** A job's pid, read without root: `launchctl print system/…` is public. */
function launchdJobPid(opts: ServiceOpts, target: string): { loaded: boolean; pid: number | null } {
  const res = opts.exec('launchctl', ['print', target]);
  if (res.code !== 0) return { loaded: false, pid: null };
  const pid = /^\s*pid = (\d+)\s*$/m.exec(res.stdout)?.[1];
  return { loaded: true, pid: pid ? Number(pid) : null };
}

function launchDaemonPid(opts: ServiceOpts): { loaded: boolean; pid: number | null } {
  return launchdJobPid(opts, SYSTEM_TARGET);
}

/**
 * Who listens on the service port without being the launchd job: the daemon
 * Timon.app runs as its own child (`superviseEmbeddedDaemon`), or another
 * program. The job's own pid is not one: a reinstall replaces it. Without
 * `lsof` (or on a port nobody holds) the answer is empty — what cannot be
 * seen cannot refuse an install.
 */
function foreignPortOwners(opts: ServiceOpts): { pid: number; command: string }[] {
  const listening = opts.exec('lsof', ['-nP', `-iTCP:${opts.port}`, '-sTCP:LISTEN', '-t']);
  if (listening.code !== 0) return [];
  const jobs = new Set([SYSTEM_TARGET, guiTarget(opts.uid)]
    .map((target) => launchdJobPid(opts, target).pid)
    .filter((pid): pid is number => pid !== null));
  const pids = [...new Set(listening.stdout.split('\n').map((line) => Number(line.trim())))]
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0 && !jobs.has(pid));
  return pids.map((pid) => ({ pid, command: opts.exec('ps', ['-o', 'command=', '-p', String(pid)]).stdout.trim() }));
}

/**
 * macOS: `timon service install` run while something else holds the service
 * port. Installing anyway starts a launchd job that cannot bind and is started
 * again every ten seconds (TIM-0045, TIM-0046: 391 `EADDRINUSE` in ten
 * minutes). The embedded daemon cannot be ended from here instead: Timon.app
 * starts it again within seconds, and an install launched from one of its
 * missions would end itself. So the install is refused, before anything is
 * staged, written or prompted, and says what to do. The onboarding button
 * never calls this: it installs while the embedded daemon serves the wizard,
 * and the desktop hands the port over to the service as soon as the
 * configuration is written, before step 3 (`serviceHandover`, desktop
 * `restart.ts`).
 */
export function installPreflight(opts: ServiceOpts): ServiceResult | null {
  if (opts.platform !== 'darwin') return null;
  const [owner] = foreignPortOwners(opts);
  if (!owner) return null;
  const command = owner.command.length > 160 ? `${owner.command.slice(0, 157)}...` : owner.command;
  const holder = /\bboot\.js\b|Timon\.app/.test(owner.command)
    ? `a Timon daemon that is not the service (pid ${owner.pid}), most likely the one Timon.app runs itself`
    : `another program (pid ${owner.pid}${command ? `: ${command}` : ''})`;
  const reason = `port ${opts.port} is held by ${holder}, so the service could not start. `
    + 'Quit Timon.app (Cmd-Q, or Quit from its menu bar icon), then run timon service install again from a terminal: '
    + 'the service then starts the daemon, and Timon.app connects to it the next time it opens. Nothing was changed.';
  return { ok: false, code: 1, lines: [reason], reason, written: false };
}

/**
 * Restarts the LaunchDaemon WITHOUT root. `kickstart -k system/…` needs it;
 * signalling the daemon, which runs as this very user, does not, and
 * `KeepAlive` starts it again with the rewritten launcher.
 */
function restartLaunchDaemon(opts: ServiceOpts, lines: string[]): boolean {
  const { loaded, pid } = launchDaemonPid(opts);
  if (!loaded) return false;
  if (pid !== null) {
    if (opts.dryRun) lines.push(`(dry-run) would signal the daemon (pid ${pid})`);
    else {
      try {
        (opts.kill ?? ((p: number) => process.kill(p, 'SIGTERM')))(pid);
        lines.push(`restarted the daemon (pid ${pid}); launchd starts it again`);
      } catch (e) {
        lines.push(`could not signal the daemon (pid ${pid}): ${(e as Error).message}`);
        return false;
      }
    }
  }
  return true;
}

function writeLauncher(opts: ServiceOpts, content: string, lines: string[]): void {
  const file = macosLauncherPath(opts.timonHome);
  write(file, content, opts.dryRun ?? false, lines);
  // Holds the user's environment; nobody else needs to read it.
  if (!opts.dryRun) chmodSync(file, 0o700);
}

function readIfExists(file: string): string | null {
  return existsSync(file) ? readFileSync(file, 'utf8') : null;
}

/**
 * Puts the LaunchDaemon in place, from the plist and launcher given. The
 * elevation is skipped when the loaded plist is already this one: an update
 * only rewrites the launcher and restarts the daemon.
 */
function applyLaunchDaemon(opts: ServiceOpts, lines: string[], plist: string, launcher: string): ServiceResult {
  const launcherFile = macosLauncherPath(opts.timonHome);
  const previousLauncher = readIfExists(launcherFile);
  const agentFile = plistPath(opts.homeDir);
  const previousAgent = readIfExists(agentFile);
  const current = readIfExists(daemonPlistOf(opts));
  writeLauncher(opts, launcher, lines);
  if (current === plist && !existsSync(agentFile) && restartLaunchDaemon(opts, lines)) {
    lines.push(`${opts.dryRun ? '(dry-run) would update the service' : 'service updated'} (${MACOS_LABEL}, LaunchDaemon)`);
    return { ok: true, code: 0, lines };
  }
  const restoreLauncher = (): void => {
    // The launcher is part of what a running daemon restarts on: put it back.
    if (opts.dryRun) return;
    if (previousLauncher === null) rmSync(launcherFile, { force: true });
    else writeFileSync(launcherFile, previousLauncher, { mode: 0o700 });
  };
  const undo = (reason: string, written: boolean): ServiceResult => {
    restoreLauncher();
    return { ok: false, code: 1, lines: [...lines, reason], reason, written };
  };
  let steps: MacElevatedStep[];
  try {
    steps = installDaemonSteps(opts, plist, current);
  } catch (e) {
    return undo((e as Error).message, false);
  }
  const { codes, output, cancelled } = runElevatedMac(opts, lines, steps);
  if (cancelled) return undo('administrator access refused: the service was left as it was', false);
  if (codes.get('write') !== 0) return undo(`could not write ${daemonPlistOf(opts)}: ${output.trim() || 'unknown error'}`, false);
  if (codes.get('wait') !== 0 || codes.get('bootstrap') !== 0) {
    const cause = codes.get('wait') !== 0
      ? 'the previous Timon service is still stopping. Try again in a moment'
      : `launchctl refused the LaunchDaemon: ${output.trim() || `exit ${codes.get('bootstrap') ?? 'unknown'}`}`;
    return rollBackMigration(opts, lines, cause, {
      daemonUndone: codes.get('rollback') === 0,
      previousDaemon: current !== null,
      previousAgent,
      restoreLauncher,
    });
  }
  // Only now: until the LaunchDaemon is loaded, this file is the way back.
  // It cannot load in parallel meanwhile, launchd reads it at login only.
  if (!opts.dryRun) rmSync(agentFile, { force: true });
  lines.push(`${opts.dryRun ? '(dry-run) would install the service' : 'service installed'} (${MACOS_LABEL}, LaunchDaemon: starts at boot, keeps running after logout)`);
  return { ok: true, code: 0, lines };
}

/**
 * The user side of a failed install, after the root script's `rollback` step
 * took the partial LaunchDaemon down: the previous launcher, then the previous
 * LaunchAgent started again. `written: false` when everything is back as it
 * was, so a desktop upgrade does not restore a second time (and prompt again).
 */
function rollBackMigration(
  opts: ServiceOpts,
  lines: string[],
  cause: string,
  prior: { daemonUndone: boolean; previousDaemon: boolean; previousAgent: string | null; restoreLauncher: () => void },
): ServiceResult {
  prior.restoreLauncher();
  let restored = prior.daemonUndone;
  // The previous daemon was bootstrapped again by root, possibly before its
  // launcher was back: a restart makes KeepAlive pick the restored one. It
  // was the active service, so a leftover agent plist stays unloaded — never
  // two supervisors on one port.
  if (prior.daemonUndone && prior.previousDaemon) restored = restartLaunchDaemon(opts, lines);
  else if (prior.daemonUndone && prior.previousAgent !== null) {
    const file = plistPath(opts.homeDir);
    write(file, prior.previousAgent, opts.dryRun ?? false, lines);
    restored = bootstrapAgent(opts, lines, file).ok;
  }
  const reason = restored
    ? `${cause}. The previous service was restored.`
    : `${cause}. The previous service could not be restored: run timon service install again.`;
  return { ok: false, code: 1, lines: [...lines, reason], reason, written: !restored };
}

/** Stops and removes the LaunchDaemon and its launcher. `ok` when none is left. */
function removeLaunchDaemon(opts: ServiceOpts, lines: string[]): ServiceResult {
  if (!existsSync(daemonPlistOf(opts))) return { ok: true, code: 0, lines };
  const { codes, output, cancelled } = runElevatedMac(opts, lines, removeDaemonSteps(opts));
  if (cancelled) {
    const reason = 'administrator access refused: the LaunchDaemon was left in place';
    return { ok: false, code: 1, lines: [...lines, reason], reason };
  }
  if (codes.get('wait') !== 0 || codes.get('remove') !== 0) {
    const reason = `the LaunchDaemon could not be removed: ${output.trim() || 'unknown error'}`;
    return { ok: false, code: 1, lines: [...lines, reason], reason };
  }
  if (!opts.dryRun) rmSync(macosLauncherPath(opts.timonHome), { force: true });
  lines.push(`${opts.dryRun ? '(dry-run) would remove' : 'removed'} ${daemonPlistOf(opts)}`);
  return { ok: true, code: 0, lines };
}

function installDarwin(opts: ServiceOpts, lines: string[]): ServiceResult {
  if (wantsLaunchDaemon(opts)) {
    let launcher: string;
    try {
      launcher = renderMacLauncher(opts);
    } catch (e) {
      return { ok: false, code: 1, lines: [...lines, (e as Error).message], written: false };
    }
    return applyLaunchDaemon(opts, lines, renderLaunchDaemonPlist(opts), launcher);
  }
  // The user chose the session, or never chose and has no claude token (a
  // LaunchDaemon would run claude where it can never sign in). Back to the
  // agent, which lives and dies with the login session.
  const removed = removeLaunchDaemon(opts, lines);
  if (!removed.ok) return { ...removed, written: false };
  const file = plistPath(opts.homeDir);
  write(file, renderPlist(opts), opts.dryRun ?? false, lines);
  const res = bootstrapAgent(opts, lines, file);
  if (res.ok) {
    res.lines.push(sessionModeOf(opts) === 'session'
      ? 'runs while you are logged in, as you chose; timon service session-mode always keeps it running when you log out'
      : 'runs while you are logged in; timon service session-mode always keeps it running when you log out');
  }
  return res;
}

function uninstallDarwin(opts: ServiceOpts, lines: string[]): ServiceResult {
  const removed = removeLaunchDaemon(opts, lines);
  if (!removed.ok) return removed;
  run(opts, lines, 'launchctl', ['bootout', guiTarget(opts.uid)]);
  const file = plistPath(opts.homeDir);
  if (!opts.dryRun) {
    rmSync(file, { force: true });
    lines.push(`removed ${file}`);
  } else {
    lines.push(`(dry-run) would remove ${file}`);
  }
  return { ok: true, code: 0, lines };
}

function statusDarwin(opts: ServiceOpts): ServiceResult {
  const daemon = existsSync(daemonPlistOf(opts));
  const agent = existsSync(plistPath(opts.homeDir));
  const token = existsSync(claudeTokenMarkerPath(opts.timonHome));
  const res = opts.exec('launchctl', ['print', daemon ? SYSTEM_TARGET : guiTarget(opts.uid)]);
  const running = res.code === 0;
  const lines = [
    `label     : ${MACOS_LABEL}`,
    `kind      : ${daemon ? 'LaunchDaemon (keeps running with no session open)' : agent ? 'LaunchAgent (stops at logout)' : 'none'}`,
    `plist     : ${daemon ? daemonPlistOf(opts) : agent ? plistPath(opts.homeDir) : 'not installed'}`,
    `state     : ${running ? 'running' : 'not loaded'}`,
  ];
  if (daemon && !token) lines.push('warning   : no claude token configured — claude missions fail in this service (timon auth claude-token set)');
  if (!daemon && agent && token && sessionModeOf(opts) === null) lines.push('note      : a claude token is set — run timon service install to keep Timon running with no session open');
  return { ok: running, code: running ? 0 : 3, installed: daemon || agent, lines };
}

type DarwinDefinition = { launchd: 'daemon'; plist: string; launcher: string | null };

function readDarwinDefinition(opts: ServiceOpts): string | null {
  const plist = readIfExists(daemonPlistOf(opts));
  if (plist !== null) {
    const definition: DarwinDefinition = { launchd: 'daemon', plist, launcher: readIfExists(macosLauncherPath(opts.timonHome)) };
    return JSON.stringify(definition);
  }
  return readIfExists(plistPath(opts.homeDir));
}

function parseDarwinDefinition(previous: string): DarwinDefinition | null {
  if (!previous.startsWith('{')) return null;
  try {
    const parsed = JSON.parse(previous) as Partial<DarwinDefinition>;
    return parsed.launchd === 'daemon' && typeof parsed.plist === 'string'
      ? { launchd: 'daemon', plist: parsed.plist, launcher: typeof parsed.launcher === 'string' ? parsed.launcher : null }
      : null;
  } catch {
    return null;
  }
}

function restoreDarwinDefinition(opts: ServiceOpts, previous: string, lines: string[]): ServiceResult {
  const daemon = parseDarwinDefinition(previous);
  if (daemon) {
    if (daemon.launcher === null) return { ok: false, code: 1, lines, reason: 'the previous service had no launcher to restore' };
    return applyLaunchDaemon(opts, lines, daemon.plist, daemon.launcher);
  }
  // A LaunchAgent before: the LaunchDaemon this upgrade wrote goes first, or
  // both would compete for the port.
  const removed = removeLaunchDaemon(opts, lines);
  if (!removed.ok) return removed;
  const file = plistPath(opts.homeDir);
  write(file, previous, opts.dryRun ?? false, lines);
  return bootstrapAgent(opts, lines, file);
}

function removeDarwinDefinition(opts: ServiceOpts, lines: string[]): ServiceResult {
  const removed = removeLaunchDaemon(opts, lines);
  if (!removed.ok) return removed;
  const file = plistPath(opts.homeDir);
  const stop = run(opts, lines, 'launchctl', ['bootout', guiTarget(opts.uid)]);
  if (!opts.dryRun) rmSync(file, { force: true });
  lines.push(`${opts.dryRun ? '(dry-run) would remove' : 'removed'} ${file}`);
  // launchctl answers non-zero for a job that was never loaded: that is stopped too.
  const ok = stop.code === 0 || stop.code === 113 || stop.code === 3;
  return { ok, code: ok ? 0 : 1, lines, ...(ok ? {} : { reason: stop.stderr.trim() || 'the service could not be stopped' }) };
}

/**
 * The supervisor definition currently in place, so a failed upgrade can put it
 * back. `null` when there is none. On Windows it is the registered task: an
 * upgrade rewrites it when its revision changes (`WINDOWS_SERVICE_REVISION`).
 */
export function readServiceDefinition(opts: ServiceOpts): string | null {
  if (opts.platform === 'win32') return readWindowsDefinition(opts);
  if (opts.platform === 'darwin') return readDarwinDefinition(opts);
  const file = opts.platform === 'linux' ? unitPath(opts.homeDir, opts.unitName) : null;
  if (!file || !existsSync(file)) return null;
  return readFileSync(file, 'utf8');
}

/**
 * Puts back a definition saved by `readServiceDefinition` and restarts the
 * daemon it describes. Only the supervisor file changes: `TIMON_HOME` is not
 * read, let alone written.
 */
export function restoreServiceDefinition(opts: ServiceOpts, previous: string): ServiceResult {
  const lines: string[] = [];
  if (opts.platform === 'darwin') return restoreDarwinDefinition(opts, previous, lines);
  if (opts.platform === 'win32') return restoreWindowsDefinition(opts, previous, lines);
  if (opts.platform !== 'linux') return { ok: false, code: 1, lines, reason: `nothing to restore on ${opts.platform}` };
  write(unitPath(opts.homeDir, opts.unitName), previous, opts.dryRun ?? false, lines);
  const reload = run(opts, lines, 'systemctl', ['--user', 'daemon-reload']);
  if (reload.code !== 0) return { ok: false, code: 1, lines, reason: reload.stderr.trim() || 'systemd reload failed' };
  const res = run(opts, lines, 'systemctl', ['--user', 'restart', opts.unitName ?? LINUX_UNIT]);
  const ok = res.code === 0;
  return { ok, code: ok ? 0 : 1, lines, ...(ok ? {} : { reason: res.stderr.trim() || 'systemd restart failed' }) };
}

/**
 * Stops and deletes a definition this process has just written, when there is
 * no earlier one to put back. No identity check: the file is ours because we
 * wrote it moments ago, and a broken unit may not even load for `status`.
 */
export function removeServiceDefinition(opts: ServiceOpts): ServiceResult {
  const lines: string[] = [];
  if (opts.platform === 'win32') return removeWindowsDefinition(opts, lines);
  if (opts.platform === 'darwin') return removeDarwinDefinition(opts, lines);
  let file: string;
  let stop: ExecResult;
  if (opts.platform === 'linux') {
    file = unitPath(opts.homeDir, opts.unitName);
    stop = run(opts, lines, 'systemctl', ['--user', 'disable', '--now', opts.unitName ?? LINUX_UNIT]);
  } else {
    return { ok: false, code: 1, lines, reason: `nothing to remove on ${opts.platform}` };
  }
  if (!opts.dryRun) rmSync(file, { force: true });
  lines.push(`${opts.dryRun ? '(dry-run) would remove' : 'removed'} ${file}`);
  run(opts, lines, 'systemctl', ['--user', 'daemon-reload']);
  const ok = stop.code === 0;
  return { ok, code: ok ? 0 : 1, lines, ...(ok ? {} : { reason: stop.stderr.trim() || 'the service could not be stopped' }) };
}

/**
 * `--force` over a unit of another name on this home. It must be gone before
 * this one starts, or both daemons open the same database: one that will not
 * stop ends the install here. The desktop waits for the unit its marker names
 * (`hasDesktopService`), so the marker goes with it.
 */
function takeDownReplacedUnits(opts: ServiceOpts, lines: string[]): ServiceResult | null {
  for (const unit of opts.replacing?.units ?? []) {
    const stop = run(opts, lines, 'systemctl', ['--user', 'disable', '--now', unit]);
    if (stop.code !== 0) {
      const reason = `${unit} could not be stopped: ${stop.stderr.trim() || stop.code}. This service was not installed.`;
      return { ok: false, code: 1, reason, lines: [...lines, reason], written: false };
    }
    const file = unitPath(opts.homeDir, unit);
    if (opts.dryRun) {
      lines.push(`(dry-run) would remove ${file}`);
      continue;
    }
    rmSync(file, { force: true });
    lines.push(`removed ${file}`);
    const marker = join(runtimeDir(opts.timonHome), 'installed');
    if (readIfPresent(marker)?.trim() === unit) rmSync(marker, { force: true });
  }
  return null;
}

/** What a "stop with the session" answer costs on Linux, said wherever lingering goes off. */
const LINGER_OFF_NOTICE = 'lingering is off for your account: your other user services also stop when you log out';

/**
 * Lingering keeps the user manager, and so this daemon, alive after logout.
 * `always`, given or recorded: switched on. `session` given with this very
 * install (the onboarding's answer): switched off when it was on, so the
 * daemon really stops at logout, and the line says what else that stops. A
 * `session` only read from the file (a later reinstall or upgrade) leaves a
 * lingering turned on since then as found: someone switched it on, and the
 * status shows the gap. Never asked: left as found, and a fresh install
 * stops with the session.
 */
function applyLingerOnInstall(opts: ServiceOpts, lines: string[]): void {
  const mode = sessionModeOf(opts);
  if (mode === 'always') {
    run(opts, lines, 'loginctl', ['enable-linger', opts.userName]);
    return;
  }
  if (opts.sessionMode !== 'session' || opts.dryRun || lingerEnabled(opts) !== true) return;
  const res = run(opts, lines, 'loginctl', ['disable-linger', opts.userName]);
  lines.push(res.code === 0
    ? LINGER_OFF_NOTICE
    : `lingering could not be turned off (${res.stderr.trim() || `exit ${res.code}`}): Timon keeps running after you log out`);
}

export function installService(opts: ServiceOpts): ServiceResult {
  if (opts.platform === 'linux' && !opts.dryRun) {
    let status = linuxService(opts);
    // Retry a partial registration only when the on-disk unit is exactly ours.
    const file = unitPath(opts.homeDir, opts.unitName);
    const repaired = status.reason ? repairLegacyPackagedUnit(opts) : false;
    if (status.reason && opts.unitContent && existsSync(file)
      && readFileSync(file, 'utf8') === opts.unitContent) {
      const reload = opts.exec('systemctl', ['--user', 'daemon-reload']);
      if (reload.code === 0) status = linuxService(opts);
    }
    if (status.reason && !opts.replacing) return { ...status, written: repaired };
  }
  const lines: string[] = [];
  if (opts.platform === 'win32') return installWindows(opts, lines);

  if (opts.platform === 'darwin') return installDarwin(opts, lines);

  let unit: string;
  try {
    unit = opts.unitContent ?? renderUnit(opts);
  } catch (e) {
    return { ok: false, code: 1, lines: [(e as Error).message] };
  }
  const notStopped = takeDownReplacedUnits(opts, lines);
  if (notStopped) return notStopped;
  write(unitPath(opts.homeDir, opts.unitName), unit, opts.dryRun ?? false, lines);
  applyLingerOnInstall(opts, lines);
  const reload = run(opts, lines, 'systemctl', ['--user', 'daemon-reload']);
  if (reload.code !== 0) return { ok: false, code: 1, lines: [...lines, reload.stderr.trim() || 'systemd reload failed'] };
  let res = run(opts, lines, 'systemctl', ['--user', 'enable', '--now', opts.unitName ?? LINUX_UNIT]);
  // An upgrade finds the previous release still running; only a restart makes
  // systemd stop it and start the rewritten unit.
  if (res.code === 0 && (opts.restart || opts.replacing)) res = run(opts, lines, 'systemctl', ['--user', 'restart', opts.unitName ?? LINUX_UNIT]);
  if (res.code === 0 && !opts.dryRun) {
    const status = linuxService(opts);
    if (!status.installed || (!status.ok && !opts.pendingHandover)) {
      const reason = status.reason ?? 'The daemon service was not confirmed as installed and ready.';
      return { ok: false, code: 1, installed: status.installed, reason, lines: [...lines, reason] };
    }
  }
  const ok = res.code === 0;
  lines.push(!ok ? `systemctl refused: ${res.stderr.trim()}`
    : opts.dryRun ? `(dry-run) would install the service (${opts.unitName ?? LINUX_UNIT})`
      : `service installed (${opts.unitName ?? LINUX_UNIT})`);
  return { ok, code: ok ? 0 : 1, lines };
}

export function uninstallService(opts: ServiceOpts): ServiceResult {
  if (opts.platform === 'linux' && !opts.dryRun) {
    const status = linuxService(opts);
    if (status.reason ? !opts.replacing : !status.installed) return status;
  }
  const lines: string[] = [];
  if (opts.platform === 'win32') {
    const failed = uninstallWindows(opts, lines);
    if (failed) return failed;
  } else if (opts.platform === 'darwin') {
    const res = uninstallDarwin(opts, lines);
    if (!res.ok) return res;
  } else {
    run(opts, lines, 'systemctl', ['--user', 'disable', '--now', opts.unitName ?? LINUX_UNIT]);
    const file = unitPath(opts.homeDir, opts.unitName);
    if (!opts.dryRun) {
      rmSync(file, { force: true });
      lines.push(`removed ${file}`);
    } else {
      lines.push(`(dry-run) would remove ${file}`);
    }
    run(opts, lines, 'systemctl', ['--user', 'daemon-reload']);
  }
  // Said out loud on purpose: the user must know their data survived.
  lines.push(`${opts.timonHome} left untouched — missions, agents and database are still there.`);
  return { ok: true, code: 0, lines };
}

/**
 * Is lingering on for this account? `loginctl show-user` fails for a user with
 * no session and no lingering, which is a "no"; any other answer is unknown.
 */
function lingerEnabled(opts: ServiceOpts): boolean | null {
  const res = opts.exec('loginctl', ['show-user', opts.userName, '--property=Linger', '--value']);
  if (res.code !== 0) return /not logged in or lingering/i.test(res.stderr) ? false : null;
  const value = res.stdout.trim();
  return value === 'yes' ? true : value === 'no' ? false : null;
}

/** Same answer as `windowsTaskOffSession`, from a shape already read. */
function shapeKeepsRunning(shape: WindowsTaskShape): boolean | null {
  if (shape.logon === 'InteractiveToken') return false;
  if (shape.logon === 'S4U' || shape.logon === 'Password') return true;
  return null;
}

/** What the registered supervisor does at logout, read from the machine (see `ServiceResult.offSession`). */
function keepsRunningLoggedOut(opts: ServiceOpts): boolean | null {
  if (opts.platform === 'win32') return windowsTaskOffSession(opts);
  if (opts.platform === 'darwin') return existsSync(daemonPlistOf(opts));
  if (opts.platform === 'linux') return lingerEnabled(opts);
  return null;
}

/**
 * Records the user's answer to "keep running when logged out?" and applies
 * what can be applied in place. Linux: lingering, switched on or off for the
 * account, the unit untouched. macOS and Windows: the answer picks the
 * supervisor itself (agent or LaunchDaemon, logon or boot task), so the caller
 * reinstalls the service (`sessionModeNeedsReinstall`) through the usual
 * install path, which stages the runtime first.
 * Turning lingering off is the user's explicit gesture: it also stops their
 * other user services at logout, and the line says so.
 */
export function applySessionMode(opts: ServiceOpts, mode: ServiceSessionMode): ServiceResult {
  const lines: string[] = [];
  if (!sessionModeSupported(opts.platform)) {
    const reason = 'Choosing whether Timon keeps running when you log out is not available on this system yet.';
    return { ok: false, code: 1, lines: [reason], reason };
  }
  if (!opts.dryRun) writeServiceSessionMode(opts.timonHome, mode);
  const what = mode === 'always' ? 'keep running when you log out' : 'run only while you are logged in';
  lines.push(`${opts.dryRun ? '(dry-run) would record' : 'recorded'}: ${what}`);
  if (opts.platform !== 'linux') return { ok: true, code: 0, lines };
  const res = run(opts, lines, 'loginctl', [mode === 'always' ? 'enable-linger' : 'disable-linger', opts.userName]);
  if (res.code !== 0) {
    const reason = res.stderr.trim() || `loginctl exited with code ${res.code}`;
    return { ok: false, code: 1, lines: [...lines, reason], reason };
  }
  if (mode === 'session') lines.push(LINGER_OFF_NOTICE);
  return { ok: true, code: 0, lines };
}

/** On macOS and Windows the answer changes the supervisor itself: an installed service is reinstalled to follow it. */
export function sessionModeNeedsReinstall(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32';
}

export function statusService(opts: ServiceOpts): ServiceResult {
  const res = opts.platform === 'win32' ? statusWindows(opts) : opts.platform === 'darwin' ? statusDarwin(opts) : linuxService(opts);
  // Not over a service that is not ours: that status calls nothing more.
  if (opts.platform === 'linux' && !res.reason) {
    const lingering = lingerEnabled(opts);
    if (lingering !== null) res.lingering = lingering;
  }
  if (res.installed) {
    // Windows: read from the shape `statusWindows` already queried, not twice.
    const offSession = opts.platform === 'linux' ? res.lingering ?? null
      : opts.platform === 'win32' && res.taskShape ? shapeKeepsRunning(res.taskShape)
        : keepsRunningLoggedOut(opts);
    if (offSession !== null) {
      res.offSession = offSession;
      res.lines.push(`logged out: ${offSession ? 'keeps running' : 'stops when you log out'}`);
    }
  }
  if (existsSync(serviceStoppedMarker(opts.timonHome))) {
    res.lines.push('stopped   : by the user (timon service stop); it starts again when the app opens, or with timon service start');
  }
  return res;
}

/** launchd's answer for a job that is not loaded: already stopped, which is what a stop wants. */
function launchdNotLoaded(code: number): boolean {
  return code === 113 || code === 3;
}

function stopDarwin(opts: ServiceOpts, lines: string[]): ServiceResult {
  if (existsSync(daemonPlistOf(opts))) {
    // The system domain needs root. Booted out, not removed: the plist stays
    // in /Library/LaunchDaemons and loads again at the next boot.
    const { codes, output, cancelled } = runElevatedMac(opts, lines, [{ label: 'bootout', command: `/bin/launchctl bootout ${SYSTEM_TARGET}` }]);
    if (cancelled) return { ok: false, code: 1, lines, reason: 'administrator access refused: the service keeps running' };
    const code = codes.get('bootout');
    if (code !== 0 && (code === undefined || !launchdNotLoaded(code))) {
      return { ok: false, code: 1, lines, reason: `the LaunchDaemon could not be stopped: ${output.trim() || 'unknown error'}` };
    }
    writeStoppedMarker(opts, lines);
    lines.push(`service stopped (${MACOS_LABEL}, LaunchDaemon): it starts again at the next boot, when you open Timon, or with timon service start`);
    return { ok: true, code: 0, lines };
  }
  if (!existsSync(plistPath(opts.homeDir))) return { ok: false, code: 1, lines, reason: 'no service installed' };
  const stop = run(opts, lines, 'launchctl', ['bootout', guiTarget(opts.uid)]);
  if (stop.code !== 0 && !launchdNotLoaded(stop.code)) return { ok: false, code: 1, lines, reason: stop.stderr.trim() || 'the service could not be stopped' };
  writeStoppedMarker(opts, lines);
  lines.push(`service stopped (${MACOS_LABEL}): it starts again at your next login, when you open Timon, or with timon service start`);
  return { ok: true, code: 0, lines };
}

function startDarwin(opts: ServiceOpts, lines: string[]): ServiceResult {
  const daemon = daemonPlistOf(opts);
  if (existsSync(daemon)) {
    // Loaded again by a boot in between: `bootstrap` answers EEXIST, and the
    // job being up is all that was asked.
    const { codes, output, cancelled } = runElevatedMac(opts, lines, [
      { label: 'bootstrap', command: `/bin/launchctl bootstrap system ${shQuote(daemon)} || /bin/launchctl print ${SYSTEM_TARGET} >/dev/null` },
    ]);
    if (cancelled) return { ok: false, code: 1, lines, reason: 'administrator access refused: the service stays stopped' };
    if (codes.get('bootstrap') !== 0) return { ok: false, code: 1, lines, reason: `launchctl refused the LaunchDaemon: ${output.trim() || 'unknown error'}` };
    clearStoppedMarker(opts);
    lines.push(`service started (${MACOS_LABEL}, LaunchDaemon)`);
    return { ok: true, code: 0, lines };
  }
  const agent = plistPath(opts.homeDir);
  if (!existsSync(agent)) return { ok: false, code: 1, lines, reason: 'no service installed' };
  const res = bootstrapAgent(opts, lines, agent);
  if (res.ok) clearStoppedMarker(opts);
  return res;
}

function stopLinux(opts: ServiceOpts, lines: string[]): ServiceResult {
  const status = linuxService(opts);
  if (!status.installed) return { ok: false, code: 1, lines: [...lines, ...status.lines], reason: status.reason ?? 'no service installed' };
  const unit = opts.unitName ?? LINUX_UNIT;
  // `stop`, not `disable --now`: the unit stays enabled, so a boot still starts it.
  const res = run(opts, lines, 'systemctl', ['--user', 'stop', unit]);
  if (res.code !== 0) return { ok: false, code: 1, lines, reason: res.stderr.trim() || 'systemd could not stop the service' };
  writeStoppedMarker(opts, lines);
  lines.push(`service stopped (${unit}): it starts again at the next boot, when you open Timon, or with timon service start`);
  return { ok: true, code: 0, lines };
}

function startLinux(opts: ServiceOpts, lines: string[]): ServiceResult {
  const status = linuxService(opts);
  if (!status.installed) return { ok: false, code: 1, lines: [...lines, ...status.lines], reason: status.reason ?? 'no service installed' };
  const unit = opts.unitName ?? LINUX_UNIT;
  const res = run(opts, lines, 'systemctl', ['--user', 'start', unit]);
  if (res.code !== 0) return { ok: false, code: 1, lines, reason: res.stderr.trim() || 'systemd could not start the service' };
  clearStoppedMarker(opts);
  lines.push(`service started (${unit})`);
  return { ok: true, code: 0, lines };
}

/**
 * `timon service stop`: ends the daemon and what it started, and keeps the
 * service registered. Until `startService` — or the desktop, which runs it at
 * its next launch when it finds the marker — nothing starts the daemon again
 * on Windows (the task is disabled); launchd and systemd still do at the next
 * login or boot. `TIMON_HOME` is never touched.
 */
export function stopService(opts: ServiceOpts): ServiceResult {
  const lines: string[] = [];
  if (opts.platform === 'win32') return stopWindows(opts, lines);
  if (opts.platform === 'darwin') return stopDarwin(opts, lines);
  if (opts.platform === 'linux') return stopLinux(opts, lines);
  return { ok: false, code: 1, lines, reason: `no service to stop on ${opts.platform}` };
}

/** `timon service start`: the counterpart of `stopService`; a service that already runs is left running. */
export function startService(opts: ServiceOpts): ServiceResult {
  const lines: string[] = [];
  if (opts.platform === 'win32') return startWindows(opts, lines);
  if (opts.platform === 'darwin') return startDarwin(opts, lines);
  if (opts.platform === 'linux') return startLinux(opts, lines);
  return { ok: false, code: 1, lines, reason: `no service to start on ${opts.platform}` };
}

/**
 * Replaces the daemon the service runs, for the desktop: after an update, the
 * daemon that answers may still be the previous version's. Windows ends it
 * and what the installation left running, then runs the task again, under one
 * elevation. launchd and systemd restart their own job: a stop, then a start.
 * The service stays registered and `TIMON_HOME` is never touched.
 */
export function restartService(opts: ServiceOpts): ServiceResult {
  if (opts.platform === 'win32') return restartWindowsService(opts);
  const stopped = stopService(opts);
  if (!stopped.ok) return stopped;
  const started = startService(opts);
  return { ...started, lines: [...stopped.lines, ...started.lines] };
}

/** `LastTaskResult` of a scheduled task that was registered and never started. */
export const WINDOWS_TASK_NEVER_RAN = 0x41303;
/**
 * `LastTaskResult` 0x800710e0 (ERROR_REQUEST_REFUSED): a start, by `/Run` or the 5-minute
 * repetition, came while the task's launcher still ran, and the task's IgnoreNew policy dropped it.
 * It reads like a failure and is not one: the instance already running is the service.
 */
export const WINDOWS_TASK_ALREADY_RUNNING = 0x800710e0;

/** `last result: …` of the diagnostics, with what a known code means beside it. */
export function windowsTaskResultLine(result: number): string {
  const hex = `0x${result.toString(16)}`;
  return result === WINDOWS_TASK_ALREADY_RUNNING
    ? `last result: ${result} (${hex}: an instance was already running, not a failure)`
    : `last result: ${result} (${hex})`;
}

export type ServiceDiagnostics = {
  /** The definition sets `TIMON_DESKTOP_SERVICE=1`; `null` when none was found to read. */
  marked: boolean | null;
  /** Windows only: `LastTaskResult`, `null` when unreadable. */
  lastTaskResult: number | null;
  /** What the supervisor says about the last run, a few `key: value` lines. */
  lines: string[];
  /** Windows only: what the registered task runs, `null` when unreadable. */
  shape?: WindowsTaskShape | null;
};

function readIfPresent(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/** The definition files of the installed service, as the supervisor will run them. */
function serviceDefinitionMarked(opts: ServiceOpts): boolean | null {
  if (opts.platform === 'win32') return windowsLauncherMarked(opts.timonHome);
  if (opts.platform === 'darwin') {
    // The LaunchDaemon's environment lives in its launcher, the agent's in its plist.
    if (existsSync(daemonPlistOf(opts))) {
      const launcher = readIfPresent(macosLauncherPath(opts.timonHome));
      return launcher === null ? null : /^export TIMON_DESKTOP_SERVICE='?1'?$/m.test(launcher);
    }
    const plist = readIfPresent(plistPath(opts.homeDir));
    return plist === null ? null : /<key>TIMON_DESKTOP_SERVICE<\/key>\s*<string>1<\/string>/.test(plist);
  }
  const unit = readIfPresent(unitPath(opts.homeDir, opts.unitName));
  return unit === null ? null : /^Environment="?TIMON_DESKTOP_SERVICE=1"?$/m.test(unit);
}

/**
 * Read-only details for the diagnostic report (TODO #343): is the service
 * marked as the app's, and what did its supervisor do last. Never changes
 * anything, never throws: a missing tool is a missing line.
 */
/**
 * What `schtasks` cannot say about the Windows task, for `timon service status`
 * and the diagnostic report: whether the session witness the launcher waits on
 * still opens (TIM-0107 — a task "Running" whose daemon never binds), and
 * whether the ScheduledTasks module agrees that the task exists (TIM-0108 — a
 * status of "registered: yes" for a task its owner had deleted).
 */
/** The cause `readSessionWitnessCommand` printed, as a suffix of its status note. */
function witnessCause(stderr: string): string {
  const cause = stderr.trim().split(/\r?\n/)[0]?.trim().slice(0, 300);
  return cause ? ` (cause: ${cause})` : '';
}

export function windowsServiceNotes(opts: ServiceOpts): string[] {
  if (opts.platform !== 'win32') return [];
  const lines: string[] = [];
  try {
    const files = windowsServiceFiles(opts.timonHome, join);
    const witness = opts.exec('powershell', readSessionWitnessCommand(files.sessionWitness));
    lines.push(witness.code === 0 ? 'session witness: opens'
      : witness.code === 2 ? 'session witness: missing - run `timon service install`'
        : witness.code === 1 ? `session witness: cannot be opened (reset password or rebuilt profile?) - run \`timon service repair\`${witnessCause(witness.stderr)}`
          : `session witness: not checked (exit ${witness.code})`);
    const lookup = opts.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `if (Get-ScheduledTask -TaskName ${powershellLiteral(WINDOWS_TASK)} -TaskPath '\\' -ErrorAction SilentlyContinue) { 'present' } else { 'absent' }`]);
    const answer = /^(present|absent)\s*$/m.exec(lookup.stdout)?.[1];
    if (lookup.code === 0 && answer) lines.push(`ScheduledTasks module: task ${answer}`);
  } catch { /* what we have */ }
  return lines;
}

export function serviceDiagnostics(opts: ServiceOpts): ServiceDiagnostics {
  const marked = serviceDefinitionMarked(opts);
  const lines: string[] = [];
  let lastTaskResult: number | null = null;
  let shape: WindowsTaskShape | null = null;
  try {
    if (opts.platform === 'win32') {
      const res = opts.exec('powershell', ['-NoProfile', '-NonInteractive', '-Command',
        `$i = Get-ScheduledTaskInfo -TaskName ${powershellLiteral(WINDOWS_TASK)} -TaskPath '\\'; `
        + "'LastRunTime=' + $i.LastRunTime.ToString('s'); 'LastTaskResult=' + $i.LastTaskResult; "
        + "'NextRunTime=' + $(if ($i.NextRunTime) { $i.NextRunTime.ToString('s') } else { '' }); 'NumberOfMissedRuns=' + $i.NumberOfMissedRuns; "
        + `'LogonType=' + (Get-ScheduledTask -TaskName ${powershellLiteral(WINDOWS_TASK)} -TaskPath '\\').Principal.LogonType`]);
      if (res.code === 0) {
        for (const line of res.stdout.split(/\r?\n/)) {
          const [key, ...rest] = line.split('=');
          if (!key?.trim()) continue;
          const value = rest.join('=').trim();
          if (key.trim() === 'LastTaskResult' && /^\d+$/.test(value)) {
            lastTaskResult = Number(value);
            lines.push(windowsTaskResultLine(lastTaskResult));
          } else {
            lines.push(`${key.trim()}: ${value || '—'}`);
          }
        }
      }
      shape = readWindowsTaskShape(opts);
      if (shape) {
        lines.push(`Action: ${shape.program ?? '—'}`, `ConsoleVisible: ${shape.consoleVisible ? 'yes' : 'no'}`);
      }
      lines.push(...windowsServiceNotes(opts));
    } else if (opts.platform === 'darwin') {
      const target = existsSync(daemonPlistOf(opts)) ? SYSTEM_TARGET : guiTarget(opts.uid);
      const res = opts.exec('launchctl', ['print', target]);
      lines.push(`launchctl print ${target}: ${res.code === 0 ? 'loaded' : `not loaded (code ${res.code})`}`);
      for (const line of res.stdout.split('\n')) {
        const match = /^\s*(state|pid|last exit code|last exit reason|runs|immediate reason)\s*=\s*(.+)$/.exec(line);
        if (match) lines.push(`${match[1]}: ${match[2]!.trim()}`);
      }
    } else {
      const name = opts.unitName ?? LINUX_UNIT;
      const res = opts.exec('systemctl', ['--user', 'show', name,
        '--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,NRestarts,ActiveEnterTimestamp']);
      if (res.code === 0) {
        for (const line of res.stdout.split('\n')) if (line.includes('=')) lines.push(line.replace('=', ': '));
      }
    }
  } catch { /* A supervisor that cannot be queried: what we have. */ }
  return { marked, lastTaskResult, lines, ...(opts.platform === 'win32' ? { shape } : {}) };
}
