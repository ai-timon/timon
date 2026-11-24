/**
 * Dispatch gate: evaluates a task's dependencies before spawn.
 *
 * Why this module exists ("shipping fees overhaul" incident, L1→L7, 29-30/07):
 * the dispatcher considered a dep satisfied as soon as it had the DONE status,
 * without ever looking at the VERDICT carried by a `review` dep. Yet the
 * project orchestrators pre-wire the pipeline (code→review→merge→verify linked
 * by `deps` from creation): the `merge` task therefore left just as well on a
 * `changes_requested` as on a review closed without any verdict. Result on
 * that job: 3 unvalidated merges, including a batch where two bugs (N+1 on the hot
 * checkout path, silent exclusion of products from free shipping) stayed
 * on main for a day.
 *
 * The verification-loop, for its part, was correct (it only creates a merge on
 * `pass`) — but it does not control the PRE-CREATED merges. Hence a structural
 * guarantee here, at the dispatch point, rather than prose instructions in
 * the task descriptions.
 *
 * No SQLite import (`db.js` for its types only): testable without opening it.
 */
import type { TaskRow } from './db.js';
import { daemonMessage, type DaemonMessage } from './daemon-message.js';
import { parseReviewVerdict } from './review-verdict.js';

/** Result of the evaluation of a task's deps.
 *  - `ok`: the task can be dispatched.
 *  - `!ok` without `blockedReason`: normal wait (dep not finished yet).
 *  - `!ok` with `blockedReason`: final refusal — the task must go BLOCKED
 *    with this reason, otherwise a withheld merge is indistinguishable from a mere
 *    wait and nobody ever learns about it. */
export type DepGate =
  | { ok: true }
  | {
      ok: false;
      blockedReason: string | null;
      /** The code of `blockedReason`, for the webview to translate (TODO #1063). */
      blockedReasonCode?: DaemonMessage;
      waitingFor?: string;
      /** Set when the wait is "review requested changes, no repair iteration
       *  exists": the closure time of that review. The dispatcher turns a wait
       *  that outlasts `REPAIR_WAIT_BLOCK_MS` into a BLOCKED with a reason
       *  (`repairWaitStall`). Absent for every other wait. */
      awaitingRepairSince?: number;
      /** The refused review and its code task, set with `awaitingRepairSince`. */
      awaitingRepairOf?: { reviewId: string; codeId: string };
    };

const SATISFIED: DepGate = { ok: true };

/** Subset of TaskRow actually read here — lets the tests build minimal
 *  fixtures without fabricating a complete SQLite row. `iteration` and
 *  `verification_root_id` are optional: a dep outside a verification chain
 *  (code task created by hand, chore…) does not carry them. */
type GatedTask = Pick<TaskRow, 'type' | 'deps'> & Partial<Pick<TaskRow, 'base_branch' | 'landing'>>;
type DepTask = Pick<TaskRow, 'id' | 'type' | 'status' | 'done_comment'> &
  Partial<
    Pick<
      TaskRow,
      'iteration' | 'verification_root_id' | 'pipeline' | 'branch_name' | 'worktree_path' | 'deps' | 'updated_at'
      | 'merged_commit_sha' | 'base_branch' | 'integration_mode'
    >
  >;

/** Where a dependency's chain stands (`chain-landing.ts`), injected to keep
 *  this module SQLite-free. */
export type DepLanding = 'local' | 'integrated' | 'landed' | 'closed';
type LandingLookup = (dep: DepTask) => DepLanding;
const ALWAYS_LOCAL: LandingLookup = () => 'local';

/** All the tasks of a verification chain (same `verification_root_id`).
 *  Injected rather than imported: the module stays testable without SQLite. Empty
 *  default → behaviour from before the chain guard.
 *
 *  The `code` dependency guard injects a second, WIDER one
 *  (`evaluateDeps`, `listFullChain`): the root carries a null `verification_root_id`
 *  and the `merge` task is never labelled by the verification-loop, so
 *  the labelled lookup does not see them (see `dbApi.listVerificationChain`). The
 *  concurrent reviews guard keeps its own, unchanged. */
type ChainLookup = (rootId: string) => DepTask[];

const NO_CHAIN: ChainLookup = () => [];

/** Other reviews living on the same state of the code as `dep`: same verification
 *  chain, iteration >= its own.
 *
 * The iteration filter is load-bearing: a healthy chain almost always contains
 * `changes_requested` reviews from earlier iterations (that is what
 * triggered the following iterations) — counting them would block every
 * legitimate merge. What we look for are the CONCURRENT reviews of the same
 * state of the code, or more recent ones (in which case the verdict the merge depends on
 * is stale).
 */
function concurrentReviews(dep: DepTask, listChain: ChainLookup): DepTask[] {
  const rootId = dep.verification_root_id;
  if (!rootId) return [];
  const minIteration = dep.iteration ?? 0;
  return listChain(rootId).filter(
    (t) => t.type === 'review' && t.id !== dep.id && (t.iteration ?? 0) >= minIteration,
  );
}

/** Refusal reason carried by a DONE review, or null if it approves.
 *
 * `changes_requested` AND `unknown` (empty or unparsable done_comment) both
 * block: we prefer a readable stall to an unvalidated merge — the absence of a
 * verdict is precisely what let batch L5 through. The feedback is
 * copied into the reason so that the divergence is readable on the Kanban without having
 * to reopen the review.
 */
function verdictGate(review: DepTask): DepGate | null {
  const { verdict, feedback } = parseReviewVerdict(review.done_comment);
  if (verdict === 'pass') return null;
  if (verdict === 'changes_requested') {
    const finding = feedback?.trim() ?? '';
    return {
      ok: false,
      blockedReason:
        `Merge held: review ${review.id} carries the verdict "changes_requested". ` +
        `Address the feedback (new code iteration), then run a review again before merging.` +
        (finding ? `\n\nFinding:\n${finding}` : ''),
      blockedReasonCode: daemonMessage('merge_held_changes_requested', {
        reviewId: review.id,
        finding: finding || 'none',
      }),
    };
  }
  return {
    ok: false,
    blockedReasonCode: daemonMessage('merge_held_no_verdict', { reviewId: review.id }),
    blockedReason:
      `Merge held: review ${review.id} is DONE but its done_comment carries NO ` +
      `usable verdict (expected a first line \`verdict: pass\` or \`verdict: changes_requested\`). ` +
      `Without an explicit verdict there is no merge. Have the review closed again with a verdict, ` +
      `or unblock it by hand after reading the diff.`,
  };
}

/** Readable reason for waiting on a `code` dependency whose chain has not
 *  reached a DONE merge yet. */
function chainWait(
  dep: DepTask,
  chainTasks: DepTask[],
): { reason: string; awaitingRepairSince?: number; awaitingRepairOf?: { reviewId: string; codeId: string } } {
  const reviews = chainTasks.filter((t) => t.type === 'review');
  const codes = chainTasks.filter((t) => t.type === 'code');
  const lastIter = Math.max(0, ...[...reviews, ...codes].map((t) => t.iteration ?? 1));
  const newestCode = codes.filter((t) => (t.iteration ?? 1) === lastIter && t.status !== 'DONE')[0];
  if (newestCode) {
    return { reason: `code ${dep.id} DONE, but repair iteration ${lastIter} (${newestCode.id}) is ${newestCode.status}` };
  }
  const latest = reviews.filter((t) => (t.iteration ?? 1) === lastIter);
  if (latest.length === 0) {
    return { reason: `code ${dep.id} DONE, its review has not been created yet` };
  }
  const open = latest.find((t) => t.status !== 'DONE');
  if (open) return { reason: `review ${open.id} of code ${dep.id} is ${open.status}` };
  const refused = latest.find((t) => parseReviewVerdict(t.done_comment).verdict !== 'pass');
  if (refused) {
    const { verdict } = parseReviewVerdict(refused.done_comment);
    return verdict === 'changes_requested'
      ? {
          reason: `review ${refused.id} of code ${dep.id} requested changes, waiting for the repair iteration`,
          awaitingRepairSince: refused.updated_at,
          awaitingRepairOf: { reviewId: refused.id, codeId: dep.id },
        }
      : { reason: `review ${refused.id} of code ${dep.id} has no usable verdict` };
  }
  const merge = latestMerge(chainTasks, latest);
  if (merge) return { reason: `merge ${merge.id} of code ${dep.id} is ${merge.status}` };
  return { reason: `review of code ${dep.id} passed, its merge has not been created yet` };
}

function dependsOnAny(task: DepTask, ids: Set<string>): boolean {
  try {
    return (JSON.parse(task.deps ?? '[]') as string[]).some((d) => ids.has(d));
  } catch {
    return false;
  }
}

/** Merge attached (through `deps`) to one of the given reviews; prefers a DONE merge. */
function latestMerge(chainTasks: DepTask[], reviews: DepTask[]): DepTask | undefined {
  const ids = new Set(reviews.map((r) => r.id));
  const merges = chainTasks.filter((t) => t.type === 'merge' && dependsOnAny(t, ids));
  return merges.find((m) => m.status === 'DONE') ?? merges[merges.length - 1];
}

/** Code-only pipelines integrate without a chained merge. Mirrors
 *  `isCodeOnlyPipeline` (db.ts), not imported to keep this module SQLite-free:
 *  only an explicitly recognised value disables the guard, anything else
 *  (null, 'full', a typo) is the full pipeline. */
function isCodeOnlyPipeline(pipeline: string | null | undefined): boolean {
  return pipeline === 'code-self' || pipeline === 'code-group';
}

/**
 * `code` dependency guard: a `code` task of the `full` pipeline goes DONE
 * BEFORE its review and its merge exist, so a dependent started on a
 * `main` without its dependency's work (ACP job, 29/09/2026; only
 * the `scheduled_at` spacing made up for it).
 *
 * The dependency is satisfied only if the merge of the LAST iteration of its
 * chain is DONE. Always a wait (never BLOCKED): chain in progress,
 * blocked or in changes_requested, chain not created yet — a human or a
 * repair iteration unblocks it, and the reason is logged.
 *
 * Exceptions, where no chain can (or must) exist:
 *  - code-self / code-group pipeline: the coder, or a group merge, integrates;
 *  - `review`, `merge` or `doc` dependent: it is the chain itself (the review
 *    depends on the code, the merge on the review, the doc on the merge) — waiting for it here
 *    would be a deadlock. Not the `merge` that ends a job on its branch
 *    (`landing = 'pr'` opens the pull request, `'local'` merges the branch into
 *    its target): it depends on the job's code tasks and lands what their
 *    chains merged, so it waits for those merges like any dependent;
 *  - dependency without a branch or worktree (agent outside git): the verification-loop
 *    creates neither review nor merge (no diff);
 *  - `code` task of the chain marked merged (`merged_commit_sha`): integrated
 *    outside the chain.
 */
function codeChainGate(
  task: GatedTask,
  dep: DepTask,
  listChain: ChainLookup,
): DepGate | null {
  if (dep.type !== 'code') return null;
  if (task.type === 'review' || task.type === 'doc') return null;
  if (task.type === 'merge' && !task.landing) return null;
  if (isCodeOnlyPipeline(dep.pipeline)) return null;
  if (!dep.branch_name && !dep.worktree_path) return null;
  // Marked merged (TIM-0109): the branch landed outside the chain — a PR
  // merged on GitHub, a merge by hand — and no merge task will ever say so.
  if (dep.merged_commit_sha) return null;

  const chainTasks = listChain(dep.verification_root_id ?? dep.id);
  if (chainTasks.some((t) => t.type === 'code' && t.status === 'DONE' && t.merged_commit_sha)) return null;
  const reviews = chainTasks.filter((t) => t.type === 'review');
  const codes = chainTasks.filter((t) => t.type === 'code');
  const lastIter = Math.max(0, ...[...reviews, ...codes].map((t) => t.iteration ?? 1));

  // A newer code iteration or any review of the last iteration still open or
  // refusing means the chain has not converged.
  const pendingCode = codes.some((t) => (t.iteration ?? 1) === lastIter && t.status !== 'DONE');
  const latest = reviews.filter((t) => (t.iteration ?? 1) === lastIter);
  const approved =
    !pendingCode &&
    latest.length > 0 &&
    latest.every((t) => t.status === 'DONE' && parseReviewVerdict(t.done_comment).verdict === 'pass');
  const merge = approved ? latestMerge(chainTasks, latest) : undefined;
  if (merge?.status === 'DONE') return null;

  const wait = chainWait(dep, chainTasks);
  return {
    ok: false,
    blockedReason: null,
    waitingFor: wait.reason,
    ...(wait.awaitingRepairSince !== undefined ? { awaitingRepairSince: wait.awaitingRepairSince } : {}),
    ...(wait.awaitingRepairOf ? { awaitingRepairOf: wait.awaitingRepairOf } : {}),
  };
}

/**
 * Landing guard: a dependency integrated into an integration branch
 * (`feat/<topic>`) is in that branch only. A dependent of the same job (same
 * base, or no base yet: it inherits the dependency's) starts from the branch
 * and has what it needs. A dependent of ANY other base would start without the
 * work, so it waits until the branch lands (`docs/KANBAN-PR-PIPELINE.md`
 * §2.7). Always a wait: a pull request merged later frees it, and one closed
 * without a merge says so in the reason.
 */
function landingGate(task: GatedTask, dep: DepTask, landingOf: LandingLookup): DepGate | null {
  if (!task.base_branch || !dep.base_branch || task.base_branch === dep.base_branch) return null;
  const landing = landingOf(dep);
  if (landing === 'local' || landing === 'landed') return null;
  return {
    ok: false,
    blockedReason: null,
    waitingFor: landing === 'closed'
      ? `${dep.type} ${dep.id} is in ${dep.base_branch}, whose pull request was closed without a merge`
      : `${dep.type} ${dep.id} is integrated into ${dep.base_branch}, which has not landed in ${task.base_branch} yet`,
  };
}

/**
 * A DONE `code` task whose chain has not landed: a `code` task depending on it
 * still waits. The board offers "Merged outside Timon?" on it (TIM-0109), for
 * the PR merged on GitHub that no merge task will ever report.
 */
export function codeAwaitsMerge(dep: DepTask, listChain: ChainLookup): boolean {
  if (dep.status !== 'DONE') return false;
  return codeChainGate({ type: 'code', deps: '[]' }, dep, listChain) !== null;
}

/**
 * How long a dependent may wait for a repair iteration that nobody creates.
 *
 * The verification loop creates iteration N+1 within milliseconds of the
 * review's closure, and `reconcileMissingChangesRequested` replays a lost one
 * every 120 s. Ten minutes therefore means the chain is stuck, not slow
 * (TODO #322: a series frozen on "waiting for the repair iteration", logged
 * once, with no BLOCKED and no one woken).
 */
export const REPAIR_WAIT_BLOCK_MS = 10 * 60 * 1000;

/** Blocked reason for a dependent stuck behind a refused review with no repair
 *  iteration, or null while the wait is still plausible. Pure: the dispatcher
 *  passes `now`. `code` is null only for a gate built without the refused
 *  review's ids, whose English the translation could not mirror. */
export function repairWaitStall(gate: DepGate, now: number): { reason: string; code: DaemonMessage | null } | null {
  if (gate.ok || gate.awaitingRepairSince === undefined) return null;
  const waitedMs = now - gate.awaitingRepairSince;
  if (waitedMs < REPAIR_WAIT_BLOCK_MS) return null;
  const waited = Math.round(waitedMs / 60_000);
  const limit = Math.round(REPAIR_WAIT_BLOCK_MS / 60_000);
  const of = gate.awaitingRepairOf;
  return {
    reason:
      `${gate.waitingFor ?? 'Waiting for a repair iteration'} — no iteration has appeared in ` +
      `${waited} min (limit ${limit} min). ` +
      `The verification loop did not create one (iteration cap reached, chain root gone, or a lost event). ` +
      `Create the repair iteration by hand, or re-run the review, then unblock this task.`,
    code: of
      ? daemonMessage('repair_wait_stalled', { reviewId: of.reviewId, codeId: of.codeId, waited, limit })
      : null,
  };
}

/**
 * Evaluates a task's deps. General rule unchanged: every dep must
 * be DONE. Extra rule for `merge` tasks ONLY: a DONE `review`
 * dep is satisfied only if its verdict is `pass`.
 *
 * `changes_requested` AND `unknown` (empty or unparsable done_comment) both
 * block: we prefer a readable stall to an unvalidated merge — the absence of a
 * verdict is precisely what let batch L5 through.
 *
 * The other task types (`code`, `chore`, `doc`…) keep the historical
 * behaviour, even when their dep is a review: only the merge is concerned.
 *
 * Second rule, on the dependency itself: a `code` dep of the `full` pipeline
 * is satisfied only once the merge of its chain is DONE (`codeChainGate`).
 * Third: a dep integrated into an integration branch frees a dependent of
 * another base only once that branch landed (`landingGate`).
 */
export function evaluateDeps(
  task: GatedTask,
  getTask: (id: string) => DepTask | undefined,
  listChain: ChainLookup = NO_CHAIN,
  listFullChain: ChainLookup = listChain,
  landingOf: LandingLookup = ALWAYS_LOCAL,
): DepGate {
  let deps: string[];
  try {
    deps = JSON.parse(task.deps) as string[];
  } catch {
    return SATISFIED;
  }
  if (!Array.isArray(deps) || deps.length === 0) return SATISFIED;

  for (const depId of deps) {
    const dep = getTask(depId);
    if (!dep || dep.status !== 'DONE') return { ok: false, blockedReason: null };
    const chainGate = codeChainGate(task, dep, listFullChain);
    if (chainGate) return chainGate;
    const landed = landingGate(task, dep, landingOf);
    if (landed) return landed;
    if (task.type !== 'merge' || dep.type !== 'review') continue;

    const own = verdictGate(dep);
    if (own) return own;

    // Chain guard: the dep's verdict is not enough if ANOTHER review
    // lives on the same state of the code (nimbus incident of 2026-08-15: two
    // iter:4 reviews in parallel on commit 224c7ec, diverging verdicts, merge left
    // on the `pass` while the other's finding was real).
    for (const sibling of concurrentReviews(dep, listChain)) {
      // Concurrent review still alive: a mere wait, NEVER BLOCKED —
      // a future tick will see it finished, whereas a blocked task stays stuck
      // until a human sees it.
      if (sibling.status !== 'DONE') return { ok: false, blockedReason: null };
      const divergent = verdictGate(sibling);
      if (divergent) return divergent;
    }
  }
  return SATISFIED;
}
