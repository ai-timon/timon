/**
 * Worktree manager — management of the git worktrees created by TIMON for the
 * `type=code` tasks (and their review/merge descendants, which inherit the
 * same worktree through the deps).
 *
 * Convention:
 *   - Root: ~/.timon/worktrees/
 *   - One worktree per task: ~/.timon/worktrees/<task-id>/
 *   - Branch: timon/task/<task-id>
 *   - Source branch: HEAD of the agent's repo at creation time
 *     (unless explicitly overridden through the 3rd arg of createWorktree).
 *
 * Lifecycle:
 *   1. The dispatcher detects task.type='code' without worktree_path → createWorktree
 *   2. The builder commits in the branch
 *   3. The reviewer reads it (always in the same worktree, shared through deps)
 *   4. The merger merges the branch into the base + gets the sha → setTaskMergedSha
 *   5. The merger calls disposeWorktree → the local branch is deleted,
 *      the worktree dir is unmounted. The DB events and the sha remain the audit.
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { TIMON_HOME } from './paths.js';
import { execFileHost, linkDirectory } from './host/index.js';
import { purgeShell } from './worktree-shell.js';

const exec = execFileHost;

// Derived from TIMON_HOME and not from a hard-coded homedir(): an instance launched with a
// test TIMON_HOME otherwise scanned the REAL worktrees, which its garbage collector
// saw as all orphaned (empty database) and deleted — worktree and branch.
export const WORKTREES_ROOT = join(TIMON_HOME, 'worktrees');

export type WorktreeInfo = {
  taskId: string;
  path: string;
  branch: string;
  base: string;
  sourceRepo: string;
};

/** Share installed dependencies for tracked packages, without installing or replacing anything. */
export async function prepareWorktreeDependencies(repoCwd: string, worktreePath: string): Promise<void> {
  try {
    const root = realpathSync(worktreePath);
    const { stdout } = await exec('git', [
      '-C', worktreePath, 'ls-files', '-z', '--', 'package.json', '**/package.json',
    ], { timeout: 10_000 });
    for (const manifest of new Set(stdout.split('\0').filter(Boolean))) {
      const packageDir = dirname(manifest);
      const source = join(repoCwd, packageDir, 'node_modules');
      const parent = join(worktreePath, packageDir);
      const destination = join(parent, 'node_modules');
      try {
        if (!existsSync(source) || !statSync(source).isDirectory() || !existsSync(parent)) continue;
        // A tracked package path must not redirect writes outside this worktree.
        const inside = relative(root, realpathSync(parent));
        if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) continue;
        // lstat also preserves dangling links and package-specific installations.
        if (lstatSync(destination, { throwIfNoEntry: false })) continue;
        // Only ignored paths can be shared without dirtying the worktree.
        try {
          await exec('git', ['-C', worktreePath, 'check-ignore', '-q', '--', join(packageDir, 'node_modules')], { timeout: 10_000 });
        } catch {
          console.warn(`[worktree] dependencies not shared for ${packageDir}: node_modules is not git-ignored`);
          continue;
        }
        linkDirectory(source, destination);
      } catch (error) {
        console.warn(`[worktree] Could not link dependencies for ${manifest}: ${(error as Error).message}`);
      }
    }
    await linkDeclaredFolders(repoCwd, worktreePath, root);
  } catch (error) {
    console.warn(`[worktree] Could not prepare dependencies: ${(error as Error).message}`);
  }
}

/** Tracked file at a repository's root listing the ignored folders a task worktree shares with the main clone. */
export const WORKTREE_LINKS_FILE = '.worktreelinks';

/**
 * Relative folder paths read from a `.worktreelinks` file: one per line, `#`
 * starts a comment. Absolute paths and paths that climb out of the repository
 * are dropped, since a link there would let a task write outside its project.
 */
export function parseWorktreeLinks(text: string): string[] {
  const paths: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim().replace(/[\\/]+$/, '');
    if (!line || isAbsolute(line) || /^[A-Za-z]:/.test(line)) continue;
    const parts = line.split(/[\\/]+/);
    if (parts.some((part) => part === '..' || part === '.' || part === '')) continue;
    paths.push(join(...parts));
  }
  return [...new Set(paths)];
}

/**
 * Links the folders a repository declares in `.worktreelinks` (an ignored
 * notes repository, local fixtures…) from the main clone into a task worktree,
 * under the same guards as the dependencies: the folder exists in the main
 * clone, git ignores it, the worktree has nothing at that path yet, and the
 * link stays inside the worktree. Removing the worktree unlinks it without
 * touching the folder it points to.
 */
async function linkDeclaredFolders(repoCwd: string, worktreePath: string, root: string): Promise<void> {
  let text: string;
  try { text = readFileSync(join(worktreePath, WORKTREE_LINKS_FILE), 'utf8'); } catch { return; }
  for (const rel of parseWorktreeLinks(text)) {
    const source = join(repoCwd, rel);
    const destination = join(worktreePath, rel);
    try {
      if (!existsSync(source) || !statSync(source).isDirectory()) continue;
      const parent = dirname(destination);
      if (!existsSync(parent)) continue;
      const inside = relative(root, realpathSync(parent));
      if (isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) continue;
      if (lstatSync(destination, { throwIfNoEntry: false })) continue;
      try {
        // Checked as git will see the link: a file. A directory-only rule (`/docs/`) does not
        // cover a symlink, which would then show as untracked and be committed by a `git add -A`.
        await exec('git', ['-C', worktreePath, 'check-ignore', '-q', '--', rel], { timeout: 10_000 });
      } catch {
        console.warn(`[worktree] ${rel} not linked: ${WORKTREE_LINKS_FILE} lists it but git does not ignore it as a file (write \`/${rel.split(sep).join('/')}\`, without a trailing slash)`);
        continue;
      }
      linkDirectory(source, destination);
    } catch (error) {
      console.warn(`[worktree] Could not link ${rel}: ${(error as Error).message}`);
    }
  }
}

/** True if `cwd` is inside a git working tree. */
export async function isGitRepo(cwd: string): Promise<boolean> {
  if (!existsSync(cwd)) return false;
  try {
    const r = await exec('git', ['-C', cwd, 'rev-parse', '--is-inside-work-tree'], { timeout: 2000 });
    return r.stdout.trim() === 'true';
  } catch {
    return false;
  }
}

/** Current branch (HEAD) of a repo. Null if detached or on error. */
export async function currentBranch(cwd: string): Promise<string | null> {
  try {
    const r = await exec('git', ['-C', cwd, 'branch', '--show-current'], { timeout: 2000 });
    const out = r.stdout.trim();
    return out || null;
  } catch {
    return null;
  }
}

/** Does the branch exist in this repo? */
async function branchExists(cwd: string, branch: string): Promise<boolean> {
  try {
    await exec('git', ['-C', cwd, 'rev-parse', '--verify', branch], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

/** Sha of the current HEAD. Null if not a repo. */
export async function headSha(cwd: string): Promise<string | null> {
  try {
    const r = await exec('git', ['-C', cwd, 'rev-parse', 'HEAD'], { timeout: 2000 });
    return r.stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Creates a worktree for a task. Idempotent: if a worktree for this
 * `taskId` already exists on disk, returns its info without recreating it.
 *
 * `repoCwd` must point to the main repo (typically the agent's cfg.cwd).
 * `git worktree add` runs there; the worktree lands
 * in WORKTREES_ROOT/<taskId>.
 */
export async function createWorktree(
  taskId: string,
  repoCwd: string,
  base?: string,
  branchName?: string,
): Promise<WorktreeInfo> {
  if (!(await isGitRepo(repoCwd))) {
    throw new Error(`createWorktree: ${repoCwd} is not a git repo`);
  }
  const path = join(WORKTREES_ROOT, taskId);
  // `branchName` serves the merger, which receives its OWN worktree (`timon/merge/…`)
  // instead of operating in the main repo — see `refreshWorktreeBase`
  // and the incident of 2026-08-20.
  const branch = branchName ?? `timon/task/${taskId}`;
  // If the dir already exists AND is a valid worktree, we assume we
  // are in a re-spawn: idempotent return.
  if (existsSync(path) && (await isGitRepo(path))) {
    const existingBase = base ?? (await currentBranch(repoCwd)) ?? 'HEAD';
    await prepareWorktreeDependencies(repoCwd, path);
    return { taskId, path, branch, base: existingBase, sourceRepo: repoCwd };
  }
  mkdirSync(WORKTREES_ROOT, { recursive: true });
  const baseRef = base ?? (await currentBranch(repoCwd)) ?? 'HEAD';
  // The branch outlives the folder: an unmounted worktree (dispose, GC, manual
  // purge) leaves its commits behind. Recreating it with -b would fail
  // and, worse, we would restart from the base, losing sight of that work — so we
  // reattach to the existing branch rather than forge a new one.
  const addArgs = (await branchExists(repoCwd, branch))
    ? ['worktree', 'add', path, branch]
    : ['worktree', 'add', '-b', branch, path, baseRef];
  await exec('git', ['-C', repoCwd, ...addArgs], { timeout: 30_000 });
  await prepareWorktreeDependencies(repoCwd, path);
  return { taskId, path, branch, base: baseRef, sourceRepo: repoCwd };
}

/**
 * Messages of the merge commits Timon creates or prescribes. Git's default
 * (`Merge branch 'timon/task/<uuid>' into …`) carries a task id: a public
 * repository's `commit-msg` hook refuses it, which leaves the merge unfinished,
 * and a merge that does land puts internal ids into the public history. Every
 * merge of a task chain therefore names its base only, in English.
 */
export function refreshMergeMessage(base: string): string {
  return `merge: bring ${base} into the task branch`;
}

export function integrateMergeMessage(base: string): string {
  return `merge: integrate the task branch into ${base}`;
}

/** What an attempt to bring a worktree up to date with its base gave. */
export type RefreshOutcome =
  /** The branch already contained the whole base — nothing moved. */
  | { status: 'up-to-date' }
  /** The base was integrated cleanly into the branch. */
  | { status: 'merged'; base: string }
  /** Conflicts: the merge is left AS IS in the worktree, for the agent to
   *  settle. It is not aborted — an agent coding on a stale base
   *  produces work that will overwrite the others' at the final merge. */
  | { status: 'conflict'; base: string; files: string[] }
  /** Operation impossible (worktree missing, unknown base, merge commit refused
   *  by a hook). Not fatal: the caller carries on with the base as it is, and
   *  any half-done merge is aborted so the agent does not start inside it. */
  | { status: 'failed'; reason: string };

/**
 * Brings an existing worktree up to date with its base.
 *
 * WHY: a worktree is created at the FIRST spawn of its task and reused as
 * is afterwards (re-queue, iterations `[iter:2]`, `[iter:3]`). A task that
 * iterates for three hours therefore still codes on the `main` of three hours ago, and
 * its final merge reintroduces that old state — that is the mechanism of the
 * regressions observed on 2026-08-20.
 *
 * We MERGE the base into the branch rather than rebasing: a rebase rewrites
 * commits the reviewer may already have read and quoted by sha, and it
 * multiplies the conflict points (one per commit). The merge creates a single one,
 * and the history stays true.
 *
 * Conflicts are not an error: they are left in the worktree and
 * reported to the caller, which tells the agent. It is exactly the work
 * expected of it, and hiding it would be worse.
 */
export async function refreshWorktreeBase(
  worktreePath: string,
  base: string,
): Promise<RefreshOutcome> {
  if (!existsSync(worktreePath) || !(await isGitRepo(worktreePath))) {
    return { status: 'failed', reason: `worktree missing or invalid: ${worktreePath}` };
  }
  try {
    // Already up to date: the base is an ancestor of HEAD. A cheap test that avoids
    // creating an empty merge commit on every re-spawn.
    await exec('git', ['-C', worktreePath, 'merge-base', '--is-ancestor', base, 'HEAD'], {
      timeout: 10_000,
    });
    return { status: 'up-to-date' };
  } catch {
    /* not an ancestor → there is indeed something to integrate */
  }
  try {
    await exec(
      'git',
      ['-C', worktreePath, 'merge', '--no-edit', '-m', refreshMergeMessage(base), base],
      { timeout: 120_000 },
    );
    return { status: 'merged', base };
  } catch (err) {
    // A failing merge leaves the index in a conflicted state. The files
    // concerned are listed so that the agent knows where to look without fumbling.
    let files: string[] = [];
    try {
      const r = await exec(
        'git',
        ['-C', worktreePath, 'diff', '--name-only', '--diff-filter=U'],
        { timeout: 10_000 },
      );
      files = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    } catch { /* list unavailable: the conflict is reported without detail */ }
    if (files.length === 0) {
      // No conflict, yet no merge commit: typically a `commit-msg` hook that
      // refused the message. Git then leaves the merge pending (MERGE_HEAD),
      // and the agent's first `git commit` would silently become that merge.
      // Abort it so the task starts on its base as is, and say why.
      await abortPendingMerge(worktreePath);
      return { status: 'failed', reason: mergeFailureReason(err) };
    }
    return { status: 'conflict', base, files };
  }
}

/** The tail of git's output, where a hook or git itself says why it refused. */
function mergeFailureReason(err: unknown): string {
  const e = err as Error & { stderr?: string; stdout?: string };
  const detail = [e.stderr, e.stdout].map((t) => (t ?? '').trim()).filter(Boolean).join('\n');
  return (detail || e.message || 'git merge failed').slice(-600);
}

async function abortPendingMerge(worktreePath: string): Promise<void> {
  try {
    await exec('git', ['-C', worktreePath, 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], { timeout: 10_000 });
  } catch {
    return; // no merge in progress
  }
  try {
    await exec('git', ['-C', worktreePath, 'merge', '--abort'], { timeout: 30_000 });
  } catch (err) {
    console.warn(`[worktree] could not abort the pending merge in ${worktreePath}: ${(err as Error).message}`);
  }
}

/**
 * Removes a task's worktree folder and KEEPS its branch: its commits stay, and
 * the next dispatch reattaches to it (`createWorktree`). Run from the worktree
 * itself, so it needs neither the agent's cwd nor the source repo (TIM-0113: a
 * task moved to an agent without a folder). No `--force`: git refuses a
 * worktree with uncommitted changes, which is work this gesture must not lose.
 */
export async function releaseWorktreeFolder(path: string): Promise<void> {
  await exec('git', ['-C', path, 'worktree', 'remove', path], { timeout: 15_000 });
  purgeShell(WORKTREES_ROOT, path, 0, Date.now());
}

/**
 * Unmounts a worktree and deletes its local branch. Called by the merger
 * agent after a successful merge (or manually through `timon worktree dispose`
 * on abandon). The trace of the session stays in events + the possible
 * Codex rollouts — that is on purpose.
 *
 * `force = true` ignores the `worktree remove` errors (case of a dirty
 * or already partly deleted worktree).
 */
export async function disposeWorktree(
  info: WorktreeInfo,
  force = false,
): Promise<void> {
  // Worktree remove
  try {
    const args = ['-C', info.sourceRepo, 'worktree', 'remove'];
    if (force) args.push('--force');
    args.push(info.path);
    await exec('git', args, { timeout: 15_000 });
  } catch (err) {
    if (!force) throw err;
  }
  // Branch -D (forced, it was already merged if we get here).
  try {
    await exec('git', ['-C', info.sourceRepo, 'branch', '-D', info.branch], { timeout: 5_000 });
  } catch {
    /* branch already deleted or conflict — no big deal, the merge sha is in the DB */
  }
  // Every removal path goes through here, so the shell is purged at the
  // source. No grace: git has just let go of this folder. A failed remove
  // leaves its `.git`, which purgeShell refuses to touch.
  purgeShell(WORKTREES_ROOT, info.path, 0, Date.now());
}
