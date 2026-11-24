/** Public plugin types, extracted from the host implementations (TODO #512). */
import type { WriteOrigin as TaskOrigin } from './origin.js';

// Spelled out from the constant of `db.ts`, which proves at compilation that both agree (TODO #512, volet 3).
export type TaskType = 'code' | 'review' | 'merge' | 'research' | 'doc' | 'chore';

/** A task as a plugin reads it: the board's row, plus its links to other systems. */
export type PluginTask = {
  id: string;
  title: string;
  description: string | null;
  agent_name: string;
  status: 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED';
  priority: number;
  /** JSON array of task ids, as the board stores it. */
  deps: string;
  type: string;
  /** Explicit project slug; `null` = derived from the agent. */
  project: string | null;
  scheduled_at: number | null;
  blocked_reason: string | null;
  done_comment: string | null;
  done_summary: string | null;
  group_id: string | null;
  /** Group of volets of the series plan; `null` = none. */
  plan_group: string | null;
  pipeline: string | null;
  base_branch: string | null;
  merged_commit_sha: string | null;
  todo_id: number | null;
  created_at: number;
  updated_at: number;
  /** Account the task belongs to; `plugin:<id>` when a plugin job created it. */
  owner_user_id: string | null;
  /** Inert image of an external ticket: never dispatched. */
  mirror: boolean;
  links: PluginTaskLink[];
  /** Files attached to the task, its verification root's included (an
   *  iteration works with them). The files themselves stay behind the HTTP
   *  routes `/api/tasks/:id/attachments`. */
  attachment_count: number;
};

/** Where a task lives outside Timon (a GitHub card, a Linear issue…). */
export type PluginTaskLink = {
  provider: string;
  ref: string;
  url: string | null;
  label: string | null;
  /** Plugin that wrote the link — set by the daemon, never by the caller. */
  plugin_id: string | null;
  created_at: number;
};

/** `provider` is a lowercase slug, `ref` the ticket's id in that system
 *  (≤ 256), `url` http(s) only, `label` ≤ 200. */
export type PluginTaskLinkInput = {
  provider: string;
  ref: string;
  url?: string | null;
  label?: string | null;
};

/**
 * A new task, aligned on `kanban_add`. `agent` is required unless `mirror`.
 * `scheduledAt` is a Unix timestamp in MILLISECONDS.
 */
export type PluginTaskInput = {
  title: string;
  /** Agent that will run it. Optional for a mirror task (a label is stored). */
  agent?: string;
  description?: string | null;
  priority?: number;
  deps?: string[];
  scheduledAt?: number | null;
  type?: string;
  project?: string | null;
  groupId?: string | null;
  /** Group of volets of the series plan (≤ 60 chars): the task and the chain
   *  after it resolve their LLM and fallback on the group's rules first. */
  planGroup?: string | null;
  /** TO DO idea this task works on; only an idea the caller owns. */
  todoId?: number;
  /** The work return never goes up to the orchestrator. */
  silentReturn?: boolean;
  /** LLM for this task; the backend must be registered, the model fit it. */
  model?: string | null;
  backend?: string | null;
  /** Judged against the assigned agent's own mode: never above it. */
  permissionMode?: string | null;
  /** Explicit fallback for THIS task; `none` refuses any automatic fallback. */
  fallbackBackend?: string | null;
  fallbackModel?: string | null;
  /** Git branch a `code` task's worktree starts from. */
  base?: string | null;
  /** `full` (default), `code-self` or `code-group`. */
  pipeline?: string | null;
  extraSkills?: string[];
  /** MCP servers the agent already declares; none the agent lacks. */
  extraMcp?: string[];
  /** Tools the agent already holds; none it lacks. */
  extraAllowedTools?: string[];
  /**
   * Make the task the inert image of an external ticket: never dispatched, its
   * closure chains no review, doc or wake-up. Set at creation, never changed.
   * Not combinable with `groupId`, `todoId`, `pipeline`, `base` or overrides.
   */
  mirror?: boolean;
};

export type PluginTaskPatch = {
  title?: string;
  description?: string | null;
  priority?: number;
  deps?: string[];
  scheduledAt?: number | null;
  clearScheduledAt?: boolean;
  /**
   * `PENDING`, `IN_PROGRESS`, `DONE` or `BLOCKED` on a mirror task. On a task
   * that runs: `PENDING` only (re-queue) — closing goes through `done` /
   * `block`, which ask for the comment or the reason. A re-queue obeys the same
   * crash-loop rule as an agent's.
   */
  status?: string;
  /** Assign the task to another agent (a delegation, like the field at creation). */
  agent?: string;
  type?: string;
};

/** Filter of `list`: all optional, all combined. */
export type PluginTaskFilter = {
  /** One status, or a list: a task matching any of them is returned once. An empty list is `invalid`. */
  status?: string | string[];
  /** Project slug, explicit or derived from the task's agent. */
  project?: string;
  mirror?: boolean;
  limit?: number;
};

/** Closing a task as done. `comment` is required: the pilot and the board read it. */
export type PluginTaskDoneInput = {
  comment: string;
  /** Human-facing one-liner shown on the board. */
  summary?: string;
  /** 7–40 hex chars; a `merge` task cannot be closed without it. */
  mergedSha?: string;
};

/**
 * `code` of `PluginTaskError`:
 *  - `invalid`: the input;
 *  - `not_found`: no such task (or none the caller may see);
 *  - `conflict`: the ticket is already tied to another task, or the task cannot
 *    be deleted now (`reason` names why: `task_state`, `task_dependents`…);
 *  - `forbidden`: the task is visible but not writable by this caller, an
 *    override was refused, or the account is anonymous. `reason:
 *    'spawn_policy'`: a task that runs, opened or re-queued by a job, a
 *    webhook delivery or an event handler, takes the approval and the quota
 *    of `missions.spawn` (`pluginPolicy.spawn`) — the operator is asked on an
 *    action card.
 */
export type PluginTaskErrorCode = 'invalid' | 'not_found' | 'conflict' | 'forbidden';

export type PluginTaskEventKind =
  | 'task_created'
  | 'task_updated'
  | 'task_assigned'
  | 'task_deleted'
  | 'task_unblocked';

/** Who wrote: `kind: 'plugin', id: ctx.id` is this plugin's own write. */
export type PluginTaskOrigin = TaskOrigin;

export type PluginTaskCreatedEvent = Readonly<{
  kind: 'task_created'; taskId: string; task: Readonly<PluginTask>; origin: PluginTaskOrigin;
}>;

/** `changed` names the watched columns that moved (`status`, `title`, `agent_name`…),
 *  `previous` holds what they were. A write that changed none emits nothing. */
export type PluginTaskUpdatedEvent = Readonly<{
  kind: 'task_updated'; taskId: string; task: Readonly<PluginTask>;
  changed: readonly string[]; previous: Readonly<Record<string, unknown>>; origin: PluginTaskOrigin;
}>;

/** The task's `agent_name` changed (alongside its `task_updated`). */
export type PluginTaskAssignedEvent = Readonly<{
  kind: 'task_assigned'; taskId: string; task: Readonly<PluginTask>; previousAgent: string; origin: PluginTaskOrigin;
}>;

/** A BLOCKED task that is active again. */
export type PluginTaskUnblockedEvent = Readonly<{
  kind: 'task_unblocked'; taskId: string; task: Readonly<PluginTask>; origin: PluginTaskOrigin;
}>;

/** Taken before the delete: the task and its links no longer exist. */
export type PluginTaskDeletedEvent = Readonly<{
  kind: 'task_deleted'; taskId: string;
  task: Readonly<{
    id: string; title: string; agent_name: string; status: string; type: string; project: string | null;
    owner_user_id: string | null; mirror: boolean; links: readonly PluginTaskLink[];
  }>;
  origin: PluginTaskOrigin;
}>;

export type PluginTaskEvent =
  | PluginTaskCreatedEvent | PluginTaskUpdatedEvent | PluginTaskAssignedEvent
  | PluginTaskUnblockedEvent | PluginTaskDeletedEvent;

export type PluginTaskEventMap = {
  task_created: PluginTaskCreatedEvent;
  task_updated: PluginTaskUpdatedEvent;
  task_assigned: PluginTaskAssignedEvent;
  task_unblocked: PluginTaskUnblockedEvent;
  task_deleted: PluginTaskDeletedEvent;
};

export type PluginTaskEventHandler = (ev: PluginTaskEvent) => void | Promise<void>;
