/** Packaged daemons must outlive the desktop bundle they were installed from. */
import { readFile, writeFile } from 'node:fs/promises';
import nodeFs from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { ServiceOpts } from './service-install.js';
import { isBundledNode } from './bundled-node.js';

export function instanceId(home: string): string {
  return createHash('sha256').update(resolve(home)).digest('hex').slice(0, 24);
}
export function packagedUnit(home: string): string {
  return `timon-desktop-${instanceId(home)}`;
}
/**
 * The systemd unit this daemon runs under on Linux. A packaged service carries
 * `TIMON_DESKTOP_SERVICE=1` and is named after its home; anything else is a
 * source checkout's `sourceUnit`. Naming the source unit to a package user hands
 * them a restart command that restarts nothing.
 */
export function ownLinuxUnit(sourceUnit: string, home: string, env: NodeJS.ProcessEnv = process.env): string {
  return env.TIMON_DESKTOP_SERVICE === '1' ? packagedUnit(home) : sourceUnit;
}
export function runtimeDir(home: string): string { return join(home, 'desktop-runtime'); }
export function packagedReleaseId(version = process.env.TIMON_DESKTOP_VERSION ?? 'current'): string {
  const readable = version.trim().replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 48) || 'unknown';
  const digest = createHash('sha256').update(version).digest('hex').slice(0, 12);
  return `${readable}-${digest}`;
}
export function runtimeReleaseDir(home: string, version?: string): string {
  return join(runtimeDir(home), 'releases', packagedReleaseId(version));
}
export function activeReleaseFile(home: string): string { return join(runtimeDir(home), 'active-release'); }
/** Set by a newly installed desktop bundle that replaces its predecessor's service. */
export function desktopUpgrade(): boolean { return process.env.TIMON_DESKTOP_UPGRADE === '1'; }

/** Electron virtualises ASAR paths; durable runtime copies need the real disk. */
function rawFilesystem(): typeof nodeFs {
  return process.versions.electron
    ? createRequire(import.meta.url)('original-fs') as typeof nodeFs
    : nodeFs;
}

/**
 * A daemon that fails at every start (a disk returning I/O errors, TIM-0109)
 * was restarted every 2 s, thousands of times. The delay now grows up to
 * 5 minutes and never gives up: a `StartLimit*` would leave the unit `failed`,
 * refusing even the desktop's own `start` until a `reset-failed`. systemd
 * before 254 ignores both keys with a warning; the daemon's own wait on a
 * storage failure (`storage-failure.ts`) bounds the loop there.
 */
export const PACKAGED_RESTART_BACKOFF = 'RestartSteps=10\nRestartMaxDelaySec=300\n';

function execQuote(value: string): string { return quote(value).replaceAll('$', '$$'); }

function quote(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error('Invalid service value');
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%')}"`;
}

/**
 * `Timon.app` for both runtimes: `<Name>.app/Contents/MacOS/<Name>` (Electron)
 * or `<Name>.app/Contents/Resources/node/node` (the shipped Node).
 */
function macBundleName(executable: string, bundled: boolean): string {
  return bundled ? basename(dirname(dirname(dirname(dirname(executable))))) : `${basename(executable)}.app`;
}

/** All arguments originate in the desktop process, never in an HTTP request. */
export function packagedServiceOptions(
  base: ServiceOpts,
  executable: string,
  appPort: number,
  version?: string,
): ServiceOpts {
  const root = runtimeReleaseDir(base.timonHome, version);
  const mac = base.platform === 'darwin';
  // The Node the package ships (`resources/node/node`), or Electron run as
  // Node for a package built before it travelled.
  const bundled = isBundledNode(executable, base.platform);
  // dyld/Electron require the executable to remain inside a directory whose
  // name ends in .app; copying Contents alone crashes with SIGTRAP on macOS.
  // The staged copy keeps the bundle's name either way.
  const runtimeRoot = mac ? join(root, macBundleName(executable, bundled), 'Contents') : root;
  const resources = join(runtimeRoot, mac ? 'Resources' : 'resources');
  const installDir = join(resources, 'orchestrator');
  const nodePath = bundled
    ? join(resources, 'node', basename(executable))
    : mac ? join(runtimeRoot, 'MacOS', basename(executable)) : join(root, basename(executable));
  // Finder/launchd start applications with a deliberately tiny PATH. The
  // packaged CLI lives next to the orchestrator, while onboarding installs
  // user-scoped tools (notably Node) under ~/.local/bin. Put both first so
  // agents can invoke `timon` and its /usr/bin/env node shebang without a
  // global install. Keep inherited and known system directories afterwards.
  // The package's `cli/timon` launcher comes first: it runs the CLI with the
  // app's runtime, where `bin/timon` alone needed a system Node whose ABI does
  // not match the native modules (tester report, 27/09/2026).
  const path = [...new Set([
    join(dirname(dirname(installDir)), 'cli'),
    join(installDir, 'bin'),
    join(base.homeDir, '.local', 'bin'),
    ...(process.env.PATH ?? '').split(delimiter),
    ...(base.platform === 'win32'
      ? []
      : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']),
  ].filter(Boolean))].join(delimiter);
  const env = {
    // Only Electron needs it: the shipped Node would pass it on to every child.
    ...(bundled ? {} : { ELECTRON_RUN_AS_NODE: '1' }),
    NODE_ENV: 'production',
    TIMON_HOME: base.timonHome, TIMON_INSTALL_DIR: installDir,
    TIMON_DESKTOP_SERVICE: '1', TIMON_DESKTOP_EMBEDDED: '0',
    TIMON_RESOURCE_GUARD_ENABLED: '0', PORT: String(base.port),
    TIMON_APP_ENABLED: '1', TIMON_APP_PORT: String(appPort),
    PATH: path,
    TIMON_DESKTOP_VERSION: version ?? process.env.TIMON_DESKTOP_VERSION ?? 'current',
  };
  // WorkingDirectory is a single literal path: unlike ExecStart/Environment,
  // systemd does not remove surrounding quotes from this directive.
  const workingDirectory = `WorkingDirectory=${installDir.replaceAll('%', '%%')}`;
  const render = (directory: string, backoff: string) => `[Unit]\nDescription=Timon desktop daemon\nAfter=network.target\n\n[Service]\nType=simple\n${directory}\n`
    + Object.entries(env).map(([key, value]) => `Environment=${quote(`${key}=${value}`)}`).join('\n')
    + `\nExecStart=${execQuote(nodePath)} --max-old-space-size=${base.heapMb} ${execQuote(join(installDir, 'dist', 'host', 'packaged-runner.js'))}\nRestart=on-failure\nRestartSec=2\n${backoff}KillMode=control-group\nTimeoutStopSec=30\n\n[Install]\nWantedBy=default.target\n`;
  const unitContent = render(workingDirectory, PACKAGED_RESTART_BACKOFF);
  return { ...base, installDir, nodePath, environment: env,
    unitName: packagedUnit(base.timonHome), unitContent,
    // The malformed template predates the backoff: rendering it with the new
    // lines would never match a unit that release actually wrote.
    legacyUnitContent: render(`WorkingDirectory=${quote(installDir)}`, ''),
    releasesRoot: join(runtimeDir(base.timonHome), 'releases'),
    // An upgrade runner is no embedded daemon: nothing to hand over, and the
    // previous release still holds the port until it is restarted.
    pendingHandover: process.env.TIMON_DESKTOP_EMBEDDED === '1' && !desktopUpgrade(),
    restart: desktopUpgrade() };
}

/** Stage a complete runtime, without following links into live development dependencies. */
export async function stagePackagedRuntime(
  home: string,
  executable: string,
  installDir: string,
  version?: string,
): Promise<void> {
  // Electron's patched fs treats .asar files as directories, even in Node mode.
  // Use its raw filesystem for the whole copy and cleanup without changing the daemon's global ASAR handling.
  const fs = rawFilesystem();
  const { existsSync, realpathSync } = fs;
  const { cp, lstat, mkdir, readlink, rename, rm } = fs.promises;
  const mac = basename(dirname(installDir)) === 'Resources';
  const bundled = isBundledNode(executable, process.platform);
  const resourcesName = mac ? 'Resources' : 'resources';
  // The package root: `Contents` on macOS, the folder holding `resources` elsewhere.
  const source = realpathSync(mac ? dirname(dirname(installDir)) : bundled ? dirname(dirname(dirname(executable))) : dirname(executable));
  const expectedInstall = join(source, resourcesName, 'orchestrator');
  const executableIn = (packageRoot: string): string => bundled
    ? join(packageRoot, resourcesName, 'node', basename(executable))
    : mac ? join(packageRoot, 'MacOS', basename(executable)) : join(packageRoot, basename(executable));
  const expectedExecutable = executableIn(source);
  if (realpathSync(installDir) !== expectedInstall || realpathSync(executable) !== expectedExecutable) {
    throw new Error('The daemon is not running from a complete desktop package');
  }
  const target = runtimeReleaseDir(home, version);
  const bundleName = mac ? (bundled ? basename(dirname(source)) : `${basename(executable)}.app`) : '';
  const targetRoot = mac ? join(target, bundleName, 'Contents') : target;
  const targetInstall = join(targetRoot, resourcesName, 'orchestrator');
  const targetExecutable = executableIn(targetRoot);
  if (existsSync(join(targetInstall, 'dist', 'host', 'packaged-runner.js'))
    && existsSync(targetExecutable)) return;
  if (!relative(source, resolve(target)).startsWith('..')) throw new Error('Runtime destination is inside its source');
  await mkdir(home, { recursive: true });
  await mkdir(join(runtimeDir(home), 'releases'), { recursive: true });
  const stage = `${target}.staging-${process.pid}`;
  const stageRoot = mac ? join(stage, bundleName, 'Contents') : stage;
  try {
    if (mac) await mkdir(dirname(stageRoot), { recursive: true });
    await cp(source, stageRoot, { recursive: true, verbatimSymlinks: true, filter: async (path) => {
      if (!(await lstat(path)).isSymbolicLink()) return true;
      const link = await readlink(path);
      // Absolute links were the cause of a previous live ABI corruption.
      if (isAbsolute(link) || relative(source, resolve(dirname(path), link)).startsWith('..')) {
        return false;
      }
      return true;
    } });
    const stagedInstall = join(stageRoot, resourcesName, 'orchestrator');
    if (!existsSync(join(stagedInstall, 'dist', 'host', 'packaged-runner.js'))) {
      throw new Error('The desktop package is missing its service runner');
    }
    await rename(stage, target);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

/** The release the supervisor definition points at, as last recorded. */
export async function readActiveRelease(home: string): Promise<string | null> {
  try {
    return (await readFile(activeReleaseFile(home), 'utf8')).trim() || null;
  } catch {
    return null;
  }
}

/** Marks the release only after its supervisor definition was accepted. */
export async function markActiveRelease(home: string, version?: string): Promise<void> {
  await writeFile(activeReleaseFile(home), `${packagedReleaseId(version)}\n`, { mode: 0o600 });
}

/**
 * Remove superseded runtime copies after launchd/systemd accepted this release.
 * `keep` holds the release that was active before it: going back to that
 * version then reuses its copy instead of depending on the installer again.
 */
export async function pruneInactiveReleases(home: string, version?: string, keep: readonly string[] = []): Promise<void> {
  const releases = join(runtimeDir(home), 'releases');
  const active = packagedReleaseId(version);
  const { readdir, rm } = rawFilesystem().promises;
  let entries;
  try {
    entries = await readdir(releases, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  await Promise.all(entries
    .filter((entry) => entry.isDirectory() && entry.name !== active && !keep.includes(entry.name))
    .map((entry) => rm(join(releases, entry.name), { recursive: true, force: true })));
}

/** Linux start-time tokens prevent PID reuse from keeping a service waiting forever. */
export function processToken(stat: string): string {
  return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? '';
}
export async function recordHandover(home: string, pid: number): Promise<void> {
  const token = processToken(await readFile(`/proc/${pid}/stat`, 'utf8'));
  if (!token) throw new Error('Cannot identify the embedded daemon');
  await writeFile(join(runtimeDir(home), 'handover.json'), JSON.stringify({ pid, token }), { mode: 0o600 });
}
export async function waitForHandover(
  handover: { pid: number; token: string },
  read: (path: string) => Promise<string> = (path) => readFile(path, 'utf8'),
): Promise<void> {
  for (;;) {
    let current: string;
    try { current = processToken(await read(`/proc/${handover.pid}/stat`)); }
    catch (error) {
      // ESRCH: the process died between the open and the read of its stat file.
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ESRCH') break;
      throw error;
    }
    if (current !== handover.token) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
