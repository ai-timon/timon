import { existsSync } from 'node:fs';
import { getHost } from './host/index.js';
import type { TaskRow } from './db.js';

/** Null distinguishes an unavailable inspection from an empty branch. */
export type GitInspection = {
  commitCount: number | null;
  uncommittedFiles: string[];
  mergedIntoBase?: boolean | null;
  /** Branch the pull-request gate tested (`baseRefName`, or the task base). */
  checkedBase?: string;
};

type CodeTask = Pick<TaskRow, 'type' | 'branch_name' | 'worktree_path' | 'base_branch'
  | 'pipeline' | 'merged_commit_sha'>;

export function evaluateCodeDone(
  task: CodeTask,
  git: GitInspection,
): string | null {
  if (task.type !== 'code' || !task.branch_name) return null;

  // Only code-self closes after integration; code-group awaits a separate merge.
  if (task.pipeline === 'code-self') {
    if (!task.merged_commit_sha) {
      return `⚠️ [code-gate] No merged_sha declared for ${task.pipeline} task ${task.branch_name}.`;
    }
    if (git.mergedIntoBase === false) {
      const baseName = git.checkedBase || task.base_branch;
      return `⚠️ [code-gate] Declared merged_sha ${task.merged_commit_sha} is missing or is not contained in base ${baseName}.`;
    }
    // An unavailable repository must not be reported as a failed merge.
    return null;
  }
  // Marked merged outside the chain: the route checked the sha, and the branch
  // contained in its base has no commits beyond it by definition.
  if (task.merged_commit_sha) return null;
  if (git.commitCount === null || git.commitCount > 0) return null;

  const parts: string[] = [
    `⚠️ [code-gate] Branch ${task.branch_name} has NO commits beyond its base.`,
  ];
  if (git.uncommittedFiles.length > 0) {
    parts.push(
      `Uncommitted files in the worktree (${git.uncommittedFiles.length}):`,
      ...git.uncommittedFiles.map((f) => `  - ${f}`),
      `To recover the work: cd ${task.worktree_path ?? '<missing worktree_path>'} && git add -A && git commit -m "<message>" then push the branch`,
    );
  }
  return parts.join('\n');
}

/** Git failures remain unknown, rather than claiming that work was lost.
 *  A branch name that can be a refspec: no options, no second remote, no `..`. */
export function isGitBranchName(name: string): boolean {
  if (!/^[\w./-]{1,200}$/.test(name) || name.includes('..')) return false;
  return name.split('/').every((part) => part.length > 0 && !part.startsWith('-') && !part.startsWith('.'));
}

/**
 * Destination of the pull request that was merged, from `gh pr view --json
 * baseRefName`. `origin/<name>` is the same branch: the gate already fetches
 * `origin/<name>`, so a second `origin/` would look up a ref that does not
 * exist and skip the check. An unusable name is `null`.
 */
export function normalizeMergeBase(name: string): string | null {
  const trimmed = name.trim();
  const bare = trimmed.startsWith('origin/') ? trimmed.slice('origin/'.length) : trimmed;
  return bare && isGitBranchName(bare) ? bare : null;
}

/** Close-body field. Absent is `null`. A present but unusable name is a 400. */
export function parseMergeBase(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'merged_base must be a branch name' };
  if (!raw.trim()) return { ok: true, value: null };
  const name = normalizeMergeBase(raw);
  if (!name) return { ok: false, error: 'merged_base must be a branch name' };
  return { ok: true, value: name };
}

type GitCallOpts = { timeout?: number; env?: NodeJS.ProcessEnv };
type GitRun = (args: string[], timeoutOrOpts?: number | GitCallOpts) => { code: number; stdout: string };

/** Local ancestry. An unknown commit is a failed merge: code-self integrated here. */
function mergedOnLocalBase(git: GitRun, baseBranch: string, mergedSha: string): boolean | null {
  const base = git(['rev-parse', '--verify', '--end-of-options', `${baseBranch}^{commit}`]);
  if (base.code !== 0) return null;
  if (!/^[0-9a-f]{7,40}$/i.test(mergedSha)) return false;
  const commit = git(['rev-parse', '--verify', '--end-of-options', `${mergedSha}^{commit}`]);
  if (commit.code !== 0) return false;
  const ancestor = git(['merge-base', '--is-ancestor', commit.stdout.trim(), base.stdout.trim()]);
  return ancestor.code === 0 ? true : ancestor.code === 1 ? false : null;
}

/**
 * Ancestry against `origin/<base>`, not the local branch. Fetch when the
 * remote exists. A commit this clone does not have is not a merge once that
 * fetch succeeded, or when no remote is configured: an invented sha must not
 * close the task. It stays unknown only when the fetch itself failed.
 */
function mergedOnOrigin(git: GitRun, baseBranch: string, mergedSha: string): boolean | null {
  if (!/^[0-9a-f]{7,40}$/i.test(mergedSha)) return false;
  if (!isGitBranchName(baseBranch)) return null;
  const remoteUrl = git(['config', '--get', 'remote.origin.url']);
  const remoteConfigured = remoteUrl.code === 0 && remoteUrl.stdout.trim().length > 0;
  // No remote: the remote-tracking ref already in the clone is the evidence.
  // A configured remote that we could not refresh is not evidence against the sha.
  let refreshed = !remoteConfigured;
  if (remoteConfigured) {
    const fetched = git([
      'fetch', '--no-tags', '--', 'origin', `${baseBranch}:refs/remotes/origin/${baseBranch}`,
    ], {
      timeout: 10_000,
      // No terminal behind the daemon: git must fail rather than wait for a password.
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    });
    refreshed = fetched.code === 0;
  }
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  const base = git(['rev-parse', '--verify', '--end-of-options', `${remoteRef}^{commit}`]);
  const commit = git(['rev-parse', '--verify', '--end-of-options', `${mergedSha}^{commit}`]);
  // Unknown commit: false when we could look, null only when the fetch failed.
  if (commit.code !== 0) return refreshed ? false : null;
  if (base.code !== 0) return refreshed ? false : null;
  const ancestor = git(['merge-base', '--is-ancestor', commit.stdout.trim(), base.stdout.trim()]);
  if (ancestor.code === 0) return true;
  // Both objects are in this clone, so ancestry is known. A failed fetch must
  // not turn a side commit into "unknown" and let the task close.
  if (ancestor.code !== 1) return null;
  return false;
}

export function inspectGitBranch(
  worktreePath: string | null,
  branchName: string | null,
  baseBranch: string | null,
  pipeline: TaskRow['pipeline'] = null,
  mergedSha: string | null = null,
  integration: 'local' | 'pull-request' = 'local',
  /** Ref stored on the task (`origin/<base>` or `<base>`). The local branch name is the fallback. */
  compareRef: string | null = null,
  /**
   * Destination of the pull request merged at close (`baseRefName`). A stacked
   * pull request lands there, not on `origin/<task.base_branch>`. Absent keeps
   * the task base. Not stored: `base_ref` stays the worktree pin.
   */
  mergeBase: string | null = null,
): GitInspection {
  const unknown: GitInspection = { commitCount: null, uncommittedFiles: [], mergedIntoBase: null };
  if (!worktreePath || !branchName || !baseBranch) return unknown;

  try {
    const host = getHost();
    // Arguments never pass through a shell; refs cannot execute commands.
    const git: GitRun = (args, timeoutOrOpts = 5_000) => {
      const opts = typeof timeoutOrOpts === 'number' ? { timeout: timeoutOrOpts } : timeoutOrOpts;
      return host.exec('git', args, {
        cwd: worktreePath,
        timeout: opts.timeout ?? 5_000,
        stdio: ['ignore', 'pipe', 'ignore'],
        ...(opts.env ? { env: opts.env } : {}),
      });
    };
    // `origin/<base>` when the task stored one. Passing that ref to `mergedOnOrigin`
    // would fetch `origin/origin/<base>`, so the forge check still takes the branch name.
    const counted = compareRef || baseBranch;
    if (pipeline === 'code-self') {
      if (!mergedSha) return unknown;
      // A pull request merges on the forge. Local `main` does not move, so it
      // is not the base this gate checks. The close may name the pull request's
      // destination (`baseRefName`): a stacked pull request lands there, not on
      // `origin/<task base>`. An unusable name falls back to the task base.
      // A commit this clone still does not have after the fetch, or when no
      // remote is configured, is not a merge. It stays unknown only when the
      // fetch failed: the sha may exist only on the forge.
      const named = mergeBase ? normalizeMergeBase(mergeBase) : null;
      const destination = integration === 'pull-request' && named ? named : baseBranch;
      const mergedIntoBase = integration === 'pull-request'
        ? mergedOnOrigin(git, destination, mergedSha)
        : mergedOnLocalBase(git, counted, mergedSha);
      return {
        ...unknown,
        mergedIntoBase,
        ...(integration === 'pull-request' ? { checkedBase: destination } : {}),
      };
    }
    const rev = git(['rev-list', '--count', 'HEAD', `^${counted}`]);
    if (rev.code !== 0) return unknown;
    const raw = rev.stdout.trim();
    const parsed = Number(raw);
    const commitCount = raw && Number.isInteger(parsed) ? parsed : null;
    const status = git(['status', '--porcelain']);
    if (status.code !== 0) return unknown;
    const statusOut = status.stdout.trim();
    const uncommittedFiles = statusOut ? statusOut.split('\n').filter((l) => l.length > 0) : [];
    return { commitCount, uncommittedFiles };
  } catch {
    return unknown;
  }
}

/**
 * Whether `sha` is in `baseBranch` of the repository at `repoPath` (TIM-0109,
 * marking a task merged by hand). `unknown` covers a commit this clone has not
 * fetched yet — a PR merged on GitHub usually is — and any git failure: only
 * a commit git knows and places outside the base is `not_contained`.
 */
export function shaInBase(
  repoPath: string | null,
  baseBranch: string | null,
  sha: string,
): 'contained' | 'not_contained' | 'unknown' {
  if (!repoPath || !baseBranch || !existsSync(repoPath) || !/^[0-9a-f]{7,40}$/i.test(sha)) return 'unknown';
  try {
    const git = (args: string[]) => getHost().exec('git', args, {
      cwd: repoPath,
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const base = git(['rev-parse', '--verify', '--end-of-options', `${baseBranch}^{commit}`]);
    const commit = git(['rev-parse', '--verify', '--end-of-options', `${sha}^{commit}`]);
    if (base.code !== 0 || commit.code !== 0) return 'unknown';
    const ancestor = git(['merge-base', '--is-ancestor', commit.stdout.trim(), base.stdout.trim()]);
    return ancestor.code === 0 ? 'contained' : ancestor.code === 1 ? 'not_contained' : 'unknown';
  } catch {
    return 'unknown';
  }
}
