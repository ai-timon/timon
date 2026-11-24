/**
 * Portable (embedded) mode — the shell runs the daemon itself (plan §5.2).
 *
 * Used when `daemon.supervisor === 'none'`: nobody else keeps the daemon
 * alive, so the window does. The daemon is a CHILD of the Electron process and
 * dies with it, unlike a daemon managed by a service.
 *
 * The restart mechanics mirror `orchestrator/src/kernel/child-supervisor.ts`
 * word for word (2 s → 30 s backoff, 5 rapid falls then give up). They are
 * re-implemented rather than imported: the two packages are independent, and
 * the daemon-side supervisor writes to the database, which this side must not
 * touch. Any change to the numbers belongs in both places.
 */
import { execFile, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, delimiter, join, win32 } from 'node:path';
import { withRuntimeEnv } from './daemon-runtime.js';

export const FIRST_DELAY_MS = 2_000;
export const MAX_DELAY_MS = 30_000;
/**
 * "Rapid" = the daemon fell before staying up `RESTART_WINDOW_MS`. A literal
 * "5 restarts per 60 s of wall clock" would never fire: the backoff alone
 * (2+4+8+16+30) already fills 60 s. A daemon that held a minute resets both
 * the counter and the backoff — that is an isolated crash, not a loop.
 */
export const MAX_RESTARTS = 5;
export const RESTART_WINDOW_MS = 60_000;
/** How long a quit waits for the daemon it asked to stop: past the daemon's own 5 s grace. */
export const STOP_WAIT_MS = 10_000;
/** Overrides that wait, in milliseconds; `0` skips the request (the orchestrator's `cooperative-stop.ts` reads it too). */
export const STOP_WAIT_ENV = 'TIMON_COOPERATIVE_STOP_MS';

/** Injected in tests; production passes `child_process.spawn`. */
export type Spawner = (
  command: string,
  args: string[],
  opts: { env: NodeJS.ProcessEnv; stdio: 'inherit'; detached: boolean; windowsHide?: boolean },
) => ChildProcess;

export type EmbeddedOpts = {
  /** Absolute path of the daemon entry point (`orchestrator/dist/boot.js`). */
  entry: string;
  /** `<resources>/orchestrator` — where the daemon is installed IN THIS launch. */
  installDir: string;
  /** Bootstrap settings the daemon must share with the shell (`daemonEnvOverrides`). */
  overrides?: Record<string, string>;
  /** `TIMON_HOME` the daemon must use — never guessed by the child. */
  home: string;
  heapMb: number;
  /** The daemon's runtime (`daemonRuntime`): the Node the package ships, or Electron run as plain Node. */
  execPath: string;
  /** That runtime's own variables (`DaemonRuntime.env`); Electron's `ELECTRON_RUN_AS_NODE` when absent. */
  runtimeEnv?: Readonly<Record<string, string>>;
  spawn: Spawner;
  /** Production terminates the whole detached process group; tests use child.kill. */
  terminate?: (child: ChildProcess) => boolean;
  /**
   * Windows: asks the daemon to run its own stop (`requestDaemonStop`), true
   * when it accepted. The forced `terminate` then only ends a daemon that did
   * not leave within `stopWaitMs`. Absent on POSIX, whose `terminate` already
   * sends SIGTERM.
   */
  askToStop?: () => Promise<boolean>;
  stopWaitMs?: number;
  /** Once the daemon has exited: ends what its tree no longer reached (`endEmbeddedLeftovers`). */
  afterStop?: () => Promise<void>;
  /**
   * The daemon died on its own: ends what it left running (`endFallenDaemonLeftovers`)
   * before the next attempt. Its web server otherwise kept the app port, and
   * the service installed next waited on that port forever (macOS, 26/10/2026).
   */
  endLeftovers?: (pid: number) => Promise<void>;
  /** Called once when the supervisor gives up. The shell turns it into a dialog. */
  onGiveUp: (why: string) => void;
  log?: Pick<Console, 'warn' | 'error'>;
};

/** `orchestrator/` under the packaged resources (§5.5). */
export function daemonInstallDirOf(resourcesPath: string): string {
  return join(resourcesPath, 'orchestrator');
}

/** `orchestrator/dist/boot.js` under the packaged resources (§5.5). */
export function daemonEntryOf(resourcesPath: string): string {
  return join(daemonInstallDirOf(resourcesPath), 'dist', 'boot.js');
}

/** PATH Finder does not provide, but user-local developer tools expect. */
export function embeddedExecutablePath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const home = env.HOME ?? env.USERPROFILE ?? '';
  const paths = [
    home ? join(home, '.local', 'bin') : '',
    ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'] : []),
    ...(env.PATH ?? '').split(delimiter),
  ].filter(Boolean);
  return [...new Set(paths)].join(delimiter);
}

/**
 * Environment of the embedded daemon.
 *
 * `spawn`'s `env` REPLACES the parent environment, it does not merge: a bare
 * `{ TIMON_HOME }` would strip `PATH` and `HOME`, and the daemon's first act is
 * to spawn `claude` — which it would then never find. We inherit and override.
 *
 * The runtime's own variables come from `daemonRuntime`: nothing for the Node
 * the package ships, `ELECTRON_RUN_AS_NODE` when Electron runs as plain Node
 * (from the sources, or a package without its Node). Never inherited.
 *
 * `TIMON_INSTALL_DIR` is not a convenience: the daemon serves the web app from
 * `<installDir>/../app`, and inside an AppImage the resources live in a
 * `/tmp/.mount_XXXX` path that CHANGES at every launch. Writing it to
 * `timon.config.json` would be wrong the next morning; the shell, which is the
 * only process that knows where it was mounted this time, passes it at spawn
 * (`orchestrator/src/config/load.ts`, `ENV_OVERRIDES`).
 *
 * Inheriting also inherits mistakes, hence `STRIPPED`: a packaged client is the
 * product and must never present itself as anything else. The daemon passes its
 * own environment on to the web app it spawns (`plugins-bundled/web-app`), so a
 * variable left in the shell that launched the client would reach the window
 * title, the manifest and the installed PWA's icon.
 */
const STRIPPED = new Set(['TIMON_INSTANCE', 'NODE_OPTIONS']);
export function embeddedEnv(
  opts: Pick<EmbeddedOpts, 'home' | 'heapMb' | 'installDir' | 'overrides' | 'runtimeEnv'>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...withRuntimeEnv(process.env, { execPath: '', env: opts.runtimeEnv ?? { ELECTRON_RUN_AS_NODE: '1' } }),
    TIMON_DESKTOP_EMBEDDED: '1',
    TIMON_RESOURCE_GUARD_ENABLED: '0',
    TIMON_HOME: opts.home,
    TIMON_INSTALL_DIR: opts.installDir,
    PATH: embeddedExecutablePath(),
    ...opts.overrides,
  };
  // Apply after overrides, including case-insensitive Windows environment keys.
  for (const key of Object.keys(env)) {
    if (STRIPPED.has(key.toUpperCase())) delete env[key];
  }
  return env;
}

/**
 * Starts the daemon and keeps it alive. Returns the stop function: it cuts the
 * restarts and kills the child.
 *
 * The caller MUST have checked that no daemon already answers (see
 * `main.ts`): two daemons on the same `TIMON_HOME` write the same database.
 */
export function superviseEmbeddedDaemon(opts: EmbeddedOpts): () => Promise<void> {
  const log = opts.log ?? console;
  let child: ChildProcess | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let delay = FIRST_DELAY_MS;
  let rapidFalls = 0;
  let startedAt = 0;
  let cleaning: Promise<void> | undefined;

  const scheduleRestart = (why: string): void => {
    if (stopped) return;
    if (Date.now() - startedAt >= RESTART_WINDOW_MS) {
      rapidFalls = 0;
      delay = FIRST_DELAY_MS;
    }
    rapidFalls += 1;
    if (rapidFalls > MAX_RESTARTS) {
      stopped = true;
      log.error(`[embedded] ${MAX_RESTARTS} restarts without the daemon holding ${RESTART_WINDOW_MS / 1000}s — giving up`);
      opts.onGiveUp(why);
      return;
    }
    log.warn(`[embedded] ${why} — restarting in ${delay / 1000}s`);
    timer = setTimeout(() => { timer = undefined; start(); }, delay);
    timer.unref?.();
    delay = Math.min(delay * 2, MAX_DELAY_MS);
  };

  function start(): void {
    if (stopped) return;
    const spawned = opts.spawn(opts.execPath, [`--max-old-space-size=${opts.heapMb}`, opts.entry], {
      env: embeddedEnv(opts),
      stdio: 'inherit',
      detached: process.platform !== 'win32',
      // node.exe is a console program: without this, a black window per start.
      windowsHide: true,
    });
    child = spawned;
    startedAt = Date.now();
    // One start counts once: on ENOENT node emits both `error` and `exit`,
    // and two scheduled restarts would race.
    let down = false;
    const fell = (why: string): void => {
      if (down || child !== spawned) return;
      down = true;
      child = undefined;
      const pid = spawned.pid;
      if (stopped || !opts.endLeftovers || pid === undefined) { scheduleRestart(why); return; }
      // Awaited before the restart: a Windows sweep still running when the
      // next daemon starts would end that daemon too.
      const ending = opts.endLeftovers;
      cleaning = Promise.resolve()
        .then(() => ending(pid))
        .catch((error: unknown) => log.warn(`[embedded] could not end what the daemon left: ${(error as Error).message}`))
        .then(() => { cleaning = undefined; scheduleRestart(why); });
    };
    spawned.on('error', (err: Error) => fell(`launch failed: ${err.message}`));
    spawned.on('exit', (code, signal) => fell(`exited (code ${code ?? 'null'}, signal ${signal ?? 'null'})`));
  }

  start();

  return async () => {
    stopped = true;
    if (timer) { clearTimeout(timer); timer = undefined; }
    // `kill` on an undefined pid would signal the whole process group, us
    // included. Only ever this child, and only if it has a pid.
    const stopping = child;
    // Windows runs no handler on a forced kill: asked first, the daemon exits
    // through its own stop and its next start reads this run as clean.
    const left = stopping?.pid !== undefined && opts.askToStop
      ? await exitOnRequest(stopping, opts.askToStop, opts.stopWaitMs ?? STOP_WAIT_MS, log)
      : false;
    // A relaunch must not probe the dying daemon and mistake it for the
    // installed service. Keep the AppImage mounted until this child exits.
    if (stopping?.pid !== undefined && !left && !hasExited(stopping)) await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        stopping.removeListener('exit', exited);
        stopping.removeListener('error', failed);
      };
      const exited = () => { cleanup(); resolve(); };
      const failed = (error: Error) => { cleanup(); reject(error); };
      const timeout = setTimeout(() => failed(new Error('The embedded daemon did not stop in time.')), 15_000);
      timeout.unref?.();
      stopping.once('exit', exited);
      stopping.once('error', failed);
      try {
        const terminated = opts.terminate ? opts.terminate(stopping) : stopping.kill();
        if (!terminated) failed(new Error('The embedded daemon could not be stopped.'));
      } catch (error) { failed(error as Error); }
    });
    // Without a live child (between two attempts, or after giving up), what
    // the last daemon left behind must still go with the shell.
    if (cleaning) await cleaning;
    if (opts.afterStop) {
      try { await opts.afterStop(); } catch (error) { log.warn(`[embedded] could not end the daemon's orphans: ${(error as Error).message}`); }
    }
  };
}

function hasExited(child: ChildProcess): boolean {
  return typeof child.exitCode === 'number' || typeof child.signalCode === 'string';
}

/**
 * Asks the daemon to stop and waits for `child` to exit, `waitMs` at most.
 * False when it refused, did not answer, or is still there: the caller then
 * ends it by force, as it did before.
 */
async function exitOnRequest(
  child: ChildProcess,
  ask: () => Promise<boolean>,
  waitMs: number,
  log: Pick<Console, 'warn'>,
): Promise<boolean> {
  let accepted = false;
  try { accepted = await ask(); } catch (error) { log.warn(`[embedded] the stop request failed: ${(error as Error).message}`); }
  if (!accepted) return false;
  if (hasExited(child)) return true;
  return new Promise<boolean>((resolve) => {
    const done = (exited: boolean): void => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      if (!exited) log.warn(`[embedded] the daemon was still running ${waitMs / 1000}s after the stop request: ending it`);
      resolve(exited);
    };
    const onExit = (): void => done(true);
    const timer = setTimeout(() => done(false), waitMs);
    timer.unref?.();
    child.once('exit', onExit);
  });
}

/** The wait the environment asks for; anything unreadable keeps the default. */
export function stopWaitMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env[STOP_WAIT_ENV]?.trim();
  if (!raw || !/^\d+$/.test(raw)) return STOP_WAIT_MS;
  return Math.min(Number(raw), 120_000);
}

/**
 * `POST /api/daemon/shutdown` with the daemon token of `home`: true when the
 * daemon accepted (202). The token only ever goes to this machine's loopback
 * listener over plain HTTP. Never throws: a refusal is a forced stop.
 */
export async function requestDaemonStop(origin: string, home: string, fetcher: typeof fetch = fetch): Promise<boolean> {
  let url: URL;
  try { url = new URL(origin); } catch { return false; }
  if (!['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password) return false;
  let token: string;
  try { token = readFileSync(join(home, 'daemon-token'), 'utf8').trim(); } catch { return false; }
  if (!token) return false;
  try {
    const res = await fetcher(new URL('/api/daemon/shutdown', url), {
      method: 'POST', redirect: 'error',
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(3_000),
    });
    return res.status === 202;
  } catch {
    return false;
  }
}

/**
 * The request a quit sends before its forced stop: Windows only, where
 * nothing else would let the daemon run its own stop. `undefined` on POSIX
 * (SIGTERM already does) and when the wait is set to 0.
 */
export function stopRequestFor(
  platform: NodeJS.Platform,
  origin: string,
  home: string,
  env: NodeJS.ProcessEnv = process.env,
  fetcher: typeof fetch = fetch,
): { askToStop: () => Promise<boolean>; stopWaitMs: number } | undefined {
  const waitMs = stopWaitMs(env);
  if (platform !== 'win32' || waitMs === 0) return undefined;
  return { askToStop: () => requestDaemonStop(origin, home, fetcher), stopWaitMs: waitMs };
}

/**
 * What a background process of this installation carries on its command line
 * and the window never does — a copy of `installationProcessNeedles`
 * (orchestrator `host/service-install.ts`, the two packages being independent):
 * the daemon, the terminal host, the browser helper a mission's CLI starts,
 * and the web server, which runs the sibling `app` directory. The trailing
 * separator keeps Electron's own `--app-path=…\resources\app.asar` out.
 */
export function orphanNeedles(installDir: string): string[] {
  return [
    win32.join(installDir, 'dist', 'boot.js'),
    win32.join(installDir, 'dist', 'terminal-host', 'main.js'),
    win32.join(installDir, 'bin', 'browser-mcp.mjs'),
    `${win32.join(win32.dirname(installDir), 'app')}${win32.sep}`,
  ];
}

const psLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * PowerShell that ends every `exe` of this installation left without the
 * daemon, except this very shell and Electron's helpers (`--type=`). Run after
 * `taskkill /T` on the daemon: the terminal host is started by an intermediate
 * that exits at once (orchestrator `host/detached.ts`), so no tree reaches it,
 * and a mission's browser helper outlives a CLI that went first (TIM-0115,
 * tester report of 22/10/2026 — the installer then looped on "Timon cannot
 * be closed").
 */
export function orphanSweepScript(installDir: string, exe: string | readonly string[], ownPid: number): string {
  const needles = orphanNeedles(installDir).map((needle) => psLiteral(needle.toLowerCase())).join(', ');
  const names = (typeof exe === 'string' ? [exe] : exe).map(psLiteral).join(', ');
  return `$needles = @(${needles}); $names = @(${names}); Get-CimInstance Win32_Process | Where-Object { `
    + `if ($names -notcontains $_.Name -or $_.ProcessId -eq ${ownPid} -or -not $_.CommandLine -or $_.CommandLine.Contains('--type=')) { return $false }; `
    + '$line = $_.CommandLine.ToLowerInvariant(); foreach ($needle in $needles) { if ($line.Contains($needle)) { return $true } }; $false '
    + '} | ForEach-Object { & taskkill.exe /F /T /PID $_.ProcessId | Out-Null }; exit 0';
}

export type ScriptRunner = (script: string) => Promise<void>;
const runPowershell: ScriptRunner = (script) => new Promise((resolve, reject) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 10_000, windowsHide: true }, (error) => (error ? reject(error) : resolve()));
});

/**
 * Windows, portable mode: the daemon's orphans go with the shell, as the public
 * docs promise. Both runtimes are swept — the shell's executable and the
 * `node.exe` the package ships — and only processes whose command line names
 * this installation: a `node.exe` of the machine is never touched.
 */
export function endInstallationOrphans(installDir: string, run: ScriptRunner = runPowershell, exe: string | readonly string[] = [basename(process.execPath), 'node.exe'], ownPid: number = process.pid): Promise<void> {
  return run(orphanSweepScript(installDir, exe, ownPid));
}

/** The orchestrator's runner that ends the mission CLIs a stopped daemon left (TODO #565). */
export function missionSweepRunnerOf(installDir: string): string {
  return join(installDir, 'dist', 'host', 'mission-process-sweep-runner.js');
}

export type RunnerExec = (file: string, args: string[], env: NodeJS.ProcessEnv) => Promise<void>;
const execRunner: RunnerExec = (file, args, env) => new Promise((resolve, reject) => {
  execFile(file, args, { env, timeout: 30_000, windowsHide: true }, (error) => (error ? reject(error) : resolve()));
});

/**
 * Every OS, portable mode: the mission CLIs the daemon recorded and that
 * outlived it — a CLI's own children leave the daemon's process group, and
 * `taskkill /T` stops at a dead parent. The runner reads the daemon's registry
 * with the daemon's own environment, so it sees the same home.
 */
export function endRecordedMissionProcesses(
  opts: Pick<EmbeddedOpts, 'home' | 'heapMb' | 'installDir' | 'overrides' | 'execPath' | 'runtimeEnv'>,
  run: RunnerExec = execRunner,
  exists: (path: string) => boolean = existsSync,
): Promise<void> {
  const runner = missionSweepRunnerOf(opts.installDir);
  // A daemon run from sources without its build has no runner, and no registry worth reading.
  if (!exists(runner)) return Promise.resolve();
  return run(opts.execPath, [runner], embeddedEnv(opts));
}

/**
 * Once the embedded daemon has exited: its recorded mission CLIs, then on
 * Windows the installation sweep. One failing never skips the other.
 */
export async function endEmbeddedLeftovers(
  opts: Pick<EmbeddedOpts, 'home' | 'heapMb' | 'installDir' | 'overrides' | 'execPath' | 'runtimeEnv'>,
  platform: NodeJS.Platform = process.platform,
  steps: { missions: () => Promise<void>; installation: () => Promise<void> } = {
    missions: () => endRecordedMissionProcesses(opts),
    installation: () => endInstallationOrphans(opts.installDir),
  },
): Promise<void> {
  const failures: string[] = [];
  try { await steps.missions(); } catch (error) { failures.push(`mission processes: ${(error as Error).message}`); }
  if (platform === 'win32') {
    try { await steps.installation(); } catch (error) { failures.push(`installation: ${(error as Error).message}`); }
  }
  if (failures.length) throw new Error(failures.join('; '));
}

/**
 * What a daemon that died on its own left running: its web server above all,
 * which kept the app port so that the service installed next could never
 * start the UI (macOS tester report, 26/10/2026).
 *
 * POSIX: the daemon was spawned detached, so it led its own process group and
 * its web server is in it. While a member is alive the kernel does not reuse
 * that number, so signalling the group cannot reach a stranger; `ESRCH` means
 * nothing was left. Windows: a dead parent's tree is out of `taskkill /T`'s
 * reach, hence the installation sweep (`endInstallationOrphans`).
 */
export function endFallenDaemonLeftovers(
  pid: number,
  installDir: string,
  platform: NodeJS.Platform = process.platform,
  signal: (pid: number, signal: NodeJS.Signals) => void = process.kill,
  sweep: (installDir: string) => Promise<void> = endInstallationOrphans,
): Promise<void> {
  if (platform === 'win32') return sweep(installDir);
  try { signal(-pid, 'SIGTERM'); } catch { /* Nothing left in its group. */ }
  return Promise.resolve();
}

function endWindowsTree(pid: number, done: (error: Error | null) => void): void {
  execFile('taskkill.exe', ['/T', '/F', '/PID', String(pid)], { timeout: 10_000, windowsHide: true }, (error) => done(error));
}

/** A detached daemon and every child it launched receive the same signal. */
export function terminateProcessTree(
  child: ChildProcess,
  platform: NodeJS.Platform = process.platform,
  signal: (pid: number, signal: NodeJS.Signals) => void = process.kill,
  taskkill: (pid: number, done: (error: Error | null) => void) => void = endWindowsTree,
): boolean {
  if (child.pid === undefined) return false;
  if (platform === 'win32') {
    // `child.kill()` ends the daemon alone: its web server, mission CLIs and
    // MCP servers stay behind, orphaned (TIM-0115). The tree goes with it.
    taskkill(child.pid, (error) => { if (error) child.kill(); });
    return true;
  }
  try {
    signal(-child.pid, 'SIGTERM');
    return true;
  } catch {
    return child.kill();
  }
}
