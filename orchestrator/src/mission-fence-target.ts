/**
 * What the fence of one mission needs to know beyond its identity: the git
 * directories its working directory commits into, and the plugin folders its
 * MCP servers run from (`host/isolation.ts`, `FenceTarget`).
 *
 * Both are read from places a mission can write: the `.git` file of a linked
 * worktree, the configuration of an MCP server an agent may declare. Nothing
 * here grants anything: `resolveFence` checks every path again on what it
 * resolves to. What this module adds is the check a path alone cannot carry —
 * that the git directory a worktree names is one that names it back.
 */
import { lstatSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { agentPackageCacheDir, isFenceAgent } from './host/isolation.js';
import type { NodeRuntime } from './host/node-runtime.js';

/** The orchestrator folder this code runs from: `src/` or `dist/` sit right below it, `bin/` beside them. */
const ORCHESTRATOR_ROOT = resolve(import.meta.dirname, '..');

/**
 * What the daemon runs from, for the fence (`FenceTarget.runtime`): its own
 * executable, its orchestrator folder, whose `bin/` holds the Timon MCP
 * servers, and the Node those servers start with (`nodeRuntime`, the one
 * `backends/provider-mcp.ts` writes in the MCP configuration). A bare command
 * name is looked up on PATH and says nothing about a folder: left out.
 */
export function daemonRuntimePaths(
  mcpNode: NodeRuntime,
  execPath: string = process.execPath,
  orchestratorRoot: string = ORCHESTRATOR_ROOT,
): string[] {
  const paths = [execPath, orchestratorRoot, mcpNode.command].filter((path) => isAbsolute(path));
  return [...new Set(paths)];
}

export type GitDirsFs = {
  /** What sits at `path`, links not followed: a folder, a file, or nothing. */
  kind(path: string): 'dir' | 'file' | null;
  /** The text of a file, or null when it cannot be read. */
  read(path: string): string | null;
  /** The resolved path, or null when it does not exist. */
  realpath(path: string): string | null;
};

export const GIT_DIRS_FS: GitDirsFs = Object.freeze({
  kind(path: string) {
    try {
      const stat = lstatSync(path);
      return stat.isDirectory() ? 'dir' as const : stat.isFile() ? 'file' as const : null;
    } catch {
      return null;
    }
  },
  read(path: string) {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  realpath(path: string) {
    try {
      return realpathSync.native(path);
    } catch {
      return null;
    }
  },
});

export type MissionGitDirs = {
  /** Folders to make writable so that `git commit` works from the mission's working directory. */
  dirs: string[];
  /** Why a git directory was found and not granted, for the log. */
  refused: string | null;
};

/** `child` is `parent` or lies beneath it. */
function within(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/**
 * The git directories of the repository `cwd` belongs to, outside `cwd`
 * itself (which the fence already grants).
 *
 * - `.git` is a folder in `cwd`: nothing to add.
 * - `.git` is a folder in an ancestor (`cwd` is a sub-folder of a checkout):
 *   that folder, unless the checkout is the user's home or holds it — a
 *   dotfiles repository is not the project the mission works on.
 * - `.git` is a file (a linked worktree): it names a git directory, which
 *   must name the worktree back (`<gitdir>/gitdir`, the link `git worktree`
 *   writes and `git worktree repair` checks). The `.git` file is the
 *   mission's to rewrite; the back-link lives in the repository, which it
 *   cannot write before this grant. Without it, a rewritten `.git` file would
 *   open any folder on disk. Granted then: the repository's common git
 *   directory (objects, refs, and this worktree's own folder inside it) and,
 *   when it is a `.git` folder, the main checkout around it — integrating a
 *   branch fast-forwards that checkout, as the codex sandbox already allows
 *   (`backends/provider-git.ts`).
 *
 * A submodule's `.git` file has no back-link (`core.worktree` replaces it):
 * it is refused, and a commit inside a submodule fails under the fence.
 */
export function worktreeGitDirs(cwd: string, home: string, fs: GitDirsFs = GIT_DIRS_FS): MissionGitDirs {
  // Real paths on both sides: the repository is resolved through links, so a
  // home (or a working directory) reached through one would otherwise never
  // compare equal to it, and a dotfiles repository would slip past the guard.
  // git itself walks up from the real working directory.
  const start = fs.realpath(cwd) ?? resolve(cwd);
  const homeDir = fs.realpath(home) ?? resolve(home);
  for (let dir = start; ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git');
    const kind = fs.kind(dotGit);
    if (kind === 'dir') {
      if (dir === start) return { dirs: [], refused: null };
      if (within(dir, homeDir)) return { dirs: [], refused: `the repository at ${dir} holds the home folder` };
      return { dirs: [dotGit], refused: null };
    }
    if (kind === 'file') return linkedWorktreeGitDirs(dotGit, homeDir, fs);
    if (dirname(dir) === dir) return { dirs: [], refused: null };
  }
}

function linkedWorktreeGitDirs(dotGit: string, homeDir: string, fs: GitDirsFs): MissionGitDirs {
  const refuse = (why: string): MissionGitDirs => ({ dirs: [], refused: `${dotGit}: ${why}` });
  const named = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(fs.read(dotGit) ?? '')?.[1];
  if (!named) return refuse('not a worktree link');
  const gitDir = fs.realpath(resolve(dirname(dotGit), named));
  if (!gitDir) return refuse('the git directory it names does not exist');
  const back = fs.read(join(gitDir, 'gitdir'))?.trim();
  const self = fs.realpath(dotGit);
  if (!back || !self || fs.realpath(resolve(gitDir, back)) !== self) {
    return refuse('the git directory it names does not name this worktree back');
  }
  const common = fs.read(join(gitDir, 'commondir'))?.trim();
  const commonDir = common ? fs.realpath(resolve(gitDir, common)) : gitDir;
  if (!commonDir) return refuse('the common git directory does not exist');
  // A linked worktree's own folder lives in `<common>/worktrees/<name>`.
  if (common && !within(join(commonDir, 'worktrees'), gitDir)) return refuse('its git directory is not one of the repository\'s worktrees');
  const main = basename(commonDir) === '.git' ? dirname(commonDir) : null;
  if (within(main ?? commonDir, homeDir)) return refuse(`the repository at ${main ?? commonDir} holds the home folder`);
  return { dirs: main ? [commonDir, main] : [commonDir], refused: null };
}

/** Role ids (`config.role`, never the agent's name) whose missions integrate the project's work. */
const INTEGRATING_ROLES: ReadonlySet<string> = new Set(['orchestrator', 'merger']);

/**
 * Whether a mission integrates its project's work and so reaches the worktrees
 * of the project's tasks and the repository's git directory: its agent's role
 * is lead (`orchestrator`) or `merger`, or it runs a `merge` task. Read from
 * the role field and the task row, never from a name: an agent called
 * "merge-helper" with another role gets nothing.
 */
export function integratesProject(role: string | null | undefined, taskType: string | null | undefined): boolean {
  return taskType === 'merge' || (typeof role === 'string' && INTEGRATING_ROLES.has(role));
}

/**
 * The common git directory of the repository at `repoCwd` (objects, refs,
 * `worktrees/<id>`, config), and nothing around it: `git push`, `fetch`,
 * `merge` and `update-ref` need no more. A repository holding the home folder
 * is a dotfiles repository, not a project.
 */
export function projectCommonGitDir(repoCwd: string, home: string, fs: GitDirsFs = GIT_DIRS_FS): { dir: string | null; refused: string | null } {
  const start = fs.realpath(repoCwd) ?? resolve(repoCwd);
  const homeDir = fs.realpath(home) ?? resolve(home);
  for (let dir = start; ; dir = dirname(dir)) {
    const dotGit = join(dir, '.git');
    const kind = fs.kind(dotGit);
    if (kind === 'dir') {
      if (within(dir, homeDir)) return { dir: null, refused: `the repository at ${dir} holds the home folder` };
      return { dir: dotGit, refused: null };
    }
    if (kind === 'file') {
      const linked = linkedWorktreeGitDirs(dotGit, homeDir, fs);
      return { dir: linked.dirs[0] ?? null, refused: linked.refused };
    }
    if (dirname(dir) === dir) return { dir: null, refused: null };
  }
}

export type LeadFenceGrants = { worktrees: string[]; gitDirs: string[]; refused: string[] };

/**
 * What the fence of an integrating mission opens beyond its own folders: the
 * worktrees of its project's tasks that exist at launch, and the project
 * repository's common git directory. Landlock takes no rule after the process
 * starts, so a worktree made later is covered from the next launch (every
 * turn of a one-shot CLI, the next mission otherwise): the limit is documented
 * in Mission isolation. Only paths directly below `<timonHome>/worktrees` and
 * existing as folders count; another project's folders are never listed.
 */
export function leadFenceGrants(input: {
  role: string | null | undefined;
  taskType: string | null | undefined;
  project: string;
  timonHome: string;
  home: string;
  repoCwd: string | null | undefined;
  /** Worktree paths recorded on the project's tasks. */
  taskWorktrees: readonly string[];
  fs?: GitDirsFs;
}): LeadFenceGrants {
  const none: LeadFenceGrants = { worktrees: [], gitDirs: [], refused: [] };
  if (!input.project || !integratesProject(input.role, input.taskType)) return none;
  const fs = input.fs ?? GIT_DIRS_FS;
  const root = join(resolve(input.timonHome), 'worktrees');
  const worktrees = new Set<string>();
  for (const raw of input.taskWorktrees) {
    const path = resolve(raw);
    if (dirname(path) !== root || fs.kind(path) !== 'dir') continue;
    worktrees.add(path);
  }
  const refused: string[] = [];
  const gitDirs: string[] = [];
  if (input.repoCwd) {
    const found = projectCommonGitDir(input.repoCwd, input.home, fs);
    if (found.dir) gitDirs.push(found.dir);
    if (found.refused) refused.push(found.refused);
  }
  return { worktrees: [...worktrees], gitDirs, refused };
}

/**
 * The plugin packages an MCP server's command line runs from: every absolute
 * path among `paths` under `<timonHome>/plugins/node_modules/`, cut to its
 * package folder (`<name>` or `@scope/name`). `resolveFence` grants each one
 * readable and executable, and nothing else of the plugins folder.
 */
export function pluginPackageDirs(paths: readonly string[], timonHome: string): string[] {
  const modules = join(timonHome, 'plugins', 'node_modules');
  const out = new Set<string>();
  for (const path of paths) {
    if (!isAbsolute(path)) continue;
    const rel = relative(modules, resolve(path));
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    const [first, second] = rel.split(sep);
    if (!first) continue;
    if (first.startsWith('@')) {
      if (second) out.add(join(modules, first, second));
    } else {
      out.add(join(modules, first));
    }
  }
  return [...out];
}

/** A folder with no mission row (an aborted launch) may still serve a CLI: it waits this long. */
const UNKNOWN_MISSION_TMP_GRACE_MS = 24 * 60 * 60 * 1000;

/**
 * Removes the temporary folders (`tmp/missions/<id>`, the `TMPDIR` of a fenced
 * mission) of missions that are over. Temporary files serve one run: unlike a
 * session store, nothing in them is needed to resume, so a mission over is
 * enough, without a retention. A running mission — a resumed one included —
 * is never touched; a folder with no mission row falls back on its own date.
 */
export function purgeMissionTmpDirs(
  timonHome: string,
  lifetimeOf: (missionId: string) => { live: boolean } | null,
  now: number = Date.now(),
): string[] {
  const root = join(timonHome, 'tmp', 'missions');
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    const dir = join(root, name);
    try {
      const stat = statSync(dir);
      if (!stat.isDirectory()) continue;
      const life = lifetimeOf(name);
      if (life?.live) continue;
      if (!life && now - stat.mtimeMs < UNKNOWN_MISSION_TMP_GRACE_MS) continue;
      rmSync(dir, { recursive: true, force: true });
      removed.push(name);
    } catch (error) {
      console.warn(`[fence] could not remove the temporary folder ${dir}: ${(error as Error).message}`);
    }
  }
  return removed;
}

/**
 * Removes an agent's package cache (`agentPackageCacheDir`): with the agent,
 * whatever becomes of its folder (trash or not), and on a rename. A cache is
 * fetched again on demand; kept, it would hand an agent created later under
 * the same name packages the old one's missions wrote. Best effort.
 */
export function removeAgentPackageCache(timonHome: string, agent: string): void {
  if (!isFenceAgent(agent)) return;
  const dir = agentPackageCacheDir(timonHome, agent);
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch (error) {
    console.warn(`[fence] could not remove the package cache ${dir}: ${(error as Error).message}`);
  }
}

/**
 * Removes the package caches of agents that no longer exist: an agent folder
 * removed by hand, or a removal that failed. A cache is only kept while
 * `agentExists` says its agent is there.
 */
export function purgeOrphanAgentPackageCaches(timonHome: string, agentExists: (agent: string) => boolean): string[] {
  const root = dirname(agentPackageCacheDir(timonHome, 'x'));
  let names: string[];
  try {
    names = readdirSync(root);
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const name of names) {
    if (agentExists(name)) continue;
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      removed.push(name);
    } catch (error) {
      console.warn(`[fence] could not remove the package cache of ${name}: ${(error as Error).message}`);
    }
  }
  return removed;
}
