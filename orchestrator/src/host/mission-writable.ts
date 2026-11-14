/**
 * Folders a mission can write, as far as the daemon must care when it picks
 * something to EXECUTE (GHSA-f58g, V6 of the mission fence).
 *
 * A mission that can write a folder the daemon later executes from runs code
 * as the daemon, outside any fence a mission is launched in: a `git` planted
 * in a worktree that sits on the daemon's PATH, a relative PATH entry resolved
 * against a mission's cwd. So binary resolution (`binary-path.ts`) and the
 * PATH handed to the daemon's own `git` (`git-neutral.ts`) both skip these.
 *
 * Under `TIMON_HOME` the rule is a whitelist, like the fence's projection:
 * missions write most of it (worktrees, provider scratch, `tmp`, accounts,
 * memory) and a folder added tomorrow must be refused by default. Only what
 * the daemon installs itself and a fenced mission cannot write holds
 * executables: `plugins/` and `providers/` (ACP registry agents).
 *
 * The user's home is NOT refused as a whole: the AI CLIs live there
 * (`~/.local/bin`, nvm, Volta, Git for Windows per-user install), and as long
 * as no fence applies a mission writes the whole home, `timon.config.json`
 * included, so refusing it would break those installs and protect nothing.
 * The fence makes the home read-only except its write list
 * (`resolveFence`): the folders the configuration lets every mission, or
 * some of them, write (`host.isolation.writable` and its exceptions) are
 * refused here too, through `setMissionWritableRootsSource`.
 *
 * Not refused, on purpose: the system temporary folders the fence leaves
 * writable, and a backend's own state folder (`~/.claude`…). Neither is on
 * the daemon's PATH, which a mission cannot change, and an older Claude Code
 * install keeps its CLI in the latter.
 */
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep, win32 } from 'node:path';
import type { TimonConfig } from '../config/schema.js';
import { TIMON_HOME } from '../paths.js';

/** The only folders of `TIMON_HOME` that may hold an executable. */
export const TIMON_HOME_EXECUTABLE_DIRS: readonly string[] = Object.freeze(['plugins', 'providers']);

export type MissionWritableOptions = {
  platform?: NodeJS.Platform;
  /** Stands in for `TIMON_HOME` in tests. */
  timonHome?: string;
  /** More folders a mission writes; defaults to the fence's write list. */
  extraRoots?: readonly string[];
  /** Folders refused on top of `extraRoots` (or its default), each also
   *  compared once its links are resolved. */
  alsoRoots?: readonly string[];
};

let rootsSource: () => readonly string[] = () => [];

/** Where the folders the fence lets missions write come from: the live
 *  configuration, set by `createHost`. */
export function setMissionWritableRootsSource(source: () => readonly string[]): void {
  rootsSource = source;
}

let fencedSystemSource: () => readonly string[] = () => [];

/**
 * Where the system folders the fence leaves writable come from (`/tmp`…),
 * set by `createHost`: empty when no fence is configured. They are no PATH
 * entry, so binary resolution ignores them; a local git remote does not
 * (`git-neutral.ts`): its hooks run on the daemon's side of a push.
 */
export function setFencedSystemFoldersSource(source: () => readonly string[]): void {
  fencedSystemSource = source;
}

/** The system folders a fenced mission writes, as the live configuration says. */
export function fencedSystemFolders(): readonly string[] {
  try { return fencedSystemSource(); } catch { return []; }
}

/** The home folders `host.isolation` lets any mission write, `~/` expanded. */
export function fenceWritableRoots(config: TimonConfig, home = homedir()): string[] {
  const iso = config.host.isolation;
  const all = [
    ...iso.writable,
    ...Object.values(iso.exceptions.agents).flatMap((e) => e.writable),
    ...Object.values(iso.exceptions.projects).flatMap((e) => e.writable),
  ];
  return [...new Set(all.map((p) => resolve(p.startsWith('~/') ? join(home, p.slice(2)) : p)))];
}

function isAbsoluteFor(platform: NodeJS.Platform, path: string): boolean {
  return platform === 'win32' ? win32.isAbsolute(path) : isAbsolute(path);
}

/** `child` equals `parent` or lies beneath it. Case-insensitive on Windows and
 *  macOS, whose default volumes are. */
function within(platform: NodeJS.Platform, parent: string, child: string): boolean {
  const fold = (p: string) => (platform === 'win32' || platform === 'darwin' ? p.toLowerCase() : p);
  const rel = platform === 'win32'
    ? win32.relative(fold(parent), fold(child))
    : relative(fold(parent), fold(child));
  const separator = platform === 'win32' ? win32.sep : sep;
  return rel === '' || (!rel.startsWith(`..${separator}`) && rel !== '..' && !isAbsoluteFor(platform, rel));
}

/** A configuration that cannot be read yet refuses nothing more: resolution
 *  must not fail because of it. */
function safeRoots(): readonly string[] {
  try { return rootsSource(); } catch { return []; }
}

function canonical(path: string): string {
  try { return realpathSync(path); } catch { return path; }
}

/**
 * Why `path` (a folder or a file) is one a mission can write, or null. A
 * relative path is refused: resolved against whatever cwd the process has,
 * it can land in a mission's worktree.
 */
export function missionWritableProblem(path: string, options: MissionWritableOptions = {}): string | null {
  const platform = options.platform ?? process.platform;
  if (!path || !isAbsoluteFor(platform, path)) return 'relative path';
  const home = options.timonHome ?? TIMON_HOME;
  // Both spellings: a symlinked TIMON_HOME (or macOS `/private/var`) must not
  // let the resolved form of a path slip past the typed one.
  const candidates = platform === process.platform ? [path, canonical(path)] : [path];
  const homes = platform === process.platform ? [home, canonical(home)] : [home];
  const pathJoin = platform === 'win32' ? win32.join : (...parts: string[]) => resolve(...parts);
  for (const p of candidates) {
    for (const h of homes) {
      if (!within(platform, h, p)) continue;
      if (TIMON_HOME_EXECUTABLE_DIRS.some((dir) => within(platform, pathJoin(h, dir), p))) continue;
      return 'inside the Timon home';
    }
    for (const root of options.extraRoots ?? safeRoots()) {
      if (within(platform, root, p)) return `inside ${root}`;
    }
    for (const root of options.alsoRoots ?? []) {
      const spellings = platform === process.platform ? [root, canonical(root)] : [root];
      if (spellings.some((r) => within(platform, r, p))) return `inside ${root}`;
    }
  }
  return null;
}
