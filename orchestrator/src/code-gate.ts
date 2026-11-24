import { existsSync } from 'node:fs';
import { getHost } from './host/index.js';
import { loadConfig } from './agent-config.js';
import { integrationOfTask } from './chain-landing.js';
import { localTargetOf } from './git-integration.js';
import { db, dbApi, isCodeOnlyPipeline, type TaskRow } from './db.js';

/** Null distinguishes an unavailable inspection from an empty branch. */
export type GitInspection = {
  commitCount: number | null;
  uncommittedFiles: string[];
  mergedIntoBase?: boolean | null;
  /** Own commits of a branch whose head the base already contains (see `branchWork`). */
  integratedCommits?: number | null;
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
  // The coder merged the branch into its base: its work exists, and the review
  // reads it from where the branch started (TODO #1012).
  const parts: string[] = [git.integratedCommits
    ? `ℹ️ [code-gate] Branch ${task.branch_name} is already contained in ${task.base_branch}: `
      + `its ${git.integratedCommits} own commit(s) are reviewed from where the branch started.`
    : `⚠️ [code-gate] Branch ${task.branch_name} has NO commits beyond its base.`];
  if (git.uncommittedFiles.length > 0) {
    parts.push(
      `Uncommitted files in the worktree (${git.uncommittedFiles.length}):`,
      ...git.uncommittedFiles.map((f) => `  - ${f}`),
      `To recover the work: cd ${task.worktree_path ?? '<missing worktree_path>'} && git add -A && git commit -m "<message>" then push the branch`,
    );
  }
  return parts.join('\n');
}

/** Git failures remain unknown, rather than claiming that work was lost. */
export function inspectGitBranch(
  worktreePath: string | null,
  branchName: string | null,
  baseBranch: string | null,
  pipeline: TaskRow['pipeline'] = null,
  mergedSha: string | null = null,
): GitInspection {
  const unknown: GitInspection = { commitCount: null, uncommittedFiles: [], mergedIntoBase: null };
  if (!worktreePath || !branchName || !baseBranch) return unknown;

  try {
    const host = getHost();
    // Arguments never pass through a shell; refs cannot execute commands.
    const git = (args: string[]) => host.exec('git', args, {
      cwd: worktreePath,
      timeout: 5_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (pipeline === 'code-self') {
      if (!mergedSha) return unknown;
      const base = git(['rev-parse', '--verify', '--end-of-options', `${baseBranch}^{commit}`]);
      if (base.code !== 0) return unknown;
      if (!/^[0-9a-f]{7,40}$/i.test(mergedSha)) return { ...unknown, mergedIntoBase: false };
      const commit = git(['rev-parse', '--verify', '--end-of-options', `${mergedSha}^{commit}`]);
      if (commit.code !== 0) return { ...unknown, mergedIntoBase: false };
      const ancestor = git(['merge-base', '--is-ancestor', commit.stdout.trim(), base.stdout.trim()]);
      return { ...unknown, mergedIntoBase: ancestor.code === 0 ? true : ancestor.code === 1 ? false : null };
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
    if (commitCount !== 0) return { commitCount, uncommittedFiles };
    const work = branchWork(worktreePath, branchName);
    const integratedCommits = work?.start ? work.commits.length : null;
    return { commitCount, uncommittedFiles, integratedCommits };
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

type Git = (args: string[]) => { code: number; stdout: string };

function gitIn(repoPath: string): Git {
  return (args) => getHost().exec('git', args, {
    cwd: repoPath,
    timeout: 5_000,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
}

function resolveCommit(git: Git, ref: string): string | null {
  const r = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/** `null` when git cannot tell (exit code other than 0 or 1). */
function isAncestor(git: Git, ancestor: string, descendant: string): boolean | null {
  const r = git(['merge-base', '--is-ancestor', ancestor, descendant]);
  return r.code === 0 ? true : r.code === 1 ? false : null;
}

/** What the closing of a `merge` task could prove about the branches it integrates. */
export type MergeCloseVerdict = {
  /** Why DONE must be refused; null when nothing was disproved. */
  refusal: string | null;
  /** What git could not decide (missing branch, git failure): logged, never refused. */
  undecided: string[];
};

/**
 * Proves, before a `merge` task goes DONE, that every source branch it
 * integrates is contained in its base, and that the declared sha belongs to
 * the base and contains them (TODO #1012: three mergers closed on the sha of
 * the base's previous merge while the branch stayed outside it).
 *
 * Checking the merge task's own `timon/merge/<id>` branch would prove nothing:
 * it starts from the base, so it is "contained" even when the merger did no
 * work. The sources are the coders' branches.
 */
export function evaluateMergeClose(input: {
  repoPath: string | null;
  baseBranch: string | null;
  sourceBranches: readonly string[];
  sha: string | null;
}): MergeCloseVerdict {
  const { repoPath, baseBranch, sourceBranches, sha } = input;
  const undecided: string[] = [];
  if (!repoPath || !baseBranch || !existsSync(repoPath)) {
    return { refusal: null, undecided: ['no repository or base branch to inspect'] };
  }
  try {
    const git = gitIn(repoPath);
    const base = resolveCommit(git, baseBranch);
    if (!base) return { refusal: null, undecided: [`base ${baseBranch} not found`] };
    const heads: { branch: string; head: string }[] = [];
    for (const branch of sourceBranches) {
      const head = resolveCommit(git, `refs/heads/${branch}`);
      if (!head) { undecided.push(`branch ${branch} not found`); continue; }
      const contained = isAncestor(git, head, base);
      if (contained === null) { undecided.push(`ancestry of ${branch} unknown`); continue; }
      if (!contained) {
        return {
          refusal:
            `Merge guard: branch ${branch} (head ${head.slice(0, 12)}) is not contained in ${baseBranch}, ` +
            `so it was not merged. Integrate it from your worktree, move ${baseBranch} forward as your brief ` +
            `says, check with \`git merge-base --is-ancestor ${branch} ${baseBranch}\`, then close again ` +
            `with the full sha of \`git rev-parse ${baseBranch}\`. If it cannot be merged, mark the task failed with the reason.`,
          undecided,
        };
      }
      heads.push({ branch, head });
    }
    if (sha) {
      const commit = resolveCommit(git, sha);
      if (!commit) {
        return {
          refusal: `Merge guard: commit ${sha} does not exist in this repository. Close with the full sha of \`git rev-parse ${baseBranch}\`.`,
          undecided,
        };
      }
      const inBase = isAncestor(git, commit, base);
      if (inBase === false) {
        return {
          refusal: `Merge guard: commit ${sha} is not in ${baseBranch}. Close with the full sha of \`git rev-parse ${baseBranch}\` once your merge is there.`,
          undecided,
        };
      }
      if (inBase === null) undecided.push(`ancestry of ${sha} unknown`);
      for (const { branch, head } of heads) {
        const carries = isAncestor(git, head, commit);
        if (carries === false) {
          return {
            refusal:
              `Merge guard: commit ${sha} does not contain branch ${branch} (head ${head.slice(0, 12)}): ` +
              `it is not the merge of this task. Close with the full sha of \`git rev-parse ${baseBranch}\`.`,
            undecided,
          };
        }
        if (carries === null) undecided.push(`ancestry of ${branch} against ${sha} unknown`);
      }
    }
    return { refusal: null, undecided };
  } catch (err) {
    return { refusal: null, undecided: [`git failed: ${(err as Error).message}`] };
  }
}

/** The commits a coder made on a branch, whether or not the base contains them yet. */
export type BranchWork = {
  /** Where the branch was created, read from its reflog; null when unknown. */
  start: string | null;
  head: string;
  /** Own commits, newest first: the first-parent line from `start`, merges of the base left out. */
  commits: string[];
};

/**
 * The work on `branch` since it was created (TODO #1012). When the coder of a
 * `full` task merged the branch into its base, `base...HEAD` is empty and
 * proves nothing; the branch's reflog still knows where it started.
 *
 * First parent only: refreshing a task branch merges its base INTO it, so the
 * other tasks' work reaches the branch through the second parent of those
 * merges and must not land in this coder's review. A refresh that was a
 * fast-forward moves the start instead.
 */
export function branchWork(repoPath: string | null, branch: string | null): BranchWork | null {
  if (!repoPath || !branch || !existsSync(repoPath)) return null;
  try {
    const git = gitIn(repoPath);
    const head = resolveCommit(git, `refs/heads/${branch}`);
    if (!head) return null;
    const log = git(['reflog', 'show', '--format=%H %gs', `refs/heads/${branch}`, '--']);
    const entries = log.code === 0
      ? log.stdout.trim().split('\n')
        .map((l) => /^([0-9a-f]{40}) (.*)$/i.exec(l))
        .filter((m): m is RegExpExecArray => m !== null)
      : [];
    // Newest first. A refresh that fast-forwarded the branch onto its base put
    // the base's commits on its first-parent line: the coder's work starts
    // after the latest one, else where the branch was created.
    const fastForward = entries.find((m) => /^merge [^:]*: Fast-forward\b/.test(m[2]!));
    const start = fastForward?.[1] ?? entries[entries.length - 1]?.[1] ?? null;
    if (!start) return { start: null, head, commits: [] };
    const list = git(['rev-list', '--first-parent', '--no-merges', `${start}..${head}`]);
    if (list.code !== 0) return { start: null, head, commits: [] };
    const commits = list.stdout.trim().split('\n').filter((l) => l.length > 0);
    return { start, head, commits };
  } catch {
    return null;
  }
}

/** Whether `branch`'s head is contained in `baseBranch`; null when git cannot tell. */
export function branchInBase(repoPath: string | null, branch: string | null, baseBranch: string | null): boolean | null {
  if (!repoPath || !branch || !baseBranch || !existsSync(repoPath)) return null;
  try {
    const git = gitIn(repoPath);
    const head = resolveCommit(git, `refs/heads/${branch}`);
    const base = resolveCommit(git, baseBranch);
    if (!head || !base) return null;
    return isAncestor(git, head, base);
  } catch {
    return null;
  }
}

/**
 * The branches a `merge` task integrates: its coders' branches, never its own
 * `timon/merge/<id>`. A chained merge hangs off a review, which carries the
 * coder's branch once dispatched (else its chain root does); a `code-group`
 * merge hangs off the code tasks themselves.
 */
export function mergeSourceBranches(task: TaskRow): string[] {
  const branches = new Set<string>();
  const add = (branch: string | null | undefined) => {
    if (branch && branch !== task.branch_name) branches.add(branch);
  };
  let deps: unknown;
  try { deps = JSON.parse(task.deps); } catch { return []; }
  if (!Array.isArray(deps)) return [];
  for (const id of deps) {
    if (typeof id !== 'string') continue;
    const dep = dbApi.getTask(id);
    if (!dep) continue;
    if (dep.type === 'code') add(dep.branch_name);
    if (dep.type !== 'review') continue;
    if (dep.branch_name) { add(dep.branch_name); continue; }
    const root = dep.verification_root_id ? dbApi.getTask(dep.verification_root_id) : undefined;
    add(root?.branch_name);
  }
  return [...branches];
}

const tasksWithShaStmt = db.prepare(
  'SELECT id, title, owner_user_id, merged_commit_sha FROM tasks WHERE merged_commit_sha IS NOT NULL AND id != ?',
);

/**
 * Another task already carrying `sha` (prefix match: older rows hold
 * abbreviated shas). Every owner counts, for one merge proves one task only;
 * `sameOwner` says whether the caller may be told which one.
 */
export function mergedShaOwner(
  task: Pick<TaskRow, 'id' | 'owner_user_id'>,
  sha: string,
): { id: string; title: string; sameOwner: boolean } | null {
  const wanted = sha.toLowerCase();
  const rows = tasksWithShaStmt.all(task.id) as { id: string; title: string; owner_user_id: string | null; merged_commit_sha: string }[];
  const owner = rows.find((r) => {
    const other = r.merged_commit_sha.toLowerCase();
    return other.startsWith(wanted) || wanted.startsWith(other);
  });
  if (!owner) return null;
  return { id: owner.id, title: owner.title, sameOwner: owner.owner_user_id === task.owner_user_id };
}

/** Where git can tell whether a task's sha landed: its worktree, else its agent's repository. */
export function taskRepo(task: TaskRow): string | null {
  if (task.worktree_path && existsSync(task.worktree_path)) return task.worktree_path;
  try { return loadConfig(task.agent_name).cwd ?? null; } catch { return null; }
}

/** The sha a `merge` task's DONE will carry: the one sent, else the stored one,
 *  else the full sha the merge guard (`db.ts`) reads from the comment. */
export function effectiveMergeSha(task: TaskRow, sha: string | null | undefined, comment: string | null | undefined): string | null {
  if (sha) return sha;
  if (task.merged_commit_sha) return task.merged_commit_sha;
  return /\b[0-9a-f]{40}\b/i.exec(comment ?? task.done_comment ?? '')?.[0] ?? null;
}

/**
 * Whether a `merge` task may go DONE with `sha` (TODO #1012). The daemon proves
 * the merge itself instead of trusting the merger: every source branch must be
 * in the base, the sha must be in the base and contain them, and no other task
 * may already carry it. What git cannot decide (branch deleted, git missing) is
 * let through, as before, and logged.
 *
 * One exception to the last rule (TODO #1053): a `code-group` merge whose
 * source branches were all in the base already has no merge of its own to
 * show, and no single branch head contains the others. Once git proves every
 * branch in the base and inside the sha, a sha another task carries (the
 * base's head, typically) is accepted: the proof is the ancestry, not the sha.
 *
 * The task that opens a job's pull request (`landing = 'pr'`) merges nothing of
 * its own: it closes with the tip of the integration branch it published, the
 * very sha the job's last merge may carry. Ancestry is checked all the same.
 */
export function mergeCloseRefusal(task: TaskRow, sha: string | null): string | null {
  if (task.type !== 'merge') return null;
  if (task.landing === 'local') return localLandingCloseRefusal(task, sha);
  const sources = mergeSourceBranches(task);
  const verdict = evaluateMergeClose({
    repoPath: taskRepo(task),
    baseBranch: task.base_branch,
    sourceBranches: sources,
    sha,
  });
  if (sources.length === 0) verdict.undecided.push('no source branch found in its dependencies');
  const owner = sha ? mergedShaOwner(task, sha) : null;
  const allSourcesProven = sources.length > 1 && verdict.refusal === null && verdict.undecided.length === 0;
  if (sha && owner && !allSourcesProven && task.landing !== 'pr') {
    // Another user's task is not named: its id and title are theirs.
    const which = owner.sameOwner ? `task ${owner.id} ("${owner.title}")` : 'another task';
    return `Merge guard: commit ${sha} is already the merge of ${which}, ` +
      `so it does not prove this one. Merge this task's branch, then close with the full sha of the ` +
      `resulting base. If the branch was already in the base before this task, close with the full sha ` +
      `of the branch head (\`git rev-parse <branch>\`), once \`git merge-base --is-ancestor <branch> <base>\` succeeds. ` +
      `If this task integrates several branches that were all in the base already, close with the full sha ` +
      `of the base (\`git rev-parse <base>\`) once each of them passes that check.`;
  }
  if (owner) console.warn(`[merge-guard] task ${task.id}: sha ${sha} shared with task ${owner.id}, accepted as every source branch is in the base`);
  if (verdict.undecided.length > 0) {
    console.warn(`[merge-guard] task ${task.id}: merge not fully verified (${verdict.undecided.join('; ')})`);
  }
  return verdict.refusal;
}

/**
 * Whether the task that merges a job's branch into its local target
 * (`landing = 'local'`, `local-landing.ts`) may go DONE with `sha`. Its DONE
 * lands the whole job (ideas closed, doc task created), so git must prove it,
 * and nothing undecided passes: `sha` is in the target, and carries the
 * branch's tip. The target is the chain's (`refs/heads/<target>`), else the
 * integration row's.
 */
export function localLandingCloseRefusal(task: TaskRow, sha: string | null): string | null {
  const branch = task.base_branch;
  const target = localTargetOf(task.base_ref) ?? integrationOfTask(task)?.target ?? null;
  const guard = 'Landing guard: this task merges the job\'s branch into its target, and its close lands the whole job';
  if (!branch || !target) return `${guard}, but the job has no branch or no target to check. Mark the task failed with the reason.`;
  const repo = taskRepo(task);
  const how = `Merge ${branch} into ${target} as your brief says, then close with the full sha of \`git rev-parse ${target}\`.`;
  if (!sha) return `${guard}: close it with the sha of the merge (\`--merged-sha\`). ${how}`;
  if (!repo || !existsSync(repo)) return `${guard}, and the repository cannot be read to check it. Retry once it is back.`;
  try {
    const git = gitIn(repo);
    const commit = resolveCommit(git, sha);
    const tip = resolveCommit(git, `refs/heads/${target}`);
    const head = resolveCommit(git, `refs/heads/${branch}`);
    if (!commit) return `${guard}: commit ${sha} does not exist in this repository. ${how}`;
    if (!tip || !head) return `${guard}: ${tip ? branch : target} is not a branch of this repository. Mark the task failed with the reason.`;
    const inTarget = isAncestor(git, commit, tip);
    if (inTarget !== true) {
      return `${guard}: commit ${sha} is ${inTarget === false ? 'not' : 'not provably'} in ${target}. ${how}`;
    }
    const carries = isAncestor(git, head, commit);
    if (carries !== true) {
      return `${guard}: commit ${sha} does not ${carries === false ? '' : 'provably '}contain ${branch} (head ${head.slice(0, 12)}): ` +
        `it is not the merge of the job's branch. ${how}`;
    }
    return null;
  } catch {
    return `${guard}, and git could not check it. Retry the close.`;
  }
}

/**
 * Whether the task that opens a job's pull request (`landing = 'pr'`) may go
 * DONE (`docs/KANBAN-PR-PIPELINE.md` §2.4). Closing it without `timon pr open`
 * left the integration row at 'branch': the poller only reads open pull
 * requests, so the job never landed, its ideas stayed partial and nobody was
 * told. DONE waits for the row to be open, merged or closed; a failed close
 * stays possible. Fail-closed: a row that cannot be found has no pull request.
 */
export function pullRequestCloseRefusal(task: TaskRow): string | null {
  if (task.type !== 'merge' || task.landing !== 'pr') return null;
  const row = integrationOfTask(task);
  if (row && row.state !== 'branch') return null;
  const branch = task.base_branch ?? 'the integration branch';
  const why = row ? `${branch} has no pull request yet` : `no integration branch of this job was found`;
  return `Pull request guard: this task opens the job's pull request, and ${why}. ` +
    `Open it first with \`timon pr open ${task.id} --title "<title>" --body-file <file>\` ` +
    `(MCP tool \`pr_open\`), then close the task. If it cannot be opened, mark the task failed with the reason.`;
}

/**
 * Whether a `full` code task may go DONE (TODO #1012). When its coder merged
 * the branch into the base, the review reads the coder's commits from where the
 * branch started, found in its reflog. Without that start the review would
 * see an empty diff: the closing is refused rather than letting the chain skip
 * the review.
 */
export function codeCloseRefusal(task: TaskRow): string | null {
  if (task.type !== 'code' || !task.branch_name || isCodeOnlyPipeline(task.pipeline)) return null;
  if (task.merged_commit_sha) return null;
  const repo = taskRepo(task);
  if (branchInBase(repo, task.branch_name, task.base_branch) !== true) return null;
  const work = branchWork(repo, task.branch_name);
  if (!work || work.start) return null;
  return `Code guard: branch ${task.branch_name} is already contained in ${task.base_branch}, and where it ` +
    `started cannot be found, so its review would see an empty diff. In the full pipeline the chained merge ` +
    `task integrates the branch, never the coder. Mark the task failed with this reason so a person decides ` +
    `how to review it.`;
}
