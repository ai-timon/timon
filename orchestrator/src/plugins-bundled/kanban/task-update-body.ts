/**
 * The body `PUT /api/tasks/:id` accepts (TODO #752, SECURITY.md: every network
 * input goes through zod before the database).
 *
 * Strict on purpose: an unknown field is a 400 that names it and lists the
 * accepted ones. A misspelt field used to be ignored without a word, so a
 * client believed it had changed what it had not (the same lesson as
 * `project-todo-unknown-fields.test.ts`).
 *
 * The shape checks types only. The finer refusals keep their own, more
 * explicit messages in the route: `validateScheduledAt` (an ISO string or an
 * epoch in seconds), `backendRefusal`, `isTaskType`, the merge sha, the TO DO
 * link. A new field — a `clear_*` sentinel, say — is one line in
 * `TASK_UPDATE_FIELDS`.
 */
import { z } from 'zod';
import { MergeRequestInput } from '../../merge-request.js';

/** Free text a client may send as `null`: the route reads `null` as "unchanged". */
const text = z.string().nullable();
/** Skills, MCP servers, tools: `null` or `[]` clears the list. */
const names = z.array(z.string().max(512)).max(256).nullable();
/** `null` clears the primary LLM only; fallback and mode need their sentinels. */
const override = z.string().max(255).nullable();

export const TASK_UPDATE_FIELDS = {
  title: text,
  description: text,
  agent_name: z.string().min(1).max(255).nullable(),
  /** `TODO` is the deprecated input alias of `PENDING` (`normalizeTaskStatusInput`). */
  status: z.enum(['PENDING', 'IN_PROGRESS', 'DONE', 'BLOCKED', 'TODO']),
  priority: z.number().int(),
  deps: z.array(z.string().min(1).max(255)).max(256),
  /** Shape left to `validateScheduledAt`, whose refusals say what was wrong. */
  scheduled_at: z.unknown(),
  /** Sentinel clearing the scheduling: `scheduled_at: null` is a deliberate no-op. */
  clear_scheduled_at: z.boolean(),
  blocked_reason: text,
  done_comment: text,
  extra_skills: names,
  extra_mcp_servers: names,
  extra_allowed_tools: names,
  type: z.string(),
  backend_override: override,
  model_override: override,
  fallback_backend_override: override,
  fallback_model_override: override,
  permission_mode_override: override,
  /** Explicit erasure, winning over override values in the same body. */
  clear_fallback: z.boolean(),
  clear_permission_mode: z.boolean(),
  merged_commit_sha: z.string(),
  /** A TO DO idea (number) to attach, `null` to detach; checked against the caller's scope. */
  todo_id: z.unknown(),
  /** The pull / merge request the task opened; the forge and number come from its URL. */
  merge_request: MergeRequestInput,
  /** Human summary, read only when this call closes the task as DONE. */
  done_summary: z.string().nullable(),
} as const;

export const TaskUpdateBodySchema = z.object(TASK_UPDATE_FIELDS).partial().strict();

export type TaskUpdateBody = z.infer<typeof TaskUpdateBodySchema>;

/**
 * A strict body, or the 400 text: unknown fields named first (with the
 * accepted ones, or the nested path they sit in), then the first type error. Shared with the creation body.
 */
export function parseStrictBody<S extends z.ZodTypeAny>(
  schema: S,
  accepted: readonly string[],
  raw: unknown,
): { ok: true; value: z.output<S> } | { ok: false; error: string } {
  const parsed = schema.safeParse(raw ?? {});
  if (parsed.success) return { ok: true, value: parsed.data };
  const unrecognized = parsed.error.issues.flatMap((issue) => issue.code === 'unrecognized_keys' ? [issue] : []);
  const listed = (keys: string[]): string => `field${keys.length > 1 ? 's' : ''} ${keys.map((k) => `"${k}"`).join(', ')}`;
  const unknown = unrecognized.flatMap((issue) => issue.path.length === 0 ? issue.keys : []);
  if (unknown.length > 0) {
    return { ok: false, error: `unknown ${listed(unknown)} (accepted: ${accepted.join(', ')})` };
  }
  // A nested object (a pipeline step): its path says where the stray field is.
  const nested = unrecognized[0];
  if (nested) return { ok: false, error: `unknown ${listed(nested.keys)} in ${nested.path.join('.')}` };
  const issue = parsed.error.issues[0];
  const path = issue?.path.length ? issue.path.join('.') : 'body';
  return { ok: false, error: `invalid ${path}: ${issue?.message ?? 'malformed request body'}` };
}

/** The update body, or the 400 text. */
export function parseTaskUpdateBody(raw: unknown): { ok: true; value: TaskUpdateBody } | { ok: false; error: string } {
  return parseStrictBody(TaskUpdateBodySchema, Object.keys(TASK_UPDATE_FIELDS), raw);
}

/** What closing a task carries: `timon task done` / `timon task block` send nothing else. */
const CLOSING_FIELDS: ReadonlySet<string> = new Set(['status', 'done_comment', 'blocked_reason', 'done_summary', 'merged_commit_sha', 'merge_request']);

/**
 * A body that only closes the task (DONE or BLOCKED, with its note). The one
 * write a mission may make on its own task without `kanban:write`: the same
 * gesture as `POST /api/tasks/close`, which only needs the task to be visible.
 */
export function isClosingOnly(body: TaskUpdateBody): boolean {
  if (body.status !== 'DONE' && body.status !== 'BLOCKED') return false;
  return Object.keys(body).every((key) => CLOSING_FIELDS.has(key));
}
