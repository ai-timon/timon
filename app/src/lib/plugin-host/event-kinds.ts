/**
 * Copy of `PLUGIN_EVENT_KINDS` (orchestrator/src/plugins/contract/events.ts): the app
 * and the daemon are separate packages. The browser half of a plugin reads the
 * global SSE stream, which also carries `event` / `event_delta` — the mission
 * transcripts the host half is already denied. Both halves must apply the same
 * list; `plugin-event-kinds.test.ts` fails when the two copies drift.
 */
export const PLUGIN_EVENT_KINDS = Object.freeze([
  'mission_complete',
  'mission_started',
  'turn_complete',
  'mission_title_changed',
  'mission_archived',
  'mission_unarchived',
  'task_done',
  'task_blocked',
  'notifications_changed',
  'workflow_run',
  'workflow_proposal',
] as const);
export type PluginEventKind = (typeof PLUGIN_EVENT_KINDS)[number];

export function isPluginEventKind(kind: unknown): kind is PluginEventKind {
  return typeof kind === 'string' && (PLUGIN_EVENT_KINDS as readonly string[]).includes(kind);
}

/**
 * The one transcript kind the browser stream carries: a complete row of a
 * mission's conversation. It is not a generic kind (see above): the browser
 * half receives it only when the manifest declares `missions:transcript`.
 * The stream itself is the signed-in account's — it only ever carries the
 * missions that account sees. `event_delta` (live fragments) is host-only: the
 * global stream does not carry it.
 */
export const TRANSCRIPT_EVENT_KIND = 'event';
export const TRANSCRIPT_PERMISSION = 'missions:transcript';

export function isSubscribableKind(kind: unknown, permissions: readonly string[]): boolean {
  return isPluginEventKind(kind) || (kind === TRANSCRIPT_EVENT_KIND && permissions.includes(TRANSCRIPT_PERMISSION));
}
