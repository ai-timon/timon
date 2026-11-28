/**
 * Bus kinds a plugin may listen to (`ctx.events.on`).
 *
 * Extracted verbatim from `plugins/context.ts`, which re-exports it: the public
 * contract lives in leaf modules so `@timon-ai/sdk` can name it without the
 * implementation (TODO #512, option B).
 */

/**
 * Bus kinds a plugin may listen to (§10.4). The list excludes `event` and
 * `event_delta`: these are mission transcripts, meaning everything agents
 * read and write. They reach a plugin only through its own permission,
 * `missions:transcript` (API 10, `mission-events.ts`), filtered by the
 * mission's owner. `mission_started` and `turn_complete` come the same way,
 * under `missions:read`.
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
