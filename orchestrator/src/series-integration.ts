/**
 * The integration branch of a SEQUENTIAL job (`kanban_plan` modes
 * `sequential-here` and `sequential-new-mission`) in a project that lands
 * through pull requests (`docs/KANBAN-PR-PIPELINE.md` §2.2), or in a project
 * that merges locally when the planner gave the job a branch of its own.
 *
 * A Kanban job gets its branch from the dispatcher, at the first task. A
 * sequential job has no task before its very end: its pilot codes in a
 * mission. So the pilot asks the daemon for the branch (`timon pr branch`),
 * which does what the dispatcher does, through the same functions: the name
 * the plan gave is checked again, the branch is cut from the remote's target
 * (or the local one) without a checkout, fail-closed, or taken as it is when
 * the plan chose an existing branch, and recorded for the series (the lock a
 * reopened plan reads). Then the daemon gives the pilot a worktree of its own,
 * detached on the branch's tip: the shared checkout is never written, and the
 * branch itself is checked out nowhere, so the job's last task can still move
 * it by reference.
 *
 * The worktree lives outside `WORKTREES_ROOT` on purpose: the worktree GC
 * disposes of every folder there no task claims, uncommitted work included.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { dbApi } from './db.js';
import { baseRefLabel, ensureIntegrationBranch, type IntegrationRefusalCode } from './git-integration.js';
import { execFileHost } from './host/index.js';
import { TIMON_HOME } from './paths.js';
import { checkPlanBranch, landingSetting, planBranchName, planProject } from './plan-landing.js';
import { integrationBaseRef } from './project-integration.js';
import { isGitRepo, prepareWorktreeDependencies } from './worktree.js';

const exec = execFileHost;

/** Where the pilots of sequential jobs code, one folder per series. */
export const SERIES_WORKTREES_ROOT = join(TIMON_HOME, 'series-worktrees');

export type SeriesBranchRefusalCode =
  | 'series_not_found'
  | 'series_branch_not_pr'
  | 'series_branch_refused'
  | 'series_branch_unavailable'
  | 'series_worktree_failed';

export type SeriesBranchOutcome =
  | {
    ok: true;
    branch: string;
    /** `origin/main`: what the branch was cut from and the pull request targets. */
    base_ref: string;
    /** The branch's tip when the call answered. */
    sha: string;
    /** False when the branch was already there (a job being resumed). */
    created: boolean;
    project: string;
    /** The pilot's worktree, detached on the branch's tip. */
    worktree: string;
  }
  | { ok: false; status: number; code: SeriesBranchRefusalCode; reason: string; detail?: IntegrationRefusalCode };

export type SeriesBranchDeps = {
  /** Stands in for the remote in tests. */
  ensureBranch?: typeof ensureIntegrationBranch;
};

function refused(status: number, code: SeriesBranchRefusalCode, reason: string): SeriesBranchOutcome {
  return { ok: false, status, code, reason };
}

/** The pilot's worktree, created detached on `branch` when missing. */
async function pilotWorktree(repo: string, seriesId: string, branch: string): Promise<string> {
  const path = join(SERIES_WORKTREES_ROOT, seriesId);
  if (existsSync(path) && (await isGitRepo(path))) {
    await prepareWorktreeDependencies(repo, path);
    return path;
  }
  mkdirSync(SERIES_WORKTREES_ROOT, { recursive: true });
  // A folder removed by hand leaves its entry in git, which would refuse the
  // path: prune only drops entries whose folder is gone.
  await exec('git', ['-C', repo, 'worktree', 'prune'], { timeout: 15_000 });
  await exec('git', ['-C', repo, 'worktree', 'add', '--detach', '--', path, `refs/heads/${branch}`], { timeout: 30_000 });
  await prepareWorktreeDependencies(repo, path);
  return path;
}

/**
 * Cuts (or finds) the integration branch `proposed` of the sequential job
 * piloted by `seriesId`, records it for the series, and gives the pilot its
 * worktree. Refused, never renamed: the plan already numbered the name, so a
 * name taken since is the caller's to change.
 */
export async function prepareSeriesBranch(
  seriesId: string,
  proposed: string,
  deps: SeriesBranchDeps = {},
): Promise<SeriesBranchOutcome> {
  const pilot = dbApi.getMission(seriesId);
  if (!pilot) return refused(404, 'series_not_found', 'series not found');
  const target = planProject(pilot.agent_name, seriesId);
  const found = target ? landingSetting(target.slug, target.cwd) : null;
  // What the planner chose for this job, when it chose this very branch.
  const recorded = dbApi.getSeriesPlanLanding(seriesId);
  const local = found?.setting.mode !== 'pr';
  const planned = recorded && found && (recorded.project === target?.slug || recorded.repo === found.repo)
    && (recorded.branch === proposed.trim() || recorded.branch === planBranchName(proposed, found.setting.branch_prefix))
    ? recorded : undefined;
  if (!target || !found || !found.repo || (local && planned?.mode !== 'branch')) {
    return refused(409, 'series_branch_not_pr',
      'the job\'s project does not land through pull requests and its plan gave it no branch: code as usual, ' +
      'there is no integration branch');
  }
  const { setting, repo } = found;
  const slug = target.slug;
  const kind = planned?.branch_kind === 'existing' ? 'existing' : 'new';
  const baseRef = planned?.base_ref ?? integrationBaseRef(setting);
  const wanted = kind === 'existing' ? proposed.trim() : planBranchName(proposed, setting.branch_prefix);
  const held = dbApi.listIntegrationsBySeries(seriesId).find((r) => r.project === slug || r.repo === repo);
  let branch: string;
  if (held) {
    if (held.branch !== wanted) {
      return refused(409, 'series_branch_refused', `the job already starts from ${held.branch}; its name no longer changes`);
    }
    branch = held.branch;
  } else {
    const checked = checkPlanBranch(proposed, setting, repo, { kind, strict: planned?.branch_kind === 'new', local });
    if (!checked.ok) return refused(400, 'series_branch_refused', checked.refusal);
    if (checked.branch !== wanted) {
      return refused(409, 'series_branch_refused',
        `${wanted} is already taken by an earlier job; open the plan again or use ${checked.branch}`);
    }
    branch = checked.branch;
  }

  const out = await (deps.ensureBranch ?? ensureIntegrationBranch)(repo, { branch, baseRef, mustExist: kind === 'existing' });
  if (!out.ok) {
    return {
      ok: false, status: 409, code: 'series_branch_unavailable', detail: out.code,
      reason: `integration branch ${branch} is unavailable: ${out.reason}; it is never cut from the local base instead of ${baseRefLabel(baseRef)}`,
    };
  }
  dbApi.recordIntegration({
    repo,
    branch,
    remote: out.remote,
    target: out.target,
    // Same rule as the dispatcher (`projectLanding`): an embargoed branch, or
    // a project that merges locally, lands by hand or by its last task.
    mode: local || branch.startsWith('sec/') ? 'branch' : 'pr',
    project: slug,
    seriesId,
    baseSha: out.created ? out.sha : null,
  });
  if (out.created) console.log(`[series-integration] integration branch ${branch} created from ${baseRef} for series ${seriesId.slice(0, 8)}`);

  let worktree: string;
  try {
    worktree = await pilotWorktree(repo, seriesId, branch);
  } catch (err) {
    // Not echoed: git's message quotes folders of this machine.
    console.error(`[series-integration] worktree of series ${seriesId.slice(0, 8)} failed: ${(err as Error).message}`);
    return refused(500, 'series_worktree_failed',
      `integration branch ${branch} is ready, but the worktree to code in could not be created; retry the command`);
  }
  return { ok: true, branch, base_ref: baseRef, sha: out.sha, created: out.created, project: slug, worktree };
}
