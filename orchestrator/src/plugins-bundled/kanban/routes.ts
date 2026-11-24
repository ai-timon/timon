/**
 * Module `kanban` — the generic backlog: tasks, pipelines, series fallback
 * plans. Tier `std`. The "code" half (git worktrees, merge) lives in
 * `kanban-code`, which may be missing.
 *
 * Routes extracted verbatim from `index.ts` (step 1.4).
 */
import express, { type Router } from 'express';
import { z } from 'zod';
import { AgentConfig, listAgents, stopSettledTaskMission } from '../../agent.js';
import { bus, type BusEvent } from '../../bus.js';
import { backendIdForModel, catalogClaimsModel } from '../../backends/catalog.js';
import { asBackendName } from '../../backends/index.js';
import { codeCloseRefusal, effectiveMergeSha, evaluateCodeDone, inspectGitBranch, mergeCloseRefusal, pullRequestCloseRefusal, shaInBase, taskRepo } from '../../code-gate.js';
export { codeCloseRefusal, effectiveMergeSha, mergeCloseRefusal, pullRequestCloseRefusal } from '../../code-gate.js';
import { config } from '../../config/load.js';
import { FALLBACK_SCOPES, TASK_TYPES, db, dbApi, isCodeOnlyPipeline, isFallbackScope, isTaskType, normalizeTaskStatusInput, rowVisible, type TaskDeleteOutcome, type TaskDeleteResult, type TaskRow, type TaskType } from '../../db.js';
import { forbidden, forbiddenBody, isPersonAuth, rejectIfDenied, requireAuth, viewerFromRequest } from '../../users/identity.js';
import { scopedDb, type ScopedDb } from '../../users/scoped-db.js';
import { resolveTaskLlm, type SeriesLlmChoice } from '../../dispatcher.js';
import {
  clearSeriesFallbackRule, clearSeriesRoleChoice, listSeriesFallbackRules, listSeriesRoleChoices, parsePlanGroup, resolveSeriesId,
  SeriesParamSchema, seriesLlmChoice, SeriesServiceError, seriesVisibleTo, setSeriesFallbackRule, setSeriesRoleChoice,
  type FallbackRuleInput,
} from '../../series-service.js';
import { applySeriesFallbackRule } from '../../backend-fallback.js';
import { automationOriginOf, emitAutomationEvent } from '../../plugins/automation-events.js';
import { createPipeline, deletePipeline, getPipeline, getRunStatus, listPipelines, pipelineRunVisibleTo, pipelineVisibleTo, pipelineWritableBy, runPipeline, type Pipeline, type PipelineDefinition, updatePipeline } from '../../pipelines.js';
import { readRoles, type RoleSpec, type TaskRole } from '../../projects.js';
import { isTemplateBackend, llmOfMission, previewRoleAgent, roleForTaskType } from '../../agent-seed.js';
import { taskProjectSlug } from '../../task-project.js';
import { codeAwaitsMerge } from '../../merge-gate.js';
import { integrationTargetLabel, usesIntegrationBranch } from '../../git-integration.js';
import { chainLanding, integrationOfTask } from '../../chain-landing.js';
import { concludeMerged, type Notify } from '../../integration-poller.js';
import { applyTodoClosure } from '../../todo-closure.js';
import { checkScheduledAtPlausibility, validateScheduledAt } from '../../task-guards.js';
import { delegatingAgent, delegationRefusal } from '../../delegation-guard.js';
import { agentRequeueDelayMs, agentRequeueRefusal, isCorrection } from '../../crash-loop.js';
import { loadConfig } from '../../agent-config.js';
import { readSkillsAllowedTools } from '../../skills.js';
import { auditRequest } from '../../users/audit-actor.js';
import {
  canonicalizePermissionMode, isPrivilegedCaller, llmChoiceRefusal, overrideAuthority, rejectOverride, spawnWideningDenied, taskOverrideRefusal,
  type TaskOverrides,
} from '../../users/privileged-overrides.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { gitTaskRefusal, isPlausibleGitRef } from '../../task-git.js';
import { taskOriginFromRequest, withTaskOrigin } from '../../task-origin.js';
import { backendRefusal, landingRefusal, pipelineRefusal, planGroupRefusal, projectRefusal } from './task-field-guards.js';
import { isClosingOnly, parseTaskUpdateBody } from './task-update-body.js';
import { parseAttachSeriesBody, parseMarkMergedBody, parseTaskCloseBody } from './task-write-bodies.js';
import { parsePipelineCreateBody, parsePipelineRunBody, parsePipelineUpdateBody } from './pipeline-body.js';
import { isOwnMissionTask, ownMissionTaskId } from './own-task.js';
import { parseTaskCreateBody, type TaskCreateBody } from './task-create-body.js';
import { countTaskAttachments, publicTaskAttachment, taskAttachmentsWithInherited } from '../../attachments.js';
import { apiError, type ApiErrorBody } from '../../api-error.js';

/** `:id` of a series route, resolved by the shared rule (`series-service.ts`). */
function resolveSeriesParam(req: express.Request): string | null {
  return resolveSeriesId(String(req.params.id ?? ''), req.header('X-TIMON-Mission') ?? undefined);
}

/**
 * Longest `description` / `done_comment` the list sends by default. The board
 * shows two lines of description and a short closing note per card; the full
 * texts (8.6 MB of the 12 MB answer on 2,571 tasks, 26/09/2026) were reparsed
 * every 5 s by an open Kanban tab. The full text stays on `GET /api/tasks/:id`
 * and on `GET /api/tasks?full=1`.
 */
export const TASK_PREVIEW_CHARS = { description: 280, done_comment: 600 } as const;

function preview(text: string | null, max: number): string | null {
  if (text == null || text.length <= max) return text;
  return `${text.slice(0, max).trimEnd()}…`;
}

const BOARD_STATUSES: readonly string[] = ['PENDING', 'IN_PROGRESS', 'DONE', 'BLOCKED'];

/**
 * The list only speaks the four statuses the board has columns for. A row
 * carrying another one (TIM-0101: `CANCELLED`, left by an older version or a
 * hand edit) is a task that no longer runs: it is shown as DONE, never as
 * BLOCKED, which asks for a human. Read-side only — the stored value is kept,
 * and the dispatcher keeps seeing the raw status, so a task is never released
 * as completed because of this display rule.
 */
export function boardStatusRow<T extends TaskRow>(task: T): T {
  return BOARD_STATUSES.includes(task.status) ? task : { ...task, status: 'DONE' };
}

/** A task as the list sends it by default: every column, long texts cut. */
export function boardTaskRow(task: TaskRow): TaskRow {
  return {
    ...task,
    description: preview(task.description, TASK_PREVIEW_CHARS.description),
    done_comment: preview(task.done_comment, TASK_PREVIEW_CHARS.done_comment),
  };
}

/**
 * The agent that ran a task, when it is not the one the task names (TIM-0109:
 * a tester saw 12 tasks out of 186 run by another agent, and the board only
 * showed the assigned one). Read from the task's mission: `agent_name` is who
 * ran it, `source_meta.routing` / `routing_reason` why (`dispatcher.ts`). A
 * mission spawned before that instrumentation has no reason: `null`.
 */
export type TaskRunner = {
  agent: string;
  /** `pinned` | `named` | `role` | `convention`. */
  source: string | null;
  /** `pinned` | `missing` | `other_project` | `orchestrator` | `other_role`. */
  reason: string | null;
};

export function taskRunner(
  task: Pick<TaskRow, 'agent_name' | 'mission_id'>,
  lookup: (missionId: string) => { agent_name: string; source_meta: string | null } | undefined = dbApi.getMissionRunner,
): TaskRunner | null {
  if (!task.mission_id) return null;
  const mission = lookup(task.mission_id);
  if (!mission || mission.agent_name === task.agent_name) return null;
  let meta: Record<string, unknown> = {};
  try {
    const parsed: unknown = mission.source_meta ? JSON.parse(mission.source_meta) : null;
    if (parsed && typeof parsed === 'object') meta = parsed as Record<string, unknown>;
  } catch { /* an unreadable meta only loses the reason */ }
  const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
  return { agent: mission.agent_name, source: text(meta.routing), reason: text(meta.routing_reason) };
}

/** A task that keeps another one alive, as the board and the 409 show it. */
export type TaskLink = { id: string; kind: 'dep' | 'chain' };

/**
 * Adds to each row the tasks that depend on it: explicit `deps`, and the
 * verification chain it heads (`verification_root_id`), which `deps` never
 * shows. Both block a deletion; without them the board showed no reason why
 * (TIM-0078). Computed over `all`, not the DONE window, so a card still counts
 * the children the window left out.
 */
export function withDependents<T extends TaskRow>(rows: readonly T[], all: readonly TaskRow[]): (T & { dependents: TaskLink[] })[] {
  const byTask = new Map<string, Map<string, TaskLink['kind']>>();
  const link = (target: string, from: string, kind: TaskLink['kind']) => {
    if (target === from) return;
    const links = byTask.get(target) ?? new Map<string, TaskLink['kind']>();
    if (links.get(from) !== 'chain') links.set(from, kind);
    byTask.set(target, links);
  };
  for (const t of all) {
    let deps: unknown = [];
    try { deps = JSON.parse(t.deps ?? '[]'); } catch { /* malformed deps link nothing */ }
    if (Array.isArray(deps)) for (const d of deps) if (typeof d === 'string') link(d, t.id, 'dep');
    if (t.verification_root_id) link(t.verification_root_id, t.id, 'chain');
  }
  return rows.map((row) => ({
    ...row,
    dependents: [...(byTask.get(row.id) ?? new Map()).entries()].map(([id, kind]) => ({ id, kind })),
  }));
}

const DELETE_REFUSALS: Record<Exclude<TaskDeleteResult, 'deleted'>, string> = {
  not_found: 'Task not found.',
  forbidden: 'Part of this verification chain belongs to another account.',
  state: 'This task is in progress. Stop it before deleting it.',
  dependents: 'Other tasks depend on this task. Remove those dependencies, or delete those tasks first.',
  chain: 'This task is the root of a verification chain. Delete the whole chain (chain=1), or delete its other tasks first.',
  mission: 'This task still has a running mission. Stop the mission before deleting it.',
  worktree: 'This task still has a worktree. Ask the project maintainer to review and dispose of it before deleting the task.',
  pipeline: 'This task belongs to a pipeline run and must be kept for its history.',
};

/** The 409 body: the reason, and the tasks behind it by id so an agent reading
 *  only `error` can act on them. Titles of tasks the viewer cannot see stay out. */
export function deleteRefusal(
  outcome: TaskDeleteOutcome,
  requested: string,
  visible: (id: string) => boolean,
): Record<string, unknown> {
  const result = outcome.result as Exclude<TaskDeleteResult, 'deleted'>;
  const shown = outcome.blockers.filter((t) => visible(t.id));
  const hidden = outcome.blockers.length - shown.length;
  const kind: TaskLink['kind'] = result === 'chain' ? 'chain' : 'dep';
  let error = DELETE_REFUSALS[result];
  if (outcome.taskId !== requested) error = `Chain task ${outcome.taskId}: ${error}`;
  if (shown.length > 0) {
    const ids = shown.slice(0, 10).map((t) => t.id).join(', ');
    error += ` Blocking tasks: ${ids}${shown.length > 10 ? `, +${shown.length - 10} more` : ''}.`;
  }
  if (hidden > 0) error += ` ${hidden} more blocking task(s) belong to another account.`;
  return {
    error,
    code: `task_${result}`,
    task_id: outcome.taskId,
    blockers: shown.map((t) => ({ id: t.id, title: t.title, status: t.status, kind })),
    hidden_blockers: hidden,
    ...(result === 'chain' ? { chain_size: outcome.chain.length } : {}),
  };
}

function parseDoneLimit(raw: unknown): number | null {
  if (typeof raw !== 'string' || !/^\d{1,6}$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

/**
 * The board's window over DONE tasks: every unfinished task, the `limit` most
 * recently closed ones (only those `matches` keeps when the board filters on
 * an agent or a project), and every task of a series one of those belongs to —
 * a series graph opened from any card on screen must still see all its nodes.
 * `doneTotal` is what the DONE column counts, window or not. Order is the
 * list's own.
 */
export function windowDoneTasks(
  tasks: readonly TaskRow[],
  limit: number,
  matches: ((task: TaskRow) => boolean) | null,
): { tasks: TaskRow[]; doneTotal: number } {
  const done = tasks
    .filter((t) => t.status === 'DONE' && (!matches || matches(t)))
    .sort((a, b) => b.updated_at - a.updated_at);
  const kept = new Set(done.slice(0, limit).map((t) => t.id));
  const series = new Set<string>();
  for (const t of tasks) {
    if ((t.status !== 'DONE' || kept.has(t.id)) && t.series_id) series.add(t.series_id);
  }
  return {
    tasks: tasks.filter((t) =>
      t.status !== 'DONE' || kept.has(t.id) || (!!t.series_id && series.has(t.series_id))),
    doneTotal: done.length,
  };
}

/** A project slug as it travels in a URL (same shape `projects.ts` accepts). */
const ProjectSlugSchema = z.string().regex(/^[A-Za-z0-9._-]{1,64}$/);

/**
 * Which DONE tasks the board's filters keep. A task's project is
 * `taskProjectSlug`'s: its own `project`, else its agent's — the same rule the
 * board applies on the client with the agents list, so `doneTotal` counts
 * exactly the cards the column can show.
 */
export function doneTaskFilter(
  agent: string | null,
  project: string | null,
  agentProjects: () => ReadonlyMap<string, string | null> = agentProjectMap,
  query: string | null = null,
): ((task: TaskRow) => boolean) | null {
  const needle = query?.trim().toLowerCase() || null;
  if (!agent && !project && !needle) return null;
  const byAgent = project ? agentProjects() : null;
  return (t) => {
    if (agent && t.agent_name !== agent) return false;
    if (project && (t.project || byAgent?.get(t.agent_name) || null) !== project) return false;
    // Same fields and same description cut as the board (`kanban-filters.ts`):
    // the client sees the preview, so the count must be taken on it too.
    if (needle && ![t.id, t.title, t.agent_name, preview(t.description, TASK_PREVIEW_CHARS.description)]
      .some((v) => v?.toLowerCase().includes(needle))) return false;
    return true;
  };
}

/** Agent → project, as `/api/agents` serves it (`cfg.project`, else the cwd's). */
function agentProjectMap(): Map<string, string | null> {
  return new Map(listAgents().map((a) => [a.name, a.project ?? null]));
}

/** The series visibility rule applied to a request's caller. */
function seriesVisible(req: express.Request, seriesId: string): boolean {
  return seriesVisibleTo(viewerFromRequest(req), seriesId);
}

/** `?group=<name>` of a `DELETE` on a series rule: the group of volets the rule
 *  belongs to; absent = the series-wide rule. Validated by the service (shape,
 *  length, control characters); here only its presence as ONE string. */
function groupQuery(req: express.Request): string | undefined | null {
  const raw = req.query.group;
  if (raw === undefined) return undefined;
  return typeof raw === 'string' ? raw : null;
}

/** Auth + series resolution shared by the `/roles` routes. Answers the error
 *  itself and returns null when the request stops there. */
function seriesForRolesRoute(req: express.Request, res: express.Response): string | null {
  if (!requireAuth(req, res)) return null;
  if (!SeriesParamSchema.safeParse(req.params).success) {
    res.status(400).json(apiError('series_invalid', 'invalid series identifier'));
    return null;
  }
  const seriesId = resolveSeriesParam(req);
  if (!seriesId) {
    res.status(400).json(apiError('series_unresolved', 'series unknown (X-TIMON-Mission header missing?)'));
    return null;
  }
  if (!seriesVisible(req, seriesId)) {
    res.status(404).json(apiError('series_not_found', 'series not found'));
    return null;
  }
  return seriesId;
}

/**
 * A series rule names the backend the dispatcher will run the series' tasks on
 * (a role) or switch them to (a fallback rule), with nobody asked then: it takes
 * the grid of a task's `backend_override` (TODO #561). Seeing the series is not
 * enough — `seriesForRolesRoute` only proves that. Refused = 403, audited.
 */
function seriesLlmDenied(req: express.Request, res: express.Response, seriesId: string, kind: 'role' | 'fallback'): boolean {
  if (isPrivilegedCaller(req)) return false;
  const body: { backend?: unknown; model?: unknown } = req.body && typeof req.body === 'object' ? req.body : {};
  const refusal = llmChoiceRefusal({ backend: body.backend, model: body.model }, overrideAuthority(req), `series ${kind} rule`);
  if (!refusal) return false;
  rejectOverride(req, res, 'series.override_denied', `series:${seriesId}`, refusal);
  return true;
}

const TodoIdSchema = z.number().int().positive();

/**
 * Validate a `todo_id` from a request body against what the caller may see.
 *
 * Linking a task to an idea is what later CLOSES that idea, so the link is an
 * access decision (SECURITY.md): the idea must be visible to the caller under
 * the same owner scope as `GET /api/project-todo`. A missing idea and someone
 * else's idea get the very same answer — telling them apart would confirm that
 * the other account's idea exists. `null` is only meaningful on update (unlink).
 */
function parseTodoLink(
  req: express.Request,
  raw: unknown,
): { ok: true; value: number | null | undefined } | { ok: false; body: ApiErrorBody } {
  if (raw === undefined) return { ok: true, value: undefined };
  if (raw === null) return { ok: true, value: null };
  const parsed = TodoIdSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, body: apiError('todo_id_invalid', 'todo_id must be a positive integer') };
  if (!scopedDb(viewerFromRequest(req)).getProjectTodo(parsed.data)) {
    return { ok: false, body: apiError('todo_link_not_found', `todo_id ${parsed.data}: no such TO DO item`, { id: String(parsed.data) }) };
  }
  return { ok: true, value: parsed.data };
}

/** Acceptable merge sha: 7 to 40 hex. Below 7, the abbreviated sha git
 *  shows everywhere proves nothing. */
const MERGED_SHA_RE = /^[0-9a-f]{7,40}$/i;

/** Ceiling of the human summary shown on a return card. Clamped, never
 *  refused: closing is the gesture that must not fail. */
const SUMMARY_MAX = 400;
const SummarySchema = z.string().nullish();

/** `undefined` = the caller sent nothing usable (the column is then cleared). */
function parseSummary(raw: unknown): string | undefined {
  const parsed = SummarySchema.safeParse(raw);
  if (!parsed.success || !parsed.data) return undefined;
  const text = parsed.data.trim();
  if (!text) return undefined;
  return text.length > SUMMARY_MAX ? `${text.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : text;
}

/**
 * Closing of a task: code gate, status transition, process stop.
 *
 * Shared by `PUT /api/tasks/:id` and `POST /api/tasks/close`, so that both
 * paths do exactly the same thing. The order matters: the merge sha is
 * set by the caller BEFORE this call (the merge guard refuses DONE without it),
 * then the code gate's annotation, then the transition, then the deferred stop of the
 * process (`stopClosedTaskMission`) — it is the process's exit that publishes
 * `mission_complete`, hence that primes the verification-loop and the doc task.
 */
/**
 * A sha on a full-pipeline `code` task skips its review, releases its
 * dependents and closes its idea (TIM-0109, marked merged by hand). Every
 * path that records one refuses a commit git places outside the base; a
 * commit this clone does not have is taken on trust, as it may be a PR
 * merged on GitHub and not fetched yet.
 */
export function mergedShaRefusal(task: TaskRow, sha: string): string | null {
  if (task.type !== 'code' || isCodeOnlyPipeline(task.pipeline)) return null;
  if (shaInBase(taskRepo(task), task.base_branch, sha) !== 'not_contained') return null;
  return `Commit ${sha} is not in ${task.base_branch} of this repository. Check the sha of the merge.`;
}

/** Answers 409 when a `merge` or `full` code task may not go DONE yet; true if it did. */
function rejectUnprovenClose(res: express.Response, task: TaskRow, sha: string | null): boolean {
  // First: until its pull request is open, the PR task has nothing to prove.
  const prRefusal = pullRequestCloseRefusal(task);
  if (prRefusal) { res.status(409).json(apiError('pr_not_opened', prRefusal, { detail: prRefusal })); return true; }
  const mergeRefusal = mergeCloseRefusal(task, sha);
  if (mergeRefusal) { res.status(409).json(apiError('merge_not_proven', mergeRefusal, { detail: mergeRefusal })); return true; }
  const codeRefusal = codeCloseRefusal(task);
  if (codeRefusal) { res.status(409).json(apiError('branch_unreviewable', codeRefusal, { detail: codeRefusal })); return true; }
  return false;
}

export function closeTask(
  readTask: ScopedDb['getTask'],
  taskId: string,
  task: TaskRow,
  status: 'DONE' | 'BLOCKED',
  opts: { doneComment?: string; blockedReason?: string; summary?: string; byPerson?: boolean },
): void {
  let doneComment = opts.doneComment;
  // Before the transition, like the merge sha: `task_done` builds the return
  // from the stored row. Rewritten on every close so a reopened task never
  // shows the summary of an earlier attempt.
  dbApi.setTaskDoneSummary(taskId, status === 'DONE' ? opts.summary ?? null : null);
  // Prefix the report so missing work or merge evidence stays visible in review.
  if (status === 'DONE' && task.type === 'code' && task.branch_name) {
    const git = inspectGitBranch(task.worktree_path, task.branch_name, task.base_branch, task.pipeline, task.merged_commit_sha);
    const annotation = evaluateCodeDone(task, git);
    if (annotation) doneComment = doneComment ? `${annotation}\n\n${doneComment}` : annotation;
  }
  dbApi.updateTaskStatus(taskId, status, {
    blockedReason: opts.blockedReason,
    doneComment,
    byPerson: opts.byPerson,
  });
  // A dispatched task runs in a `persistentProcess` mission: after its
  // `result` the process keeps stdin open and stays idle indefinitely →
  // `proc.on('exit')` never fires → `mission_complete` never published → the
  // pipeline does not start. Retire only the dispatched task's settled process.
  const missionId = task.mission_id;
  if (!missionId) return;
  const closed = readTask(taskId);
  if (closed?.mission_id === missionId && (closed.status === 'DONE' || closed.status === 'BLOCKED')) {
    stopClosedTaskMission(readTask, taskId, missionId, closed.status);
  }
}

/**
 * Minimum grace period before a closed task's process is stopped. The agent closes its
 * task through its own stdio MCP server (`kanban_mark_as_done`), a child of the
 * very process being killed: killed in the same tick, that server died before
 * the HTTP answer reached it, the agent read "Connection closed", took the
 * close for a failure and retried on a task already DONE.
 */
export const CLOSED_TASK_STOP_DELAY_MS = 1_000;
const pendingStops = new Set<string>();

/** Non-blocking and idempotent: one stop per mission however many closes race. */
function stopClosedTaskMission(
  readTask: ScopedDb['getTask'], taskId: string, missionId: string, status: 'DONE' | 'BLOCKED',
): void {
  if (pendingStops.has(missionId)) return;
  pendingStops.add(missionId);
  let elapsed = false;
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true;
    clearTimeout(timer);
    bus.off('event', onEvent);
    pendingStops.delete(missionId);
  };
  const check = () => {
    if (!elapsed || cancelled) return;
    const task = readTask(taskId);
    if (task?.status !== status || task.mission_id !== missionId
        || stopSettledTaskMission(missionId, { source: 'kanban: task closed', detail: `task ${taskId} ${status}` })) cancel();
  };
  const onEvent = (ev: BusEvent) => {
    if ('taskId' in ev && ev.taskId === taskId
        && (ev.kind === 'task_deleted' || (ev.kind === 'task_updated' && ev.changed.includes('status')))) cancel();
    if (!('missionId' in ev) || ev.missionId !== missionId) return;
    if (ev.kind === 'mission_complete' || (ev.kind === 'event' && ev.type === 'turn_interrupted')) cancel();
    // Let the agent finish publishing the committed result before retiring it.
    if (ev.kind === 'turn_complete' && ev.outcome !== 'cancelled' && elapsed) {
      queueMicrotask(check);
    }
  };
  const timer = setTimeout(() => {
    elapsed = true;
    check();
  }, CLOSED_TASK_STOP_DELAY_MS);
  timer.unref();
  bus.on('event', onEvent);
}

export type { TaskCreateBody } from './task-create-body.js';

type TaskUpdateOverrides = TaskOverrides & { clear_fallback?: boolean; clear_permission_mode?: boolean };

/**
 * A task carries the overrides a spawn would (permission level, backend, model,
 * extra tools/MCP): it is a spawn deferred to the dispatcher, so it takes the
 * same guard. Null = accepted; the refusal text names the refused value, and
 * every refusal is audited like the agent and spawn gates.
 *
 * `reassigned` is the task being handed to `agentName`: the overrides it already
 * carries were judged against its former agent, so they are judged again
 * against the new one, merged with what the body changes. Otherwise a task
 * created with `bypassPermissions` or extra tools by someone allowed to could
 * be pointed at any agent by someone who is not.
 *
 * `current` is the task a `PUT` edits: its fallback is judged as it will be
 * stored (see `fallbackAfterUpdate`).
 */
function taskOverrideDenied(
  req: express.Request,
  body: TaskUpdateOverrides,
  agentName: string,
  reassigned: TaskRow | null = null,
  current: TaskRow | null = null,
): string | null {
  const target = (() => { try { return loadConfig(agentName); } catch { return null; } })();
  // Extra tools, a skill that pre-authorises tools or a stdio MCP server need a
  // person, whatever an agent's token holds: before the privileged exemption,
  // which a developer-owner mission passes. A PUT that re-sends the extras the
  // task already carries grants nothing new.
  const granted = current && !reassigned ? withTaskExtras(target, current) : target;
  let widening = spawnWideningDenied(req, body, granted, agentName);
  if (!widening && reassigned) {
    const kept = spawnWideningDenied(req, overridesAfterUpdate(reassigned, body), target, agentName);
    if (kept) widening = `the task already carries extras agent "${agentName}" may not receive from an agent's token: ${kept}`;
  }
  if (widening) {
    auditRequest(req, 'task.override_denied', `agent:${agentName} — ${widening}`);
    return widening;
  }
  if (isPrivilegedCaller(req)) return null;
  const authority = overrideAuthority(req);
  const judged = current ? {
    ...body,
    ...fallbackAfterUpdate(current, body),
    permission_mode_override: body.clear_permission_mode ? null : body.permission_mode_override,
  } : body;
  let refusal = taskOverrideRefusal(judged, target, authority);
  if (!refusal && reassigned) {
    const kept = taskOverrideRefusal(overridesAfterUpdate(reassigned, body), target, authority);
    if (kept) refusal = `the task already carries overrides agent "${agentName}" may not receive from this caller: ${kept}`;
  }
  if (refusal) auditRequest(req, 'task.override_denied', `agent:${agentName} — ${refusal}`);
  // The dispatcher hands this value to whichever dialect runs the task: store
  // the name they all understand (see `canonicalPermissionMode`).
  else canonicalizePermissionMode(body as Record<string, unknown>, 'permission_mode_override');
  return refusal;
}

/**
 * A pipeline's steps carry the extras a task does: an agent's token that adds a
 * tool, a skill that pre-authorises one or a stdio MCP server through them is
 * refused when it writes the pipeline, not only when it runs it (the run takes
 * `taskOverrideDenied` step by step). Judged against each step's agent.
 */
function pipelineWideningDenied(req: express.Request, definition: PipelineDefinition | undefined): string | null {
  for (const step of definition?.steps ?? []) {
    const target = (() => { try { return loadConfig(step.agent); } catch { return null; } })();
    const refusal = spawnWideningDenied(req, step, target, step.agent);
    if (refusal) {
      auditRequest(req, 'pipeline.override_denied', `agent:${step.agent} — ${refusal}`);
      return `step ${step.id}: ${refusal}`;
    }
  }
  return null;
}

/**
 * The agent's config plus the extras `task` already carries: what an edit of
 * that task keeps. Its extra skills count by the tools they pre-authorise.
 */
function withTaskExtras(config: AgentConfig | null, task: TaskRow): AgentConfig {
  const stored = (raw: string | null): string[] => {
    try {
      const value = raw ? JSON.parse(raw) as unknown : undefined;
      return Array.isArray(value) ? value.map(String) : [];
    } catch { return []; }
  };
  return {
    ...config,
    allowed_tools: [
      ...(config?.allowed_tools ?? []),
      ...stored(task.extra_allowed_tools),
      ...readSkillsAllowedTools(stored(task.extra_skills)),
    ],
    mcp_servers: [...(config?.mcp_servers ?? []), ...stored(task.extra_mcp_servers)],
  };
}

/**
 * The overrides a task will carry once `PUT /api/tasks/:id` wrote `body`,
 * following `dbApi.updateTask`'s rules: `undefined` keeps a value, `null` clears
 * only the backend and the model, an empty list and a null mode keep theirs.
 * Explicit clear sentinels win over values sent alongside them.
 */
function overridesAfterUpdate(task: TaskRow, body: TaskUpdateOverrides): TaskOverrides {
  const storedList = (raw: string | null): string[] | undefined => {
    try {
      const value = raw ? JSON.parse(raw) as unknown : undefined;
      return Array.isArray(value) ? value.map(String) : undefined;
    } catch { return undefined; }
  };
  const list = (sent: unknown, stored: string | null): unknown =>
    sent === undefined || sent === null || (Array.isArray(sent) && sent.length === 0) ? storedList(stored) : sent;
  return {
    permission_mode_override: body.clear_permission_mode ? null : body.permission_mode_override ?? task.permission_mode_override ?? undefined,
    backend_override: body.backend_override !== undefined ? body.backend_override : task.backend_override ?? undefined,
    model_override: body.model_override !== undefined ? body.model_override : task.model_override ?? undefined,
    extra_allowed_tools: list(body.extra_allowed_tools, task.extra_allowed_tools),
    extra_mcp_servers: list(body.extra_mcp_servers, task.extra_mcp_servers),
    extra_skills: list(body.extra_skills, task.extra_skills),
  };
}

/**
 * The fallback a task will carry once `PUT /api/tasks/:id` wrote `body`
 * (`clear_fallback` erases both columns, otherwise COALESCE), or none to judge when the body
 * changes neither: re-sending what is stored grants nothing, and a task an
 * operator gave a fallback its owner could not pick stays editable. A changed
 * model is judged with the backend it will ride with.
 *
 * Reassignment does not re-judge it, unlike `overridesAfterUpdate`: no agent
 * config bounds a fallback, so the new agent changes nothing about it.
 */
function fallbackAfterUpdate(
  task: TaskRow,
  body: TaskUpdateOverrides,
): Pick<TaskOverrides, 'fallback_backend_override' | 'fallback_model_override'> {
  const sent = (value: unknown, stored: string | null): boolean =>
    value !== undefined && value !== null && value !== stored;
  if (body.clear_fallback || (!sent(body.fallback_backend_override, task.fallback_backend_override)
    && !sent(body.fallback_model_override, task.fallback_model_override))) {
    return { fallback_backend_override: undefined, fallback_model_override: undefined };
  }
  return {
    fallback_backend_override: body.fallback_backend_override ?? task.fallback_backend_override ?? undefined,
    fallback_model_override: body.fallback_model_override ?? task.fallback_model_override ?? undefined,
  };
}

/** The agent's working directory, `null` when it has none or cannot be read. */
function agentCwd(agentName: string): string | null {
  try { return loadConfig(agentName).cwd ?? null; } catch { return null; }
}

/**
 * The LLM a task inherits from the mission that creates it, when that mission
 * does not run on Claude and nothing else decides the task's LLM (TIM-0082).
 *
 * A pilot on GPT that leaves `backend_override` / `model_override` empty used
 * to see its tasks fall to the Claude default of the role's agent — "prepared
 * with GPT, executed with Opus". A stored override is frozen and beats the
 * series roles and `roles.json`, so it is only laid down where none of them has
 * a say: no series role for this type, no `roles.json` backend, and no agent
 * that pins its own backend (an agent the pilot named, or that holds the role).
 */
function pilotLlmDefault(
  body: TaskCreateBody,
  type: TaskType | undefined,
  creatorMission: string | null,
  creatorAgent: string | null,
): { backend: string; model: string | null } | null {
  if (!creatorMission) return null;
  const llm = llmOfMission(creatorMission);
  // The template provider, account instances included: its default is already the status quo.
  if (!llm || isTemplateBackend(llm.backend)) return null;
  const taskType = type ?? 'chore';
  const seriesId = dbApi.seriesIdForMission(creatorMission) ?? creatorMission;
  const planGroup = parsePlanGroup(body.plan_group);
  if (seriesLlmChoice(seriesId, taskType, planGroup.ok ? planGroup.value : null)) return null;

  let named: AgentConfig = {};
  try { named = loadConfig(body.agent_name ?? ''); } catch { /* unknown agent */ }
  const slug = body.project || taskProjectSlug({}, named);
  let executor = body.agent_name ?? '';
  if (slug) {
    let spec: RoleSpec | undefined;
    try { spec = readRoles(slug.toLowerCase())[taskType as TaskRole]; } catch { /* no roles.json */ }
    if (spec?.backend) return null;
    const preview = previewRoleAgent(slug, roleForTaskType(taskType), spec, {
      named: body.agent_name,
      avoid: [creatorAgent],
    });
    if (preview) executor = preview.agent;
  }
  try { if (executor && loadConfig(executor).backend) return null; } catch { /* seeded later */ }
  return llm;
}

/**
 * The mission whose LLM a task may inherit, or null.
 *
 * A mission-bound api-token is the identity the daemon issued: its own mission
 * is the pilot, whatever `X-TIMON-Mission` or `creator_mission_id` claim — a
 * visible mission id is not proof of who is calling (same rule as
 * `delegatingAgent`). Without such a token only an unrestricted caller (the
 * operator's daemon-token, an open first-run install) may name one: a
 * restricted human session has no mission behind it, so inherits nothing.
 */
function pilotMissionOf(
  req: express.Request,
  claimed: string | null,
  claimedAgent: string | null,
): { id: string; agent: string } | null {
  const auth = req.auth;
  if (auth?.kind === 'api-token' && auth.missionId) {
    // Through the viewer's scope like every owned read: the token's own mission
    // is always inside it (the token acts as the mission's owner).
    const own = scopedDb(viewerFromRequest(req)).getMission(auth.missionId);
    return own ? { id: own.id, agent: own.agent_name } : null;
  }
  if (isPrivilegedCaller(req) && claimed && claimedAgent) return { id: claimed, agent: claimedAgent };
  return null;
}

/**
 * Creation of a task — the path taken by `POST /api/tasks` and by the promotion
 * of an idea from the notebook (`POST /api/project-todo/:id/promote`). Extracted verbatim from the
 * handler: same validations, same codes, same messages. Two entrances,
 * a single exit — otherwise the promotion would replay in its own way the
 * dozen guards set here (pipeline, backend, project, `scheduled_at`, git base).
 */
export function createTaskFromBody(
  req: express.Request,
  body: TaskCreateBody,
): { status: number; json: Record<string, unknown> } {
  if (!body.title || !body.agent_name) {
    return { status: 400, json: { ...apiError('task_fields_required', 'title and agent_name required') } };
  }
  // Delegation list: assigning work to another agent is delegating. Checked
  // first so a refused caller learns nothing from the other validations.
  const refusal = delegationRefusal(req, body.agent_name);
  if (refusal) {
    return { status: 403, json: { ...apiError('orchestration_denied', `task refused: ${refusal}`, { detail: refusal }) } };
  }
  const overrideRefusal = taskOverrideDenied(req, body, body.agent_name);
  if (overrideRefusal) {
    // `taskOverrideDenied` audited the refusal already (`task.override_denied`).
    return { status: 403, json: { ...forbiddenBody(req, { kind: 'override', reason: overrideRefusal }) } };
  }
  // Strict validation: an unknown value would silently disable
  // the review if it were let through. Reject instead of guessing.
  const fieldRefusal = pipelineRefusal(body.pipeline) ?? backendRefusal(body) ?? projectRefusal(body.project)
    ?? planGroupRefusal(body.plan_group);
  if (fieldRefusal) return { status: 400, json: { ...apiError('task_field_invalid', fieldRefusal, { detail: fieldRefusal }) } };
  const planGroup = parsePlanGroup(body.plan_group);
  // Same discipline: a `scheduled_at` as an ISO string was stored as is,
  // then compared numerically at dispatch → the task never left (or
  // left right away). No error anywhere. Reject.
  const sched = validateScheduledAt(body.scheduled_at);
  if (!sched.ok) {
    return { status: 400, json: { ...apiError('scheduled_at_invalid', sched.error, { detail: sched.error }) } };
  }
  const schedWarning = checkScheduledAtPlausibility(sched.value, Date.now());
  if (schedWarning) console.warn(`[tasks] ${schedWarning}`);
  let type: TaskType | undefined;
  if (body.type !== undefined) {
    if (!isTaskType(body.type)) {
      return { status: 400, json: { ...apiError('task_type_invalid', `invalid type "${body.type}"`, { type: String(body.type) }) } };
    }
    type = body.type;
  }
  const landing = landingRefusal(body.landing, type);
  if (landing) return { status: 400, json: { ...apiError('task_field_invalid', landing, { detail: landing }) } };
  // Refused here rather than BLOCKED at dispatch: the caller learns at once
  // that this host cannot run it (TODO #275).
  const gitRefusal = gitTaskRefusal(type, { cwd: agentCwd(body.agent_name) });
  if (gitRefusal) return { status: 400, json: { ...apiError('git_missing', gitRefusal) } };
  // The base becomes an argument of `git worktree add`: a leading `-` would be
  // read as a flag there. The dubious shape is refused here rather than
  // discovered at dispatch, as for an unknown pipeline or project. A
  // well-formed but non-existent reference, on the other hand, will fail loudly at
  // dispatch — the right place for that, the branch may be born in the meantime.
  let base: string | null = null;
  if (body.base != null && body.base !== '') {
    base = String(body.base).trim();
    if (!isPlausibleGitRef(base)) {
      return { status: 400, json: { ...apiError('task_base_invalid', `base "${body.base}" is not a plausible git ref`, { base }) } };
    }
  }
  // Checked before the task exists: a refused link must not leave a task behind.
  const todo = parseTodoLink(req, body.todo_id);
  if (!todo.ok) return { status: 400, json: { ...todo.body } };
  // Calling mission: the header is authoritative (it comes from the agent process), the body
  // is only a fallback. Only a mission that REALLY exists is kept — a ghost
  // id would attach the series to an unreachable pilot.
  const claimedMission = req.header('X-TIMON-Mission') ?? body.creator_mission_id ?? null;
  const claimed = claimedMission ? scopedDb(viewerFromRequest(req)).getMission(claimedMission) : undefined;
  // What is STORED is the authenticated pilot, never the claim: the dispatcher
  // and the verification loop read `creator_mission_id` back to seed agents on
  // the pilot's backend, so a visible mission id named by a restricted caller
  // would seed on someone else's backend (TIM-0082). Lineage keeps working for
  // every agent — its token IS its mission; a restricted session has none.
  const pilot = pilotMissionOf(req, claimed ? claimedMission : null, claimed?.agent_name ?? null);
  const creatorMission = pilot?.id ?? null;
  let pilotLlm = !body.backend_override && !body.model_override && pilot
    ? pilotLlmDefault(body, type, pilot.id, pilot.agent)
    : null;
  // An inherited value is a selection like any other: the override gate ran on
  // the request, which carried none, so it is judged here against the caller's
  // own authority. Refused = nothing is inherited, the task falls back on the
  // role's agent as before (never a 403: the caller asked for nothing).
  if (pilotLlm && !isPrivilegedCaller(req)) {
    let target: AgentConfig | null = null;
    try { target = loadConfig(body.agent_name); } catch { /* unknown agent: judged bare */ }
    const inherited = { backend_override: pilotLlm.backend, model_override: pilotLlm.model };
    if (taskOverrideRefusal(inherited, target, overrideAuthority(req))) pilotLlm = null;
  }
  const id = crypto.randomUUID();
  const scope = scopedDb(viewerFromRequest(req));
  scope.createTask(id, body.title, body.agent_name, {
    description: body.description,
    priority: body.priority,
    deps: body.deps,
    scheduledAt: sched.value ?? undefined,
    extraSkills: body.extra_skills,
    extraMcpServers: body.extra_mcp_servers,
    extraAllowedTools: body.extra_allowed_tools,
    type,
    backendOverride: body.backend_override || pilotLlm?.backend || null,
    modelOverride: body.model_override || pilotLlm?.model || null,
    fallbackBackendOverride: body.fallback_backend_override ?? null,
    fallbackModelOverride: body.fallback_model_override ?? null,
    reasoningEffort: body.reasoning_effort ?? null,
    permissionModeOverride: body.permission_mode_override ?? null,
    groupId: body.group_id ?? null,
    planGroup: planGroup.ok ? planGroup.value : null,
    // Lineage: the calling mission is the pilot of the work. The header is
    // set by the `timon` CLI AND by the MCP on ALL their calls; it was
    // simply never read here, so that `creator_mission_id` stayed null
    // for every task created by an agent. Consequence observed on 2026-08-20:
    // the dispatcher fell back on "the most recent orchestrator mission"
    // and the task returns scattered across new missions, each
    // without the plan. This line is what attaches a series to ONE pilot.
    creatorMissionId: creatorMission,
    pipeline: body.pipeline ?? null,
    project: body.project || null,
    traceId: typeof body.trace_id === 'string' ? body.trace_id : null,
    landing: body.landing || null,
  });
  if (base) dbApi.setTaskBaseBranch(id, base);
  if (todo.value) dbApi.setTaskTodoId(id, todo.value);
  // `warnings` only if there are any: a client that ignores it keeps exactly
  // the previous contract.
  return {
    status: 201,
    json: {
      task: scope.getTask(id),
      ...(schedWarning ? { warnings: [schedWarning] } : {}),
    },
  };
}

/**
 * The account a pipeline or a run written by this request belongs to: the
 * signed-in user, else the identity a token acts for (as `scopedDb().createTask`
 * reads it). `undefined` for a superadmin with no account behind (first run):
 * the row stays a system row, the run's tasks inherit their owner.
 */
function pipelineAccountOf(req: express.Request): string | undefined {
  if (req.auth?.user?.id) return req.auth.user.id;
  const viewer = viewerFromRequest(req);
  return viewer && !viewer.isSuperadmin ? viewer.id : undefined;
}

/** The pipeline as this caller may see it, `null` when missing or someone else's. */
function visiblePipeline(req: express.Request, id: string): Pipeline | null {
  const p = getPipeline(id);
  return p && pipelineVisibleTo(p, viewerFromRequest(req)) ? p : null;
}

/** 403 on a visible pipeline the caller may not change (a system row, for a non-superadmin). */
function rejectReadOnlyPipeline(req: express.Request, res: express.Response, p: Pipeline): boolean {
  if (pipelineWritableBy(p, viewerFromRequest(req))) return false;
  res.status(403).json(apiError('pipeline_read_only', 'this is a shared system pipeline: only a superadmin can change or delete it'));
  return true;
}

export type KanbanRouteDeps = {
  /** How a landing reaches the series pilot; the wake loop by default. */
  notifyLanding?: Notify;
};

/**
 * `mark-merged` for a chain whose base is an integration branch (`pr`, or
 * `branch` under embargo or in a project that merges locally): the sha is the
 * commit of the target that brought the branch in, so it is checked against
 * `<remote>/<target>` (the local target when there is no remote), and the whole
 * job lands through the same gate as the poller's (`concludeMerged`). The
 * task itself closes like a local one when it was BLOCKED or had no sha.
 */
async function markIntegrationMerged(
  req: express.Request, res: express.Response, task: TaskRow, sha: string, comment: string | undefined,
  deps: KanbanRouteDeps,
): Promise<void> {
  // A PENDING or running task still belongs to its agent.
  if (task.status !== 'BLOCKED' && task.status !== 'DONE') {
    res.status(409).json(apiError('task_still_running', 'The task is still running: wait for it to finish before marking it merged.'));
    return;
  }
  // Keyed by the agent's repository, as the dispatcher recorded it: never the
  // task's worktree.
  const row = integrationOfTask(task);
  if (!row) {
    const branch = task.base_branch ?? '';
    res.status(409).json(apiError('integration_not_found', `Timon has no record of the integration branch ${branch}: dispatch the job first.`, { branch }));
    return;
  }
  if (row.state === 'merged') {
    res.status(409).json(apiError('integration_already_landed', `${row.branch} has already landed.`, { branch: row.branch }));
    return;
  }
  // `origin/main`, or the local `main` of a job that merges locally.
  const target = integrationTargetLabel(row);
  const found = shaInBase(row.repo, target, sha);
  if (found === 'not_contained') {
    res.status(409).json(apiError('sha_not_in_base', `Commit ${sha} is not in ${target} of this repository. Check the sha of the merge.`, { sha, base: target }));
    return;
  }
  await concludeMerged(row.id, sha, deps.notifyLanding);
  const note = found === 'contained'
    ? `Marked as merged outside Timon: ${row.branch} landed as ${sha} (found in ${target}).`
    : `Marked as merged outside Timon: ${row.branch} landed as ${sha} (not found in the local ${target}: not verified, fetch to check).`;
  const trimmed = comment?.trim();
  const report = trimmed ? `${note}\n\n${trimmed}` : note;
  const scope = scopedDb(viewerFromRequest(req));
  if (task.status === 'BLOCKED') {
    dbApi.setTaskMergedSha(task.id, sha);
    task.merged_commit_sha = sha;
    closeTask(scope.getTask, task.id, task, 'DONE', { doneComment: report });
  } else {
    // A DONE task keeps the sha of its merge into the integration branch;
    // one without any gets the target's, as in a local chain.
    if (!task.merged_commit_sha) dbApi.setTaskMergedSha(task.id, sha);
    dbApi.appendTaskDoneComment(task.id, report);
    try {
      applyTodoClosure(scope.getTask(task.id) ?? task);
    } catch (err) {
      console.error(`[kanban] TO DO closure failed for ${task.id}: ${(err as Error).message}`);
    }
  }
  auditRequest(req, 'task.mark_merged', `${task.id} ${sha} ${row.branch}`);
  const landed = dbApi.getIntegrationById(row.id);
  res.json({
    task: scope.getTask(task.id),
    verified: found === 'contained',
    integration: { id: row.id, branch: row.branch, state: landed?.state ?? row.state, merge_sha: landed?.merge_sha ?? sha },
  });
}

export function registerRoutes(app: Router, deps: KanbanRouteDeps = {}): void {
  // The writer of every task write below, for the `origin` that the lifecycle
  // events carry: without it a change made from the board would read as the
  // daemon's, and a sync plugin could not tell it from its own echo.
  app.use('/api/tasks', (req, _res, next) => withTaskOrigin(taskOriginFromRequest(req), next));

  app.get('/api/pipelines', (req, res) => {
    const viewer = viewerFromRequest(req);
    res.json({ pipelines: listPipelines().filter((p) => pipelineVisibleTo(p, viewer)) });
  });

  // Writing or running a pipeline opens Kanban tasks: `kanban:write`, after
  // identity and before the body's shape (TODO #787). Then the owner scope
  // (TODO #797): someone else's pipeline answers 404 like a missing one, and a
  // shared system row (owner NULL) is read and run by all, changed by a
  // superadmin only (403, the row being visible).
  app.post('/api/pipelines', (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'kanban:write')) return;
    const parsed = parsePipelineCreateBody(req.body);
    if (!parsed.ok) { res.status(400).json(apiError('pipeline_body_invalid', parsed.error, { detail: parsed.error })); return; }
    const body = parsed.value;
    const widening = pipelineWideningDenied(req, body.definition as PipelineDefinition);
    if (widening) { res.status(403).json(forbiddenBody(req, { kind: 'override', reason: widening })); return; }
    try {
      const pipeline = createPipeline({
        name: body.name,
        description: body.description ?? null,
        definition: body.definition as PipelineDefinition,
        ownerUserId: pipelineAccountOf(req) ?? null,
      });
      emitAutomationEvent({ kind: 'pipeline_created', pipeline, origin: automationOriginOf(req) });
      res.status(201).json({ pipeline });
    } catch (err) {
      res.status(400).json(apiError('pipeline_refused', (err as Error).message, { detail: (err as Error).message }));
    }
  });

  app.get('/api/pipelines/:id', (req, res) => {
    const p = visiblePipeline(req, req.params.id);
    if (!p) {
      res.status(404).json(apiError('pipeline_not_found', 'pipeline not found'));
      return;
    }
    res.json({ pipeline: p });
  });

  app.put('/api/pipelines/:id', (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'kanban:write')) return;
    const parsed = parsePipelineUpdateBody(req.body);
    if (!parsed.ok) { res.status(400).json(apiError('pipeline_body_invalid', parsed.error, { detail: parsed.error })); return; }
    const existing = visiblePipeline(req, req.params.id);
    if (!existing) { res.status(404).json(apiError('pipeline_not_found', 'pipeline not found')); return; }
    if (rejectReadOnlyPipeline(req, res, existing)) return;
    const { definition, ...rest } = parsed.value;
    const widening = pipelineWideningDenied(req, definition as PipelineDefinition | undefined);
    if (widening) { res.status(403).json(forbiddenBody(req, { kind: 'override', reason: widening })); return; }
    try {
      const updated = updatePipeline(existing.id, { ...rest, ...(definition ? { definition: definition as PipelineDefinition } : {}) });
      emitAutomationEvent({ kind: 'pipeline_updated', pipeline: updated, origin: automationOriginOf(req) });
      res.json({ pipeline: updated });
    } catch (err) {
      res.status(400).json(apiError('pipeline_refused', (err as Error).message, { detail: (err as Error).message }));
    }
  });

  app.delete('/api/pipelines/:id', (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'kanban:write')) return;
    const existing = visiblePipeline(req, req.params.id);
    if (!existing) { res.status(404).json(apiError('pipeline_not_found', 'pipeline not found')); return; }
    if (rejectReadOnlyPipeline(req, res, existing)) return;
    deletePipeline(existing.id);
    emitAutomationEvent({ kind: 'pipeline_deleted', pipeline: existing, origin: automationOriginOf(req) });
    res.json({ ok: true });
  });

  app.post('/api/pipelines/:id/run', (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'kanban:write')) return;
    const parsed = parsePipelineRunBody(req.body);
    if (!parsed.ok) { res.status(400).json(apiError('pipeline_body_invalid', parsed.error, { detail: parsed.error })); return; }
    const target = visiblePipeline(req, req.params.id);
    if (!target) { res.status(404).json(apiError('pipeline_not_found', 'pipeline not found')); return; }
    // Each step assigns work to its agent: the delegation list `POST /api/tasks`
    // applies, step by step, before anything is written. A mission that does
    // not orchestrate `coder` cannot make it work through a pipeline either. A
    // person or an operator has no list (`delegatingAgent` is null).
    for (const step of target.definition.steps) {
      const refusal = delegationRefusal(req, step.agent);
      if (refusal) {
        res.status(403).json(apiError('orchestration_denied', `pipeline run refused: step ${step.id}: ${refusal}`, { detail: `step ${step.id}: ${refusal}` }));
        return;
      }
    }
    // Each step opens a task carrying its overrides: the guard a task created
    // by hand takes (`POST /api/tasks`), before `runPipeline` writes the run.
    // Without it, a pipeline was the way around that guard.
    for (const step of target.definition.steps) {
      const refusal = taskOverrideDenied(req, { ...step }, step.agent);
      if (refusal) {
        res.status(403).json(forbiddenBody(req, { kind: 'override', reason: `step ${step.id}: ${refusal}` }));
        return;
      }
    }
    // The run and its tasks are the caller's, as a task created by hand is
    // (`ctx.pipelines.run` does the same with `runOwner()`): without it the run
    // row stayed NULL and its tasks took an inherited owner.
    const owner = pipelineAccountOf(req);
    try {
      const result = runPipeline(target.id, parsed.value.input ?? {}, owner !== undefined ? { ownerUserId: owner } : {});
      const pipeline = getPipeline(target.id);
      if (pipeline) {
        emitAutomationEvent({
          kind: 'pipeline_run_started', pipeline, run: result,
          ownerUserId: owner ?? pipeline.owner_user_id, origin: automationOriginOf(req),
        });
      }
      res.status(201).json(result);
    } catch (err) {
      res.status(400).json(apiError('pipeline_run_failed', (err as Error).message, { detail: (err as Error).message }));
    }
  });

  app.get('/api/pipelines/runs/:runId', (req, res) => {
    // Someone else's run answers like a missing one: its input and steps are theirs.
    const run = dbApi.getPipelineRun(req.params.runId);
    const status = run && pipelineRunVisibleTo(run, viewerFromRequest(req)) ? getRunStatus(run.id) : null;
    if (!status) {
      res.status(404).json(apiError('pipeline_run_not_found', 'run not found'));
      return;
    }
    res.json(status);
  });

  app.get('/api/tasks', (req, res) => {
    // `TODO` as input = deprecated alias of `PENDING` (see normalizeTaskStatusInput).
    const status = typeof req.query.status === 'string'
      ? normalizeTaskStatusInput(req.query.status)
      : undefined;
    const full = req.query.full === '1' || req.query.full === 'true';
    // Tasks implementing one TO DO idea: what its detail dialog lists.
    let todoId: number | null = null;
    if (req.query.todo_id !== undefined) {
      const parsed = TodoIdSchema.safeParse(Number(req.query.todo_id));
      if (typeof req.query.todo_id !== 'string' || !parsed.success) {
        res.status(400).json(apiError('todo_id_invalid', 'todo_id must be a positive integer'));
        return;
      }
      todoId = parsed.data;
    }
    const listed = scopedDb(viewerFromRequest(req))
      .listTasks(status as Parameters<typeof dbApi.listTasks>[0])
      .map(boardStatusRow);
    const all = todoId === null ? listed : listed.filter((t) => t.todo_id === todoId);
    const doneLimit = parseDoneLimit(req.query.done_limit);
    const doneAgent = typeof req.query.done_agent === 'string' && req.query.done_agent ? req.query.done_agent : null;
    let doneProject: string | null = null;
    if (req.query.done_project !== undefined && req.query.done_project !== '') {
      const parsed = ProjectSlugSchema.safeParse(req.query.done_project);
      if (!parsed.success) {
        res.status(400).json(apiError('done_project_invalid', 'done_project must be a project slug'));
        return;
      }
      doneProject = parsed.data;
    }
    const doneQuery = typeof req.query.done_q === 'string' ? req.query.done_q.trim().slice(0, 200) : '';
    const doneWindow = doneLimit === null
      ? null
      : windowDoneTasks(all, doneLimit, doneTaskFilter(doneAgent, doneProject, undefined, doneQuery || null));
    const tasks = doneWindow?.tasks ?? all;
    // Effective backend + model per task (override → role → config → default),
    // resolved on the server side because the client does not have the agent config. Cache shared
    // over the batch: the tasks reuse the same agents/projects.
    const cache = {
      cfg: new Map<string, AgentConfig>(),
      roles: new Map<string, RoleSpec | undefined>(),
      series: new Map<string, SeriesLlmChoice | undefined>(),
      modelBackend: new Map<string, string | null>(),
    };
    const listChain = (rootId: string) => dbApi.listVerificationChain(rootId);
    // Only the number: the card shows a paperclip, the dialog reads the list.
    const attachmentCounts = countTaskAttachments(tasks);
    // `listed`, not `all`: a todo_id filter must not hide a task's dependents.
    const withLlm = withDependents(tasks, listed).map((t) => {
      const { backend, model } = resolveTaskLlm(t, cache);
      const row = full ? t : boardTaskRow(t);
      const runner = taskRunner(t);
      return {
        ...row,
        effective_backend: backend,
        effective_model: model,
        attachment_count: attachmentCounts.get(t.id) ?? 0,
        ...(runner ? { run_by: runner } : {}),
        ...(codeAwaitsMerge(t, listChain) ? { awaiting_merge: true } : {}),
        // Only on a chain merged into an integration branch: 'integrated'
        // until that branch lands, then 'landed' (or 'closed').
        ...(usesIntegrationBranch(t.integration_mode) ? { landing: chainLanding(t) } : {}),
      };
    });
    res.json({
      tasks: withLlm,
      ...(full ? {} : { view: 'board' }),
      ...(doneWindow ? { done_total: doneWindow.doneTotal } : {}),
    });
  });

  app.post('/api/tasks', (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'kanban:write')) return;
    // After the right, like the update: a refused caller learns nothing of the shape.
    const parsed = parseTaskCreateBody(req.body);
    if (!parsed.ok) { res.status(400).json(apiError('task_body_invalid', parsed.error, { detail: parsed.error })); return; }
    const r = createTaskFromBody(req, parsed.value);
    res.status(r.status).json(r.json);
  });

  // The fallback routes take the `/roles` guard too: a series' plan is steered
  // by its pilot's owner, never by another account that merely knows its id.
  app.get('/api/series/:id/fallbacks', (req, res) => {
    const seriesId = seriesForRolesRoute(req, res);
    if (!seriesId) return;
    res.json({ series_id: seriesId, fallbacks: listSeriesFallbackRules(seriesId) });
  });

  /** Sets a fallback rule and applies it, unless `apply: false` (see `setSeriesFallbackRule`). */
  app.put('/api/series/:id/fallbacks', async (req, res) => {
    const seriesId = seriesForRolesRoute(req, res);
    if (!seriesId || seriesLlmDenied(req, res, seriesId, 'fallback')) return;
    try {
      res.json(await setSeriesFallbackRule(seriesId, (req.body ?? {}) as FallbackRuleInput));
    } catch (err) {
      if (err instanceof SeriesServiceError) { res.status(400).json(apiError('series_rule_refused', err.message, { detail: err.message })); return; }
      throw err;
    }
  });

  app.delete('/api/series/:id/fallbacks/:scope', (req, res) => {
    const seriesId = seriesForRolesRoute(req, res);
    if (!seriesId) return;
    const group = groupQuery(req);
    if (group === null) { res.status(400).json(apiError('series_group_invalid', 'group must be a single string')); return; }
    try {
      res.json({ series_id: seriesId, fallbacks: clearSeriesFallbackRule(seriesId, req.params.scope, group) });
    } catch (err) {
      if (err instanceof SeriesServiceError) { res.status(400).json(apiError('series_rule_refused', err.message, { detail: err.message })); return; }
      throw err;
    }
  });

  /** Backend/model per task type FOR THIS SERIES — see `series-service.ts`. */
  app.get('/api/series/:id/roles', (req, res) => {
    const seriesId = seriesForRolesRoute(req, res);
    if (!seriesId) return;
    res.json({ series_id: seriesId, roles: listSeriesRoleChoices(seriesId) });
  });

  app.put('/api/series/:id/roles', (req, res) => {
    const seriesId = seriesForRolesRoute(req, res);
    if (!seriesId || seriesLlmDenied(req, res, seriesId, 'role')) return;
    try {
      res.json({ series_id: seriesId, roles: setSeriesRoleChoice(seriesId, req.body) });
    } catch (err) {
      if (err instanceof SeriesServiceError) { res.status(400).json(apiError('series_rule_refused', err.message, { detail: err.message })); return; }
      throw err;
    }
  });

  app.delete('/api/series/:id/roles/:scope', (req, res) => {
    const seriesId = seriesForRolesRoute(req, res);
    if (!seriesId) return;
    const group = groupQuery(req);
    if (group === null) { res.status(400).json(apiError('series_group_invalid', 'group must be a single string')); return; }
    try {
      res.json({ series_id: seriesId, roles: clearSeriesRoleChoice(seriesId, req.params.scope, group) });
    } catch (err) {
      if (err instanceof SeriesServiceError) { res.status(400).json(apiError('series_rule_refused', err.message, { detail: err.message })); return; }
      throw err;
    }
  });

  /**
   * TYPED closing of a task: the end gesture, not a generic edit.
   *
   * Why a separate route when `PUT /api/tasks/:id` already does it all:
   * depending on the LLM backend, agents did not manage to close. The id
   * had to be copied from the brief's text, the comment went through
   * shell quoting, and nothing designated `kanban_update` as THE end gesture.
   * Here the task is resolved from the current mission (`X-TIMON-Mission`, injected
   * into the env of every dispatched agent) and the comment is MANDATORY:
   * that is what structurally prevents the silent closing, the one that leaves the
   * pilot with an empty `task_closed`.
   *
   * `timon task done`, `timon task block` and `kanban_update` stay valid:
   * nothing was removed, the path that cannot fail was added.
   */
  app.post('/api/tasks/close', (req, res) => {
    // Identity, then the right, then the shape (TODO #787), like the PUT.
    const auth = requireAuth(req, res);
    if (!auth) return;
    const parsed = parseTaskCloseBody(req.body);
    const explicitId = parsed.ok && typeof parsed.value.id === 'string' ? parsed.value.id.trim() : '';
    const claimedMission = parsed.ok
      ? (typeof parsed.value.mission_id === 'string' ? parsed.value.mission_id.trim() : '') || req.header('X-TIMON-Mission') || ''
      : '';
    // Closing the task one's own mission runs needs no `kanban:write`. Its
    // mission is the token's binding: the header and `mission_id` only say
    // which mission the caller claims, so a claim elsewhere needs the right.
    const ownTaskId = parsed.ok ? ownMissionTaskId(req) : null;
    const ownClose = ownTaskId !== null && (explicitId
      ? explicitId === ownTaskId
      : !claimedMission || claimedMission === auth.missionId);
    if (!ownClose && rejectIfDenied(req, res, 'kanban:write')) return;
    if (!parsed.ok) { res.status(400).json(apiError('task_body_invalid', parsed.error, { detail: parsed.error })); return; }
    const body = parsed.value;
    const scope = scopedDb(viewerFromRequest(req));
    const outcome = body.outcome ?? 'done';
    if (outcome !== 'done' && outcome !== 'failed') {
      res.status(400).json(apiError('task_outcome_invalid', `invalid outcome "${String(body.outcome)}" (expected: done | failed)`));
      return;
    }
    // Resolution by mission: no id to copy, the first cause of a failed
    // closing. `id` is still accepted to close ANOTHER task than one's own.
    let taskId = explicitId;
    if (!taskId) {
      const missionId = claimedMission || (ownClose ? auth.missionId ?? '' : '');
      if (!missionId) {
        res.status(400).json(apiError('task_close_target_missing', 'no task id, and no mission to resolve one from (X-TIMON-Mission absent)'));
        return;
      }
      const resolved = dbApi.getTaskByMission(missionId);
      if (!resolved) {
        res.status(404).json(apiError('mission_has_no_task', `no task attached to mission ${missionId}`));
        return;
      }
      taskId = resolved.id;
    }
    // Read again under the caller's scope: the resolution by mission goes
    // through `dbApi`, which does not know the viewer. Without this second pass, the
    // closing would be the only path of this file ignoring the partitioning.
    const task = scope.getTask(taskId);
    if (!task) { res.status(404).json(apiError('not_found', 'not found')); return; }

    if (outcome === 'failed') {
      const reason = (typeof body.reason === 'string' ? body.reason
        : typeof body.blocked_reason === 'string' ? body.blocked_reason : '').trim();
      if (!reason) {
        res.status(400).json(apiError('task_reason_required', 'reason is required to mark a task as failed'));
        return;
      }
      closeTask(scope.getTask, taskId, task, 'BLOCKED', { blockedReason: reason, byPerson: isPersonAuth(req.auth) });
      res.json({ task: scope.getTask(taskId) });
      return;
    }

    const comment = typeof body.comment === 'string' ? body.comment.trim() : '';
    if (!comment) {
      res.status(400).json(apiError('task_comment_required', 'comment is required to mark a task as done'));
      return;
    }
    let verdict: 'pass' | 'changes_requested' | null = null;
    if (body.verdict !== undefined && body.verdict !== null) {
      if (body.verdict !== 'pass' && body.verdict !== 'changes_requested') {
        res.status(400).json(apiError('task_verdict_invalid', `invalid verdict "${String(body.verdict)}" (expected: pass | changes_requested)`));
        return;
      }
      verdict = body.verdict;
    }
    if (body.merged_sha !== undefined) {
      if (typeof body.merged_sha !== 'string' || !MERGED_SHA_RE.test(body.merged_sha)) {
        res.status(400).json(apiError('sha_invalid', 'merged_sha must be 7-40 hex chars'));
        return;
      }
      const shaRefusal = mergedShaRefusal(task, body.merged_sha);
      if (shaRefusal) { res.status(409).json(apiError('sha_not_in_base', shaRefusal, { sha: body.merged_sha, base: task.base_branch ?? '' })); return; }
    }
    const declaredSha = typeof body.merged_sha === 'string' ? body.merged_sha : null;
    if (rejectUnprovenClose(res, task, effectiveMergeSha(task, declaredSha, comment))) return;
    if (body.merged_sha !== undefined) {
      // Set BEFORE the status: the merge guard refuses DONE on a
      // type='merge' task without a sha, and the reverse order degrades the transition into BLOCKED.
      dbApi.setTaskMergedSha(taskId, body.merged_sha);
      // The gate must inspect the SHA just persisted, not the earlier snapshot.
      task.merged_commit_sha = body.merged_sha;
    }
    // Plain 1st line: it is the contract of `parseReviewVerdict`, which survives
    // the truncation of everything that follows. It is not doubled if the agent has
    // already written it itself.
    const doneComment = verdict && !/^verdict\s*[:=]/i.test(comment)
      ? `verdict: ${verdict}\n\n${comment}`
      : comment;
    closeTask(scope.getTask, taskId, task, 'DONE', { doneComment, summary: parseSummary(body.summary) });
    res.json({ task: scope.getTask(taskId) });
  });

  /**
   * TIM-0109 — a branch integrated outside Timon (a PR merged on GitHub, a
   * merge by hand) left its task BLOCKED and every dependent waiting. Marking
   * it merged records the sha and closes it DONE: the dependency gate counts
   * it as landed, and no review is chained on it.
   *
   * A task already DONE without a sha (a `full` code task whose review or
   * merge never came, its PR merged elsewhere) only records the sha and a
   * note: it is not closed again, so its return and follow-ups do not replay.
   *
   * A chain on an integration branch (`integration_mode` 'pr' or 'branch')
   * lands its whole job instead: `markIntegrationMerged`.
   */
  app.post('/api/tasks/:id/mark-merged', async (req, res) => {
    if (!requireAuth(req, res)) return;
    // A human gesture of the board: no exception for a mission (TODO #787).
    if (rejectIfDenied(req, res, 'kanban:write')) return;
    const params = z.object({ id: z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/) }).safeParse(req.params);
    if (!params.success) { res.status(400).json(apiError('task_invalid', 'Invalid task identifier.')); return; }
    const parsed = parseMarkMergedBody(req.body);
    if (!parsed.ok) { res.status(400).json(apiError('task_body_invalid', parsed.error, { detail: parsed.error })); return; }
    const rawSha = parsed.value.sha;
    if (typeof rawSha !== 'string' || !MERGED_SHA_RE.test(rawSha)) {
      res.status(400).json(apiError('sha_invalid', 'sha must be a commit id (7 to 40 hex characters).'));
      return;
    }
    const scope = scopedDb(viewerFromRequest(req));
    const task = scope.getTask(params.data.id);
    if (!task) { res.status(404).json(apiError('task_not_found', 'Task not found.')); return; }
    if (task.type !== 'code' && task.type !== 'merge') {
      res.status(400).json(apiError('task_not_mergeable', 'Only a code or merge task can be marked merged.'));
      return;
    }
    if (usesIntegrationBranch(task.integration_mode)) {
      try {
        await markIntegrationMerged(req, res, task, rawSha.toLowerCase(), parsed.value.comment, deps);
      } catch (err) {
        // Not echoed: an unexpected failure may quote a path of this machine.
        console.error(`[kanban] marking ${task.id} merged failed: ${(err as Error).message}`);
        if (!res.headersSent) res.status(500).json(apiError('task_mark_merged_failed', 'The task could not be marked merged.'));
      }
      return;
    }
    // A PENDING or running task still belongs to its agent.
    const doneUnmerged = task.status === 'DONE' && !task.merged_commit_sha;
    if (task.status !== 'BLOCKED' && !doneUnmerged) {
      res.status(409).json(task.status === 'DONE' && task.merged_commit_sha
        ? apiError('task_already_merged', `The task is already merged (${task.merged_commit_sha}).`, { sha: task.merged_commit_sha })
        : apiError('task_not_blocked', task.merged_commit_sha
          ? `The task is already merged (${task.merged_commit_sha}).`
          : 'Only a blocked task, or a done one without a merge commit, can be marked merged.'));
      return;
    }
    const sha = rawSha.toLowerCase();
    const found = shaInBase(taskRepo(task), task.base_branch, sha);
    if (found === 'not_contained') {
      res.status(409).json(apiError('sha_not_in_base', `Commit ${sha} is not in ${task.base_branch} of this repository. Check the sha of the merge.`, { sha, base: task.base_branch ?? '' }));
      return;
    }
    dbApi.setTaskMergedSha(task.id, sha);
    task.merged_commit_sha = sha;
    const note = found === 'contained'
      ? `Marked as merged outside Timon: ${sha} (found in ${task.base_branch}).`
      : `Marked as merged outside Timon: ${sha} (not found in the local ${task.base_branch ?? 'base'}: not verified, fetch to check).`;
    const comment = parsed.value.comment?.trim();
    const report = comment ? `${note}\n\n${comment}` : note;
    if (doneUnmerged) {
      dbApi.appendTaskDoneComment(task.id, report);
      // The close already ran its chain: the TO DO idea it realises only lands now.
      try {
        applyTodoClosure(task);
      } catch (err) {
        console.error(`[kanban] TO DO closure failed for ${task.id}: ${(err as Error).message}`);
      }
    } else {
      closeTask(scope.getTask, task.id, task, 'DONE', { doneComment: report });
    }
    auditRequest(req, 'task.mark_merged', `${task.id} ${sha}`);
    res.json({ task: scope.getTask(task.id), verified: found === 'contained' });
  });

  /**
   * Attach a task's whole chain to a series (TODO #1013): its root, and every
   * review, merge, doc and repair iteration below it, get the series and its
   * current pilot. A task created without a mission (a `curl` with the
   * daemon-token, a board click) has neither, so its returns reach no pilot
   * and its reviews ignore the series' roles; this is the gesture that repairs
   * it without touching the database by hand.
   *
   * `series`: the series id, the id of the mission piloting it, or `current`
   * (the caller's own mission). A mission that pilots no task yet starts its
   * series here. Neither a series nor a mission = 404, and a series the caller
   * cannot see answers the same, so the refusal confirms nothing.
   */
  app.post('/api/tasks/:id/attach-series', (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'kanban:write')) return;
    const params = z.object({ id: z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/) }).safeParse(req.params);
    if (!params.success) { res.status(400).json(apiError('task_invalid', 'Invalid task identifier.')); return; }
    const parsed = parseAttachSeriesBody(req.body);
    if (!parsed.ok) { res.status(400).json(apiError('task_body_invalid', parsed.error, { detail: parsed.error })); return; }
    const named = parsed.value.series;
    if (!named || !SeriesParamSchema.safeParse({ id: named }).success) {
      res.status(400).json(apiError('series_invalid', 'series must be a series id, a pilot mission id or "current".'));
      return;
    }
    const viewer = viewerFromRequest(req);
    const scope = scopedDb(viewer);
    const task = scope.getTask(params.data.id);
    if (!task) { res.status(404).json(apiError('task_not_found', 'Task not found.')); return; }
    // A mission-bound token IS its mission; the header is only a claim (`pilotMissionOf`).
    const tokenMission = req.auth?.kind === 'api-token' ? req.auth.missionId : undefined;
    const raw = named === 'current' ? (tokenMission ?? req.header('X-TIMON-Mission') ?? '').trim() : named;
    if (!raw) {
      res.status(400).json(apiError('series_invalid', 'series "current" needs a mission: call from inside one, or name the series.'));
      return;
    }
    const notFound = () => res.status(404).json(apiError('series_not_found', `Series ${raw} not found: name a series id or the id of the mission piloting it.`));
    const known = dbApi.seriesIdForMission(raw);
    const seriesId = known ?? (scope.getMission(raw) ? raw : null);
    if (!seriesId || !seriesVisible(req, seriesId)) { notFound(); return; }
    const pilotId = (known ? dbApi.seriesPilotMission(known) : null) ?? seriesId;
    // The stored pilot seeds follow-up agents on its backend (TIM-0082): a
    // restricted caller may only name a pilot it can see.
    const pilot = scope.getMission(pilotId);
    if (!pilot) { notFound(); return; }
    if (pilot.task_id) {
      res.status(400).json(apiError('series_pilot_is_task', `Mission ${pilot.id} runs a task: a series is piloted by the mission that plans it.`));
      return;
    }
    // Only what the caller sees moves: someone else's follow-up keeps its row.
    const lineage = (dbApi.listTaskLineage(task.id) ?? []).filter((t) => scope.getTask(t.id));
    const ids = lineage.map((t) => t.id);
    dbApi.attachTasksToSeries(ids, seriesId, pilot.id);
    auditRequest(req, 'task.attach_series', `${task.id} series:${seriesId} pilot:${pilot.id} tasks:${ids.length}`);
    res.json({ series_id: seriesId, pilot_mission_id: pilot.id, attached: ids, task: scope.getTask(task.id) });
  });

  app.get('/api/tasks/:id', (req, res) => {
    const task = scopedDb(viewerFromRequest(req)).getTask(req.params.id);
    if (!task) { res.status(404).json(apiError('not_found', 'not found')); return; }
    const { backend, model } = resolveTaskLlm(task);
    const runner = taskRunner(task);
    // Inherited ones included: an iteration works with its root's files.
    const attachments = taskAttachmentsWithInherited(task).map(publicTaskAttachment);
    res.json({ task: { ...task, effective_backend: backend, effective_model: model, attachments, ...(runner ? { run_by: runner } : {}) } });
  });

  app.put('/api/tasks/:id', (req, res) => {
    // Identity, then the right, then the shape (TODO #752): a caller refused
    // learns nothing of the body's shape nor of the task's existence.
    if (!requireAuth(req, res)) return;
    const parsed = parseTaskUpdateBody(req.body);
    // Without `kanban:write`, a mission may still close the task it runs
    // (`timon task done` / `block`): `POST /api/tasks/close` lets it, and a
    // task its owner can no longer close would hang IN_PROGRESS.
    const ownClose = parsed.ok && isClosingOnly(parsed.value) && isOwnMissionTask(req, req.params.id);
    if (!ownClose && rejectIfDenied(req, res, 'kanban:write')) return;
    if (!parsed.ok) { res.status(400).json(apiError('task_body_invalid', parsed.error, { detail: parsed.error })); return; }
    const body = parsed.value;
    const scope = scopedDb(viewerFromRequest(req));
    const task = scope.getTask(req.params.id);
    if (!task) { res.status(404).json(apiError('not_found', 'not found')); return; }
    // An empty override means none: stored as '', it would pass for a requeue
    // correction while the dispatcher runs the task on the same LLM (TIM-0065).
    if (body.backend_override === '') body.backend_override = null;
    if (body.model_override === '') body.model_override = null;
    // Re-assigning is delegating, same list as at creation. Before any write.
    if (typeof body.agent_name === 'string' && body.agent_name !== task.agent_name) {
      const refusal = delegationRefusal(req, body.agent_name);
      if (refusal) {
        res.status(403).json(apiError('orchestration_denied', `task refused: ${refusal}`, { detail: refusal }));
        return;
      }
    }
    const reassigned = typeof body.agent_name === 'string' && body.agent_name !== task.agent_name;
    const overrideRefusal = taskOverrideDenied(req, body, body.agent_name ?? task.agent_name, reassigned ? task : null, task);
    if (overrideRefusal) {
      forbidden(req, res, { kind: 'override', reason: overrideRefusal });
      return;
    }
    // A task that keeps dying must not be replayed by its pilot forever
    // (TIM-0065, crash-loop.ts). `null` = a human or an operator.
    const requeue = normalizeTaskStatusInput(body.status) === 'PENDING' && task.status === 'BLOCKED';
    const requeuer = requeue ? delegatingAgent(req) : null;
    if (requeue && requeuer !== null) {
      const refusal = agentRequeueRefusal(task, isCorrection(task, body));
      if (refusal) {
        auditRequest(req, 'task.requeue_refused', task.id);
        res.status(409).json(apiError('crash_loop', refusal, { detail: refusal }));
        return;
      }
    }
    // Before any write, like the delegation check: a refused link changes nothing.
    const todo = parseTodoLink(req, body.todo_id);
    if (!todo.ok) { res.status(400).json(todo.body); return; }
    // The merge sha's shape and base, checked with the rest: every refusal
    // comes before the first write, so a 400 or 409 leaves the task untouched.
    const sha = typeof body.merged_commit_sha === 'string' ? body.merged_commit_sha : null;
    if (sha !== null) {
      if (!/^[0-9a-f]{7,40}$/i.test(sha)) {
        res.status(400).json(apiError('sha_invalid', 'merged_commit_sha must be 7-40 hex chars'));
        return;
      }
      const shaRefusal = mergedShaRefusal(task, sha);
      if (shaRefusal) { res.status(409).json(apiError('sha_not_in_base', shaRefusal, { sha, base: task.base_branch ?? '' })); return; }
    }
    if (normalizeTaskStatusInput(body.status) === 'DONE' && task.status !== 'DONE'
      && rejectUnprovenClose(res, task, effectiveMergeSha(task, sha, body.done_comment))) return;
    // See creation: a non-numeric scheduled_at would go into the database as is.
    const sched = validateScheduledAt(body.scheduled_at);
    if (!sched.ok) {
      res.status(400).json(apiError('scheduled_at_invalid', sched.error, { detail: sched.error }));
      return;
    }
    // See creation: an unknown backend would be dropped at dispatch silently.
    const backendError = backendRefusal(body);
    if (backendError) { res.status(400).json(apiError('task_field_invalid', backendError, { detail: backendError })); return; }
    let type: TaskType | undefined;
    if (body.type !== undefined) {
      if (!isTaskType(body.type)) {
        res.status(400).json(apiError('task_type_invalid', `invalid type "${body.type}"`, { type: String(body.type) }));
        return;
      }
      type = body.type;
    }
    const schedWarning = checkScheduledAtPlausibility(sched.value, Date.now());
    if (schedWarning) console.warn(`[tasks] ${schedWarning}`);

    // ── Writes: every refusal of the request is above. ──
    // The merge sha goes BEFORE any status transition: the merge guard
    // (dbApi.updateTaskStatus) refuses DONE on a type='merge' task without
    // merged_commit_sha. Lets the direct API/MCP paths close in one call.
    if (sha !== null) {
      dbApi.setTaskMergedSha(req.params.id, sha);
      // The gate receives this snapshot, loaded before the SHA was persisted.
      task.merged_commit_sha = sha;
    }
    // Written before the status: a task linked and closed in the same call must
    // already carry its idea when `task_done` fires.
    if (todo.value !== undefined) dbApi.setTaskTodoId(req.params.id, todo.value);
    const nextStatus = normalizeTaskStatusInput(body.status);
    if (nextStatus && nextStatus !== task.status) {
      // Terminal status: exactly the same path as `POST /api/tasks/close`
      // (code gate, transition, process stop). The non-terminal statuses
      // have neither a gate nor a process to stop.
      if (nextStatus === 'DONE' || nextStatus === 'BLOCKED') {
        closeTask(scope.getTask, req.params.id, task, nextStatus, {
          doneComment: body.done_comment ?? undefined,
          blockedReason: body.blocked_reason ?? undefined,
          summary: parseSummary(body.done_summary),
          // Only a browser session: an agent, the CLI or a plugin blocking a
          // task still hands it to the pilot.
          byPerson: isPersonAuth(req.auth),
        });
      } else {
        dbApi.updateTaskStatus(req.params.id, nextStatus as Parameters<typeof dbApi.updateTaskStatus>[1], {
          blockedReason: body.blocked_reason,
          doneComment: body.done_comment,
        });
      }
    }
    if (body.title || body.description !== undefined || body.agent_name ||
        body.priority !== undefined || body.deps !== undefined || 'scheduled_at' in body ||
        body.clear_scheduled_at === true ||
        body.clear_fallback === true || body.clear_permission_mode === true ||
        body.extra_skills !== undefined || body.extra_mcp_servers !== undefined ||
        body.extra_allowed_tools !== undefined || type !== undefined ||
        'backend_override' in body || 'model_override' in body || 'permission_mode_override' in body ||
        'fallback_backend_override' in body || 'fallback_model_override' in body) {
      dbApi.updateTask(req.params.id, {
        title: body.title,
        description: body.description,
        agentName: body.agent_name,
        priority: body.priority,
        deps: body.deps,
        scheduledAt: sched.value ?? null,
        clearScheduledAt: body.clear_scheduled_at === true,
        extraSkills: body.extra_skills,
        extraMcpServers: body.extra_mcp_servers,
        extraAllowedTools: body.extra_allowed_tools,
        type,
        backendOverride: body.backend_override,
        modelOverride: body.model_override,
        fallbackBackendOverride: body.fallback_backend_override,
        fallbackModelOverride: body.fallback_model_override,
        clearFallback: body.clear_fallback === true,
        permissionModeOverride: body.permission_mode_override,
        clearPermissionMode: body.clear_permission_mode === true,
      });
    }
    // After `updateTask`, so a `scheduled_at` in the same body cannot bring an
    // agent's requeue forward past its backoff.
    if (requeue) {
      if (requeuer === null) dbApi.resetTaskRequeues(req.params.id);
      else {
        const delay = agentRequeueDelayMs(task);
        if (delay > 0) dbApi.deferTask(req.params.id, Date.now() + delay);
      }
    }
    res.json({
      task: scope.getTask(req.params.id),
      ...(schedWarning ? { warnings: [schedWarning] } : {}),
    });
  });

  app.delete('/api/tasks/:id', (req, res) => {
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'kanban:write')) return;
    const params = z.object({ id: z.string().min(1).max(255).regex(/^[A-Za-z0-9_-]+$/) }).safeParse(req.params);
    if (!params.success) { res.status(400).json(apiError('task_invalid', 'Invalid task identifier.')); return; }
    const chainFlag = z.enum(['0', '1', 'true', 'false']).optional().safeParse(req.query.chain);
    if (!chainFlag.success) { res.status(400).json(apiError('chain_invalid', 'chain must be 1 or 0.')); return; }
    const chain = chainFlag.data === '1' || chainFlag.data === 'true';
    try {
      const scope = scopedDb(viewerFromRequest(req));
      const task = scope.getTask(params.data.id);
      if (!task) { res.status(404).json(apiError('task_not_found', 'Task not found.')); return; }
      const outcome = dbApi.deleteTask(params.data.id, {
        chain,
        canDelete: (t) => scope.getTask(t.id) !== undefined,
      });
      if (outcome.result === 'deleted') { res.json({ ok: true, deleted: outcome.chain }); return; }
      res.status(outcome.result === 'not_found' ? 404 : outcome.result === 'forbidden' ? 403 : 409)
        .json(deleteRefusal(outcome, params.data.id, (id) => scope.getTask(id) !== undefined));
    } catch {
      res.status(500).json(apiError('task_delete_failed', 'Unable to delete the task. Please try again.'));
    }
  });
}
