/**
 * Verification loop: turns an agent that writes code into a system that
 * produces reliable code, by systematically wiring a code → review (→ code →
 * review ... bounded) cycle after every finished `code` task.
 *
 * Wiring: no listener here any more. `task-chain.ts` owns the single
 * `task_done` subscription and calls `runVerificationChain` — so the chain
 * starts from the task's CLOSURE, no longer from the death of the process that
 * ran it.
 *
 * Why that move (2026-08-21): `mission_complete` is only emitted on idle reap
 * (`TIMON_REAP_IDLE_MS` = 600,000 ms), not on closure. Measured that same
 * morning: review `98e28f1a` closed at 09:47:28 with `changes_requested`, code
 * task iter:2 created at 09:58 — 11 minutes during which the Kanban was empty
 * and the job looked finished. Systematic on every code → review → merge → doc
 * chain, not an edge case.
 *
 * Welcome side effect: the registration-order constraint disappears.
 * `task_done` is published BY the write that sets status=DONE
 * (dbApi.updateTaskStatus / setTaskStatusOnly), so the status is in the
 * database by construction when our handlers run — no more need to register
 * after `startDispatcher()`.
 *
 * Flow:
 *   1. `code` task → DONE with a non-empty diff → automatically spawns a
 *      `review` task on the same worktree (inherited through deps in the
 *      dispatcher). The iteration stays at 1 and `verification_root_id` points
 *      at the original code task.
 *   2. `review` task → DONE → we parse `done_comment` to extract a structured
 *      verdict (`pass` or `changes_requested`).
 *      - `pass` → stop, the merger (or the human) takes over.
 *      - `changes_requested` → respawn a `code` task at iteration N+1, deps on
 *        the review, worktree pre-filled (reuses the root's branch).
 *   3. MAX_ITERATIONS cap. A review that would ask for iteration MAX+1
 *      → we mark the root task BLOCKED with an explicit blocked_reason
 *      (escalation visible on the Kanban). No `ask_user` here: it requires a
 *      live mission_id and a tool_use_id (see permissions.ts), which is
 *      incompatible with a post-mortem trigger on the orchestrator side.
 *
 * Safeguards:
 *   - No second review/merge if one already depends on the task (the agent
 *     may have created it by hand through the timon-task skill). For the
 *     repair iteration the test is stricter: only a `code` task of the SAME
 *     chain at iteration N+1 counts — a series task merely pre-wired behind the
 *     review is not an answer to it (TODO #322).
 *   - Unknown verdict or empty done_comment → no-op + warning (a stall is
 *     preferable to an empty loop).
 *   - `chore`/`doc`/`research` tasks are ignored (code/review only).
 */
import { randomUUID } from 'node:crypto';
import { dbApi, isCodeOnlyPipeline, type TaskRow } from './db.js';
import { loadConfig } from './agent.js';
import { taskProjectSlug } from './task-project.js';
import { readRoles } from './projects.js';
import { inheritedLlm, resolveRoleAgent } from './agent-seed.js';
import { notifyUser } from './notify.js';
import { warnSandboxCascadeAhead } from './sandbox-cascade.js';
import { parseReviewVerdict } from './review-verdict.js';
import { execFileHost } from './host/index.js';
import { integrateMergeMessage } from './worktree.js';

const exec = execFileHost;
const MAX_ITERATIONS = 3;

// Parsing a review verdict lives in `review-verdict.ts`: it is shared with the
// dispatcher (dispatch gate for pre-created merge tasks). Re-exported here so
// existing imports keep working.
export { parseReviewVerdict };

async function diffSummary(task: TaskRow): Promise<{ stat: string; hasChanges: boolean } | null> {
  if (!task.worktree_path || !task.base_branch) return null;
  try {
    const r = await exec(
      'git',
      ['-C', task.worktree_path, 'diff', '--stat', `${task.base_branch}...HEAD`],
      { timeout: 5_000 },
    );
    const stat = r.stdout.trim();
    return { stat, hasChanges: stat.length > 0 };
  } catch {
    return null;
  }
}

function projectOfTask(task: TaskRow): string | null {
  try {
    const cfg = loadConfig(task.agent_name);
    return taskProjectSlug(task, cfg);
  } catch {
    return null;
  }
}

/** Host cwd of a task's agent (project root) — required to seed a child agent.
 *  Null if the config cannot be read. */
function cwdOfTask(task: TaskRow): string | null {
  try {
    return loadConfig(task.agent_name).cwd ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves the agent to assign to an auto-generated `review`/`merge` task, with
 * a sane default: the roles.json `<type>.agent` override if there is one,
 * OTHERWISE the `<slug>.<role>` convention — the agent being seeded along the
 * way through resolveRoleAgent. That way a project WITHOUT roles.json still
 * gets a dedicated reviewer/merger instead of seeing the review skipped or the
 * merge falling back on the main agent. `cwd` is needed for the seed (host path
 * of the project root).
 */
export function roleAgentForProject(
  slug: string | null,
  cwd: string | null,
  taskType: 'review' | 'merge',
  root: TaskRow | null = null,
): string | null {
  if (!slug) return null;
  const role = taskType === 'review' ? 'reviewer' : 'merger';
  let spec;
  try {
    spec = readRoles(slug.toLowerCase())[taskType];
  } catch {
    spec = undefined;
  }
  // A reviewer or merger seeded here runs for the pilot that ordered the job:
  // on its backend, not on Claude by default (TIM-0082).
  const inherit = root ? inheritedLlm(root.creator_mission_id) : null;
  return resolveRoleAgent(slug, role, { cwd, spec, inherit });
}

/** True if a task of the given type already depends on `taskId`.
 *  O(n) over the kanban — acceptable as long as tasks stay in the hundreds. */
function hasChildTask(taskId: string, type: 'review' | 'merge'): boolean {
  for (const t of dbApi.listTasks()) {
    if (t.type !== type) continue;
    let deps: string[];
    try { deps = JSON.parse(t.deps) as string[]; } catch { continue; }
    if (deps.includes(taskId)) return true;
  }
  return false;
}

/**
 * The repair iteration answering a `changes_requested` review: a `code` task of
 * the SAME verification chain at iteration N+1.
 *
 * `hasChildTask(review, 'code')` used to stand here and counted ANY `code` task
 * whose `deps` held the review — including a series task an orchestrator
 * pre-wired behind it as a gate. Such a task is not a repair: it waits for the
 * chain to converge (merge-gate `codeChainGate`), so counting it left the chain
 * with no iteration and nothing to wake it (TODO #322, 2026-10-12).
 */
function findIterationChild(review: TaskRow, rootId: string): TaskRow | undefined {
  const next = review.iteration + 1;
  return dbApi
    .listTasksByVerificationRoot(rootId)
    .find((t) => t.type === 'code' && t.iteration === next);
}

async function handleCodeDone(task: TaskRow): Promise<void> {
  // "Code only" pipelines (daytime mode): The user explicitly asked for neither a
  // review nor a verification loop. This is the ONLY automatic path to BLOCKED
  // (iteration cap): cutting it here also cuts automatic blocking, which is
  // exactly what the mode intends.
  if (isCodeOnlyPipeline(task.pipeline)) {
    console.log(`[verification] code ${task.id} pipeline=${task.pipeline} — skip review`);
    return;
  }
  if (hasChildTask(task.id, 'review')) return;
  // Marked merged by hand (TIM-0109): reviewing a branch already integrated
  // would only start a chain nobody needs.
  if (task.merged_commit_sha) {
    console.log(`[verification] code ${task.id} marked merged (${task.merged_commit_sha}) — skip review`);
    return;
  }

  // One live review per verification chain. `hasChildTask` only deduplicates by
  // dep (hence by code task): two code tasks of the same chain — an iteration
  // respawn and a review created by hand through the timon-task skill — each
  // produced their own review without seeing the other. That is what had two
  // iter:4 reviews running in parallel on the same commit on 2026-08-15
  // (nimbus project), with diverging verdicts and a merge based on only one of
  // the two.
  const chainRootId = task.verification_root_id ?? task.id;
  const pending = dbApi
    .listTasksByVerificationRoot(chainRootId)
    .find((t) => t.type === 'review' && t.status !== 'DONE');
  if (pending) {
    console.warn(
      `[verification] code ${task.id} DONE but review ${pending.id} (${pending.status}) ` +
      `is already live on chain ${chainRootId} — skip (no second concurrent review)`,
    );
    return;
  }

  const diff = await diffSummary(task);
  if (!diff || !diff.hasChanges) {
    console.log(`[verification] code ${task.id} DONE with no diff — skip review`);
    return;
  }

  const project = projectOfTask(task);
  const reviewer = roleAgentForProject(project, cwdOfTask(task), 'review', task);
  if (!reviewer) {
    console.warn(`[verification] code ${task.id}: project slug not found (agent=${task.agent_name}) — skip review`);
    return;
  }

  const iteration = task.iteration;
  const rootId = chainRootId;
  const root = dbApi.getTask(rootId) ?? task;

  const reviewId = randomUUID();
  const description = [
    `Automatic review of code task [${task.id}] (iteration ${iteration}/${MAX_ITERATIONS}).`,
    ``,
    `Branch: \`${task.branch_name ?? '?'}\` (base \`${task.base_branch ?? '?'}\`)`,
    `Worktree: \`${task.worktree_path ?? '?'}\``,
    ``,
    `## Diff (stat)`,
    '```',
    diff.stat,
    '```',
    ``,
    `## Original mission (root ${rootId})`,
    root.description ?? root.title,
    ``,
    `## Expected format for your \`timon task done --comment\``,
    `**FIRST LINE MANDATORY, in plain text** (it alone carries the verdict — it survives any truncation):`,
    '```',
    `verdict: pass`,
    '```',
    `or \`verdict: changes_requested\`. The JSON details below are optional (the verdict does NOT depend on them):`,
    '```json',
    `{`,
    `  "findings": ["finding 1", "finding 2"],`,
    `  "suggested_fixes": "actionable instructions for the coder if changes_requested, otherwise empty"`,
    `}`,
    '```',
    `If the comment is long, pass it via \`--comment-file PATH\` or \`--comment-stdin\` rather than as an inline shell argument (avoids quoting truncation).`,
    `If \`changes_requested\`, the coder will be respawned automatically with your \`suggested_fixes\` injected into its prompt — be precise and actionable.`,
  ].join('\n');

  dbApi.createTask(reviewId, `review iter:${iteration} — ${root.title}`, reviewer, {
    description,
    priority: Math.max(root.priority, 4),
    deps: [task.id],
    type: 'review',
    // The explicit slug propagates down the chain: without inheritance the
    // child would fall back on the agent and lose role resolution.
    project: root.project,
    // The base is part of the job too: the review carries it for the brief and
    // the merge that follows inherits it from the root.
    baseBranch: task.base_branch ?? root.base_branch,
    // Same for the job: a review belonging to no series would escape the
    // fallback plan and its returns would have no pilot.
    seriesId: root.series_id,
    // The group of volets too: it is what picks the review's LLM (TODO #433).
    planGroup: root.plan_group,
    // And the batch: outside it, the batch looked finished between the last
    // code's closure and its review, so the end-of-batch recap left before any
    // review or merge had run (TODO #521).
    groupId: root.group_id,
    creatorMissionId: root.creator_mission_id,
    parentTaskId: task.id,
  });
  dbApi.setTaskVerificationMeta(reviewId, iteration, rootId);
  console.log(
    `[verification] code ${task.id} DONE → review ${reviewId} (iter ${iteration}, reviewer=${reviewer})`,
  );
  const created = dbApi.getTask(reviewId);
  if (created) warnSandboxCascadeAhead(created);
}

/** Review approved → creates the `merge` task that integrates the branch into
 *  main. Closes the code → review → merge → doc chain (the doc task is then
 *  created by doc-task.ts when the merge is DONE). Idempotent: skipped if a
 *  merge already depends on this review. */
async function spawnMergeTask(review: TaskRow): Promise<void> {
  if (hasChildTask(review.id, 'merge')) {
    console.log(`[verification] review ${review.id} pass → merge already exists, skip`);
    return;
  }
  const rootId = review.verification_root_id ?? review.id;
  const root = dbApi.getTask(rootId) ?? review;
  const project = projectOfTask(review);
  // Sane default: the project's merge role (roles.json) or the {slug}.merger
  // convention seeded on the fly; falls back on the root's agent only if the
  // slug cannot be found (the root's cwd is the project root for the seed).
  const merger = roleAgentForProject(project, cwdOfTask(root), 'merge', root) ?? root.agent_name;

  const branch = root.branch_name ?? review.branch_name ?? '?';
  // Known base only: a null stays null so the dispatcher's fallback is the one
  // that decides, rather than a 'main' this task never had.
  const knownBase = root.base_branch ?? review.base_branch ?? null;
  const base = knownBase ?? 'main';
  const mergeId = randomUUID();
  const description = [
    `Automatic merge: review [${review.id}] approved (verdict pass) the branch produced by code task [${rootId}].`,
    ``,
    `**Branch to integrate**: \`${branch}\` → \`${base}\``,
    ``,
    `## What to do`,
    `1. From YOUR worktree (the dispatcher created a dedicated one for you — see`,
    `   the "Where you integrate" section at the end of the brief), integrate`,
    `   \`${branch}\` and resolve conflicts sensibly. NEVER work in the main repo:`,
    `   \`git merge --no-ff -m "${integrateMergeMessage(base)}" ${branch}\``,
    `2. Check that \`npx tsc --noEmit\` passes (orchestrator/ and app/ if touched) before finishing.`,
    `3. Advance \`${base}\` with the fast-forward given at the end of the brief, then take`,
    `   the FULL sha (40 hex) for \`timon task done --merged-sha\`.`,
    `4. Non-trivial conflict or broken build → do NOT force it: leave the task BLOCKED with the reason (the orchestrator will escalate).`,
    `5. Never delete a file your branch does not ask to delete: an automatic`,
    `   check detects it and will hand the task back to you for repair.`,
    ``,
    `Merge commits carry an explicit English message (\`-m\`) with no task or mission id, and no mention of Claude/Anthropic/Co-Authored-By: git's default message names the task branch, which a public repository's commit-msg hook refuses.`,
  ].filter(Boolean).join('\n');

  dbApi.createTask(mergeId, `merge — ${root.title}`, merger, {
    description,
    priority: Math.max(root.priority, 3),
    deps: [review.id],
    type: 'merge',
    project: root.project,
    // Without it the merger advanced the repo's ACTIVE branch (18/10/2026: four
    // merges about to land on a feature branch instead of `main`).
    baseBranch: knownBase,
    seriesId: root.series_id,
    planGroup: root.plan_group,
    groupId: root.group_id,
    creatorMissionId: root.creator_mission_id,
    parentTaskId: review.id,
  });
  console.log(`[verification] review ${review.id} pass → merge ${mergeId} (merger=${merger})`);
  const created = dbApi.getTask(mergeId);
  if (created) warnSandboxCascadeAhead(created);
}

async function handleReviewDone(task: TaskRow): Promise<void> {
  if (!task.verification_root_id) {
    // A review created by hand carries no chain: nothing to iterate or merge.
    console.log(`[verification] review ${task.id} DONE outside a verification chain (no verification_root_id) — skipped`);
    return;
  }
  const parsed = parseReviewVerdict(task.done_comment);
  if (parsed.verdict === 'pass') {
    await spawnMergeTask(task);
    return;
  }
  if (parsed.verdict === 'unknown') {
    // Before: a silent `return` → the review stayed DONE and the chain died
    // quietly (no merge, no respawn, no escalation): the most common stall
    // (a reviewer writing prose instead of JSON). We now move the review to
    // BLOCKED → emits task_blocked → the wake loop wakes the orchestrator
    // (which can re-drive or escalate to the user). Never silent again.
    const reason =
      `Review verdict not parsable in done_comment (expected: JSON {"verdict":"pass"|"changes_requested",...}). ` +
      `done_comment received: ${(task.done_comment ?? '(empty)').slice(0, 300)}`;
    console.warn(`[verification] review ${task.id} verdict not parsable → BLOCKED (escalated through wake)`);
    dbApi.updateTaskStatus(task.id, 'BLOCKED', { blockedReason: reason });
    notifyUser(
      `Review with no usable verdict: ${task.title}`,
      `Review ${task.id} closed without a parsable JSON verdict, so the code→review→merge chain cannot continue.\n\n${reason}\n\nRe-trigger the review or decide manually (merge / new code iteration).`,
      { taskId: task.id, fromMission: task.mission_id },
    );
    return;
  }

  const rootId = task.verification_root_id;
  const root = dbApi.getTask(rootId);
  if (!root) {
    // Thrown, not returned: a silent exit let task-chain mark the chain DONE
    // with no iteration created. The throw keeps it replayable and, after
    // MAX_CHAIN_ATTEMPTS, escalates it (CHAIN_FAILED + notification).
    console.error(`[verification] review ${task.id} changes_requested → skipped: chain root ${rootId} no longer exists`);
    throw new Error(`review ${task.id} requested changes but its chain root ${rootId} no longer exists — no iteration can be created`);
  }
  const nextIter = task.iteration + 1;

  if (nextIter > MAX_ITERATIONS) {
    const reason = [
      `Verification loop: cap of ${MAX_ITERATIONS} iterations reached without a 'pass' verdict.`,
      ``,
      `Last review: ${task.id}`,
      `Last feedback:`,
      parsed.feedback ?? '(none)',
      ``,
      `Human intervention required — unblock manually after review.`,
    ].join('\n');
    dbApi.updateTaskStatus(rootId, 'BLOCKED', { blockedReason: reason });
    console.warn(
      `[verification] root ${rootId} → BLOCKED (cap ${MAX_ITERATIONS} reached, review ${task.id})`,
    );
    return;
  }

  const existing = findIterationChild(task, rootId);
  if (existing) {
    console.log(
      `[verification] review ${task.id} changes_requested → skipped: iteration ${nextIter} ` +
      `already exists (${existing.id}, ${existing.status})`,
    );
    return;
  }

  // The code iteration this review judged, not the root: a pilot that re-routed
  // iter:N by hand (kanban_update) means iter:N+1 to keep that choice.
  let reviewDeps: string[] = [];
  try { reviewDeps = JSON.parse(task.deps) as string[]; } catch { /* root below */ }
  const reviewed = reviewDeps
    .map((id) => dbApi.getTask(id))
    .find((t): t is TaskRow => t?.type === 'code');
  const llmSource = reviewed ?? root;

  const codeId = randomUUID();
  const description = [
    root.description ?? '',
    ``,
    `---`,
    `## Reviewer feedback (iter ${task.iteration} → ${nextIter})`,
    parsed.feedback ?? '(the reviewer provided no suggested_fixes — read their done_comment)',
    ``,
    `You are working on the same branch \`${root.branch_name ?? '?'}\` and the same worktree as the previous version. Amend or extend the existing commits to answer the points raised.`,
  ].join('\n');

  dbApi.createTask(codeId, `${root.title} [iter:${nextIter}]`, root.agent_name, {
    description,
    priority: root.priority,
    deps: [task.id],
    type: 'code',
    project: root.project,
    seriesId: root.series_id,
    creatorMissionId: root.creator_mission_id,
    parentTaskId: task.id,
    // The LLM chosen for the job is part of the job, like its worktree: without
    // this, iter:2 silently fell back to the role/agent model mid-job (task
    // 1a25fadc, 2026-09-17). Review and merge children deliberately do NOT
    // inherit these — they resolve on their own role/series pair, which is how
    // code and review run on different LLMs.
    backendOverride: llmSource.backend_override,
    modelOverride: llmSource.model_override,
    fallbackBackendOverride: llmSource.fallback_backend_override,
    fallbackModelOverride: llmSource.fallback_model_override,
    permissionModeOverride: llmSource.permission_mode_override,
    // Batch and pipeline are the job's lineage, like project and series: an
    // iteration outside the group lets the end-of-batch recap fire while it
    // still runs, and a null pipeline would silently mean 'full'.
    groupId: root.group_id,
    planGroup: root.plan_group,
    pipeline: root.pipeline,
    baseBranch: root.base_branch,
  });
  dbApi.setTaskVerificationMeta(codeId, nextIter, rootId);
  // Pre-fills the worktree → the dispatcher sees the columns are already set
  // and reuses them as is (see the idempotent branch of resolveWorktree),
  // instead of creating a new branch for this task.
  if (root.worktree_path && root.branch_name && root.base_branch) {
    dbApi.setTaskWorktree(codeId, root.worktree_path, root.branch_name, root.base_branch);
  }
  console.log(
    `[verification] review ${task.id} changes_requested → code ${codeId} (iter ${nextIter})`,
  );
}

/**
 * Catch-up window. An indispensable bound: before this net existed, branches
 * were merged by hand with no `merge` task tied to their review. With no age
 * limit, reconcile would take them for broken chains and spawn merges on
 * already integrated branches. A genuinely broken chain shows up in minutes,
 * not in days.
 */
const RECONCILE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Safety net: catches broken review→merge chains.
 *
 * `handleReviewDone` only runs on the `task_done` event, and that event is
 * volatile — it is lost if the review turns DONE while no listener is
 * registered (orchestrator restarted mid-flight, write performed by another
 * process), or if the chain fails along the way. When it is lost, the work is
 * approved but NEVER integrated, and nothing flags it: every task shows DONE.
 * Lived through on 2026-08-04 on the vault API task (review iter:2 verdict
 * `pass`, a two-commit branch never merged, found by hand).
 *
 * Rather than guessing which cause applies, we periodically rebuild the
 * expected state: every DONE review with a `pass` verdict, attached to a
 * verification chain, must have a child merge task. `spawnMergeTask` is
 * idempotent (the `hasChildTask` guard), so running over it again creates no
 * duplicate.
 *
 * Scheduled by `reconcile.ts`, which carries all of the system's invariants.
 */
export async function reconcileMissingMerges(): Promise<void> {
  const cutoff = Date.now() - RECONCILE_MAX_AGE_MS;
  for (const task of dbApi.listTasks()) {
    if (task.type !== 'review' || task.status !== 'DONE') continue;
    if (task.updated_at < cutoff) continue;
    if (!task.verification_root_id) continue;
    if (isCodeOnlyPipeline(task.pipeline)) continue;
    if (parseReviewVerdict(task.done_comment).verdict !== 'pass') continue;
    if (hasChildTask(task.id, 'merge')) continue;
    // We do not start a further iteration here: if the root has already moved
    // on (code iter N+1), the chain is living its life and this review is a
    // legitimate dead end.
    if (findIterationChild(task, task.verification_root_id)) continue;

    console.warn(`[verification] reconcile: review ${task.id} pass with no merge → catch-up creation`);
    try {
      await spawnMergeTask(task);
    } catch (err) {
      console.error(`[verification] reconcile: failed on ${task.id}: ${(err as Error).message}`);
    }
  }
}

/**
 * Safety net: catches broken code→review chains.
 *
 * Symmetric to `reconcileMissingMerges`, and added for the same reason one
 * notch higher in the chain: nothing was watching UPSTREAM. A closed `code`
 * task whose review had never started (chain killed in flight between the
 * closure and the review's creation) fell off the radar with no signal at all —
 * and the wake loop assumed that "full pipeline ⇒ the review follows" and did
 * not wake the pilot. Result: work finished, never reviewed, never integrated,
 * and a Kanban that simply looks empty.
 *
 * The invariant: every DONE `code` task on a `full` pipeline, with a non-empty
 * diff, has a child review task. `handleCodeDone` already carries every guard
 * (existing child review, live review elsewhere on the chain, empty diff,
 * project not found) and is therefore idempotent: replaying it on a healthy
 * system creates nothing.
 *
 * Scheduled by `reconcile.ts`, which carries all of the system's invariants.
 */
export async function reconcileMissingReviews(): Promise<void> {
  const cutoff = Date.now() - RECONCILE_MAX_AGE_MS;
  for (const task of dbApi.listTasks('DONE')) {
    if (task.type !== 'code') continue;
    if (task.updated_at < cutoff) continue;
    if (isCodeOnlyPipeline(task.pipeline)) continue;
    if (hasChildTask(task.id, 'review')) continue;
    console.warn(`[verification] reconcile: code ${task.id} DONE with no review → catch-up`);
    try {
      // Go back through the nominal path: same guards, same logs, no duplicated
      // logic that could drift from the live version.
      await handleCodeDone(task);
    } catch (err) {
      console.error(`[verification] reconcile: failed on ${task.id}: ${(err as Error).message}`);
    }
  }
}

/**
 * Safety net: catches `changes_requested` reviews that produced no iteration.
 *
 * Symmetric to `reconcileMissingMerges` / `reconcileMissingReviews` for the
 * third exit of the chain. A review closed `changes_requested` whose chain was
 * marked CHAIN_DONE without creating iteration N+1 (2026-10-12, review
 * da2cae59: a series task depending on the review was taken for the repair)
 * left the series frozen — the dispatcher only logged "waiting for the repair
 * iteration" — and `reconcileUnchainedTasks` could not see it, the chain being
 * DONE. Invariant: every DONE review with a `changes_requested` verdict on a
 * verification chain has an iteration N+1 on that chain.
 *
 * Bounds:
 *   - iteration cap respected: a review that would ask for iteration
 *     MAX+1 is left to the nominal path (explicit BLOCKED of the root). Replaying
 *     it here every 120 s would fight a human who unblocked the root;
 *   - a missing or BLOCKED root is skipped (chain abandoned by hand, or already
 *     escalated), otherwise the same failure would repeat on every pass;
 *   - 6 h window, like the other two.
 *
 * Goes back through `handleReviewDone`: same guards, same logs, no duplicated
 * logic. Idempotent: `findIterationChild` finds the iteration it created.
 *
 * Registered by the `kanban-code` plugin next to its siblings.
 */
export async function reconcileMissingChangesRequested(): Promise<void> {
  const cutoff = Date.now() - RECONCILE_MAX_AGE_MS;
  for (const task of dbApi.listTasks('DONE')) {
    if (task.type !== 'review') continue;
    if (task.updated_at < cutoff) continue;
    if (!task.verification_root_id) continue;
    if (isCodeOnlyPipeline(task.pipeline)) continue;
    if (parseReviewVerdict(task.done_comment).verdict !== 'changes_requested') continue;
    if (task.iteration + 1 > MAX_ITERATIONS) continue;
    const root = dbApi.getTask(task.verification_root_id);
    if (!root || root.status === 'BLOCKED') continue;
    if (findIterationChild(task, task.verification_root_id)) continue;

    console.warn(`[verification] reconcile: review ${task.id} changes_requested with no iteration → catch-up`);
    try {
      await handleReviewDone(task);
    } catch (err) {
      console.error(`[verification] reconcile: failed on ${task.id}: ${(err as Error).message}`);
    }
  }
}

/**
 * Verification chain for a freshly closed task: `code` → review, `review` →
 * merge or next iteration. Called by `task-chain.ts` on closure (the
 * `task_done` event), once per task execution (the `chain_ran` guard). Other
 * types are ignored.
 *
 * Awaitable: the caller must be able to wait for the follow-up task to be
 * created before evaluating terminality (doc) or group completion — otherwise
 * it would observe a state where the follow-up does not exist yet (see
 * task-chain.ts).
 */
export async function runVerificationChain(task: TaskRow): Promise<void> {
  if (task.status !== 'DONE') return;
  if (task.type === 'code') return handleCodeDone(task);
  if (task.type === 'review') return handleReviewDone(task);
}

export const VERIFICATION_MAX_ITERATIONS = MAX_ITERATIONS;
