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
import { isBundledNode } from './bundled-node.js';

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
 */
export const WINDOWS_SERVICE_REVISION = '5';

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
    launcher: joinPath(run, 'timon-service.cmd'),
    /** Launcher of revision 1, kept so a restored revision-1 task still starts. */
    legacyLauncher: joinPath(run, 'timon-service.vbs'),
    sessionWitness: joinPath(run, 'session-witness.dpapi'),
    revision: joinPath(run, 'service-revision'),
    /** Written by the desktop when the user declines the offer to reinstall the task. */
    repairDeclined: joinPath(run, 'service-repair-declined'),
    /** Written when Windows registered the task but never started it for this
     *  account (`verifyTaskStartedStep`); removed by an install whose task runs
     *  and by an uninstall. */
    refused: joinPath(run, 'service-refused'),
    log: joinPath(timonHome, 'tmp', 'daemon.log'),
  };
}

/** Where the launcher the task runs lives. */
export function windowsLauncherPath(timonHome: string): string {
  return windowsServiceFiles(timonHome).launcher;
}

/** A value written literally into a batch file: cmd expands `%` everywhere,
 *  and a quote or a line break would end the statement it sits in. */
function batchValue(value: string): string {
  if (/[\r\n\0"]/.test(value)) throw new Error('Invalid service value');
  return value.replace(/%/g, '%%');
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
 * Exit 0 once DPAPI decrypts the witness, 1 after a pause while it cannot, 2
 * when the witness is missing. Reads its path from the environment, so no path
 * has to survive both cmd and PowerShell quoting.
 *
 * The cause goes to the service log on the first pass only: the batch sets
 * TIMON_SERVICE_WAITING after it, and the loop runs every 10 seconds until a
 * logon that may never come (TIM-0107), against a log rotated only at start.
 * Written by .NET rather than redirected by cmd: UTF-8 like the batch's own
 * lines after `chcp 65001`, so a localized message keeps its accents. A log
 * that cannot be written costs the diagnostic, never the wait.
 */
const SESSION_WITNESS_CHECK = [
  ...sessionWitnessReadStatements('$env:TIMON_SESSION_WITNESS'),
  "if (-not $env:TIMON_SERVICE_WAITING) { try { [IO.File]::AppendAllText($env:TIMON_SERVICE_LOG, '[timon-service] ' + (Get-Date).ToString('s') + ' session witness unreadable: ' + $why + [Environment]::NewLine) } catch { $null = $_ } }",
  'Start-Sleep -Seconds 10',
  'exit 1',
].join('; ');

/**
 * The launcher the task runs: a batch that HOLDS the daemon until it exits.
 *
 * Revision 1 went through `wscript`, which started the daemon and returned at
 * once. The task then no longer followed its daemon, and neither
 * RestartOnFailure nor anything else could relaunch a daemon that died
 * (docs/SERVICE-HORS-SESSION.md, W5). Holding it is what lets the repeating
 * trigger + `IgnoreNew` act as the supervisor. The console window that made
 * `cmd` unusable under an InteractiveToken does not exist here: an S4U task
 * runs in session 0, which nobody sees.
 *
 * Before starting anything, it waits until DPAPI works for the user. Under
 * S4U, when nobody has logged on since boot, it does not — and a `claude` run
 * in that state ERASES the user's Windows credentials (Git Credential Manager,
 * `gh`…), reproduced 3 times out of 3 (W6). Gating the daemon itself rather
 * than each spawn leaves no code path to forget: plugins, MCP servers and git
 * included. It is enough to check once: only a reboot takes the keys away,
 * and a reboot restarts this launcher.
 *
 * `chcp 65001` comes first so the lines after it, written in UTF-8, keep an
 * accented user name intact; everything before it is ASCII.
 */
export function renderWindowsLauncher(
  opts: Pick<ServiceOpts, 'timonHome' | 'installDir' | 'heapMb' | 'port' | 'nodePath' | 'environment'>,
): string {
  const files = windowsServiceFiles(opts.timonHome);
  const boot = winPath.join(opts.installDir, 'dist', 'boot.js');
  const environment: Record<string, string> = {
    ...(opts.environment ?? {}),
    // Electron run as Node (a package before its Node travelled) needs the
    // flag; the Node the package ships ignores it and must not pass it on.
    // Set on the PROCESS only: on the user, it would make every Electron
    // application of the machine behave as Node.
    ...(isBundledNode(opts.nodePath, 'win32') ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
    TIMON_HOME: opts.timonHome,
    PORT: String(opts.port),
    TIMON_SERVICE_LOG: files.log,
    TIMON_SESSION_WITNESS: files.sessionWitness,
  };
  for (const key of Object.keys(environment)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error('Invalid service environment name');
  }
  const log = '"%TIMON_SERVICE_LOG%"';
  const daemon = `"${batchValue(opts.nodePath)}" --max-old-space-size=${opts.heapMb} "${batchValue(boot)}"`;
  return [
    '@echo off',
    'rem Timon service launcher - written by `timon service install`, never by hand.',
    'rem Why each line is here: renderWindowsLauncher (host/service-install.ts).',
    'chcp 65001 >nul',
    ...Object.entries(environment).map(([key, value]) => `set "${key}=${batchValue(value)}"`),
    'for %%D in ("%TIMON_SERVICE_LOG%") do if not exist "%%~dpD" mkdir "%%~dpD"',
    ':wait',
    `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "${SESSION_WITNESS_CHECK}"`,
    'if errorlevel 2 (',
    `  echo [timon-service] %DATE% %TIME% session witness missing, reinstall the service >>${log}`,
    '  exit /b 2',
    ')',
    'if errorlevel 1 (',
    `  if not defined TIMON_SERVICE_WAITING echo [timon-service] %DATE% %TIME% waiting for the first logon since boot >>${log}`,
    '  set "TIMON_SERVICE_WAITING=1"',
    '  goto wait',
    ')',
    // Rotated at start only: nothing holds the file yet, so the move cannot fail on a lock.
    `if exist ${log} for %%F in (${log}) do if %%~zF GEQ ${WINDOWS_LOG_ROTATE_BYTES} move /y ${log} "%TIMON_SERVICE_LOG%.1" >nul`,
    `echo [timon-service] %DATE% %TIME% starting the daemon >>${log}`,
    `${daemon} >>${log} 2>&1`,
    `echo [timon-service] %DATE% %TIME% daemon exited with code %ERRORLEVEL% >>${log}`,
    '',
  ].join('\r\n');
}

/**
 * Arguments of `cmd.exe` in the task. `/s` with doubled quotes: cmd strips the
 * outer pair and keeps the path quoted, whatever characters it holds — without
 * `/s`, a `&` or `(` in the path makes cmd strip the quotes themselves.
 */
export function windowsTaskCommand(opts: Pick<ServiceOpts, 'timonHome'>): string {
  // `win32.join`, not `join`: this string is only ever read by a Windows shell,
  // and building it on any other platform — which is where it gets TESTED —
  // would slip forward slashes into a path `cmd` then splits on its own rules.
  return `/d /s /c ""${windowsLauncherPath(opts.timonHome)}""`;
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
 * Task definition, in the XML `schtasks /Create /XML` reads.
 *
 * - `BootTrigger` + `S4U`: starts without anyone logging on, and survives the
 *   user logging off — an InteractiveToken task died with the session. S4U
 *   stores no password; registering it needs the elevation the install
 *   already asks for.
 * - The `TimeTrigger` repeating every 5 minutes, forever, is the supervisor:
 *   while the launcher holds a live daemon, `IgnoreNew` drops the repetition;
 *   once it has exited, the next one starts it again. It also covers the time
 *   between an install and the next boot, which the BootTrigger does not.
 *   Its start boundary is in the past on purpose: the repetition runs from it.
 * - `RestartOnFailure` only covers a launch that fails (W5); kept for that.
 */
export function renderTaskXml(
  opts: Pick<ServiceOpts, 'userName' | 'timonHome' | 'installDir'> & { userId?: string },
): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Timon orchestrator — local daemon, started at boot, runs without an open session.</Description>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger><Enabled>true</Enabled></BootTrigger>
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
      <UserId>${escapeXmlText(opts.userId ?? opts.userName)}</UserId>
      <LogonType>S4U</LogonType>
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
    <Hidden>true</Hidden>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>cmd.exe</Command>
      <Arguments>${escapeXmlText(windowsTaskCommand(opts))}</Arguments>
      <WorkingDirectory>${escapeXmlText(opts.installDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
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
  if (!opts.dryRun && !existsSync(files.launcher)) {
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

/**
 * Ends the daemon a launcher holds. `schtasks /End` does not: it kills the
 * launcher's `cmd.exe` and leaves the daemon running, orphaned (checked on
 * Windows 11, 23/09/2026). Found by command line, since the launcher path is
 * unique to this instance; `/T` takes the daemon's own children with it, as
 * stopping a systemd unit does. A daemon not started by a launcher (revision
 * 1, or the desktop's embedded one) is not matched.
 */
export function stopLauncherStep(timonHome: string): ElevatedStep {
  const needle = windowsLauncherPath(timonHome).toLowerCase();
  return {
    label: 'stop',
    program: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'cmd.exe' -and $_.CommandLine -and $_.CommandLine.ToLowerInvariant().Contains(${powershellLiteral(needle)}) } | ForEach-Object { & taskkill.exe /F /T /PID $_.ProcessId | Out-Null }; exit 0`],
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
 * After `/Run`, proves the task really started: `/Run` answers "SUCCESS:
 * Attempted" even when Windows then refuses the S4U logon, and the task
 * stays Ready with `LastTaskResult` 0x41303 and `LastRunTime` in 1999 — on
 * a PC joined to Microsoft Entra ID, every 5-minute repetition silently
 * skipped (TODO #342). Never started within `TASK_VERIFY_SECONDS`: the task
 * is deleted in the same elevation, so nothing is left that the desktop would
 * wait on. Both signals are required, and an unreadable state passes: a
 * false verdict would delete a working task.
 */
export function verifyTaskStartedStep(): ElevatedStep {
  const task = powershellLiteral(WINDOWS_TASK);
  return {
    label: 'verify',
    program: 'powershell',
    args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command',
      `$end = (Get-Date).AddSeconds(${TASK_VERIFY_SECONDS}); do { `
      + `$i = Get-ScheduledTaskInfo -TaskName ${task} -TaskPath '\\' -ErrorAction SilentlyContinue; if (-not $i) { exit 0 }; `
      + `if ($i.LastTaskResult -ne ${WINDOWS_TASK_NEVER_RAN} -or ($i.LastRunTime -and $i.LastRunTime.Year -ge 2000)) { exit 0 }; `
      + `Start-Sleep -Milliseconds 500 } while ((Get-Date) -lt $end); `
      + `& schtasks.exe /Delete /TN ${task} /F | Out-Null; if ($LASTEXITCODE -eq 0) { exit ${TASK_NEVER_RAN_REMOVED} }; exit ${TASK_NEVER_RAN_KEPT}`],
  };
}

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

function installWindows(opts: ServiceOpts, lines: string[]): ServiceResult {
  // Filesystem writes use the host's separators, including in cross-platform
  // tests. Only what Windows itself reads requires Windows separators.
  const files = windowsServiceFiles(opts.timonHome, join);
  let launcher: string;
  try {
    launcher = renderWindowsLauncher(opts);
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
  // UTF-16 with a BOM: `schtasks /XML` rejects a UTF-8 file with a parse error
  // that names neither the encoding nor the file.
  writeTaskXml(file, renderTaskXml({ ...opts, userId: windowsTaskUserId(opts) }), opts.dryRun ?? false, lines);
  const { codes, output, cancelled } = runElevated(opts, lines, [
    { label: 'create', args: ['/Create', '/TN', WINDOWS_TASK, '/XML', file, '/F'], stopOnFailure: true },
    // A reinstall replaces a daemon this launcher already holds: `/Run` alone
    // would be dropped by IgnoreNew and leave the old one serving.
    stopLauncherStep(opts.timonHome),
    ...replacedLauncherSteps(opts),
    // Never during onboarding: it ended the embedded daemon answering the
    // wizard, whose request then failed ("Failed to fetch", 0.1.2-rc.5).
    ...(opts.replacePortOwner ? [stopPortOwnerStep(opts)] : []),
    { label: 'run', args: ['/Run', '/TN', WINDOWS_TASK], stopOnFailure: true },
    verifyTaskStartedStep(),
  ]);
  if (cancelled) {
    lines.push('elevation refused: Windows will not register a boot task for a caller that is not elevated');
    return { ok: false, code: 1, lines, written: false };
  }
  const created = codes.get('create');
  if (created !== 0) {
    lines.push(`schtasks refused: ${output.trim() || `exit ${created ?? 'unknown'}`}`);
    return { ok: false, code: 1, lines, written: false };
  }
  const verified = codes.get('verify');
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
  if (!opts.dryRun) rmSync(files.refused, { force: true });
  lines.push(`${opts.dryRun ? '(dry-run) would install and start the service' : 'service installed and started'} (scheduled task ${WINDOWS_TASK}, starts at boot and keeps running after logoff)`);
  return { ok: true, code: 0, lines };
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
  for (const file of [files.launcher, files.legacyLauncher, files.sessionWitness, files.revision, files.repairDeclined, files.refused]) {
    if (!opts.dryRun) rmSync(file, { force: true });
  }
  lines.push(`${opts.dryRun ? '(dry-run) would remove' : 'removed'} the task launcher and its session witness`);
  return null;
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
  return {
    ok: running,
    code: running ? 0 : 3,
    installed,
    lines: [
      `task      : ${WINDOWS_TASK}`,
      `registered: ${installed ? 'yes' : 'no'}`,
      `state     : ${state}`,
    ],
  };
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

function restoreWindowsDefinition(opts: ServiceOpts, previous: string, lines: string[]): ServiceResult {
  const file = taskXmlPath();
  writeTaskXml(file, previous, opts.dryRun ?? false, lines);
  const { codes, output, cancelled } = runElevated(opts, lines, [
    { label: 'create', args: ['/Create', '/TN', WINDOWS_TASK, '/XML', file, '/F'], stopOnFailure: true },
    stopLauncherStep(opts.timonHome),
    { label: 'run', args: ['/Run', '/TN', WINDOWS_TASK] },
  ]);
  if (cancelled) return { ok: false, code: 1, lines, reason: 'elevation refused' };
  if (codes.get('create') !== 0) return { ok: false, code: 1, lines, reason: output.trim() || 'schtasks refused the previous task' };
  // A task that does not run this launcher is an older revision: the desktop
  // must try the migration again at its next launch.
  if (!previous.toLowerCase().includes(windowsLauncherPath(opts.timonHome).toLowerCase())) clearRevision(opts);
  // Same launcher: the revision `installWindows` just recorded describes the
  // definition that was taken away, and the migration would never run again.
  // Not cleared: to the desktop, no revision file means no task at all.
  else write(windowsServiceFiles(opts.timonHome, join).revision, `${WINDOWS_REVISION_RESTORED}\n`, opts.dryRun ?? false, lines);
  const ok = codes.get('run') === 0;
  return { ok, code: ok ? 0 : 1, lines, ...(ok ? {} : { reason: output.trim() || 'the previous task could not be started' }) };
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
 */
export function windowsRestartSteps(timonHome: string): ElevatedStep[] {
  return [stopLauncherStep(timonHome), { label: 'run', args: ['/Run', '/TN', WINDOWS_TASK] }];
}

export function restartWindowsService(opts: ServiceOpts): ServiceResult {
  const lines: string[] = [];
  if (opts.platform !== 'win32') return { ok: false, code: 1, lines, reason: `no Windows task to restart on ${opts.platform}` };
  const { codes, output, cancelled } = runElevated(opts, lines, windowsRestartSteps(opts.timonHome));
  if (cancelled) return { ok: false, code: 1, lines, reason: 'elevation refused' };
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

function wantsLaunchDaemon(opts: ServiceOpts): boolean {
  return opts.offSession ?? existsSync(claudeTokenMarkerPath(opts.timonHome));
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
  // No token: a LaunchDaemon left from an earlier token would run claude
  // where it can never sign in. Back to the agent, which can.
  const removed = removeLaunchDaemon(opts, lines);
  if (!removed.ok) return { ...removed, written: false };
  const file = plistPath(opts.homeDir);
  write(file, renderPlist(opts), opts.dryRun ?? false, lines);
  const res = bootstrapAgent(opts, lines, file);
  if (res.ok) {
    res.lines.push('runs while you are logged in; to keep Timon running with no session open, '
      + 'set a claude token (timon auth claude-token set) and run timon service install again');
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
  if (!daemon && agent && token) lines.push('note      : a claude token is set — run timon service install to keep Timon running with no session open');
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
  // Without linger, the user manager stops at logout and the night's agents
  // stop with it. This is the whole point of a service rather than a terminal.
  run(opts, lines, 'loginctl', ['enable-linger', opts.userName]);
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

export function statusService(opts: ServiceOpts): ServiceResult {
  const res = opts.platform === 'win32' ? statusWindows(opts) : opts.platform === 'darwin' ? statusDarwin(opts) : linuxService(opts);
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

/** `LastTaskResult` of a scheduled task that was registered and never started. */
export const WINDOWS_TASK_NEVER_RAN = 0x41303;

export type ServiceDiagnostics = {
  /** The definition sets `TIMON_DESKTOP_SERVICE=1`; `null` when none was found to read. */
  marked: boolean | null;
  /** Windows only: `LastTaskResult`, `null` when unreadable. */
  lastTaskResult: number | null;
  /** What the supervisor says about the last run, a few `key: value` lines. */
  lines: string[];
};

function readIfPresent(path: string): string | null {
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}

/** The definition files of the installed service, as the supervisor will run them. */
function serviceDefinitionMarked(opts: ServiceOpts): boolean | null {
  if (opts.platform === 'win32') {
    const launcher = readIfPresent(windowsServiceFiles(opts.timonHome, join).launcher);
    return launcher === null ? null : /^set "TIMON_DESKTOP_SERVICE=1"\r?$/m.test(launcher);
  }
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
            lines.push(`last result: ${value} (0x${lastTaskResult.toString(16)})`);
          } else {
            lines.push(`${key.trim()}: ${value || '—'}`);
          }
        }
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
  return { marked, lastTaskResult, lines };
}
