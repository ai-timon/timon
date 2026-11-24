/**
 * Promoting an idea of the TO DO notebook into a task — the idea's side of it.
 *
 * Shared by `POST /api/project-todo/:id/promote` and the plugin facade
 * (`ctx.kanban.todos.promote`): both judge the idea, build the brief and mark
 * the idea promoted the same way. What differs is how the task is created
 * (the route has a request to judge, a plugin has its context), so that step
 * is injected.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { PIPELINES, dbApi, isTaskType, type DbViewer, type ProjectTodoRow, type TaskType } from '../../db.js';
import { loadConfig } from '../../agent-config.js';
import { gitTaskRefusal, isPlausibleGitRef } from '../../task-git.js';
import { scopedDb } from '../../users/scoped-db.js';
import { withTodoOrigin } from '../../todo-origin.js';
import { copyTodoAttachmentsToTask } from '../../attachments.js';
import { apiError } from '../../api-error.js';
import {
  TodoLinkError, publishTodoChanged, withLinksOne, type TodoCallerScope, type TodoWithLinks,
} from './todo-api.js';

export type PromotionRefusal = { status: number; json: Record<string, unknown> };

export type PromotionTaskSpec = {
  title: string;
  description: string;
  /** Project the task is attached to; `null` when neither idea nor caller names one. */
  project: string | null;
  /** The idea the task carries: that is what closes it once the chain lands. */
  todoId: number;
};

export type PromotionOutcome =
  | { ok: true; task: { id: string }; item: ReturnType<typeof withLinksOne<ProjectTodoRow>> | undefined }
  | ({ ok: false } & PromotionRefusal);

/** The link is authoritative, not the status: an idea set back to `open` by a PATCH
 *  would stay promoted, and a second promotion would orphan the first task. */
export function alreadyPromoted(item: ProjectTodoRow): PromotionRefusal | null {
  if (!item.promoted_task_id) return null;
  return {
    status: 409,
    json: {
      ...apiError('todo_already_promoted', `idea #${item.id} already promoted — task ${item.promoted_task_id}`, { id: String(item.id) }),
      task_id: item.promoted_task_id,
    },
  };
}

/**
 * `createTask` returns the status and body of the creation (201 = made). The
 * idea is marked AFTER the task exists (it needs its id) and before the
 * answer: a caller who gets the task sees an idea already marked. The idea's
 * attached files are copied into the task in between.
 */
export function promoteTodoItem(
  item: ProjectTodoRow,
  /** Whose view the returned idea's landing is read through. */
  viewer: DbViewer | null | undefined,
  requestedProject: string | undefined,
  createTask: (spec: PromotionTaskSpec) => PromotionRefusal & { json: { task?: unknown } },
): PromotionOutcome {
  // An idea's project is free text, without a foreign key; a
  // task's project must exist. Without this guard, the promotion would return an "unknown
  // project" that talks about the task while the fault is in the idea.
  const project = requestedProject ?? item.project;
  if (project && !dbApi.getProjectRow(project)) {
    return {
      ok: false,
      status: 400,
      json: {
        ...apiError('todo_project_unknown', `idea #${item.id} belongs to project "${project}", which does not exist `
          + `— fix the idea's project, or pass a known \`project\` to the promotion`, { project }),
      },
    };
  }
  const created = createTask({
    title: item.text,
    // Provenance in the description too: the agent that receives this brief does not
    // read the database, and must be able to trace back to the idea.
    description: [item.notes ?? '', `\n(Promoted from idea #${item.id} of the project's TO DO notebook.)`]
      .join('').trim(),
    project: project || null,
    todoId: item.id,
  });
  if (created.status !== 201) return { ok: false, status: created.status, json: created.json };
  const task = created.json.task as { id: string };
  // The task gets its own copy of the idea's files, before the dispatcher's
  // next tick builds its brief: the idea may be deleted later, the task keeps
  // what it was given. Best effort, a failed copy never undoes the promotion.
  try { copyTodoAttachmentsToTask(item.id, task.id); } catch (err) {
    console.warn(`[attachments] idea #${item.id}: files not copied to task ${task.id}: ${(err as Error).message}`);
  }
  const promoted = dbApi.markProjectTodoPromoted(item.id, task.id);
  if (promoted) publishTodoChanged(promoted);
  return { ok: true, task, item: promoted ? withLinksOne(promoted, viewer) : undefined };
}

/**
 * What a plugin may ask of a promotion. Narrower than `POST /api/tasks`
 * on purpose: no LLM, no permission level, no series — and the project is the
 * idea's own.
 */
const pluginPromoteSchema = z.object({
  agent: z.string().trim().min(1),
  type: z.string().optional(),
  priority: z.number().finite().optional(),
  base: z.string().trim().nullish(),
  pipeline: z.enum(PIPELINES).nullish(),
}).strict();

export type PluginPromoteInput = z.input<typeof pluginPromoteSchema>;

/**
 * `ctx.kanban.todos.promote`, once the context has checked `todos:write` AND
 * `kanban:write` (a promotion spawns a task, hence an agent). Bounded by the
 * caller: an idea it cannot see — or does not own, like `PluginTaskInput.todoId`
 * — answers `not_found`, before anything about the input is judged.
 */
export function promoteTodoFor(
  scope: TodoCallerScope,
  id: number,
  input: PluginPromoteInput,
  /** Runs once every refusal of the input has passed, before the task is written; throws a `TodoLinkError` to refuse. */
  beforeCreate?: () => void,
): { task: unknown; item: TodoWithLinks } {
  const item = dbApi.getProjectTodo(id, scope.viewer);
  // Linking a task to an idea is what later closes it: one account only.
  if (!item || item.owner_user_id !== (scope.viewer?.id ?? null)) {
    throw new TodoLinkError(`idea #${id} not found`, 'not_found');
  }
  const conflict = alreadyPromoted(item);
  if (conflict) throw new TodoLinkError(String(conflict.json.error), 'conflict');
  const parsed = pluginPromoteSchema.safeParse(input);
  if (!parsed.success) {
    throw new TodoLinkError(`invalid promotion: ${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('; ')}`, 'invalid');
  }
  const { agent, priority, pipeline } = parsed.data;
  let type: TaskType | undefined;
  if (parsed.data.type !== undefined) {
    if (!isTaskType(parsed.data.type)) throw new TodoLinkError(`invalid promotion: unknown task type \`${parsed.data.type}\``, 'invalid');
    type = parsed.data.type;
  }
  const base = parsed.data.base || null;
  if (base && !isPlausibleGitRef(base)) throw new TodoLinkError(`invalid promotion: base "${base}" is not a plausible git ref`, 'invalid');
  const cwd = (() => { try { return loadConfig(agent).cwd ?? null; } catch { return null; } })();
  const gitRefusal = gitTaskRefusal(type, { cwd });
  if (gitRefusal) throw new TodoLinkError(`invalid promotion: ${gitRefusal}`, 'invalid');

  const db = scopedDb(scope.viewer);
  const outcome = withTodoOrigin({ kind: 'plugin', id: scope.pluginId }, () => promoteTodoItem(item, scope.viewer, undefined, (spec) => {
    beforeCreate?.();
    const taskId = randomUUID();
    db.createTask(taskId, spec.title, agent, {
      description: spec.description,
      priority,
      type,
      pipeline: pipeline ?? null,
      project: spec.project,
    });
    if (base) dbApi.setTaskBaseBranch(taskId, base);
    dbApi.setTaskTodoId(taskId, spec.todoId);
    return { status: 201, json: { task: db.getTask(taskId) } };
  }));
  if (!outcome.ok) throw new TodoLinkError(String(outcome.json.error), 'invalid');
  const fresh = dbApi.getProjectTodo(id, scope.viewer);
  return { task: outcome.task, item: outcome.item ?? withLinksOne(fresh ?? item, scope.viewer) };
}
