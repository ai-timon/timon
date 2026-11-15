/**
 * Bodies of the Kanban writes beside the task PUT/POST (TODO #787): closing,
 * marking merged, recording a sha, creating a worktree. Strict like the PUT
 * (`task-update-body.ts`): an unknown field is a 400 that names it, instead of
 * being dropped without a word.
 *
 * The shapes check types only. The routes keep their finer refusals and their
 * messages (an outcome or a verdict out of its enum, a sha that is not hex).
 */
import { z } from 'zod';
import { parseStrictBody } from './task-update-body.js';

type Parsed<S extends z.ZodTypeAny> = { ok: true; value: z.output<S> } | { ok: false; error: string };

function strictParser<F extends z.ZodRawShape>(fields: F) {
  const schema = z.object(fields).strict();
  return (raw: unknown): Parsed<typeof schema> => parseStrictBody(schema, Object.keys(fields), raw);
}

/** `POST /api/tasks/close` — what the CLI's `mark-as-done` / `mark-as-failed` and the MCP send. */
export const parseTaskCloseBody = strictParser({
  id: z.string().max(255).optional(),
  mission_id: z.string().max(255).optional(),
  /** Enum checked by the route, whose refusal names the accepted values. */
  outcome: z.unknown().optional(),
  comment: z.string().optional(),
  reason: z.string().optional(),
  blocked_reason: z.string().optional(),
  verdict: z.unknown().optional(),
  /** Hex shape and base checked by the route. */
  merged_sha: z.unknown().optional(),
  /** Pull-request destination (`baseRefName`). Shape checked by the route. */
  merged_base: z.unknown().optional(),
  /** Clamped or ignored by `parseSummary`: a closing never fails on its summary. */
  summary: z.unknown().optional(),
});

/** `POST /api/tasks/:id/mark-merged` — the board's "Merged outside Timon". */
export const parseMarkMergedBody = strictParser({
  /** Hex shape checked by the route, with its own message. */
  sha: z.unknown().optional(),
  comment: z.string().max(4000).optional(),
});

/** `POST /api/tasks/:id/merged-sha` — `timon task done --merged-sha`. */
export const parseMergedShaBody = strictParser({
  sha: z.unknown().optional(),
});

/** `POST /api/tasks/:id/worktree` — an optional starting branch. */
export const parseWorktreeCreateBody = strictParser({
  base: z.string().max(255).optional(),
});

/** `POST /api/tasks/:id/worktree/detach` carries nothing. */
export const parseEmptyBody = strictParser({});
