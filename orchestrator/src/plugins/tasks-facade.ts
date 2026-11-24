/**
 * `ctx.kanban`: the board's tasks as a plugin sees them — read, create, edit,
 * close, delete, and tie to a ticket that lives elsewhere (GitHub Projects,
 * Linear, Jira), so a plugin can keep the two in sync both ways.
 *
 * Who acts is decided by `context.ts` before this module is reached. The scope
 * it receives bounds everything:
 *
 *  - a REQUEST sees and writes what its user sees (`scopedDb`), like the
 *    routes; an anonymous request (no owner) may not write what only an owner
 *    can answer for — delete, close, link;
 *  - a JOB acts as `plugin:<id>`: it writes only the tasks it created. It may
 *    additionally READ the tasks of the projects the operator granted it
 *    (`pluginPolicy.kanban.projects`, `grantedKanbanProjects`) — read, never
 *    write: a task of a granted project that the plugin did not create answers
 *    `forbidden` on a write, and one outside every grant answers `not_found`.
 *
 * What a task IS, and what a plugin may do with it, comes from the routes
 * (`plugins-bundled/kanban/routes.ts`): the field refusals
 * (`task-field-guards.ts`), the closure (`closeTask`: code gate, transition),
 * the deletion (`dbApi.deleteTask`) are the routes' own functions.
 *
 * Two rules of its own:
 *
 *  - overrides (`model`, `backend`, `permissionMode`, `extraAllowedTools`,
 *    `extraMcp`) are judged like any task's, against the config of the agent
 *    the task is assigned to (`taskOverrideRefusal`): a plugin can narrow or
 *    repeat what the agent holds, never widen it. A superadmin's request lifts
 *    the rule, as for `ctx.agents`;
 *  - a MIRROR task is the inert image of a ticket (`task-mirror.ts`): it needs
 *    no agent, never runs one, and its closure starts nothing. The flag is set
 *    at creation and no write path changes it;
 *  - a task that RUNS, opened or re-queued with nobody in front (a job, a
 *    webhook delivery, an event handler), is a deferred spawn: it takes the approval and the
 *    quota of `ctx.missions.spawn` (`assertSpawnAllowed`, TODO #562). A request
 *    is not held to it — its user creates what the account may create.
 *
 * Every write runs under the origin `{ kind: 'plugin', id }` (`task-origin.ts`),
 * so the lifecycle events it causes can be recognised by the plugin as its own
 * echo, and dropped.
 */
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../agent-config.js';
import { listAgents } from '../agent.js';
import { agentRequeueDelayMs, agentRequeueRefusal, isCorrection } from '../crash-loop.js';
import {
  db, dbApi, isTaskType, normalizeTaskStatusInput, type DbViewer, type TaskExternalRefRow, type TaskRow,
  type TaskType,
} from '../db.js';
import { validateScheduledAt } from '../task-guards.js';
import { gitTaskRefusal } from '../task-git.js';
import { isMirrorTask } from '../task-mirror.js';
import { countTaskAttachments } from '../attachments.js';
import { assertSpawnAllowed, PluginPolicyError } from './policy.js';
import { withTaskOrigin } from '../task-origin.js';
import { taskProjectSlug } from '../task-project.js';
import {
  canonicalizePermissionMode, RESTRICTED, taskOverrideRefusal,
} from '../users/privileged-overrides.js';
import { scopedDb } from '../users/scoped-db.js';
import { closeTask, codeCloseRefusal, effectiveMergeSha, mergeCloseRefusal, mergedShaRefusal, pullRequestCloseRefusal } from '../plugins-bundled/kanban/routes.js';
import {
  backendRefusal, isPlausibleGitRef, pipelineRefusal, planGroupRefusal, projectRefusal,
} from '../plugins-bundled/kanban/task-field-guards.js';
import { linkSchema } from '../plugins-bundled/kanban/todo-api.js';

import type {
  PluginTask, PluginTaskLink, PluginTaskLinkInput, PluginTaskInput, PluginTaskPatch, PluginTaskFilter,
  PluginTaskDoneInput, PluginTaskErrorCode,
} from './contract/tasks.js';
export type {
  PluginTask, PluginTaskLink, PluginTaskLinkInput, PluginTaskInput, PluginTaskPatch, PluginTaskFilter,
  PluginTaskDoneInput, PluginTaskErrorCode,
} from './contract/tasks.js';

export class PluginTaskError extends Error {
  constructor(readonly code: PluginTaskErrorCode, message: string, readonly reason?: string) {
    super(message);
    this.name = 'PluginTaskError';
  }
}

export type TaskCallerScope = {
  pluginId: string;
  viewer: DbViewer | null;
  /** Owner stamped on writes; `null` = anonymous request. */
  ownerUserId: string | null;
  /** No request: the plugin acts as `plugin:<id>`. */
  job: boolean;
  /** Nobody answers for the call (a job, a webhook delivery, an event handler): a task that runs is a spawn. */
  unattended: boolean;
  /** The request's caller is a superadmin: the override rule is lifted. */
  superadmin: boolean;
  /** Projects a job may read beyond its own tasks (`grantedKanbanProjects`). */
  projects: readonly string[];
};

export type ScopedTasks = {
  get(id: string): PluginTask | undefined;
  list(filter?: PluginTaskFilter): PluginTask[];
  create(input: PluginTaskInput): PluginTask;
  /** Create, or return the task already tied to one of `links`. */
  ensure(input: PluginTaskInput, links: readonly PluginTaskLinkInput[]): { task: PluginTask; created: boolean };
  update(id: string, patch: PluginTaskPatch): PluginTask;
  done(id: string, input: PluginTaskDoneInput): PluginTask;
  block(id: string, reason: string): PluginTask;
  delete(id: string, opts?: { chain?: boolean }): { deleted: string[] };
  refs: {
    list(taskId: string): PluginTaskLink[];
    set(taskId: string, link: PluginTaskLinkInput): PluginTaskLink;
    remove(taskId: string, provider: string, ref: string): boolean;
    findByRef(provider: string, ref: string): PluginTask | undefined;
  };
};

const TASK_ID = /^[A-Za-z0-9_-]{1,255}$/;
const MERGED_SHA = /^[0-9a-f]{7,40}$/i;
const ALL_STATUSES = ['PENDING', 'IN_PROGRESS', 'DONE', 'BLOCKED'] as const;
const MAX_TEXT = 100_000;
const MAX_LIST = 1_000;

const text = (v: unknown): v is string => typeof v === 'string';
const nonBlank = (v: unknown): v is string => text(v) && v.trim().length > 0;

function toLink(row: TaskExternalRefRow): PluginTaskLink {
  return { provider: row.provider, ref: row.ref, url: row.url, label: row.label, plugin_id: row.plugin_id, created_at: row.created_at };
}

function stringList(name: string, v: unknown): string[] | undefined {
  if (v === undefined) return undefined;
  if (!Array.isArray(v) || v.length > 200 || v.some((x) => !nonBlank(x) || x.length > 256)) {
    throw new PluginTaskError('invalid', `\`${name}\` must be an array of at most 200 non-empty strings`);
  }
  return v as string[];
}

/** A row as a plugin reads it, with its links. Used by the facade and the events. */
export function toPluginTask(t: TaskRow): PluginTask {
  return {
    ...t, mirror: isMirrorTask(t), links: dbApi.listTaskExternalRefs([t.id]).map(toLink),
    attachment_count: countTaskAttachments([t]).get(t.id) ?? 0,
  } as PluginTask;
}

/** The project of a task: explicit, else the one of its agent (as the board derives it). */
export function projectOfTask(t: Pick<TaskRow, 'project' | 'agent_name'>): string | null {
  if (t.project) return t.project;
  return listAgents().find((a) => a.name === t.agent_name)?.project ?? null;
}

export function tasksFor(scope: TaskCallerScope): ScopedTasks {
  const origin = { kind: 'plugin', id: scope.pluginId } as const;
  const jobOwner = `plugin:${scope.pluginId}`;
  const scoped = scopedDb(scope.viewer);
  const granted = new Set(scope.job ? scope.projects : []);
  const asPlugin = <R>(fn: () => R): R => withTaskOrigin(origin, fn);

  /** Agent → project, as the board derives it. Built once per read that needs it. */
  let agentProjects: Map<string, string | null> | undefined;
  const projectOf = (t: TaskRow): string | null => {
    if (t.project) return t.project;
    agentProjects ??= new Map(listAgents().map((a) => [a.name, a.project ?? null]));
    return agentProjects.get(t.agent_name) ?? null;
  };

  const view = toPluginTask;

  /** A task the caller may READ: its own view, plus a job's granted projects. */
  const readable = (id: unknown): TaskRow | undefined => {
    if (!text(id) || !TASK_ID.test(id)) return undefined;
    const own = scoped.getTask(id);
    if (own) return own;
    if (granted.size === 0) return undefined;
    const row = dbApi.getTask(id);
    const project = row ? projectOf(row) : null;
    return row && project !== null && granted.has(project) ? row : undefined;
  };

  /** A task the caller may WRITE: the one it owns or, in a request, the one its user sees. */
  const writable = (id: unknown): TaskRow => {
    const row = readable(id);
    if (!row) throw new PluginTaskError('not_found', `task \`${String(id)}\` not found`);
    if (!scoped.getTask(row.id)) {
      throw new PluginTaskError('forbidden', `task \`${row.id}\` is readable by this plugin but was not created by it`);
    }
    return row;
  };

  /** Writes that only an account can answer for are refused to an anonymous request. */
  const requireOwner = (what: string): void => {
    if (scope.job || scope.ownerUserId) return;
    throw new PluginTaskError('forbidden', `${what} needs an authenticated account`);
  };

  const agentConfig = (name: string) => { try { return loadConfig(name); } catch { return null; } };

  /** A task that will run, with nobody in front: the spawn approval and quota, last before the write. */
  const spawnGate = (via: string): void => {
    if (!scope.unattended) return;
    try {
      assertSpawnAllowed(scope.pluginId, Date.now(), via);
    } catch (err) {
      if (err instanceof PluginPolicyError) throw new PluginTaskError('forbidden', err.message, 'spawn_policy');
      throw err;
    }
  };

  /** Every refusal of an input's fields, thrown before any write. */
  const checked = (input: PluginTaskInput): {
    title: string; agent: string; type: TaskType | undefined; scheduledAt: number | null; base: string | null;
    overrides: Record<string, string | null | undefined>;
  } => {
    if (typeof input !== 'object' || input === null) throw new PluginTaskError('invalid', '`title` and `agent` are required');
    const mirror = input.mirror === true;
    if (!nonBlank(input.title) || (!mirror && !nonBlank(input.agent))) {
      throw new PluginTaskError('invalid', '`title` and `agent` are required');
    }
    if (input.title.length > 500) throw new PluginTaskError('invalid', '`title` is limited to 500 characters');
    if (input.description != null && (!text(input.description) || input.description.length > MAX_TEXT)) {
      throw new PluginTaskError('invalid', `\`description\` must be a string of at most ${MAX_TEXT} characters`);
    }
    if (input.priority !== undefined && !Number.isFinite(input.priority)) {
      throw new PluginTaskError('invalid', '`priority` must be a number');
    }
    stringList('deps', input.deps);
    stringList('extraSkills', input.extraSkills);
    stringList('extraMcp', input.extraMcp);
    stringList('extraAllowedTools', input.extraAllowedTools);
    let type: TaskType | undefined;
    if (input.type !== undefined) {
      if (!isTaskType(input.type)) throw new PluginTaskError('invalid', `invalid task type: \`${String(input.type)}\``);
      type = input.type;
    }
    // The merge guard would turn the closure of a mirror `merge` into a block.
    if (mirror && type === 'merge') throw new PluginTaskError('invalid', 'a mirror task cannot be of type `merge`');
    const sched = validateScheduledAt(input.scheduledAt);
    if (!sched.ok) throw new PluginTaskError('invalid', sched.error);
    const agent = mirror ? (nonBlank(input.agent) ? input.agent : `plugin:${scope.pluginId}`) : input.agent!;
    if (agent.length > 100) throw new PluginTaskError('invalid', '`agent` is limited to 100 characters');

    const overrides = {
      permission_mode_override: input.permissionMode, backend_override: input.backend, model_override: input.model,
      fallback_backend_override: input.fallbackBackend, fallback_model_override: input.fallbackModel,
    };
    const powerful = input.permissionMode != null || input.backend != null || input.model != null
      || input.extraMcp?.length || input.extraAllowedTools?.length;
    // Not in `powerful`: a mirror refuses a fallback under its own name above.
    const fallback = input.fallbackBackend != null || input.fallbackModel != null;
    if (mirror) {
      const refused = [
        ['groupId', input.groupId], ['planGroup', input.planGroup], ['todoId', input.todoId], ['pipeline', input.pipeline], ['base', input.base],
        ['silentReturn', input.silentReturn], ['fallbackBackend', input.fallbackBackend],
        ['fallbackModel', input.fallbackModel], ['extraSkills', input.extraSkills?.length],
      ].find(([, v]) => v != null && v !== false && v !== 0)
        ?? (powerful ? ['model, backend, permissionMode, extraMcp or extraAllowedTools', true] : undefined);
      if (refused) {
        throw new PluginTaskError('invalid', `a mirror task is never run: \`${String(refused[0])}\` has no meaning on it`);
      }
    } else {
      const refusal = pipelineRefusal(input.pipeline) ?? backendRefusal(overrides) ?? projectRefusal(input.project)
        ?? planGroupRefusal(input.planGroup);
      if (refusal) throw new PluginTaskError('invalid', refusal);
      if (input.model != null && !text(input.model)) throw new PluginTaskError('invalid', '`model` must be a string');
      if ((powerful || fallback) && !scope.superadmin) {
        const refusalOfOverrides = taskOverrideRefusal({
          permission_mode_override: input.permissionMode ?? undefined,
          backend_override: input.backend ?? undefined,
          model_override: input.model ?? undefined,
          extra_allowed_tools: input.extraAllowedTools,
          extra_mcp_servers: input.extraMcp,
          fallback_backend_override: input.fallbackBackend ?? undefined,
          fallback_model_override: input.fallbackModel ?? undefined,
        }, agentConfig(agent), RESTRICTED);
        if (refusalOfOverrides) throw new PluginTaskError('forbidden', refusalOfOverrides);
      }
      const git = gitTaskRefusal(type, { cwd: agentConfig(agent)?.cwd ?? null });
      if (git) throw new PluginTaskError('invalid', git);
    }
    if (mirror) {
      const refusal = projectRefusal(input.project);
      if (refusal) throw new PluginTaskError('invalid', refusal);
    }
    let base: string | null = null;
    if (input.base != null && input.base !== '') {
      base = String(input.base).trim();
      if (!isPlausibleGitRef(base)) throw new PluginTaskError('invalid', `base "${input.base}" is not a plausible git ref`);
    }
    // The dispatcher hands this value to whichever dialect runs the task: store
    // the name they all understand.
    canonicalizePermissionMode(overrides as Record<string, unknown>, 'permission_mode_override');
    return { title: input.title.trim(), agent, type, scheduledAt: sched.value ?? null, base, overrides };
  };

  const insert = (input: PluginTaskInput, via: string): string => {
    const f = checked(input);
    if (input.todoId !== undefined) {
      // Same rule as a trigger's task after its idea: one account only, so a
      // task cannot close someone else's notebook entry.
      const idea = Number.isSafeInteger(input.todoId) && input.todoId > 0 ? dbApi.getProjectTodo(input.todoId, scope.viewer) : undefined;
      if (!idea || idea.owner_user_id !== (scope.viewer?.id ?? null)) throw new PluginTaskError('not_found', 'idea not found');
    }
    if (input.mirror !== true) spawnGate(via);
    const id = randomUUID();
    scoped.createTask(id, f.title, f.agent, {
      description: input.description ?? undefined,
      priority: input.priority,
      deps: input.deps,
      scheduledAt: f.scheduledAt ?? undefined,
      type: f.type,
      groupId: input.groupId ?? null,
      planGroup: typeof input.planGroup === 'string' && input.planGroup.trim() ? input.planGroup.trim() : null,
      project: input.project || null,
      silentReturn: input.silentReturn === true,
      extraSkills: input.extraSkills,
      extraMcpServers: input.extraMcp,
      extraAllowedTools: input.extraAllowedTools,
      backendOverride: input.backend || null,
      modelOverride: input.model || null,
      fallbackBackendOverride: input.fallbackBackend ?? null,
      fallbackModelOverride: input.fallbackModel ?? null,
      permissionModeOverride: (f.overrides.permission_mode_override as string | null | undefined) || null,
      pipeline: input.pipeline ?? null,
      mirror: input.mirror === true,
    });
    if (f.base) dbApi.setTaskBaseBranch(id, f.base);
    if (input.todoId !== undefined) dbApi.setTaskTodoId(id, input.todoId);
    return id;
  };

  const parseLink = (link: PluginTaskLinkInput): { provider: string; ref: string; url: string | null; label: string | null } => {
    // Only the four fields a caller may name: the plugin id is the context's,
    // so a forged one is dropped here, not obeyed (nor an error, as for the TO DO links).
    const parsed = linkSchema.omit({ pluginId: true }).safeParse(
      typeof link === 'object' && link !== null ? { provider: link.provider, ref: link.ref, url: link.url, label: link.label } : link,
    );
    if (!parsed.success) {
      throw new PluginTaskError('invalid', `invalid link: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`);
    }
    return { provider: parsed.data.provider, ref: parsed.data.ref, url: parsed.data.url || null, label: parsed.data.label || null };
  };

  /** Ties `ref` to `taskId`; a ref already bound elsewhere is a conflict that names nobody. */
  const putRef = (taskId: string, link: PluginTaskLinkInput): TaskExternalRefRow => {
    const l = parseLink(link);
    const bound = dbApi.getTaskExternalRef(l.provider, l.ref);
    if (bound && bound.task_id !== taskId) {
      throw new PluginTaskError('conflict', `\`${l.provider}\` ref \`${l.ref}\` is already tied to another task`);
    }
    return dbApi.putTaskExternalRef({ taskId, ...l, pluginId: scope.pluginId });
  };

  return {
    get: (id) => {
      const row = readable(id);
      return row ? view(row) : undefined;
    },

    list(filter = {}) {
      // One status or several: a task matching any of them comes back once. An
      // empty list is refused rather than read as "no filter", which would
      // answer the whole board.
      const wanted = filter.status === undefined ? [undefined] : (Array.isArray(filter.status) ? filter.status : [filter.status]);
      if (wanted.length === 0) throw new PluginTaskError('invalid', 'status needs at least one value');
      const statuses = wanted.map((raw) => {
        if (raw === undefined) return undefined;
        const status = normalizeTaskStatusInput(raw);
        if (!(ALL_STATUSES as readonly string[]).includes(status)) throw new PluginTaskError('invalid', `invalid status \`${String(raw)}\``);
        return status as TaskRow['status'];
      });
      const seen = new Map<string, TaskRow>();
      for (const status of statuses) {
        for (const t of scoped.listTasks(status)) seen.set(t.id, t);
        if (granted.size > 0) {
          for (const t of dbApi.listTasks(status)) {
            const project = projectOf(t);
            if (project !== null && granted.has(project)) seen.set(t.id, t);
          }
        }
      }
      let rows = [...seen.values()];
      if (filter.project !== undefined) rows = rows.filter((t) => projectOf(t) === filter.project);
      if (filter.mirror !== undefined) rows = rows.filter((t) => isMirrorTask(t) === filter.mirror);
      rows.sort((a, b) => b.priority - a.priority || a.created_at - b.created_at);
      const limit = filter.limit === undefined ? MAX_LIST : Math.min(Math.max(Math.trunc(filter.limit) || 0, 0), MAX_LIST);
      const page = rows.slice(0, limit);
      const links = new Map<string, PluginTaskLink[]>();
      for (const l of dbApi.listTaskExternalRefs(page.map((t) => t.id))) {
        const list = links.get(l.task_id);
        if (list) list.push(toLink(l)); else links.set(l.task_id, [toLink(l)]);
      }
      const attachments = countTaskAttachments(page);
      return page.map((t) => ({
        ...t, mirror: isMirrorTask(t), links: links.get(t.id) ?? [], attachment_count: attachments.get(t.id) ?? 0,
      }) as PluginTask);
    },

    create: (input) => asPlugin(() => view(scoped.getTask(insert(input, 'ctx.kanban.add'))!)),

    ensure(input, links) {
      requireOwner('ensure');
      if (!Array.isArray(links) || links.length === 0 || links.length > 20) {
        throw new PluginTaskError('invalid', '`links` must hold between 1 and 20 links');
      }
      const parsed = links.map(parseLink);
      // Found first, so a redelivered ticket lands on its task instead of a twin.
      for (const l of parsed) {
        const hit = dbApi.getTaskExternalRef(l.provider, l.ref);
        if (!hit) continue;
        const row = readable(hit.task_id);
        if (!row) throw new PluginTaskError('conflict', `\`${l.provider}\` ref \`${l.ref}\` is already tied to another task`);
        return { task: view(row), created: false };
      }
      return asPlugin(() => db.transaction(() => {
        // Validated before the first write: a refused input leaves nothing behind.
        const id = insert(input, 'ctx.kanban.ensure');
        for (const l of parsed) putRef(id, l);
        return { task: view(scoped.getTask(id)!), created: true };
      }).immediate());
    },

    update(id, patch) {
      const task = writable(id);
      if (typeof patch !== 'object' || patch === null) throw new PluginTaskError('invalid', 'a patch object is expected');
      const mirror = isMirrorTask(task);
      if (patch.title !== undefined && (!nonBlank(patch.title) || patch.title.length > 500)) {
        throw new PluginTaskError('invalid', '`title` must be a non-empty string of at most 500 characters');
      }
      if (patch.description != null && (!text(patch.description) || patch.description.length > MAX_TEXT)) {
        throw new PluginTaskError('invalid', `\`description\` must be a string of at most ${MAX_TEXT} characters`);
      }
      if (patch.priority !== undefined && !Number.isFinite(patch.priority)) {
        throw new PluginTaskError('invalid', '`priority` must be a number');
      }
      stringList('deps', patch.deps);
      const sched = validateScheduledAt(patch.scheduledAt);
      if (!sched.ok) throw new PluginTaskError('invalid', sched.error);
      let type: TaskType | undefined;
      if (patch.type !== undefined) {
        if (!isTaskType(patch.type)) throw new PluginTaskError('invalid', `invalid task type: \`${String(patch.type)}\``);
        type = patch.type;
      }
      if (mirror && type === 'merge') throw new PluginTaskError('invalid', 'a mirror task cannot be of type `merge`');
      let agent: string | undefined;
      if (patch.agent !== undefined) {
        if (!nonBlank(patch.agent) || patch.agent.length > 100) throw new PluginTaskError('invalid', '`agent` must be a non-empty string of at most 100 characters');
        agent = patch.agent;
      }
      let status: TaskRow['status'] | undefined;
      if (patch.status !== undefined) {
        const wanted = normalizeTaskStatusInput(patch.status);
        if (!(ALL_STATUSES as readonly string[]).includes(wanted)) throw new PluginTaskError('invalid', `invalid status \`${String(patch.status)}\``);
        if (!mirror && wanted !== 'PENDING') {
          throw new PluginTaskError('invalid', `a task that runs is closed with \`done\` / \`block\`, and only re-queued here: status \`${wanted}\` is refused`);
        }
        status = wanted as TaskRow['status'];
      }
      // Putting a RUNNING task back in the queue would dispatch it a second time
      // on the same worktree while its mission is still alive.
      if (!mirror && status === 'PENDING' && task.status === 'IN_PROGRESS') {
        throw new PluginTaskError('conflict', `task \`${task.id}\` is running and cannot be re-queued now`, 'task_state');
      }
      // The overrides the task already carries were judged against ITS agent: a new
      // agent must be able to hold them, or the reassignment would hand them rights
      // that agent does not have.
      if (!mirror && agent !== undefined && agent !== task.agent_name && !scope.superadmin) {
        const list = (raw: string | null): string[] | undefined => {
          try { const v = raw ? JSON.parse(raw) as unknown : undefined; return Array.isArray(v) ? v.map(String) : undefined; } catch { return undefined; }
        };
        const refusal = taskOverrideRefusal({
          permission_mode_override: task.permission_mode_override ?? undefined,
          backend_override: task.backend_override ?? undefined,
          model_override: task.model_override ?? undefined,
          extra_allowed_tools: list(task.extra_allowed_tools),
          extra_mcp_servers: list(task.extra_mcp_servers),
        }, agentConfig(agent), RESTRICTED);
        if (refusal) throw new PluginTaskError('forbidden', refusal);
      }
      const requeue = status === 'PENDING' && task.status !== 'PENDING' && task.status !== 'IN_PROGRESS' && !mirror;
      if (requeue) {
        // A plugin is no human: the rule that stops an agent from replaying a
        // task that keeps dying binds it too.
        const refusal = agentRequeueRefusal(task, isCorrection(task, { agent_name: agent }));
        if (refusal) throw new PluginTaskError('conflict', refusal, 'crash_loop');
        // Re-queuing runs the task again: without the gate, one approved task
        // blocked and re-queued in a loop would spawn past the quota.
        spawnGate('ctx.kanban.update');
      }
      return asPlugin(() => {
        if (status && status !== task.status) {
          if (status === 'DONE' || status === 'BLOCKED') {
            closeTask(scoped.getTask, task.id, task, status, status === 'DONE'
              ? { doneComment: task.done_comment ?? 'closed from an external system' }
              : { blockedReason: task.blocked_reason ?? 'blocked from an external system' });
          } else {
            dbApi.updateTaskStatus(task.id, status, {});
          }
        }
        dbApi.updateTask(task.id, {
          title: patch.title?.trim(),
          description: patch.description,
          agentName: agent,
          priority: patch.priority,
          deps: patch.deps,
          scheduledAt: sched.value ?? null,
          clearScheduledAt: patch.clearScheduledAt === true,
          type,
        });
        if (requeue) {
          const delay = agentRequeueDelayMs(task);
          if (delay > 0) dbApi.deferTask(task.id, Date.now() + delay);
        }
        return view(scoped.getTask(task.id)!);
      });
    },

    done(id, input) {
      requireOwner('done');
      const task = writable(id);
      if (typeof input !== 'object' || input === null || !nonBlank(input.comment)) {
        throw new PluginTaskError('invalid', 'a comment is required to mark a task as done');
      }
      if (input.summary !== undefined && !text(input.summary)) throw new PluginTaskError('invalid', '`summary` must be a string');
      if (input.mergedSha !== undefined && (!text(input.mergedSha) || !MERGED_SHA.test(input.mergedSha))) {
        throw new PluginTaskError('invalid', 'mergedSha must be 7-40 hex chars');
      }
      const shaRefusal = input.mergedSha ? mergedShaRefusal(task, input.mergedSha) : null;
      if (shaRefusal) throw new PluginTaskError('invalid', shaRefusal);
      const prRefusal = pullRequestCloseRefusal(task);
      if (prRefusal) throw new PluginTaskError('conflict', prRefusal, 'pr_not_opened');
      const mergeRefusal = mergeCloseRefusal(task, effectiveMergeSha(task, input.mergedSha, input.comment));
      if (mergeRefusal) throw new PluginTaskError('conflict', mergeRefusal, 'merge_not_proven');
      const codeRefusal = codeCloseRefusal(task);
      if (codeRefusal) throw new PluginTaskError('conflict', codeRefusal, 'branch_unreviewable');
      return asPlugin(() => {
        // Before the status, like the routes: the merge guard refuses DONE without it.
        if (input.mergedSha) {
          dbApi.setTaskMergedSha(task.id, input.mergedSha);
          task.merged_commit_sha = input.mergedSha;
        }
        closeTask(scoped.getTask, task.id, task, 'DONE', { doneComment: input.comment.trim(), summary: input.summary?.trim() || undefined });
        return view(scoped.getTask(task.id)!);
      });
    },

    block(id, reason) {
      requireOwner('block');
      const task = writable(id);
      if (!nonBlank(reason)) throw new PluginTaskError('invalid', 'a reason is required to mark a task as blocked');
      return asPlugin(() => {
        closeTask(scoped.getTask, task.id, task, 'BLOCKED', { blockedReason: reason.trim() });
        return view(scoped.getTask(task.id)!);
      });
    },

    delete(id, opts = {}) {
      requireOwner('delete');
      writable(id);
      const outcome = asPlugin(() => dbApi.deleteTask(String(id), {
        chain: opts.chain === true,
        canDelete: (t) => scoped.getTask(t.id) !== undefined,
      }));
      if (outcome.result === 'deleted') return { deleted: outcome.chain };
      if (outcome.result === 'not_found') throw new PluginTaskError('not_found', `task \`${String(id)}\` not found`);
      if (outcome.result === 'forbidden') throw new PluginTaskError('forbidden', `task \`${outcome.taskId}\` is not this plugin's to delete`);
      throw new PluginTaskError('conflict', `task \`${outcome.taskId}\` cannot be deleted now (${outcome.result})`, `task_${outcome.result}`);
    },

    refs: {
      list(taskId) {
        const row = readable(taskId);
        if (!row) throw new PluginTaskError('not_found', `task \`${String(taskId)}\` not found`);
        return dbApi.listTaskExternalRefs([row.id]).map(toLink);
      },
      set(taskId, link) {
        requireOwner('refs.set');
        const row = writable(taskId);
        return asPlugin(() => toLink(putRef(row.id, link)));
      },
      remove(taskId, provider, ref) {
        requireOwner('refs.remove');
        const row = writable(taskId);
        const l = parseLink({ provider, ref });
        return asPlugin(() => dbApi.deleteTaskExternalRef(row.id, l.provider, l.ref));
      },
      findByRef(provider, ref) {
        const l = parseLink({ provider, ref });
        const hit = dbApi.getTaskExternalRef(l.provider, l.ref);
        const row = hit ? readable(hit.task_id) : undefined;
        return row ? view(row) : undefined;
      },
    },
  };
}
