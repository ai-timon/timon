import { spawnSync } from 'node:child_process';
import { accessSync, constants, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, posix, win32 } from 'node:path';
import { TIMON_HOME } from '../paths.js';
import { installedByNpm } from './machine.js';
import { windowsShimLaunch } from './windows-shell.js';
import { missionWritableProblem } from './mission-writable.js';
import { declaredBinary } from './declared-binaries.js';
import type { BuiltinDesktopBuild } from '../backends/builtin-declarations.js';
import { expandDirectory, INSTALL_PLATFORMS, type InstallPlatform } from '../backends/provider-declarations.js';

export const INSTALLED_BINARIES_FILE = join(TIMON_HOME, 'installed-binaries.json');

export function readInstalledBinaries(file = INSTALLED_BINARIES_FILE): Record<string, string> {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] =>
      typeof entry[1] === 'string' && (isAbsolute(entry[1]) || win32.isAbsolute(entry[1]))));
  } catch { return {}; }
}

export type BinarySearchOptions = {
  platform?: NodeJS.Platform;
  path?: string;
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
  installedBinariesFile?: string;
  /** Filesystem reads behind the desktop-app and winget discovery, injectable for tests. */
  directoryReader?: DirectoryReader;
  /** Global npm prefix (`npm config get prefix`), injectable for tests. */
  npmPrefix?: () => string | null;
  /** Stands in for `TIMON_HOME` when telling the folders a mission can write. */
  timonHome?: string;
};

export type DirectoryReader = {
  /** Names of the sub-directories of `dir`; throws when it cannot be read. */
  subdirectories(dir: string): string[];
  /** Modification time of a regular file, `null` when absent or not a file. */
  fileMtimeMs(file: string): number | null;
};

const diskReader: DirectoryReader = {
  subdirectories: (dir) => readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name),
  fileMtimeMs: (file) => {
    try {
      const stat = statSync(file);
      return stat.isFile() ? stat.mtimeMs : null;
    } catch { return null; }
  },
};

/** Dot-separated identifiers: the three core numbers, then the pre-release ones. */
type Semver = { core: string[]; prerelease: string[] };

const NUMERIC_ID = '0|[1-9]\\d*';
const PRERELEASE_ID = `(?:${NUMERIC_ID}|\\d*[A-Za-z-][0-9A-Za-z-]*)`;
/** SemVer 2.0.0: no leading zeros, no empty identifier; build metadata is accepted and ignored. */
const SEMVER = new RegExp(
  `^((?:${NUMERIC_ID})\\.(?:${NUMERIC_ID})\\.(?:${NUMERIC_ID}))`
  + `(?:-(${PRERELEASE_ID}(?:\\.${PRERELEASE_ID})*))?`
  + '(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$',
);

function parseSemver(version: string): Semver | null {
  const match = SEMVER.exec(version);
  if (!match?.[1]) return null;
  return { core: match[1].split('.'), prerelease: match[2]?.split('.') ?? [] };
}

/** Numeric identifiers without leading zeros compare by length, then digit by digit: no overflow. */
function compareNumeric(a: string, b: string): number {
  if (a.length !== b.length) return a.length - b.length;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Pre-release identifier precedence: numeric as integers, numeric below alphanumeric, else ASCII order. */
function compareIdentifier(a: string, b: string): number {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return compareNumeric(a, b);
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/** SemVer 2.0.0 §11 precedence, ascending. */
function compareSemver(a: Semver, b: Semver): number {
  for (const [i, part] of a.core.entries()) {
    const diff = compareNumeric(part, b.core[i] ?? '');
    if (diff !== 0) return diff;
  }
  // A release outranks every pre-release of the same version.
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return (a.prerelease.length === 0 ? 1 : 0) - (b.prerelease.length === 0 ? 1 : 0);
  }
  for (const [i, id] of a.prerelease.entries()) {
    const other = b.prerelease[i];
    // Every shared identifier equal and `b` exhausted: the longer set ranks higher.
    if (other === undefined) return 1;
    const diff = compareIdentifier(id, other);
    if (diff !== 0) return diff;
  }
  return a.prerelease.length - b.prerelease.length;
}

/** The OS a declaration is keyed by; anything unlisted reads as `linux`, the closest. */
function declarationOs(platform: NodeJS.Platform): InstallPlatform {
  return (INSTALL_PLATFORMS as readonly string[]).includes(platform) ? platform as InstallPlatform : 'linux';
}

/** Folders a PROVIDER declared for `name` (C1 `searchDirs`), expanded for this machine. */
function declaredSearchDirectories(name: string, platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv): string[] {
  const declaration = declaredBinary(name);
  if (!declaration?.searchDirs) return [];
  const templates = [...(declaration.searchDirs.any ?? []), ...(declaration.searchDirs[declarationOs(platform)] ?? [])];
  return templates.flatMap((template) => expandDirectory(template, { platform, home, env }) ?? []);
}

/** Whether a folder name can be a build of the app (`folderPattern`, the product's own narrowing; absent = any folder). */
function isBuildFolder(build: BuiltinDesktopBuild, folder: string): boolean {
  return build.folderPattern === undefined || new RegExp(build.folderPattern, 'i').test(folder);
}

/**
 * Builds a PROVIDER declared (C1 `desktopBuilds`): one folder per build under a
 * root, newest or highest-versioned first.
 */
function declaredDesktopBuildCandidates(
  name: string, platform: NodeJS.Platform, home: string, env: NodeJS.ProcessEnv, reader: DirectoryReader,
): string[] {
  const out: string[] = [];
  for (const build of declaredBinary(name)?.desktopBuilds ?? []) {
    if (build.platform !== platform) continue;
    const root = expandDirectory(build.root, { platform, home, env });
    if (!root) continue;
    const join = platform === 'win32' && win32.isAbsolute(root) && !posix.isAbsolute(root) ? win32.join : posix.join;
    let folders: string[];
    try { folders = reader.subdirectories(root); } catch { continue; }
    const builds = folders
      .filter((folder) => isBuildFolder(build, folder))
      .map((folder) => {
        const file = join(root, folder, ...build.executable);
        return { file, semver: parseSemver(folder), mtimeMs: reader.fileMtimeMs(file) };
      })
      .filter((entry): entry is { file: string; semver: Semver | null; mtimeMs: number } => entry.mtimeMs !== null);
    out.push(...builds
      .sort((a, b) => {
        if (build.order === 'newest') return b.mtimeMs - a.mtimeMs;
        if (a.semver && b.semver) return compareSemver(b.semver, a.semver);
        if (a.semver) return -1;
        if (b.semver) return 1;
        return b.mtimeMs - a.mtimeMs;
      })
      .map((entry) => entry.file));
  }
  return out;
}

/**
 * A pin into a build folder a PROVIDER declared (the Codex app on Windows, the Claude
 * app on macOS…): the app replaces the folder on update, so such a pin goes stale on
 * its own and resolution falls back to detection instead of losing the CLI. Any other
 * pin stays strict; Windows path semantics (case, separators) apply whatever the host
 * running the comparison.
 */
export function isDesktopBuildPath(name: string, pin: string, options: BinarySearchOptions = {}): boolean {
  const platform = options.platform ?? process.platform;
  const home = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  for (const build of declaredBinary(name)?.desktopBuilds ?? []) {
    if (build.platform !== platform) continue;
    const root = expandDirectory(build.root, { platform, home, env });
    const path = platform === 'win32' ? win32 : posix;
    if (!root || !path.isAbsolute(root) || !path.isAbsolute(pin)) continue;
    const [folder, ...executable] = path.relative(root, pin).split(path.sep);
    const sameExecutable = executable.length === build.executable.length
      && executable.every((part, i) => (platform === 'win32' ? part.toLowerCase() === build.executable[i]!.toLowerCase() : part === build.executable[i]));
    if (folder !== undefined && folder !== '..' && sameExecutable && isBuildFolder(build, folder)
      && (build.order !== 'semver' || parseSemver(folder) !== null)) return true;
  }
  return false;
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * Where the installer of a prerequisite that is NOT a provider puts its binary.
 * The AI CLIs declare theirs (C1 `searchDirs`, read below): these installers only
 * announce the folder to the login shell, so a daemon started by systemd, launchd
 * or the Windows task never sees it.
 */
function installerDirectories(
  name: string,
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  pathJoin: (dir: string, ...parts: string[]) => string,
): string[] {
  // PowerShell 7 installs beside, not over, Windows PowerShell 5.1, and a daemon
  // started before the MSI ran has a PATH that does not list it yet.
  if (name === 'pwsh' && platform === 'win32') {
    return [
      env.ProgramFiles ? pathJoin(env.ProgramFiles, 'PowerShell', '7') : '',
      // Microsoft Store build: an app execution alias, resolved by `findExecutableBinary`.
      env.LOCALAPPDATA ? pathJoin(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps') : '',
    ];
  }
  // The Windows installer adds this folder to the system PATH, which a service
  // started before it ran never sees. On macOS the standalone and App Store
  // builds ship the CLI inside the app bundle (`Tailscale`, matched on the
  // case-insensitive volume macOS formats by default).
  if (name === 'tailscale' && platform === 'win32') {
    return [env.ProgramFiles ? pathJoin(env.ProgramFiles, 'Tailscale') : ''];
  }
  if (name === 'tailscale' && platform === 'darwin') {
    return [pathJoin('/Applications', 'Tailscale.app', 'Contents', 'MacOS')]; // portability: macOS-only app bundle location
  }
  return [];
}

/**
 * Node installs nvm manages (`<NVM_DIR>/versions/node/v<x.y.z>/bin`), highest
 * version first: npm puts its global CLIs (codex, claude) beside that node,
 * and only the login shell that sources `nvm.sh` ever lists the folder.
 */
function nvmBinDirectories(
  home: string,
  env: NodeJS.ProcessEnv,
  reader: DirectoryReader,
  pathJoin: (dir: string, ...parts: string[]) => string,
): string[] {
  const root = env.NVM_DIR || (home ? pathJoin(home, '.nvm') : '');
  if (!root) return [];
  const versions = pathJoin(root, 'versions', 'node');
  let folders: string[];
  try { folders = reader.subdirectories(versions); } catch { return []; }
  return folders
    .map((folder) => ({ folder, semver: parseSemver(folder.replace(/^v/, '')) }))
    .filter((entry): entry is { folder: string; semver: Semver } => entry.semver !== null)
    .sort((a, b) => compareSemver(b.semver, a.semver))
    .map((entry) => pathJoin(versions, entry.folder, 'bin'));
}

/**
 * Where the usual Node and package managers put their shims, per OS. Their
 * installers only teach the folder to shells opened afterwards, so a daemon
 * that was already running — the setup screen's daemon — never sees a CLI
 * installed there until it restarts (SUG-0006).
 */
function managerDirectories(
  platform: NodeJS.Platform,
  home: string,
  env: NodeJS.ProcessEnv,
  reader: DirectoryReader,
  pathJoin: (dir: string, ...parts: string[]) => string,
): string[] {
  if (platform === 'win32') {
    return [
      // nvm-windows keeps the active node behind this link; its default
      // (`Program Files\nodejs`) is already listed.
      env.NVM_SYMLINK ?? '',
      env.LOCALAPPDATA ? pathJoin(env.LOCALAPPDATA, 'Volta', 'bin') : '',
      // Scoop and Chocolatey stay per binary (a provider's `searchDirs`): a
      // shim there must not outrank the copy its own installer wrote.
    ];
  }
  return [
    ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'] : []),
    ...(platform === 'linux' ? ['/usr/local/bin', '/home/linuxbrew/.linuxbrew/bin'] : []),
    // Per-account npm prefixes a service never puts on PATH.
    home ? pathJoin(home, '.volta', 'bin') : '',
    home ? pathJoin(home, '.npm-global', 'bin') : '',
    ...nvmBinDirectories(home, env, reader, pathJoin),
  ];
}

/**
 * Candidate paths for a user-installed executable.
 *
 * Finder/launchd applications receive a deliberately small PATH on macOS.
 * Tools installed for the current account still live in predictable places,
 * and Codex bundled with ChatGPT is a real CLI executable even though Apple
 * never adds the app's Resources directory to PATH.
 */
export function binaryCandidates(name: string, options: BinarySearchOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  if (isAbsolute(name) || (platform === 'win32' && win32.isAbsolute(name))) return [name];
  const home = options.homeDir ?? homedir();
  const env = options.env ?? process.env;
  const path = options.path ?? env.PATH ?? env.Path ?? '';
  const pathJoin = (dir: string, ...parts: string[]) => platform === 'win32' && win32.isAbsolute(dir) && !isAbsolute(dir)
    ? win32.join(dir, ...parts) : join(dir, ...parts);
  const directories = unique([
    ...path.split(platform === 'win32' ? ';' : ':'),
    home ? pathJoin(home, '.local', 'bin') : '',
    ...(platform === 'win32' ? [
      env.APPDATA ? pathJoin(env.APPDATA, 'npm') : '',
      env.LOCALAPPDATA ? pathJoin(env.LOCALAPPDATA, 'Programs', name) : '',
      // Where the installer puts the prerequisites (Node.js, Git for Windows):
      // a shell started before them keeps a PATH that does not list them yet.
      env.ProgramFiles ? pathJoin(env.ProgramFiles, 'nodejs') : '',
      env.ProgramFiles ? pathJoin(env.ProgramFiles, 'Git', 'cmd') : '',
    ] : []),
    ...managerDirectories(platform, home, env, options.directoryReader ?? diskReader, pathJoin),
    // Last: a copy reachable through PATH, npm or Homebrew stays the one the
    // user chose to maintain.
    ...installerDirectories(name, platform, env, pathJoin),
    // A provider's own declaration (C1), after the places the adapter knows by name.
    ...declaredSearchDirectories(name, platform, home, env),
  ]);
  const extensions = platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  const candidates = directories.flatMap((dir) => extensions.map((ext) => pathJoin(dir, name + ext)));
  // The bundle's binary is `Tailscale`: found as `tailscale` on the case-insensitive
  // volume macOS formats by default, not on a case-sensitive one.
  if (name === 'tailscale' && platform === 'darwin') {
    candidates.push(pathJoin('/Applications', 'Tailscale.app', 'Contents', 'MacOS', 'Tailscale')); // portability: macOS-only app bundle location
  }
  if (platform === 'win32') {
    const installed = readInstalledBinaries(options.installedBinariesFile)[name];
    if (installed) candidates.push(installed);
  }
  // The builds a desktop app ships, last: a CLI installed through npm, or on its own, stays the
  // one the user chose to maintain.
  candidates.push(...declaredDesktopBuildCandidates(name, platform, home, env, options.directoryReader ?? diskReader));
  return unique(candidates);
}

/**
 * `winget.exe` in `WindowsApps` is an app execution alias: Node's `stat` is
 * refused (EACCES), yet the link itself is readable and runs. Skipping it left
 * the onboarding's Install buttons with "winget not found" on every Windows
 * machine (27/09/2026).
 */
function isAppExecutionAlias(file: string, error: unknown, platform: NodeJS.Platform): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (platform !== 'win32' || (code !== 'EACCES' && code !== 'EPERM' && code !== 'UNKNOWN')) return false;
  try { return lstatSync(file).isSymbolicLink(); } catch { return false; }
}

/** `npm config get prefix` output: one absolute path, or nothing usable. */
export function parseNpmPrefix(stdout: string): string | null {
  const prefix = stdout.trim();
  if (!prefix || /[\r\n]/.test(prefix) || !(isAbsolute(prefix) || win32.isAbsolute(prefix))) return null;
  return prefix;
}

const NPM_PREFIX_TTL_MS = 5 * 60_000;
let npmPrefixCache: { value: string | null; at: number } | null = null;

/**
 * The real global npm prefix on a Windows host, asked of npm itself. Only
 * reached when an npm CLI was found nowhere else, and remembered for a few
 * minutes: npm takes about a second to start on Windows, and the lookup runs
 * on the spawn path of every mission of that backend.
 */
function hostNpmPrefix(): string | null {
  if (process.platform !== 'win32') return null;
  if (npmPrefixCache && Date.now() - npmPrefixCache.at < NPM_PREFIX_TTL_MS) return npmPrefixCache.value;
  let value: string | null = null;
  const npm = findExecutableBinary('npm');
  if (npm) {
    const args = ['config', 'get', 'prefix'];
    const shim = windowsShimLaunch(npm, args);
    const result = spawnSync(shim?.file ?? npm, shim?.args ?? args, {
      // Blocks the event loop on the spawn path: a hung npm must not freeze the daemon.
      encoding: 'utf8', timeout: 5_000, windowsHide: true,
      ...(shim ? { windowsVerbatimArguments: true } : {}),
    });
    if (result.status === 0) value = parseNpmPrefix(result.stdout);
  }
  npmPrefixCache = { value, at: Date.now() };
  return value;
}

/**
 * Where an npm CLI lands under a global prefix that is not `%APPDATA%\npm`
 * (`npm config set prefix`, nvm-windows, a Node installed elsewhere): a
 * daemon started before the PATH learnt it would never look there (TIM-0093).
 * Windows only: elsewhere the shims sit in `<prefix>/bin`, already covered by
 * the per-account directories.
 */
export function npmPrefixCandidates(name: string, options: BinarySearchOptions = {}): string[] {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32' || !installedByNpm(name)) return [];
  // A caller simulating another machine (`env`) never gets this host's npm.
  const resolve = options.npmPrefix ?? (options.env === undefined ? hostNpmPrefix : () => null);
  const prefix = resolve();
  if (!prefix) return [];
  const pathJoin = win32.isAbsolute(prefix) && !isAbsolute(prefix) ? win32.join : join;
  return ['.exe', '.cmd', '.bat', ''].map((ext) => pathJoin(prefix, name + ext));
}

/**
 * A candidate in a folder a mission can write is never chosen, pinned or not:
 * the daemon would run it outside any fence, and so would every mission that
 * launches it (GHSA-f58g). The next known location is tried instead, so a
 * `git` planted ahead of the real one on PATH loses to it.
 */
function firstExecutable(candidates: string[], platform: NodeJS.Platform, timonHome?: string): string | null {
  for (const candidate of candidates) {
    if (missionWritableProblem(candidate, { platform, ...(timonHome ? { timonHome } : {}) })) continue;
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, platform === 'win32' ? constants.F_OK : constants.X_OK);
      return candidate;
    } catch (error) {
      if (isAppExecutionAlias(candidate, error, platform)) return candidate;
      /* try the next known location */
    }
  }
  return null;
}

export function findExecutableBinary(name: string, options: BinarySearchOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  // npm is asked only once every known location has failed: it costs a process.
  return firstExecutable(binaryCandidates(name, options), platform, options.timonHome)
    ?? firstExecutable(npmPrefixCandidates(name, options), platform, options.timonHome);
}

/**
 * Resolution of a `host.binaries` pin. The pin keeps priority and a broken pin
 * stays an error, except a pin into a Codex or Claude desktop build the app has
 * since replaced: that one falls back to detection, which finds the new build.
 */
export function resolvePinnedBinary(name: string, pin: string, options: BinarySearchOptions = {}): string | null {
  const pinned = findExecutableBinary(pin, options);
  if (pinned) return pinned;
  if (isDesktopBuildPath(name, pin, options)) return findExecutableBinary(name, options);
  return null;
}

/** Locations a pin resolution tries, in order — what `timon doctor` reports. */
export function pinnedBinaryCandidates(name: string, pin: string, options: BinarySearchOptions = {}): string[] {
  if (isDesktopBuildPath(name, pin, options)) {
    return unique([...binaryCandidates(pin, options), ...binaryCandidates(name, options)]);
  }
  return binaryCandidates(pin, options);
}
