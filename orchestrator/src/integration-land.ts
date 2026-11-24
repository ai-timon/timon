/**
 * The landing gesture of a job kept on its branch (`docs/KANBAN-PR-PIPELINE.md`,
 * "Branch and destination in the plan"): the Kanban planner let a person keep
 * a job's work on its branch (`finish: keep`); its ideas wait in `partial`
 * until someone lands the branch, from the Jobs widget, the CLI
 * (`timon pr land`) or the MCP tool (`pr_land`).
 *
 * - **A project that merges locally** (row without a remote): the branch is
 *   merged into the local target on this machine, fail-closed. A branch the
 *   target already contains moves nothing. A fast-forward moves the target to
 *   the branch's tip; otherwise the merge commit is written by git in memory
 *   (`merge-tree --write-tree`, then `commit-tree` with the target as first
 *   parent), the method the forge scratch repository already uses: no working
 *   tree is created, no file of the branch is written on the disk, no hook
 *   runs. A conflict refuses, with its files; nothing is ever resolved here.
 *   The target then moves by reference with its old value
 *   (`advanceBaseByReference`), or, when a working directory has it checked
 *   out, by `merge --ff-only` there, and only if that directory's status is
 *   clean: its files must follow the branch, and the user's own changes are
 *   never mixed into a landing. Then `concludeMerged`: the row goes 'merged',
 *   the ideas close, the doc task is created, once.
 * - **A project that lands through pull requests**: the job's pull request is
 *   opened by the very action of `timon pr open` (`openPullRequest`: account,
 *   remote, identity, messages, text, public tree, push never forced). Nothing
 *   merges here: the landing poller concludes when the forge merged it.
 *
 * Idempotent: a job already landed (or whose pull request is already open)
 * answers what it is, and moves nothing. Two gestures at once on the same
 * branch: the second is refused while the first runs. A job that still has a
 * task under way is refused: landing it now would leave that task's work out.
 */
import { existsSync } from 'node:fs';
import { dbApi, type IntegrationRow, type TaskRow } from './db.js';
import { advanceBaseByReference } from './git-integration.js';
import { getHost } from './host/index.js';
import type { ExecResult } from './host/types.js';
import { concludeMerged, mergeCommitOf, type Notify } from './integration-poller.js';
import { openPullRequest, type PrOpenDeps, type PrOpenOutcome, type PrOpenRefusalCode } from './pr-open.js';

export type LandDeps = PrOpenDeps & {
  /** Stand-in for the pilot's notice (tests). */
  notify?: Notify;
};

export type LandRequest = { title?: string; body?: string };

export type LandRefusalCode =
  | 'landing_refused'
  | 'landing_busy'
  | 'landing_job_running'
  | 'landing_conflict'
  | 'landing_target_dirty'
  | 'landing_move_failed';

type PrSuccess = Extract<PrOpenOutcome, { ok: true }>;

export type LandOutcome =
  | {
      ok: true;
      outcome: 'merged';
      /** True when the job had landed already: nothing moved. */
      already: boolean;
      /** The commit of the target that carries the branch. */
      merge_sha: string | null;
      /** How the target moved: `none` when it already held the branch. */
      move: 'none' | 'fast_forward' | 'merge_commit' | 'already';
    }
  | {
      ok: true;
      outcome: 'pull_request';
      already: boolean;
      pr_url: string | null;
      pr_number: number | null;
      /** The opening's own answer, when this call opened it. */
      opened: PrSuccess | null;
    }
  | { ok: false; status: number; code: LandRefusalCode; reason: string; files?: string[] }
  | { ok: false; status: number; code: PrOpenRefusalCode; reason: string; checks?: Extract<PrOpenOutcome, { ok: false }>['checks'] };

type Refusal = Extract<LandOutcome, { ok: false; code: LandRefusalCode }>;
export type PrRefusal = Extract<LandOutcome, { ok: false; code: PrOpenRefusalCode }>;

const OWN_CODES: ReadonlySet<string> = new Set<LandRefusalCode>([
  'landing_refused', 'landing_busy', 'landing_job_running', 'landing_conflict', 'landing_target_dirty', 'landing_move_failed',
]);

/** True for a refusal of the pull request's own action (`pr_*` codes). */
export function isPrRefusal(out: Refusal | PrRefusal): out is PrRefusal {
  return !OWN_CODES.has(out.code);
}

function refuse(status: number, code: LandRefusalCode, reason: string, files?: string[]): Refusal {
  return { ok: false, status, code, reason, ...(files ? { files } : {}) };
}

const SHA = /^[0-9a-f]{40,64}$/;
const UNDER_WAY: ReadonlySet<TaskRow['status']> = new Set(['PENDING', 'IN_PROGRESS']);

async function git(cwd: string, args: string[], timeout = 30_000): Promise<ExecResult> {
  try {
    return await getHost().execAsync('git', ['-C', cwd, ...args], { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  } catch (err) {
    return { code: 1, stdout: '', stderr: (err as Error).message };
  }
}

async function refSha(repo: string, ref: string): Promise<string | null> {
  const r = await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && SHA.test(sha) ? sha : null;
}

async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  return (await git(repo, ['merge-base', '--is-ancestor', ancestor, descendant])).code === 0;
}

type JobRef = Pick<IntegrationRow, 'branch' | 'project' | 'series_id'>;

/** The tasks of the job: on its branch, or in its series and not given a base yet. */
function jobTasks(row: JobRef): TaskRow[] {
  const found = new Map<string, TaskRow>();
  for (const t of dbApi.listTasksByBaseBranch(row.branch)) {
    if (!row.project || !t.project || t.project === row.project) found.set(t.id, t);
  }
  if (row.series_id) {
    for (const t of dbApi.listTasksBySeries(row.series_id)) {
      const sameProject = !row.project || !t.project || t.project === row.project;
      if (sameProject && (!t.base_branch || t.base_branch === row.branch)) found.set(t.id, t);
    }
  }
  return [...found.values()];
}

/** The tasks of the job still waiting or running. */
export function jobTasksUnderWay(row: JobRef): TaskRow[] {
  return jobTasks(row).filter((t) => UNDER_WAY.has(t.status));
}

/**
 * What the Jobs widget needs to offer the landing gesture on a job's row:
 * whether the planner kept the job on its branch, what still runs in it, and
 * the last task merged into the branch.
 */
export type KeptState = {
  /** The planner's choice for the end of the job; null when it chose nothing. */
  finish: 'merge' | 'keep' | null;
  /** The job waits on its branch for a person to land it. */
  kept: boolean;
  /** Tasks of a kept job still waiting or running: landing is refused meanwhile. */
  under_way: number;
  /** The latest task of a kept job merged into its branch. */
  last_merge: { sha: string; at: number } | null;
};

function finishOf(seriesId: string | null): KeptState['finish'] {
  const finish = seriesId ? dbApi.getSeriesPlanLanding(seriesId)?.finish : null;
  return finish === 'merge' || finish === 'keep' ? finish : null;
}

/** Adds `KeptState` to each job; the tasks are read only for a kept one. */
export function withKeptState<T extends JobRef & Pick<IntegrationRow, 'state'>>(views: readonly T[]): Array<T & KeptState> {
  return views.map((view) => {
    const finish = finishOf(view.series_id);
    const kept = view.state === 'branch' && finish === 'keep';
    if (!kept) return { ...view, finish, kept, under_way: 0, last_merge: null };
    const tasks = jobTasks(view);
    let last: TaskRow | null = null;
    for (const t of tasks) {
      if (t.status === 'DONE' && t.merged_commit_sha && (!last || t.updated_at > last.updated_at)) last = t;
    }
    return {
      ...view,
      finish,
      kept,
      under_way: tasks.filter((t) => UNDER_WAY.has(t.status)).length,
      last_merge: last?.merged_commit_sha ? { sha: last.merged_commit_sha, at: last.updated_at } : null,
    };
  });
}

/** The working directory that has `branch` checked out, or null. */
async function checkoutOf(repo: string, branch: string): Promise<{ path: string } | null | 'unknown'> {
  const r = await git(repo, ['worktree', 'list', '--porcelain', '-z']);
  if (r.code !== 0) return 'unknown';
  let path: string | null = null;
  for (const field of r.stdout.split('\0')) {
    if (field.startsWith('worktree ')) path = field.slice('worktree '.length);
    else if (field === `branch refs/heads/${branch}` && path) return { path };
  }
  return null;
}

const busy = new Set<string>();

/** Lands `row`: see the head of this file. */
export async function landIntegrationBranch(row: IntegrationRow, request: LandRequest = {}, deps: LandDeps = {}): Promise<LandOutcome> {
  const local = row.remote === '';
  if (!local && (row.mode !== 'pr' || row.branch.startsWith('sec/'))) {
    return refuse(409, 'landing_refused', `${row.branch} is under embargo: it lands by hand, never from Timon`);
  }
  if (row.state === 'merged') {
    return local
      ? { ok: true, outcome: 'merged', already: true, merge_sha: row.merge_sha, move: 'already' }
      : { ok: true, outcome: 'pull_request', already: true, pr_url: row.pr_url, pr_number: row.pr_number, opened: null };
  }
  if (row.state === 'open') {
    return { ok: true, outcome: 'pull_request', already: true, pr_url: row.pr_url, pr_number: row.pr_number, opened: null };
  }
  if (row.state !== 'branch') {
    return refuse(409, 'landing_refused', `the pull request of ${row.branch} was closed without a merge: open a new one by hand`);
  }
  const running = jobTasksUnderWay(row);
  if (running.length > 0) {
    return refuse(409, 'landing_job_running',
      `${running.length} task(s) of the job are still waiting or running: land the branch once they are done`);
  }
  if (!local && !request.title?.trim()) {
    return refuse(400, 'landing_refused', 'opening the pull request needs a title');
  }

  const key = `${row.repo}\0${row.branch}`;
  if (busy.has(key)) return refuse(409, 'landing_busy', `${row.branch} is already being landed`);
  busy.add(key);
  try {
    if (!local) {
      const out = await openPullRequest({ target: 'integration', id: row.id, title: request.title!.trim(), body: request.body ?? '' }, deps);
      if (!out.ok) return out;
      return { ok: true, outcome: 'pull_request', already: out.existing, pr_url: out.pr.url, pr_number: out.pr.number, opened: out };
    }
    return await landLocally(row, deps);
  } finally {
    busy.delete(key);
  }
}

async function landLocally(row: IntegrationRow, deps: LandDeps): Promise<LandOutcome> {
  const { repo, branch, target } = row;
  const head = await refSha(repo, `refs/heads/${branch}`);
  const before = await refSha(repo, `refs/heads/${target}`);
  if (!head || !before) {
    return refuse(409, 'landing_refused', `${head ? target : branch} does not exist in the repository`);
  }

  // Already in the target (merged by hand): the landing only records it.
  if (await isAncestor(repo, head, before)) {
    const mergeSha = (await mergeCommitOf(repo, head, `refs/heads/${target}`)) ?? before;
    await concludeMerged(row.id, mergeSha, deps.notify);
    return { ok: true, outcome: 'merged', already: false, merge_sha: mergeSha, move: 'none' };
  }

  let next: string;
  let move: 'fast_forward' | 'merge_commit';
  if (await isAncestor(repo, before, head)) {
    next = head;
    move = 'fast_forward';
  } else {
    const merged = await mergeInMemory(repo, before, head, `merge: integrate ${branch} into ${target}`);
    if (!merged.ok) return merged.refusal;
    next = merged.sha;
    move = 'merge_commit';
  }

  const moved = await moveTarget(repo, target, before, next);
  if (moved) return moved;
  await concludeMerged(row.id, next, deps.notify);
  return { ok: true, outcome: 'merged', already: false, merge_sha: next, move };
}

/**
 * The merge commit of `head` into `base`, written by git without a working
 * tree: `merge-tree` computes the tree (exit 1 = conflicts, with their
 * files), `commit-tree` writes the commit with `base` as first parent, under
 * the repository's own identity. No ref moves here.
 */
async function mergeInMemory(
  repo: string, base: string, head: string, message: string,
): Promise<{ ok: true; sha: string } | { ok: false; refusal: Refusal }> {
  const r = await git(repo, ['merge-tree', '--write-tree', '--name-only', '--no-messages', base, head]);
  const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  if (r.code === 1) {
    const files = [...new Set(lines.slice(1))].slice(0, 50);
    return {
      ok: false,
      refusal: refuse(409, 'landing_conflict',
        `the branch conflicts with the target on ${files.length ? files.join(', ') : 'some files'}: ` +
        'resolve it on the branch, then land again', files),
    };
  }
  const tree = lines[0] ?? '';
  if (r.code !== 0 || !SHA.test(tree)) {
    console.error(`[land] merge-tree failed: ${r.stderr.trim().slice(-300)}`);
    return { ok: false, refusal: refuse(409, 'landing_refused', 'git could not merge the branch (merge-tree needs git 2.38 or later)') };
  }
  const c = await git(repo, ['commit-tree', tree, '-p', base, '-p', head, '-m', message]);
  const sha = c.stdout.trim();
  if (c.code !== 0 || !SHA.test(sha)) {
    console.error(`[land] commit-tree failed: ${c.stderr.trim().slice(-300)}`);
    return {
      ok: false,
      refusal: refuse(409, 'landing_refused',
        'git could not write the merge commit: check that the repository has a commit identity (user.name, user.email)'),
    };
  }
  return { ok: true, sha };
}

/** Moves `target` from `before` to `next`; null once done, else the refusal. */
async function moveTarget(repo: string, target: string, before: string, next: string): Promise<Refusal | null> {
  const checkout = await checkoutOf(repo, target);
  if (checkout === 'unknown') {
    return refuse(409, 'landing_move_failed', `git could not tell where ${target} is checked out; nothing moved`);
  }
  if (!checkout) {
    const out = await advanceBaseByReference(repo, next, target);
    if (out.ok) return null;
    // Our own words: git's may quote a path of this machine.
    console.error(`[land] advancing ${target} failed (${out.code}): ${out.reason}`);
    return refuse(409, 'landing_move_failed', out.code === 'checked_out'
      ? `${target} was checked out meanwhile; nothing moved, land again`
      : `${target} moved while it was being landed; nothing moved, land again`);
  }
  const dir = checkout.path;
  if (!existsSync(dir)) {
    return refuse(409, 'landing_move_failed',
      `${target} is checked out in a working directory that no longer exists: run git worktree prune, then land again`);
  }
  const status = await git(dir, ['status', '--porcelain']);
  if (status.code !== 0 || status.stdout.trim() !== '') {
    return refuse(409, 'landing_target_dirty',
      `${target} is checked out in a working directory with uncommitted changes or untracked files: ` +
      'commit, stash or remove them, then land again; nothing moved');
  }
  const ff = await git(dir, ['merge', '--ff-only', '--quiet', next], 120_000);
  const now = await refSha(repo, `refs/heads/${target}`);
  if (ff.code !== 0 || now !== next) {
    console.error(`[land] fast-forward of ${target} failed: ${ff.stderr.trim().slice(-300)}`);
    return refuse(409, 'landing_move_failed', now === before
      ? `${target} could not be fast-forwarded in its working directory; nothing moved, land again`
      : `${target} moved while it was being landed; land again`);
  }
  return null;
}
