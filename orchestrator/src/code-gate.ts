import { existsSync } from 'node:fs';
import { getHost } from './host/index.js';
import type { TaskRow } from './db.js';

/** Null distinguishes an unavailable inspection from an empty branch. */
export type GitInspection = {
  commitCount: number | null;
  uncommittedFiles: string[];
  mergedIntoBase?: boolean | null;
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
      return `⚠️ [code-gate] Declared merged_sha ${task.merged_commit_sha} is missing or is not contained in base ${task.base_branch}.`;
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
function safeBranch(name: string): boolean {
  if (!/^[\w./-]{1,200}$/.test(name) || name.includes('..')) return false;
  return name.split('/').every((part) => part.length > 0 && !part.startsWith('-') && !part.startsWith('.'));
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
  if (!safeBranch(baseBranch)) return null;
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
    if (pipeline === 'code-self') {
      if (!mergedSha) return unknown;
      // A pull request merges on the forge. Local `main` does not move, so it
      // is not the base this gate checks. `origin/<base>` is, after a fetch
      // when that remote exists. A commit this clone still does not have after
      // that fetch, or when no remote is configured, is not a merge. It stays
      // unknown only when the fetch failed: the sha may exist only on the forge.
      const mergedIntoBase = integration === 'pull-request'
        ? mergedOnOrigin(git, baseBranch, mergedSha)
        : mergedOnLocalBase(git, baseBranch, mergedSha);
      return { ...unknown, mergedIntoBase };
    }
    const rev = git(['rev-list', '--count', 'HEAD', `^${baseBranch}`]);
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
