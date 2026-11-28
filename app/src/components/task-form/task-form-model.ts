/**
 * The task form's state and what it sends, apart from the DOM: the product's
 * form (`task-form.tsx`) and its tests share these rules, and a plugin that
 * replaces the form reads the same types from `@timon/ui` (`useTaskForm`).
 */

import type { TaskRunBy } from '@/lib/task-runner';
import type { PendingPermission } from '@/lib/kanban-card';

export type TaskType = 'code' | 'review' | 'merge' | 'research' | 'doc' | 'chore';

export type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED';

export type TaskPipeline = 'full' | 'code-self' | 'code-group';

/** The task a form edits, as the board and the agent pages hold it (the daemon's row). */
export type TaskFormSource = {
  id: string;
  title: string;
  description?: string | null;
  agent_name: string;
  status?: TaskStatus;
  priority: number;
  deps: string;
  scheduled_at?: number | null;
  type?: TaskType;
  backend_override?: string | null;
  model_override?: string | null;
  fallback_backend_override?: string | null;
  fallback_model_override?: string | null;
  permission_mode_override?: string | null;
  extra_skills?: string | null;
  extra_mcp_servers?: string | null;
  extra_allowed_tools?: string | null;
  worktree_path?: string | null;
  branch_name?: string | null;
  pipeline?: string | null;
  todo_id?: number | null;
  /** Resolved by the daemon: what the task runs on when it carries no override. */
  effective_backend?: string | null;
  effective_model?: string | null;
  /** The agent that runs the task, or will, when it is not `agent_name` (#1109). */
  run_by?: TaskRunBy | null;
  attachment_count?: number;
  /** The report the agent closed the task with. */
  done_comment?: string | null;
  mission_id?: string | null;
  /** The pull / merge request the task opened (all null when none). */
  mr_url?: string | null;
  mr_forge?: 'github' | 'gitlab' | null;
  mr_number?: number | null;
  mr_state?: 'open' | 'merged' | 'closed' | null;
  mr_pipeline?: string | null;
  /** The card a running task's mission waits on, as the task route reads it (TODO #1200). */
  pending_permission?: PendingPermission | null;
};

/** What `POST /api/tasks` (creation) or `PUT /api/tasks/:id` (edition) receives from the form. */
export type TaskFormBody = {
  title: string;
  description: string;
  agent_name: string;
  priority: number;
  type: TaskType;
  deps: string[];
  scheduled_at: number | null;
  backend_override: string | null;
  model_override: string | null;
  fallback_backend_override: string | null;
  fallback_model_override: string | null;
  permission_mode_override: string | null;
  /** Edition only: explicit reset; null alone keeps a stored override. */
  clear_fallback?: boolean;
  clear_permission_mode?: boolean;
  extra_skills: string[];
  extra_mcp_servers: string[];
  extra_allowed_tools: string[];
  /** Creation only: the daemon sets a task's pipeline once. */
  pipeline?: TaskPipeline | null;
  /** The TO DO idea this task carries out; `null` detaches it. */
  todo_id: number | null;
};

export const TASK_TYPES: readonly TaskType[] = ['code', 'review', 'merge', 'research', 'doc', 'chore'];

/** The API's scale, highest first: 5 urgent … 1 someday. */
export const PRIORITIES: readonly { value: number; key: string }[] = [
  { value: 5, key: 'urgent' },
  { value: 4, key: 'high' },
  { value: 3, key: 'normal' },
  { value: 2, key: 'low' },
  { value: 1, key: 'someday' },
];

/** `default` inherits the agent's mode; edition also sends the clear sentinel. */
export const PERMISSION_MODES: readonly string[] = ['default', 'acceptEdits', 'plan', 'bypassPermissions'];

export const PIPELINES: readonly TaskPipeline[] = ['full', 'code-self', 'code-group'];

/** The fallback sentinel: this task never moves to another backend on its own. */
export const NO_FALLBACK = 'none';

export type TaskFormTab = 'general' | 'dependencies' | 'capabilities';

export const TASK_FORM_TABS: readonly TaskFormTab[] = ['general', 'dependencies', 'capabilities'];

export type FormState = {
  title: string;
  description: string;
  agent_name: string;
  priority: number;
  type: TaskType;
  /** `datetime-local` value, `''` = as soon as the dependencies are done. */
  scheduled_at: string;
  deps: string[];
  // Raw stored halves: a task saved before the picker may hold only one, and
  // saving the form without touching the model must not complete it.
  backend_override: string;
  model_override: string;
  fallback_backend_override: string;
  fallback_model_override: string;
  permission_mode_override: string;
  extra_skills: string[];
  extra_mcp_servers: string[];
  extra_allowed_tools: string;
  pipeline: TaskPipeline;
  /** Digits as typed; `''` = no idea linked. */
  todo_id: string;
};

export function parseJsonList(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const j: unknown = JSON.parse(raw);
    return Array.isArray(j) ? j.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function toLocalInputValue(ms: number): string {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function asPipeline(raw: string | null | undefined): TaskPipeline {
  return (PIPELINES as readonly string[]).includes(raw ?? '') ? raw as TaskPipeline : 'full';
}

export function buildInitial(
  task: TaskFormSource | null | undefined,
  defaultAgent: string | null | undefined,
  agents: readonly { name: string }[],
): FormState {
  return {
    title: task?.title ?? '',
    description: task?.description ?? '',
    agent_name: task?.agent_name ?? defaultAgent ?? agents[0]?.name ?? '',
    priority: task?.priority ?? 3,
    type: task?.type ?? 'chore',
    scheduled_at: task?.scheduled_at ? toLocalInputValue(task.scheduled_at) : '',
    deps: parseJsonList(task?.deps),
    backend_override: task?.backend_override ?? '',
    model_override: task?.model_override ?? '',
    fallback_backend_override: task?.fallback_backend_override ?? '',
    fallback_model_override: task?.fallback_model_override ?? '',
    permission_mode_override: task?.permission_mode_override ?? 'default',
    extra_skills: parseJsonList(task?.extra_skills),
    extra_mcp_servers: parseJsonList(task?.extra_mcp_servers),
    extra_allowed_tools: parseJsonList(task?.extra_allowed_tools).join(', '),
    pipeline: asPipeline(task?.pipeline),
    todo_id: task?.todo_id ? String(task.todo_id) : '',
  };
}

export type FormProblem = 'title' | 'agent' | 'todo';

/** What keeps the form from being sent, in the order the tabs show the fields. */
export function formProblems(form: FormState): FormProblem[] {
  const problems: FormProblem[] = [];
  if (!form.title.trim()) problems.push('title');
  if (!form.agent_name) problems.push('agent');
  if (form.todo_id.trim() && !/^[1-9]\d*$/.test(form.todo_id.trim())) problems.push('todo');
  return problems;
}

/** The tab that holds a field in error, so the form can open it. */
export function tabOfProblem(problem: FormProblem): TaskFormTab | null {
  return null;
}

export function buildBody(form: FormState, mode: 'create' | 'edit'): TaskFormBody {
  const todo = form.todo_id.trim();
  return {
    title: form.title.trim(),
    agent_name: form.agent_name,
    priority: form.priority,
    description: form.description.trim(),
    type: form.type,
    deps: form.deps,
    scheduled_at: form.scheduled_at ? new Date(form.scheduled_at).getTime() : null,
    backend_override: form.backend_override.trim() || null,
    model_override: form.model_override.trim() || null,
    fallback_backend_override: form.fallback_backend_override.trim() || null,
    fallback_model_override: form.fallback_backend_override.trim() === NO_FALLBACK ? null : form.fallback_model_override.trim() || null,
    permission_mode_override: form.permission_mode_override === 'default' ? null : form.permission_mode_override,
    ...(mode === 'edit' && !form.fallback_backend_override.trim() && !form.fallback_model_override.trim() ? { clear_fallback: true } : {}),
    ...(mode === 'edit' && form.permission_mode_override === 'default' ? { clear_permission_mode: true } : {}),
    extra_skills: form.extra_skills,
    extra_mcp_servers: form.extra_mcp_servers,
    extra_allowed_tools: form.extra_allowed_tools.split(',').map((s) => s.trim()).filter(Boolean),
    ...(mode === 'create' && form.type === 'code' ? { pipeline: form.pipeline } : {}),
    todo_id: todo ? Number(todo) : null,
  };
}

/** The number a tab shows next to its name; `0` shows none. */
export function tabCounts(form: FormState, attachments: number): Record<TaskFormTab, number> {
  const tools = form.extra_allowed_tools.split(',').map((s) => s.trim()).filter(Boolean).length;
  return {
    general: attachments,
    dependencies: form.deps.length,
    capabilities: form.extra_skills.length + form.extra_mcp_servers.length + tools,
  };
}

/** Case- and accent-blind match of a filter against a few fields. */
export function matchesFilter(query: string, ...fields: (string | null | undefined)[]): boolean {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const q = fold(query.trim());
  if (!q) return true;
  return fields.some((field) => !!field && fold(field).includes(q));
}
