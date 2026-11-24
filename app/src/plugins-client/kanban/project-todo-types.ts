import type { TodoProgress, TodoUrgency } from '@/lib/project-todo-tags';
import type { UrgencyFilterKey } from '@/lib/project-todo-filter';

/** Where the idea lives outside Timon, written by a plugin (`todo_external_ref`). */
export type ProjectTodoLink = {
  provider: string;
  ref: string;
  /** http(s), checked by the daemon — and again before it becomes an `href`. */
  url: string | null;
  label: string | null;
  plugin_id: string | null;
  created_at: number;
};

/** State of one job's branch, mirror of the daemon's `todo-landing.ts`:
 *  `branch` (embargo, no pull request expected), `pending` (not created),
 *  `open`, `merged`, `closed` (without a merge). */
export type TodoLandingState = 'branch' | 'pending' | 'open' | 'merged' | 'closed';

/** One job (integration branch) of an idea. */
export type TodoLandingJob = {
  /** The job's id in `/api/kanban/landings/:id`; absent from an older daemon. */
  jobId?: string;
  state: TodoLandingState;
  branch: string;
  prNumber: number | null;
  prUrl: string | null;
};

/** Where the branch of an idea's jobs stands: the job furthest from landing
 *  on top, every job in `jobs`, oldest first. Derived by the daemon, read-only. */
export type TodoLanding = TodoLandingJob & { jobs: TodoLandingJob[] };

/** Mirror of `/api/project-todo` (ProjectTodoRow on the orchestrator side). Shared by
 *  the tile and the detail modal so a field added to the schema does not drift
 *  between the two. */
export type ProjectTodo = {
  id: number;
  text: string;
  project: string | null;
  /** Agent name, or `user` from the cockpit. null = an idea older than the field. */
  author: string | null;
  /** `promoted` = the idea became a task; it is never set by hand. */
  status: 'open' | 'done' | 'promoted';
  /** Long description, in markdown. */
  notes: string | null;
  created_at: number;
  updated_at: number;
  done_at: number | null;
  /** Task born from the idea, null if never promoted. Answers "where does this task come from?". */
  promoted_task_id: string | null;
  /** Urgency / nature tag, null = unclassified. */
  urgency: TodoUrgency | null;
  /** Progress tag, null = older than the tags (counts as `todo`). */
  progress: TodoProgress | null;
  /** Absent from an older daemon. */
  links?: ProjectTodoLink[];
  /** Files attached to the idea; absent from a daemon older than the attachments. */
  attachment_count?: number;
  /** `null` when no job of the idea has an integration branch; absent from an older daemon. */
  landing?: TodoLanding | null;
};

type TodoStatus = ProjectTodo['status'];

/** Counted by the daemon with the list's own filters, past its row limit. */
export type ProjectTodoCounts = {
  /** Every filter but the status: what each Open / Done segment would show. */
  byStatus: Record<TodoStatus, number>;
  /** Every filter but the status and the urgency: what each type chip would show. */
  byUrgency: Record<TodoStatus, Record<UrgencyFilterKey, number>>;
};

/** `GET /api/project-todo`. `counts` and `truncated` are absent from an older daemon. */
export type ProjectTodoListResponse = {
  items?: ProjectTodo[];
  counts?: ProjectTodoCounts;
  /** More ideas match than the rows sent back. */
  truncated?: boolean;
};

/** Rows a TO DO surface asks for at once: the daemon allows up to 1000. */
export const TODO_SURFACE_LIMIT = 500;

/** Total of one status across every type, whatever the type filter. */
export function statusTotal(counts: ProjectTodoCounts | null, status: TodoStatus): number {
  if (!counts) return 0;
  return Object.values(counts.byUrgency[status]).reduce((sum, n) => sum + n, 0);
}
