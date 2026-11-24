/**
 * The body `POST /api/tasks` accepts (TODO #752, SECURITY.md: every network
 * input goes through zod before the database).
 *
 * Strict, like the update body: an unknown field is a 400 that names it and
 * lists the accepted ones, and no task is created. A misspelt field used to be
 * dropped without a word, so a caller believed it had set what it had not.
 *
 * The shape checks types only. The finer refusals keep their own messages in
 * `createTaskFromBody`: `title and agent_name required`, `pipelineRefusal`,
 * `backendRefusal`, `projectRefusal`, `planGroupRefusal`, `validateScheduledAt`,
 * `isTaskType`, the git base, the TO DO link. A new field is one line in
 * `TASK_CREATE_FIELDS`.
 *
 * `null` is read as "not given" on every field, as the old cast did: the task
 * form and the MCP send `null` for an empty optional value, and the CLI's
 * `Number('x')` reaches the wire as `null`.
 */
import { z } from 'zod';
import { parseStrictBody } from './task-update-body.js';

const absent = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().transform((v) => v ?? undefined);
/** Free text. */
const text = absent(z.string());
/** Skills, MCP servers, tools. */
const names = absent(z.array(z.string().max(512)).max(256));
/** A backend, a model, a permission mode, a group, a project. */
const override = z.string().max(255).nullable();

export const TASK_CREATE_FIELDS = {
  /** Required, with `agent_name`: checked by the route, whose message says so. */
  title: text,
  description: text,
  agent_name: text,
  priority: absent(z.number().int()),
  deps: absent(z.array(z.string().min(1).max(255)).max(256)),
  /** Shape left to `validateScheduledAt`, whose refusals say what was wrong. */
  scheduled_at: z.unknown(),
  extra_skills: names,
  extra_mcp_servers: names,
  extra_allowed_tools: names,
  type: text,
  backend_override: override,
  model_override: override,
  /** EXPLICIT fallback for this specific task (wins over the series and the
   *  global setting). 'none' = no automatic fallback for this task. */
  fallback_backend_override: override,
  fallback_model_override: override,
  reasoning_effort: override,
  permission_mode_override: override,
  group_id: override,
  /** Group of volets in the series plan (`--plan-group`): the task and the
   *  review, merge, doc and iterations chained after it resolve their LLM and
   *  fallback on the group's rules before the series'. Shape left to
   *  `planGroupRefusal`. */
  plan_group: z.unknown(),
  pipeline: override,
  /** 'pr' on the final `merge` task of a job that lands through a pull
   *  request: it publishes the job's branch instead of merging into it.
   *  'local' on the final `merge` task of a job a project that merges locally
   *  runs on a branch of its own: it merges that branch into the target.
   *  Checked by `landingRefusal`. */
  landing: override,
  project: override,
  /** Orchestrator mission that opens (or joins) the work. Normally
   *  inferred from the `X-TIMON-Mission` header; the field only exists for the
   *  calls that have none (replay, import). */
  creator_mission_id: override,
  /** Starting branch of the worktree of a `code` task (and of the `merge` task
   *  that will follow). Absent, the dispatcher falls back on the CURRENT branch of the
   *  shared repository — another agent's, depending on the moment. */
  base: override,
  trace_id: absent(z.string().max(255)),
  /** TO DO idea this task implements: closed automatically when the chain
   *  lands (todo-closure.ts). Must be visible to the caller; shape left to
   *  `parseTodoLink`. */
  todo_id: z.unknown(),
} as const;

export const TaskCreateBodySchema = z.object(TASK_CREATE_FIELDS).partial().strict();

/**
 * Creation of a task — the path taken by `POST /api/tasks` and by the promotion
 * of an idea from the notebook (`POST /api/project-todo/:id/promote`).
 */
export type TaskCreateBody = z.output<typeof TaskCreateBodySchema>;

/** The creation body, or the 400 text. */
export function parseTaskCreateBody(raw: unknown): { ok: true; value: TaskCreateBody } | { ok: false; error: string } {
  return parseStrictBody(TaskCreateBodySchema, Object.keys(TASK_CREATE_FIELDS), raw);
}
