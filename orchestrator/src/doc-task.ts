/**
 * Doc-task creator: for each `merge` task (or `code` task without a review/merge pipeline)
 * that goes DONE, automatically creates a `doc` task assigned to the librarian
 * as a dependent. The doc task receives in its description a structured summary of the change
 * to guide the documentation in the knowledge vault (wiki/projects/<slug>/).
 *
 * Trigger: `task-chain.ts`, at the task's CLOSING (`task_done`), AFTER
 * the verification-loop has finished chaining a possible review/merge.
 *
 * That order is load-bearing and was NOT guaranteed before: both
 * modules listened to the same `mission_complete`, but the verification-loop yields
 * on an `await` (git diff) before creating the review, while this
 * handler decides synchronously. It therefore always won the
 * race and saw the `code` task as terminal: on 2026-08-21, the code task
 * `wake : des retours de mission…` received ITS doc at 08:00 then a second one through
 * its merge at 08:07. `task-chain.ts` now sequences the two steps.
 *
 * Idempotency: the `chain_ran` guard (task-chain) bounds the trigger to
 * once per task run; `hasDocTask` stays as a second curtain (doc created
 * by hand, reconciliation).
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dbApi, isCodeOnlyPipeline, type TaskRow } from './db.js';
import { listAgents, loadConfig } from './agent.js';
import { taskProjectSlug } from './task-project.js';
import { agentDir } from './paths.js';
import { apiBaseUrl } from './api-url.js';
import { pendingLanding } from './chain-landing.js';

/** The name the librarian used to be REQUIRED to carry. Kept as a last
 *  resort for installs whose librarian predates roles. */
const LEGACY_LIBRARIAN = 'TIMON.librarian';

/**
 * Who documents a task: the agent that HOLDS the librarian role on its
 * project, else the one holding it with no project (the cross-project
 * librarian), else the historical name if it is still on disk.
 *
 * It was hard-coded to `TIMON.librarian`. An install whose librarian was
 * called anything else simply got no doc task, with a warning naming an agent
 * the user had never heard of.
 */
function librarianFor(slug: string | null): string | null {
  const librarians = listAgents().filter((a) => a.role === 'librarian');
  const onProject = slug
    ? librarians.find((a) => a.project?.toLowerCase() === slug.toLowerCase())
    : undefined;
  if (onProject) return onProject.name;
  const global = librarians.filter((a) => !a.project);
  if (global.length === 1) return global[0]!.name;
  if (librarians.length === 1) return librarians[0]!.name;
  return existsSync(agentDir(LEGACY_LIBRARIAN)) ? LEGACY_LIBRARIAN : null;
}

/**
 * Returns true if a non-doc task depends on taskId.
 * In that case taskId is not terminal — the doc will be created after the descendant task.
 */
function hasDownstreamNonDocTask(taskId: string): boolean {
  const allTasks = dbApi.listTasks();
  for (const t of allTasks) {
    if (t.type === 'doc') continue;
    let deps: string[];
    try { deps = JSON.parse(t.deps); } catch { continue; }
    if (deps.includes(taskId)) return true;
  }
  return false;
}

/** Returns true if a `doc` task already exists with this taskId in its deps. */
function hasDocTask(taskId: string): boolean {
  const allTasks = dbApi.listTasks();
  for (const t of allTasks) {
    if (t.type !== 'doc') continue;
    let deps: string[];
    try { deps = JSON.parse(t.deps); } catch { continue; }
    if (deps.includes(taskId)) return true;
  }
  return false;
}

function buildDocDescription(task: TaskRow, projectSlug: string | null): string {
  const lines: string[] = [
    `# Post-task documentation — ${task.title}`,
    ``,
    `**Task**: \`${task.id}\` (type \`${task.type}\`)`,
    `**Title**: ${task.title}`,
    projectSlug ? `**Project**: \`${projectSlug}\`` : `**Project**: (not set)`,
  ];
  if (task.branch_name) lines.push(`**Branch**: \`${task.branch_name}\``);
  if (task.merged_commit_sha) lines.push(`**Merged SHA**: \`${task.merged_commit_sha}\``);
  if (task.done_comment) lines.push(``, `**Summary of the change**:`, task.done_comment);
  lines.push(
    ``,
    `## What you must do`,
    `1. Read \`vault/CLAUDE.md\` (vault rules: front matter, cross-linking, language) and check with \`ls vault/\` that you are at the root of the vault repo.`,
    `2. Get the details of the parent mission through the \`timon\` MCP tools or`,
    `   \`GET ${apiBaseUrl()}/api/tasks/${task.id}\` + related missions.`,
    `3. Identify: (a) non-obvious decisions, (b) pitfalls/bugs, (c) reusable patterns.`,
    `   **Ignore** anything derivable from \`git log\` or the source code.`,
    `   Note: for a \`chore\` or \`research\` task, it is normal that nothing deserves recording — leave cleanly without writing if so.`,
    `4. Write into the vault — **every path is prefixed with \`vault/\`** (your cwd is the repo root,`,
    `   the vault is in \`vault/\`; without that prefix you create a ghost tree outside the sync):`,
    projectSlug
      ? `   - Project-specific lessons → \`vault/wiki/projects/${projectSlug}/\` (update \`_index.md\` or create a dedicated note).`
      : `   - No project slug — write only if the lesson is clearly cross-cutting (\`vault/wiki/topics/\`).`,
    `   - Cross-cutting lessons → \`vault/wiki/topics/<topic>.md\` + a link from the project note where relevant.`,
    `5. **If nothing is useful** → finish without writing, and say why in your done_comment.`,
    ``,
    `## Hard rules`,
    `- Follow the vault/CLAUDE.md format (front matter, language, topic-first, \`[[name]]\` cross-linking).`,
    `- No code recap nor activity summary (git log + TIMON events do that).`,
    `- 1 short, actionable note > 3 vague notes.`,
    `- No speculative writing: if you have no concrete lesson, leave.`,
  );
  return lines.join('\n');
}

/**
 * Creates the `doc` task of a freshly closed terminal task. Called by
 * `task-chain.ts` AFTER the verification-loop, so that terminality is
 * evaluated on a Kanban where the follow-up review/merge already exists.
 */
export async function maybeCreateDocTask(task: TaskRow): Promise<void> {
  // The `doc` task never generates a doc (no recursion).
  if (task.type === 'doc') return;

  // It is the TASK's status that is authoritative, never the mission's: a
  // task mission almost never ends as `completed` (the agent closes its
  // task, goes idle, the reaper SIGTERMs it → `terminated`). The filter
  // `ev.status === 'completed'` that guarded this handler until 2026-07-28 therefore
  // NEVER let anything through: 0 `completed` missions out of 501 in 60 days,
  // that is a single doc task created in two months.
  if (task.status !== 'DONE') return;

  // An investigation born from a backlog item (TODO) or a trigger already
  // writes its report into that TODO (`analyzed`): a librarian mission on top
  // closed empty 33 times out of 35 and cost one mission per enquiry. A
  // hand-launched research (neither link) keeps its doc.
  if (task.type === 'research' && (task.todo_id != null || task.trigger_id != null)) return;

  // A chore opened by a routine is the same job replayed on every tick (a
  // nightly backup, a cleanup): there is nothing new to record, and the
  // librarian closed every such doc empty, one wasted mission per run and a
  // stray return to the pilot. A code or research routine keeps its doc.
  if (task.type === 'chore' && task.routine_id != null) return;

  // "Code only" pipelines: day mode explicitly chosen by the user to
  // go fast, the doc does not have to slot in.
  if (isCodeOnlyPipeline(task.pipeline)) return;

  // Only create a doc if the task is terminal: no non-doc task depends on it.
  // Covers every pipeline: code→review→merge, code→review (without git), code only, chore, research.
  if (hasDownstreamNonDocTask(task.id)) return;

  // Integrated into an integration branch is not landed: a pull request can
  // still be refused, and a refused one is not documented. The landing replay
  // (`integration-landing.ts`) calls this again once the branch is merged.
  const waits = pendingLanding(task);
  if (waits) {
    console.log(`[doc-task] skip ${task.id}: integrated into ${waits}, documented when it lands`);
    return;
  }

  // Idempotency: skip if a doc task already exists for this task.
  if (hasDocTask(task.id)) {
    console.log(`[doc-task] skip ${task.id}: doc task already exists`);
    return;
  }

  const cfg = loadConfig(task.agent_name);
  const projectSlug = taskProjectSlug(task, cfg);

  const librarian = librarianFor(projectSlug);
  if (!librarian) {
    console.warn('[doc-task] no agent holds the librarian role — skip');
    return;
  }

  const docTaskId = randomUUID();
  const description = buildDocDescription(task, projectSlug);

  // timon-task is injected in extra_skills so that the librarian can
  // close its task with `timon task done`. The librarian agent does not have this
  // skill by default (its original system prompt had no TASK_ID).
  dbApi.createTask(docTaskId, `doc: ${task.title}`, librarian, {
    description,
    type: 'doc',
    deps: [task.id],
    priority: 2,
    extraSkills: ['timon-task'],
    project: task.project,
    baseBranch: task.base_branch,
    integrationMode: task.integration_mode ?? null,
    baseRef: task.base_ref ?? null,
    // The doc belongs to the same work as the task it documents: without this
    // attachment, it escapes the series' fallback plan and its return
    // has no pilot to come back to.
    seriesId: task.series_id,
    planGroup: task.plan_group,
    creatorMissionId: task.creator_mission_id,
    parentTaskId: task.id,
    // A silent task's chain stays silent: its doc would otherwise report up
    // the very thread the trigger kept out of it.
    silentReturn: task.silent_return === 1,
  });

  console.log(`[doc-task] created doc task ${docTaskId} ← task ${task.id} (${task.type}: ${task.title})`);
}
