/**
 * The Kanban's "TO DO" notebook — the ideas one jots down without scheduling them,
 * and their handoff to a project's orchestrator.
 *
 * Part of `@timon/kanban` since volet 2/4 of the Kanban work: the
 * notebook is no longer a module to enable, it is the first column of the board.
 * What the merge does NOT change: the `project_todo` table stays separate from
 * `tasks`. An idea is not a task with a particular status, and it is this
 * separation — not a `WHERE` clause a refactor would forget — that guarantees
 * the dispatcher STRUCTURALLY cannot come and take work from it.
 *
 * Routes unchanged since their extraction from the old core-tier module: same
 * paths, same codes, same payloads.
 */
import type { Request, Router } from 'express';
import { orchestratorForProject } from '../../main-agent.js';
import { dbApi, PROJECT_TODO_LIST_DEFAULT_LIMIT, type ProjectTodoRow, type ProjectTodoEditableStatus, type ProjectTodoStatus } from '../../db.js';
import { rejectIfDenied, requireAuth, viewerFromRequest } from '../../users/identity.js';
import { createTaskFromBody } from './routes.js';
import { scopedDb } from '../../users/scoped-db.js';
import { TodoExtensionError } from '../../project-todo-extensions.js';
import { systemMissionId } from '../../notify.js';
import { CORE_FIELDS, patchTodo, publishTodoChanged, withLinks, withLinksOne } from './todo-api.js';
import { alreadyPromoted, promoteTodoItem } from './todo-promote.js';
import { todoOriginFromRequest, withTodoOrigin } from '../../todo-origin.js';
import {
  parseTodoProgress, parseTodoUrgency, TODO_PROGRESSES, TODO_URGENCIES,
  type TodoProgress, type TodoUrgency,
} from '../../project-todo-tags.js';
import { todoExtensionFields } from '../../project-todo-extensions.js';
import { apiError } from '../../api-error.js';
import { z } from 'zod';
import { TODO_LANDING_STATES } from '../../todo-landing.js';

/** Hard ceiling of one page: a client after more narrows the filters instead. */
export const PROJECT_TODO_LIST_MAX_LIMIT = 1000;

const splitComma = (v: string) => v.split(',').map((x) => x.trim());

/** The query fields that are not plain enums. A repeated key arrives as an array: refused. */
const LIST_QUERY = z.object({
  limit: z.coerce.number().int().min(1).max(PROJECT_TODO_LIST_MAX_LIMIT).default(PROJECT_TODO_LIST_DEFAULT_LIMIT),
  ids: z.string().transform(splitComma)
    .pipe(z.array(z.string().regex(/^[1-9]\d{0,15}$/).transform(Number)).min(1).max(PROJECT_TODO_LIST_MAX_LIMIT))
    .optional(),
  // One tag, or several separated by commas; `none` keeps the untagged ideas.
  urgency: z.string().transform(splitComma)
    .pipe(z.array(z.enum([...TODO_URGENCIES, 'none'])).min(1))
    .optional(),
  // The idea's landing badge (its worst job): `open` = pull request open,
  // `pending` = not created yet.
  landing: z.enum(TODO_LANDING_STATES).optional(),
});

/**
 * Status acceptable as a list FILTER — `promoted` included: without it, we
 * could never list the ideas gone to the board, and "where does this
 * task come from?" would stay unanswered.
 */
function parseTodoStatusFilter(v: unknown): ProjectTodoStatus | undefined {
  return v === 'open' || v === 'done' || v === 'promoted' ? v : undefined;
}
/**
 * Status acceptable on WRITE — `promoted` excluded, on purpose. An idea only becomes
 * promoted through the promotion, which creates the task in the same move;
 * accepting it here would let the status be set with no task behind it, hence a
 * "promoted" idea that leads nowhere.
 */
function parseTodoStatusEdit(v: unknown): ProjectTodoEditableStatus | undefined {
  return v === 'open' || v === 'done' ? v : undefined;
}
/**
 * Author of an idea. The `X-TIMON-Agent` header (set by the MCP shim) wins over
 * what the body claims: an agent cannot sign in place of another.
 * Without the header, the call comes from the cockpit — signed `user`, which the UI translates.
 */
function resolveTodoAuthor(req: Request, claimed: unknown): string {
  const caller = req.header('X-TIMON-Agent');
  if (caller) return caller;
  if (typeof claimed === 'string' && claimed.trim()) return claimed.trim();
  return 'user';
}
export function registerRoutes(app: Router): void {
  app.get('/api/project-todo', (req, res) => {
    try {
      const rawStatus = typeof req.query.status === 'string' ? req.query.status : undefined;
      if (rawStatus && rawStatus !== 'all' && !parseTodoStatusFilter(rawStatus)) {
        res.status(400).json(apiError('todo_status_filter_invalid', 'status must be open|done|promoted|all'));
        return;
      }
      const project = typeof req.query.project === 'string' && req.query.project ? req.query.project : undefined;
      const query = LIST_QUERY.safeParse(req.query);
      if (!query.success) {
        const field = query.error.issues[0]?.path[0];
        res.status(400).json(field === 'urgency'
          ? apiError('todo_urgency_filter_invalid', `urgency must be ${[...TODO_URGENCIES, 'none'].join('|')}, comma-separated for several`)
          : field === 'landing'
            ? apiError('todo_landing_filter_invalid', `landing must be ${TODO_LANDING_STATES.join('|')}`)
          : field === 'limit'
            ? apiError('todo_limit_invalid', `limit must be an integer from 1 to ${PROJECT_TODO_LIST_MAX_LIMIT}`, { max: PROJECT_TODO_LIST_MAX_LIMIT })
            : apiError('todo_ids_invalid', 'ids must be comma-separated positive integers'));
        return;
      }
      const progress = parseTodoProgress(req.query.progress);
      if (req.query.progress !== undefined && !progress) {
        res.status(400).json(apiError('todo_progress_invalid', `progress must be ${TODO_PROGRESSES.join('|')}`));
        return;
      }
      const scope = scopedDb(viewerFromRequest(req));
      const status = rawStatus === 'all' ? undefined : parseTodoStatusFilter(rawStatus);
      const filter = { project, urgencies: query.data.urgency, progress, ids: query.data.ids, landing: query.data.landing };
      const items = scope.listProjectTodo({ ...filter, status, limit: query.data.limit });
      // Counted in SQL with the list's own filters: a client that counted the
      // rows it received stopped at the limit (200 open ideas, 0 done).
      const counts = scope.countProjectTodo(filter);
      const matching = status
        ? counts.byStatus[status]
        : counts.byStatus.open + counts.byStatus.done + counts.byStatus.promoted;
      res.json({
        // Links ride on the rows the caller may see: no second visibility rule.
        items: withLinks(items, viewerFromRequest(req)),
        counts,
        truncated: items.length < matching,
        // Kept for older clients: the caller's open ideas across EVERY
        // project, whatever the filters. `counts.byStatus.open` is the filtered one.
        open: scope.countOpenProjectTodo(),
      });
    } catch (err) { res.status(500).json(apiError('todo_request_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.post('/api/project-todo', (req, res) => {
    try {
      const KNOWN_POST = new Set(['text', 'project', 'notes', 'author', 'urgency', 'progress']);
      const unknownPost = Object.keys(req.body ?? {}).filter((k) => !KNOWN_POST.has(k));
      if (unknownPost.length) {
        const accepted = [...KNOWN_POST].sort().join(', ');
        res.status(400).json(apiError('todo_field_unknown', `unknown field: ${unknownPost[0]}; accepted: ${accepted}`, { field: unknownPost[0] ?? '' }));
        return;
      }
      const body = (req.body ?? {}) as {
        text?: unknown; project?: unknown; notes?: unknown; author?: unknown;
        urgency?: unknown; progress?: unknown;
      };
      const text = typeof body.text === 'string' ? body.text.trim() : '';
      if (!text) { res.status(400).json(apiError('text_required', 'text (non-empty string) required')); return; }
      if (body.project !== undefined && body.project !== null && typeof body.project !== 'string') {
        res.status(400).json(apiError('todo_project_invalid', 'project must be a string or null'));
        return;
      }
      if (body.notes !== undefined && body.notes !== null && typeof body.notes !== 'string') {
        res.status(400).json(apiError('todo_notes_invalid', 'notes must be a string or null'));
        return;
      }
      let urgency: TodoUrgency | null = null;
      if (body.urgency !== undefined && body.urgency !== null) {
        const u = parseTodoUrgency(body.urgency);
        if (!u) { res.status(400).json(apiError('todo_urgency_invalid', `urgency must be ${TODO_URGENCIES.join('|')} or null`)); return; }
        urgency = u;
      }
      let progress: TodoProgress | undefined;
      if (body.progress !== undefined) {
        progress = parseTodoProgress(body.progress);
        if (!progress) { res.status(400).json(apiError('todo_progress_invalid', `progress must be ${TODO_PROGRESSES.join('|')}`)); return; }
      }
      const item = scopedDb(viewerFromRequest(req)).insertProjectTodo({
        text,
        urgency,
        ...(progress ? { progress } : {}),
        project: typeof body.project === 'string' ? body.project.trim() || null : null,
        notes: typeof body.notes === 'string' ? body.notes : null,
        author: resolveTodoAuthor(req, body.author),
      });
      publishTodoChanged(item);
      res.status(201).json({ item: withLinksOne(item, viewerFromRequest(req)) });
    } catch (err) { res.status(500).json(apiError('todo_request_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.patch('/api/project-todo/:id', (req, res) => {
    // Explicit: plugin fields of the body may write what is read outside Timon.
    if (!requireAuth(req, res)) return;
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) { res.status(400).json(apiError('invalid_id', 'invalid id')); return; }
      const allKnown = new Set([...CORE_FIELDS, ...todoExtensionFields()]);
      const unknown = Object.keys(req.body ?? {}).filter((k) => !allKnown.has(k));
      if (unknown.length) {
        const accepted = [...allKnown].sort().join(', ');
        res.status(400).json(apiError('todo_field_unknown', `unknown field: ${unknown[0]}; accepted: ${accepted}`, { field: unknown[0] ?? '' }));
        return;
      }
      const body = (req.body ?? {}) as {
        text?: unknown; project?: unknown; notes?: unknown; author?: unknown; status?: unknown;
        urgency?: unknown; progress?: unknown;
      };
      const fields: {
        text?: string;
        project?: string | null;
        notes?: string | null;
        author?: string | null;
        status?: ProjectTodoEditableStatus;
        urgency?: TodoUrgency | null;
        progress?: TodoProgress;
      } = {};
      if (body.urgency !== undefined) {
        if (body.urgency === null) fields.urgency = null;
        else {
          const u = parseTodoUrgency(body.urgency);
          if (!u) { res.status(400).json(apiError('todo_urgency_invalid', `urgency must be ${TODO_URGENCIES.join('|')} or null`)); return; }
          fields.urgency = u;
        }
      }
      if (body.progress !== undefined) {
        const p = parseTodoProgress(body.progress);
        if (!p) { res.status(400).json(apiError('todo_progress_invalid', `progress must be ${TODO_PROGRESSES.join('|')}`)); return; }
        fields.progress = p;
      }
      if (body.text !== undefined) {
        const text = typeof body.text === 'string' ? body.text.trim() : '';
        if (!text) { res.status(400).json(apiError('text_required', 'text (non-empty string) required')); return; }
        fields.text = text;
      }
      if (body.project !== undefined) {
        if (body.project !== null && typeof body.project !== 'string') {
          res.status(400).json(apiError('todo_project_invalid', 'project must be a string or null'));
          return;
        }
        fields.project = typeof body.project === 'string' ? body.project.trim() || null : null;
      }
      if (body.notes !== undefined) {
        if (body.notes !== null && typeof body.notes !== 'string') {
          res.status(400).json(apiError('todo_notes_invalid', 'notes must be a string or null'));
          return;
        }
        fields.notes = body.notes;
      }
      if (body.author !== undefined) {
        if (body.author !== null && typeof body.author !== 'string') {
          res.status(400).json(apiError('todo_author_invalid', 'author must be a string or null'));
          return;
        }
        fields.author = typeof body.author === 'string' ? body.author.trim() || null : null;
      }
      if (body.status !== undefined) {
        const status = parseTodoStatusEdit(body.status);
        if (!status) {
          res.status(400).json(body.status === 'promoted'
            ? apiError('todo_promoted_by_hand', 'status "promoted" cannot be set by hand — use POST /api/project-todo/:id/promote')
            : apiError('todo_status_invalid', 'status must be open|done'));
          return;
        }
        fields.status = status;
      }
      const existing = scopedDb(viewerFromRequest(req)).getProjectTodo(id);
      if (!existing) {
        res.status(404).json(apiError('todo_not_found', 'project-todo item not found')); return;
      }
      // Fields owned by plugins (`project-todo-extensions.ts`) ride along in the body.
      // The writer rides along: a connector tells its own echo by it.
      const item = withTodoOrigin(todoOriginFromRequest(req), () => patchTodo(existing, fields, req.body ?? {}));
      if (!item) { res.status(404).json(apiError('todo_not_found', 'project-todo item not found')); return; }
      res.json({ item: withLinksOne(item, viewerFromRequest(req)) });
    } catch (err) {
      if (err instanceof TodoExtensionError) { res.status(err.status).json(apiError('todo_field_refused', err.message, { detail: err.message })); return; }
      res.status(500).json(apiError('todo_request_failed', (err as Error).message, { detail: (err as Error).message }));
    }
  });

  /**
   * Promotion: the idea becomes a `PENDING` task, ready to code.
   *
   * Distinct from `handoff`, which SENDS A MESSAGE to the project's orchestrator so
   * that it discusses it with the user. Both gestures coexist: discussing, and
   * promoting. The task is created by `createTaskFromBody` — the exact path of
   * `POST /api/tasks`, guards included — and not by a copy that would drift.
   *
   * The idea is neither deleted nor left open: it is marked promoted and
   * keeps the link to its task, so that "where does this task come from?"
   * can always be answered.
   */
  app.post('/api/project-todo/:id/promote', (req, res) => {
    // Promoting creates a task: the same right as `POST /api/tasks` (TODO #752).
    if (!requireAuth(req, res)) return;
    if (rejectIfDenied(req, res, 'kanban:write')) return;
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) { res.status(400).json(apiError('invalid_id', 'invalid id')); return; }
      const scope = scopedDb(viewerFromRequest(req));
      const item = scope.getProjectTodo(id);
      if (!item) { res.status(404).json(apiError('todo_not_found', 'project-todo item not found')); return; }
      const conflict = alreadyPromoted(item);
      if (conflict) { res.status(conflict.status).json(conflict.json); return; }
      const body = (req.body ?? {}) as {
        agent_name?: unknown; type?: unknown; base?: unknown;
        priority?: unknown; pipeline?: unknown; project?: unknown; trace_id?: unknown;
      };
      if (typeof body.agent_name !== 'string' || !body.agent_name.trim()) {
        res.status(400).json(apiError('agent_required', 'agent_name (non-empty string) required — who runs the task?'));
        return;
      }
      const agentName = body.agent_name.trim();
      const outcome = promoteTodoItem(
        item,
        viewerFromRequest(req),
        typeof body.project === 'string' && body.project.trim() ? body.project.trim() : undefined,
        (spec) => createTaskFromBody(req, {
          title: spec.title,
          description: spec.description,
          agent_name: agentName,
          ...(typeof body.type === 'string' ? { type: body.type } : {}),
          ...(typeof body.base === 'string' ? { base: body.base } : {}),
          ...(typeof body.priority === 'number' ? { priority: body.priority } : {}),
          ...(typeof body.pipeline === 'string' ? { pipeline: body.pipeline } : {}),
          ...(spec.project ? { project: spec.project } : {}),
          // Trace lineage: a promoted task traces back like a task created
          // directly, otherwise the trace stops at the idea.
          ...(typeof body.trace_id === 'string' ? { trace_id: body.trace_id } : {}),
          // The task carries its idea: that is what closes it once the chain lands.
          todo_id: spec.todoId,
        }),
      );
      if (!outcome.ok) { res.status(outcome.status).json(outcome.json); return; }
      res.status(201).json({ task: outcome.task, item: outcome.item });
    } catch (err) { res.status(500).json(apiError('todo_request_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.post('/api/project-todo/:id/handoff', async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) { res.status(400).json(apiError('invalid_id', 'invalid id')); return; }
      const item = scopedDb(viewerFromRequest(req)).getProjectTodo(id);
      if (!item) { res.status(404).json(apiError('todo_not_found', 'project-todo item not found')); return; }
      if (!item.project) {
        res.status(400).json(apiError('todo_project_missing', 'idea without a project — set a project so it can be routed'));
        return;
      }
      // Same rule as the dispatcher's recap routing: the agent holding the
      // orchestrator ROLE on the project, then `<slug>.main`, then the
      // cross-project orchestrator. Never a name convention alone (TIM-0067).
      // `null` means no agent exists on disk: refuse rather than drop the
      // message in a ghost inbox.
      const toAgent = orchestratorForProject(item.project);
      if (!toAgent) {
        res.status(400).json(apiError('todo_no_orchestrator', `no orchestrator for project "${item.project}": give an agent of this project the orchestrator role`, { project: item.project }));
        return;
      }
      const payload = [
        `Idea raised from the Kanban TO DO notebook (item #${item.id}).`,
        ``,
        `Title: ${item.text}`,
        `Project: ${item.project}`,
        `Author: ${item.author ?? 'unknown'}`,
        ``,
        item.notes ? `Description:\n${item.notes}` : `(no description)`,
        ``,
        `Discuss it with the user. If they approve, PROMOTE the idea `
          + `(\`project_todo_promote\`, id ${item.id}): the task it creates keeps the link `
          + `to the idea. Do not recreate it with \`kanban_add\`: the link would be lost.`,
      ].join('\n');
      const { randomUUID } = await import('node:crypto');
      const row = scopedDb(viewerFromRequest(req)).enqueueMessage({
        id: randomUUID(),
        fromMission: systemMissionId(),
        fromAgent: 'cockpit',
        toAgent,
        kind: 'request',
        payload,
      });
      res.status(201).json({ to_agent: toAgent, message_id: row.id });
    } catch (err) { res.status(500).json(apiError('todo_request_failed', (err as Error).message, { detail: (err as Error).message })); }
  });

  app.delete('/api/project-todo/:id', (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) { res.status(400).json(apiError('invalid_id', 'invalid id')); return; }
      const item = scopedDb(viewerFromRequest(req)).getProjectTodo(id);
      if (!item) {
        res.status(404).json(apiError('todo_not_found', 'project-todo item not found')); return;
      }
      if (!withTodoOrigin(todoOriginFromRequest(req), () => dbApi.deleteProjectTodo(id))) { res.status(404).json(apiError('todo_not_found', 'project-todo item not found')); return; }
      publishTodoChanged(item);
      res.json({ ok: true });
    } catch (err) { res.status(500).json(apiError('todo_request_failed', (err as Error).message, { detail: (err as Error).message })); }
  });
}
