import type { PendingPermission } from '@/lib/kanban-card';
import type { TaskRunBy } from '@/lib/task-runner';

export type TaskStatus = 'PENDING' | 'IN_PROGRESS' | 'DONE' | 'BLOCKED';
export type TaskType = 'code' | 'review' | 'merge' | 'research' | 'doc' | 'chore';

// Visual identity of task types: icon + color via the single source of
// truth `@/lib/roles` (the <RoleBadge> component), shared with missions,
// canvas and the edit dropdown. No dispatcher behavior depends on it.

export type Task = {
  id: string;
  title: string;
  description?: string | null;
  agent_name: string;
  status: TaskStatus;
  priority: number;
  deps: string;
  mission_id?: string | null;
  created_at: number;
  updated_at: number;
  /** First time the dispatcher started the task; the card's running time. */
  started_at?: number | null;
  scheduled_at?: number | null;
  blocked_reason?: string | null;
  /** JSON code of a reason the daemon wrote, translated on display (`daemonMessageText`). */
  blocked_reason_code?: string | null;
  /** The BLOCKED task waits for a person (a merge to do, a go-ahead), not for a repair. */
  awaiting_user?: number | boolean | null;
  done_comment?: string | null;
  /** SYSTEM death cause of the mission (rate_limit | killed | timeout |
   *  crash), set by the orchestrator. Null = the task was not interrupted:
   *  a BLOCKED with no such value is a genuine business block decided by the agent. */
  interrupted_reason?: string | null;
  type?: TaskType;
  /** STABLE identity of the series this task belongs to; null for an isolated
   *  task. Already returned by the API (`listTasks` does a `SELECT *`) — it
   *  was only missing from this type. */
  series_id?: string | null;
  /** code<->review iteration number of the verification loop. */
  iteration?: number | null;
  backend_override?: string | null;
  model_override?: string | null;
  permission_mode_override?: string | null;
  /** Backend + model ACTUALLY assigned (resolved on the orchestrator side:
   *  override → project role → agent config → default). `effective_model`
   *  may be null when the backend uses its own CLI default (unknown to the server). */
  effective_backend?: string | null;
  effective_model?: string | null;
  /** JSON-encoded as a string by the orchestrator (TEXT in DB). Parsed only
   *  at display time, not in React state — this avoids handling different
   *  null/undefined/format cases in the update flow. */
  extra_skills?: string | null;
  extra_mcp_servers?: string | null;
  extra_allowed_tools?: string | null;
  /** Tasks that depend on this one, computed by the orchestrator: explicit
   *  `deps`, and the verification chain it heads, which `deps` never shows.
   *  Both block its deletion. */
  dependents?: { id: string; kind: 'dep' | 'chain' }[];
  /** Project set explicitly at creation; null → the agent's project. */
  project?: string | null;
  /** Set by the daemon only when the task's mission ran under another agent
   *  than `agent_name` (TIM-0109). */
  run_by?: TaskRunBy | null;
  /** Running task whose mission waits on a card in the chat (TODO #1094). */
  pending_permission?: PendingPermission | null;
  /** DONE code task whose chain never landed: its dependents wait (TIM-0109). */
  awaiting_merge?: boolean;
  /** TO DO idea the task carries out; its tags show on the card. */
  todo_id?: number | null;
  /** Files attached to the task; the list itself is read by the dialog. */
  attachment_count?: number;
};

/** What the board knows of an agent: `/api/ui/agents`, the agent's own sheet. */
export type Agent = {
  name: string;
  project?: string | null;
  role?: string | null;
  emoji?: string | null;
  color?: string | null;
  icon_url?: string | null;
};
