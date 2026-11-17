/**
 * What `GET /api/missions/:id` sends by default: the journal a conversation is
 * rebuilt from, without the rows nobody reads.
 *
 * The claude CLI writes one `system/thinking_tokens` row per reasoning token
 * and one `tool_progress` per tick of a running tool. Measured 27/10/2026 on
 * The maintainer's database: 61 % of the `events` table, and 108 158 of the 108 623 rows
 * of one mission (28.8 MB shipped to the chat, which ignores every one of
 * them). They stay stored: `trace-span-backfill.ts` rebuilds the reasoning
 * spans from `thinking_tokens`, and `?view=raw` still returns everything.
 *
 * The rows are recognised from the start of their stored JSON, never with
 * `json_extract`: the stored payload is `JSON.stringify` of the CLI's object,
 * whose first keys are `type` then `subtype`. A payload written in another
 * order is simply kept — the chat view can only ever send too much, never lose
 * a row it renders.
 */
import type { EventRow } from './db.js';

/** Stored-payload prefixes of the `system` rows the chat view drops. */
const NOISE_SYSTEM_PREFIXES = [
  '{"type":"system","subtype":"thinking_tokens"',
  // `requesting` / `compacting` heartbeats: the chat has no use for them.
  '{"type":"system","subtype":"status"',
] as const;

/** Envelope types the chat view drops entirely. */
const NOISE_TYPES = ['tool_progress'] as const;

/** Stored-payload prefix of a `system/init` row. */
export const INIT_PREFIX = '{"type":"system","subtype":"init"';

function likeEscape(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`).replace(/'/g, "''");
}

/** `LIKE` pattern matching a literal prefix (`_` and `%` escaped with `\`). */
export function likePrefix(prefix: string): string {
  return `'${likeEscape(prefix)}%' ESCAPE '\\'`;
}

/** `LIKE` pattern matching a literal anywhere in the text, escaped the same way. */
export function likeContains(text: string): string {
  return `'%${likeEscape(text)}%' ESCAPE '\\'`;
}

/** SQL condition matching the `system/init` rows. */
export const INIT_ROW_SQL = `type = 'system' AND payload LIKE ${likePrefix(INIT_PREFIX)}`;

/**
 * SQL condition (AND-ed after `mission_id = ?`) that keeps the chat view's
 * rows. `type` is tested first, so `payload` is only read on `system` rows —
 * small ones; an `assistant` row of several hundred kilobytes is never scanned.
 */
export const CHAT_VIEW_SQL = [
  // A rewind hides the rows it cut (docs/specs/rewind.md § 9).
  'rewound_by IS NULL',
  `type NOT IN (${NOISE_TYPES.map((t) => `'${t}'`).join(', ')})`,
  `NOT (type = 'system' AND (${NOISE_SYSTEM_PREFIXES.map((p) => `payload LIKE ${likePrefix(p)}`).join(' OR ')}))`,
].join(' AND ');

/**
 * Same filter in JS, for rows already read (tests, callers holding a raw list).
 * Kept in step with {@link CHAT_VIEW_SQL} by `mission-events-view.test.ts`.
 */
export function isChatViewRow(row: Pick<EventRow, 'type' | 'payload'> & { rewound_by?: number | null }): boolean {
  if (row.rewound_by != null) return false;
  if ((NOISE_TYPES as readonly string[]).includes(row.type)) return false;
  if (row.type === 'system' && NOISE_SYSTEM_PREFIXES.some((p) => row.payload.startsWith(p))) return false;
  return true;
}

function rateLimitKey(payload: string): string {
  try {
    const info = (JSON.parse(payload) as { rate_limit_info?: { rateLimitType?: unknown } }).rate_limit_info;
    return typeof info?.rateLimitType === 'string' ? info.rateLimitType : '';
  } catch {
    return '';
  }
}

/**
 * Keeps only the last `system/init` and the last `rate_limit_event` of each
 * window. The chat reads both as state where the last one wins (session id and
 * model for `init`, status-line gauge for `rate_limit_event`) and renders
 * neither; a resumed mission carries one `init` per turn, about 11 kB each.
 * Order is preserved, so a `backend_switch` after the last `init` still wins.
 */
export function keepLatestState(rows: EventRow[]): EventRow[] {
  const keep = new Array<boolean>(rows.length).fill(true);
  let initSeen = false;
  const windowsSeen = new Set<string>();
  for (let i = rows.length - 1; i >= 0; i--) {
    const row = rows[i]!;
    if (row.type === 'system' && row.payload.startsWith(INIT_PREFIX)) {
      if (initSeen) keep[i] = false;
      initSeen = true;
    } else if (row.type === 'rate_limit_event') {
      const key = rateLimitKey(row.payload);
      if (windowsSeen.has(key)) keep[i] = false;
      windowsSeen.add(key);
    }
  }
  return rows.filter((_, i) => keep[i]);
}

/** Views of `GET /api/missions/:id`. `chat` is the default. */
export const MISSION_VIEWS = ['chat', 'raw', 'status'] as const;
export type MissionView = (typeof MISSION_VIEWS)[number];

export function parseMissionView(value: unknown): MissionView | null {
  if (value === undefined) return 'chat';
  return typeof value === 'string' && (MISSION_VIEWS as readonly string[]).includes(value) ? (value as MissionView) : null;
}
