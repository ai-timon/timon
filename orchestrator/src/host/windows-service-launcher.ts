/**
 * The program the Windows scheduled task runs: it HOLDS the daemon until it
 * exits, so the repeating trigger + `IgnoreNew` act as the supervisor.
 *
 * It replaces the `timon-service.cmd` batch of revisions 2 to 5, which the
 * task ran through `cmd.exe` (boot task) or a hidden PowerShell (logon task).
 * Avast and AVG flag exactly that shape in `C:\Windows\System32\Tasks` —
 * a batch or PowerShell started at boot or logon, hidden, repeating — and
 * quarantined the task (`CMD:Heur.BZC.WBO.Boxter`). The task now starts a
 * program of the package directly: this script on the Node the package ships
 * (boot task, session 0, no window anyone sees), or `Timon.exe --timon-service`
 * (logon task), a GUI-subsystem program that starts this script with no
 * console window (`desktop/src/windows-service-shell.ts`).
 *
 * What the batch did, this does, in the same order (renderWindowsLauncher of
 * revision 5 for the history):
 * - waits until DPAPI opens the session witness: under S4U, when nobody has
 *   logged on since boot, a `claude` run ERASES the user's Windows
 *   credentials (docs/SERVICE-HORS-SESSION.md, W6);
 * - moves a log of 10 MiB or more aside, once, at start;
 * - starts the daemon with its output and errors appended to `daemon.log`,
 *   which is what `>>daemon.log 2>&1` did;
 * - waits for it, so the task runs exactly as long as its daemon.
 *
 * Unlike the batch, it does not hand every exit back to the 5-minute trigger
 * (issue #116). A daemon refused the home because the desktop's embedded one
 * holds it (`HOME_HELD_EXIT_CODE`) is waited on here until the home is
 * released, then started again: the task stays Running, `IgnoreNew` drops the
 * repetitions, and no new process (nor, for a task someone switched to the
 * session, a new console window) appears every five minutes. Any other
 * failure is restarted with a capped backoff; only a daemon that keeps
 * failing fast is handed back to the trigger, which stays the safety net. An
 * exit 0 is a stop that was asked for and ends the launcher, as before.
 *
 * An action cannot set an environment variable: the daemon's environment
 * comes from `run/timon-service.json`, written by `timon service install`
 * (`renderWindowsLauncherConfig`, `host/service-install.ts`).
 *
 * Imports node built-ins and zod only: it runs before anything of the daemon.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, writeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** Format of `run/timon-service.json`; a launcher refuses a format it does not know. */
export const WINDOWS_LAUNCHER_FORMAT = 1;

/** Seconds between two looks at a session witness that does not open yet. */
export const WITNESS_RETRY_SECONDS = 10;

/**
 * Copy of `HOME_HELD_EXIT_CODE` (`home-lock.ts`): the daemon found its home
 * held by another daemon. Copied, not imported: `home-lock.ts` loads
 * better-sqlite3, and this script runs before anything of the daemon.
 */
export const HOME_HELD_EXIT_CODE = 76;

/** Copy of the file `homeLockHolderFile` names: the holder writes it, `releaseHomeLock` removes it. */
export const HOME_LOCK_HOLDER_FILE = 'daemon.lock.json';

/** How often a held home is looked at: the handover waits on it, so a release must be seen fast. */
export const HOME_POLL_MS = 2_000;

/**
 * The wait after a refusal, doubled at each refusal in a row: past it, the
 * daemon is started again even if the home still looks held. The holder file
 * survives a holder that was killed, and a pid can be recycled, so it is
 * never trusted to wait forever. Stays under the desktop's handover budget
 * (`HANDOVER_BUDGET_MS`, 90 s, `desktop/src/main.ts`).
 */
export const HOME_HELD_FIRST_WAIT_MS = 10_000;
export const HOME_HELD_MAX_WAIT_MS = 60_000;

/** The wait before restarting a daemon that failed, doubled at each failure in a row, capped. */
export const RESTART_FIRST_WAIT_MS = 2_000;
export const RESTART_MAX_WAIT_MS = 60_000;

/** This many failures within the window and the launcher gives up: the task's trigger starts it again later. */
export const RAPID_FAILURE_LIMIT = 5;
export const RAPID_FAILURE_WINDOW_MS = 120_000;

/** What the launcher returns when it gave up on a daemon that keeps failing. */
export const GAVE_UP_EXIT_CODE = 1;

const launcherConfigSchema = z.object({
  format: z.literal(WINDOWS_LAUNCHER_FORMAT),
  /** The Node that runs the daemon. */
  node: z.string().min(1),
  /** Its arguments: the heap limit, then `dist\boot.js`. */
  args: z.array(z.string()),
  cwd: z.string().min(1),
  /** Added to the environment the task gives this process. */
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
  log: z.string().min(1),
  rotateBytes: z.number().int().positive(),
  /** Arguments of the PowerShell that exits 0 when the witness opens, 2 when it is missing, 1 otherwise (`readSessionWitnessCommand`). */
  witness: z.object({ file: z.string().min(1), args: z.array(z.string()).min(1) }),
});

export type WindowsLauncherConfig = z.infer<typeof launcherConfigSchema>;

/** The configuration, or a message that names the file and says why it was refused. */
export function parseLauncherConfig(text: string, file: string): WindowsLauncherConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`${file} is not valid JSON: ${(error as Error).message}`);
  }
  const parsed = launcherConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${file} is not a Timon service configuration (${parsed.error.issues.map((issue) => issue.path.join('.') || 'root').join(', ')}); run \`timon service install\``);
  }
  return parsed.data;
}

/** What the launcher needs from the machine; the tests replace all of it. */
export type LauncherDeps = {
  /** Runs the witness check, returns its exit code and what it wrote on stderr. */
  checkWitness: (args: string[]) => { code: number | null; stderr: string; error?: Error };
  /** Starts the daemon with its output on `logFd`, resolves with its exit code. */
  runDaemon: (config: WindowsLauncherConfig, logFd: number) => Promise<number | null>;
  sleep: (milliseconds: number) => Promise<void>;
  now: () => Date;
  /** The state of the home's holder file: who, if anyone, still holds it. */
  holder: (file: string) => HolderState;
};

/**
 * `absent`: no holder file. `alive`: it names a running process, or one this
 * process may not open (a daemon of another session). `gone`: it names a
 * process that no longer exists, a holder killed before it could remove it.
 * `unknown`: unreadable.
 */
export type HolderState = 'absent' | 'alive' | 'gone' | 'unknown';

/** Reads the holder file. Like `probePid` (`cooperative-stop.ts`), only `ESRCH` proves a process gone. */
export function readHolderState(file: string): HolderState {
  if (!existsSync(file)) return 'absent';
  let pid: unknown;
  try {
    pid = (JSON.parse(readFileSync(file, 'utf8')) as { pid?: unknown }).pid;
  } catch {
    // Removed between the two calls, or being written: look again next time.
    return existsSync(file) ? 'unknown' : 'absent';
  }
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try {
    process.kill(pid, 0);
    return 'alive';
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'gone' : 'alive';
  }
}

/**
 * The daemon's environment: the task's, then the configuration's. Never an
 * `ELECTRON_RUN_AS_NODE` inherited by accident (packaging audit I2): only the
 * configuration sets it, for Electron run as Node; the Node the package ships
 * would pass it on to every child.
 */
export function daemonEnv(inherited: NodeJS.ProcessEnv, own: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
  }
  return { ...env, ...own };
}

/** Windows PowerShell by its full path: the task's PATH is the one read when it started (packaging audit I5). */
export function windowsPowershell(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.SystemRoot ?? env.windir;
  return root ? join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
}

export const launcherDeps: LauncherDeps = {
  checkWitness: (args) => {
    // `windowsHide`: no console window in the user's session either.
    const res: SpawnSyncReturns<string> = spawnSync(windowsPowershell(), args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
    return { code: res.status, stderr: res.stderr ?? '', ...(res.error ? { error: res.error } : {}) };
  },
  runDaemon: (config, logFd) => new Promise((done) => {
    const child = spawn(config.node, config.args, {
      cwd: config.cwd,
      env: daemonEnv(process.env, config.env),
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    child.once('error', (error) => {
      writeLine(logFd, new Date(), `the daemon could not be started: ${error.message}`);
      done(null);
    });
    child.once('exit', (code) => done(code));
  }),
  sleep: (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
  now: () => new Date(),
  holder: readHolderState,
};

function writeLine(fd: number, at: Date, text: string): void {
  // A log that cannot be written costs the line, never the daemon.
  try { writeSync(fd, `[timon-service] ${at.toISOString()} ${text}\n`); } catch { /* see above */ }
}

/** One line, bounded: a localized exception message must not flood a log rotated only at start. */
function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 300 ? flat.slice(0, 300) : flat;
}

/**
 * Between two daemons, the log is rotated as at start: a launcher may now
 * live for weeks, and only a start used to rotate it. No daemon holds the
 * file then, and Node opens it shareable for a rename. The new file is open
 * before the old one is closed: one that cannot be opened keeps the old one.
 */
function reopenLog(fd: number, config: WindowsLauncherConfig): number {
  try {
    if (statSync(config.log).size < config.rotateBytes) return fd;
  } catch { return fd; }
  rotate(config.log, config.rotateBytes);
  let next: number;
  try { next = openSync(config.log, 'a'); } catch { return fd; }
  closeSync(fd);
  return next;
}

/** Moved aside at start only: nothing holds the file yet. A lock (antivirus, indexer) skips the rotation. */
function rotate(log: string, limit: number): void {
  try {
    if (statSync(log).size >= limit) renameSync(log, `${log}.1`);
  } catch { /* absent, or held: appended to as it is */ }
}

/** The home the daemon runs on: the configuration names it; `<home>\tmp\daemon.log` otherwise. */
export function launcherHome(config: WindowsLauncherConfig): string {
  return config.env.TIMON_HOME ?? dirname(dirname(config.log));
}

/** The wait before the next start, doubled for each one before it in a row (`streak` from 0), capped. */
export function backoff(streak: number, first: number, max: number): number {
  return Math.min(max, first * 2 ** Math.min(streak, 16));
}

/**
 * Waits after a refusal until the home is released or `delay` has passed.
 * Released: the holder file was there and is gone (`releaseHomeLock` removes
 * it), or it names a process that is gone. A holder file that was never seen
 * proves nothing (the holder could not write it): the whole delay is waited,
 * so a home held without one is not tried every two seconds.
 */
async function waitForHome(deps: LauncherDeps, file: string, delay: number): Promise<'released' | 'elapsed'> {
  const until = deps.now().getTime() + delay;
  let seen = deps.holder(file) !== 'absent';
  for (;;) {
    const left = until - deps.now().getTime();
    if (left <= 0) return 'elapsed';
    await deps.sleep(Math.min(HOME_POLL_MS, left));
    const state = deps.holder(file);
    if (state === 'gone' || (state === 'absent' && seen)) return 'released';
    if (state !== 'absent') seen = true;
  }
}

/**
 * The whole launch. Exit codes: 2 when the witness is missing (the service
 * must be installed again), 0 once the daemon was stopped (it exited 0),
 * `GAVE_UP_EXIT_CODE` when it kept failing (`RAPID_FAILURE_LIMIT`).
 */
export async function runLauncher(config: WindowsLauncherConfig, seams: Partial<LauncherDeps> = {}): Promise<number> {
  const deps: LauncherDeps = { ...launcherDeps, ...seams };
  mkdirSync(dirname(config.log), { recursive: true });
  rotate(config.log, config.rotateBytes);
  let fd = openSync(config.log, 'a');
  try {
    let waiting = false;
    for (;;) {
      const check = deps.checkWitness(config.witness.args);
      if (check.code === 0) break;
      if (check.code === 2) {
        writeLine(fd, deps.now(), 'session witness missing, reinstall the service');
        return 2;
      }
      if (!waiting) {
        const why = check.error ? `the check could not run: ${check.error.message}` : oneLine(check.stderr) || `exit ${check.code ?? 'unknown'}`;
        writeLine(fd, deps.now(), `session witness unreadable: ${why}`);
        writeLine(fd, deps.now(), 'waiting for the first logon since boot');
        waiting = true;
      }
      await deps.sleep(WITNESS_RETRY_SECONDS * 1000);
    }
    const holderFile = join(launcherHome(config), HOME_LOCK_HOLDER_FILE);
    let heldStreak = 0;
    let failures: number[] = [];
    for (;;) {
      writeLine(fd, deps.now(), 'starting the daemon');
      const code = await deps.runDaemon(config, fd);
      writeLine(fd, deps.now(), `daemon exited with code ${code ?? 'unknown'}`);
      if (code === 0) return 0;
      if (code === HOME_HELD_EXIT_CODE) {
        if (heldStreak === 0) writeLine(fd, deps.now(), 'home held by another daemon, waiting');
        const delay = backoff(heldStreak, HOME_HELD_FIRST_WAIT_MS, HOME_HELD_MAX_WAIT_MS);
        heldStreak += 1;
        if (await waitForHome(deps, holderFile, delay) === 'released') writeLine(fd, deps.now(), 'home released');
      } else {
        heldStreak = 0;
        const at = deps.now().getTime();
        failures = [...failures.filter((past) => at - past < RAPID_FAILURE_WINDOW_MS), at];
        if (failures.length >= RAPID_FAILURE_LIMIT) {
          writeLine(fd, deps.now(), `daemon failed ${failures.length} times in ${RAPID_FAILURE_WINDOW_MS / 60_000} minutes, leaving it to the task's next start`);
          return GAVE_UP_EXIT_CODE;
        }
        const delay = backoff(failures.length - 1, RESTART_FIRST_WAIT_MS, RESTART_MAX_WAIT_MS);
        writeLine(fd, deps.now(), `restarting the daemon in ${Math.round(delay / 1000)} s`);
        await deps.sleep(delay);
      }
      fd = reopenLog(fd, config);
    }
  } finally {
    closeSync(fd);
  }
}

/** Where a configuration that cannot be read is reported: `daemon.log` of the home it sits in (`<home>\run\timon-service.json`). */
export function fallbackLog(configFile: string): string {
  return join(dirname(dirname(configFile)), 'tmp', 'daemon.log');
}

async function main(argv: string[]): Promise<void> {
  const file = argv[0];
  if (!file) throw new Error('usage: windows-service-launcher <run\\timon-service.json>');
  let config: WindowsLauncherConfig;
  try {
    config = parseLauncherConfig(readFileSync(file, 'utf8'), file);
  } catch (error) {
    // Nobody reads this process's stderr: the task has no console.
    const log = fallbackLog(file);
    try {
      mkdirSync(dirname(log), { recursive: true });
      const fd = openSync(log, 'a');
      writeLine(fd, new Date(), `cannot start: ${(error as Error).message}`);
      closeSync(fd);
    } catch { /* nowhere left to say it */ }
    throw error;
  }
  process.exitCode = await runLauncher(config);
}

/** Run as a script, never when imported (the tests, `service-install.ts`). */
function isEntry(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  return process.platform === 'win32' ? resolve(entry).toLowerCase() === self.toLowerCase() : resolve(entry) === self;
}

if (isEntry()) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(`[timon-service] ${(error as Error).message}`);
    process.exitCode = 1;
  });
}
