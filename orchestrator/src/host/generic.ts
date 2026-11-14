import {
  execFile,
  spawn as nodeSpawn,
  spawnSync,
  type ChildProcess,
} from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';
import type { TimonConfig } from '../config/schema.js';
import { TIMON_HOME } from '../paths.js';
import type { Capability, ExecOpts, ExecResult, Host, SpawnOpts } from './types.js';
import { findExecutableBinary, resolvePinnedBinary, type BinarySearchOptions } from './binary-path.js';
import { spawnDetachedGeneric } from './detached.js';
import { inspectListenPort } from './listen-port.js';
import { detectDesktopSession, type DesktopSession } from './desktop-session.js';
import { opensAsFolder, revealInFileManager } from './reveal.js';
import { windowsDirectLaunch, windowsShimLaunch } from './windows-shell.js';
import {
  fixedGitConfig, gitmodulesScanArgs, gitScanArgs, gitToplevelArgs, neutralGitCall, neutralGitEnv, parseGitConfigList,
  parseSubmoduleNames, type GitConfigEntry,
} from './git-neutral.js';

/** Where the adapter reads `host.binaries` at each resolution. */
export type BinaryPins = () => Record<string, string | null>;

function resolveBin(pins: BinaryPins, name: string, options: BinarySearchOptions): string {
  const configured = pins()[name];
  if (configured) {
    const pinned = resolvePinnedBinary(name, configured, options);
    if (pinned) return pinned;
    throw new Error(`binary "${name}" not found or not executable: ${configured}`);
  }
  const resolved = findExecutableBinary(name, options);
  if (resolved) return resolved;
  throw new Error(`binary "${name}" not found in PATH`);
}

/**
 * What `spawn` starts for a binary that does not resolve: an absolute path
 * that cannot exist, so node still reports ENOENT through the `error` event.
 * The bare name would be looked up by the OS: on Windows in the child's cwd
 * BEFORE the PATH, and a daemon spawn whose cwd is a mission's worktree would
 * start the `<name>.exe` planted there; on every system through a relative
 * PATH entry. Windows: under the daemon's runtime, a regular file nothing can
 * be created under (libuv answers ENOENT for any path it does not find).
 * Elsewhere: under the root, which only root writes (a path under a file
 * would answer ENOTDIR, which callers read as "unknown" instead of "missing").
 */
export function unresolvedBinaryPath(name: string, platform: NodeJS.Platform, runtime = process.execPath): string {
  // An absolute name is looked up nowhere: node reports what is wrong with it
  // (missing, not executable) as before.
  if (platform === 'win32' ? win32.isAbsolute(name) : posix.isAbsolute(name)) return name;
  const file = platform === 'win32' ? win32.basename(name) : posix.basename(name);
  return platform === 'win32'
    ? win32.join(runtime, 'unresolved-binary', file)
    : posix.join('/', '.timon-unresolved-binary', file);
}

function resultOf(r: ReturnType<typeof spawnSync>): ExecResult {
  return {
    code: r.status ?? (r.error ? 1 : 0),
    stdout: typeof r.stdout === 'string' ? r.stdout : r.stdout?.toString() ?? '',
    stderr: typeof r.stderr === 'string' ? r.stderr : r.stderr?.toString() ?? r.error?.message ?? '',
  };
}

/**
 * `binaryOptions` stands in for the real platform and environment in tests.
 * `pins` defaults to the config the adapter was built with; the daemon passes
 * the LIVE config instead, so a path pinned from Settings reaches the next
 * spawn without a restart (TODO #413).
 */
export function createGenericHost(
  config: TimonConfig,
  binaryOptions: BinarySearchOptions = {},
  pins: BinaryPins = () => config.host.binaries,
): Host {
  const bin = (name: string) => resolveBin(pins, name, binaryOptions);
  const findRuntime = (name: 'node' | 'bun') => {
    try { return bin(name); } catch { return null; }
  };
  // An npm shim (`.cmd`) cannot be spawned directly on Windows: EINVAL before
  // any process exists (TIM-0009). What it runs is started in its place, so the
  // CLI dies with the daemon (TODO #603); a shim we cannot read that way goes
  // through `cmd.exe`. Real binaries are passed through untouched.
  const launch = (file: string, args: string[]) => {
    const direct = windowsDirectLaunch(file, args, { findRuntime, platform: binaryOptions.platform });
    if (direct) return { file: direct.file, args: direct.args, extra: {} };
    const shim = windowsShimLaunch(file, args);
    return shim
      ? { file: shim.file, args: shim.args, extra: { windowsVerbatimArguments: true as const } }
      : { file, args, extra: {} };
  };
  const execFileResult = (file: string, args: string[], opts: ExecOpts) => new Promise<ExecResult>((resolve) => {
    execFile(file, args, opts, (error, stdout, stderr) => resolve({
      code: typeof error?.code === 'number' ? error.code : error ? 1 : 0,
      stdout: stdout?.toString() ?? '',
      stderr: stderr?.toString() ?? error?.message ?? '',
      // `killed` is also set when the output overran `maxBuffer`: the command
      // did answer then, too much.
      ...(error?.killed && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? { timedOut: true } : {}),
    }));
  });

  // Every git the daemon runs goes through `git-neutral.ts`: a mission writes
  // the repositories it runs in, and git executes what their configuration
  // names (GHSA-f58g). The configuration scan fails closed: a call whose
  // scan did not answer does not run.
  type GitCall = { args: string[]; opts: ExecOpts } | { failed: ExecResult };
  const scanOptions = (opts: ExecOpts): ExecOpts => ({
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.timeout ? { timeout: opts.timeout } : {}),
    env: neutralGitEnv(opts.env ?? process.env),
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
  });
  const finishGitCall = (args: string[], opts: ExecOpts, entries: GitConfigEntry[] | null, submodules: string[] = []): GitCall => {
    const call = neutralGitCall(args, entries, opts.env ?? process.env, { submodules, ...(typeof opts.cwd === 'string' ? { cwd: opts.cwd } : {}) });
    if ('refused' in call) return { failed: { code: 1, stdout: '', stderr: call.refused } };
    return { args: call.args, opts: { ...opts, env: call.env } };
  };
  const gitCallSync = (file: string, args: string[], opts: ExecOpts): GitCall => {
    const scan = gitScanArgs(args);
    if (!scan) return finishGitCall(args, opts, null);
    const run = (scanArgs: string[]): ExecResult => {
      const l = launch(file, scanArgs);
      const r = spawnSync(l.file, l.args, { ...scanOptions(opts), ...l.extra, encoding: 'utf8' });
      return { ...resultOf(r), ...((r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT' ? { timedOut: true } : {}) };
    };
    let scoped = true;
    let r = run(scan.scoped);
    if (r.code !== 0 && !r.timedOut) { scoped = false; r = run(scan.plain); }
    if (r.code !== 0) return { failed: r };
    const toplevel = gitToplevelArgs(args);
    if (!toplevel) return finishGitCall(args, opts, parseGitConfigList(r.stdout, scoped));
    const top = run(toplevel);
    if (top.code !== 0) return { failed: top };
    const names = parseSubmoduleNames(gitmodulesScanArgs(args, top.stdout.trim()).map((a) => run(a).stdout));
    return finishGitCall(args, opts, parseGitConfigList(r.stdout, scoped), names);
  };
  const gitCallAsync = async (file: string, args: string[], opts: ExecOpts): Promise<GitCall> => {
    const scan = gitScanArgs(args);
    if (!scan) return finishGitCall(args, opts, null);
    let scoped = true;
    const run = (scanArgs: string[]) => {
      const l = launch(file, scanArgs);
      return execFileResult(l.file, l.args, { ...scanOptions(opts), ...l.extra });
    };
    let r = await run(scan.scoped);
    if (r.code !== 0 && !r.timedOut) { scoped = false; r = await run(scan.plain); }
    if (r.code !== 0) return { failed: r };
    const toplevel = gitToplevelArgs(args);
    if (!toplevel) return finishGitCall(args, opts, parseGitConfigList(r.stdout, scoped));
    const top = await run(toplevel);
    if (top.code !== 0) return { failed: top };
    const outputs = await Promise.all(gitmodulesScanArgs(args, top.stdout.trim()).map(async (a) => (await run(a)).stdout));
    return finishGitCall(args, opts, parseGitConfigList(r.stdout, scoped), parseSubmoduleNames(outputs));
  };

  const exec = (name: string, args: string[], opts: ExecOpts = {}) => {
    const file = bin(name);
    const call = name === 'git' ? gitCallSync(file, args, opts) : { args, opts };
    if ('failed' in call) return call.failed;
    const l = launch(file, call.args);
    return resultOf(spawnSync(l.file, l.args, { ...call.opts, ...l.extra, encoding: 'utf8' }));
  };
  const execAsync = async (name: string, args: string[], opts: ExecOpts = {}): Promise<ExecResult> => {
    const file = bin(name);
    const call = name === 'git' ? await gitCallAsync(file, args, opts) : { args, opts };
    if ('failed' in call) return call.failed;
    const l = launch(file, call.args);
    return execFileResult(l.file, l.args, { ...call.opts, ...l.extra });
  };
  // A spawn must NEVER fail with a synchronous exception: the callers
  // (agent.ts first of all) rely on the child's `error` event to
  // finalise cleanly. Unresolved binary → a path that cannot exist is passed
  // and node reports the ENOENT through that channel.
  const spawn = (name: string, args: string[], opts: SpawnOpts = {}): ChildProcess => {
    let resolved: string | null = null;
    try { resolved = bin(name); } catch { /* ENOENT through the `error` event */ }
    if (resolved === null) {
      return nodeSpawn(unresolvedBinaryPath(name, binaryOptions.platform ?? process.platform), args, opts.env ? { ...opts, env: opts.env } : opts);
    }
    // `opts.env` set = COMPLETE environment, passed verbatim. Merging it
    // with `process.env` would void the allowlist of `missionEnv`
    // (SECRETS-VAULT.md §6.1): the daemon's secrets would come back this way,
    // and the absence tests would pass for the wrong reasons. Without
    // `opts.env`, inheritance stays node's default.
    if (name === 'git') {
      const { stdio: _stdio, detached: _detached, ...scanOpts } = opts;
      const call = gitCallSync(resolved, args, scanOpts as ExecOpts);
      if ('failed' in call) {
        // Still a process, never a throw: one that fails without running
        // anything configurable, its reason in the daemon's log.
        console.error(`[git] refused: ${call.failed.stderr.trim()}`);
        const refusal = ['--no-pager', ...fixedGitConfig().flatMap((pair) => ['-c', pair]), 'rev-parse', '--verify', 'refs/timon/git-refused'];
        const l = launch(resolved, refusal);
        return nodeSpawn(l.file, l.args, { ...opts, env: neutralGitEnv(opts.env ?? process.env), ...l.extra });
      }
      const l = launch(resolved, call.args);
      return nodeSpawn(l.file, l.args, { ...opts, env: call.opts.env, ...l.extra });
    }
    const l = launch(resolved, args);
    return nodeSpawn(l.file, l.args, { ...(opts.env ? { ...opts, env: opts.env } : opts), ...l.extra });
  };

  const unitsDir = join(TIMON_HOME, 'tmp', 'units');
  const pidFile = (unit: string) => join(unitsDir, `${unit}.pid`);
  const readPid = (unit: string): number | null => {
    try {
      const pid = Number(readFileSync(pidFile(unit), 'utf8').trim());
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch { return null; }
  };
  const alive = (pid: number): boolean => {
    try { process.kill(pid, 0); return true; } catch { return false; }
  };

  const docker = (() => {
    if (config.host.docker === 'disabled') return undefined;
    try {
      bin('docker');
      if (exec('docker', ['info'], { timeout: 5_000 }).code !== 0) return undefined;
      return { cli: (args: string[], timeoutMs = 120_000) => exec('docker', args, { timeout: timeoutMs }) };
    } catch { return undefined; }
  })();

  // `gui` is always carried on Windows and macOS (unless `host.gui: 'disabled'`):
  // the file-manager route must stay mounted. Whether this daemon can actually
  // put a window on a desktop is a separate, per-request answer — the service
  // runs in session 0 (S4U) or the `system` launchd domain, where nothing it
  // launches is visible. Only the file manager is wired — no `openTerminal`.
  const nativePlatform = binaryOptions.platform ?? process.platform;
  const nativeGui = (nativePlatform === 'win32' || nativePlatform === 'darwin')
    && config.host.gui !== 'disabled';
  let session: Promise<DesktopSession> | undefined;
  const gui: Host['gui'] = nativeGui ? {
    reveal: (path) => revealInFileManager(
      nativePlatform as 'win32' | 'darwin',
      path,
      opensAsFolder(nativePlatform as 'win32' | 'darwin', path),
    ),
    // A process never changes session: one probe per daemon lifetime.
    desktopSession: () => (session ??= detectDesktopSession(nativePlatform)),
  } : undefined;

  const capabilities = (): Capability[] => {
    const out: Capability[] = [];
    if (docker) out.push('containers');
    if (config.host.traefik) out.push('traefik');
    if (gui) out.push('gui');
    for (const capability of ['git', 'grepai', 'uvx'] as const) {
      try { bin(capability); out.push(capability); } catch { /* capability missing */ }
    }
    return out;
  };

  return {
    platform: process.platform as Host['platform'],
    inspectPort: (address, port) => inspectListenPort({ platform: process.platform as Host['platform'], execAsync }, address, port),
    capabilities,
    bin,
    exec,
    execAsync,
    spawn,
    confine: (cmd, args) => ({ cmd, args }),
    services: {
      start(unit, cmd, args, cwd) {
        mkdirSync(unitsDir, { recursive: true });
        const child = spawn(cmd, args, { cwd, detached: true, stdio: 'ignore' });
        if (!child.pid) throw new Error(`cannot start unit "${unit}"`);
        writeFileSync(pidFile(unit), String(child.pid));
        child.unref();
      },
      stop(unit) {
        const pid = readPid(unit);
        if (pid !== null && alive(pid)) process.kill(pid, 'SIGTERM');
        rmSync(pidFile(unit), { force: true });
      },
      status(unit) {
        const pid = readPid(unit);
        return pid !== null && alive(pid) ? 'running' : 'stopped';
      },
      self: () => ({ status: 'running' }),
      selfRestart: () => {},
    },
    containers: docker,
    gui,
    spawnDetached: (spec) => spawnDetachedGeneric(spec),
  };
}
