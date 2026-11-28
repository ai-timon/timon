import { EventEmitter } from 'node:events';
import type { MissionTitleOrigin, MissionTitleSource } from './mission-title-source.js';
import type { InterruptionReason } from './interruption.js';
import type { PluginPublic } from './plugins/public.js';
import type { BrowserRecordingEventName, BrowserRecordingMetadata } from './browser-recordings.js';
import type { BrowserAnnotationEventName, BrowserAnnotationMetadata } from './browser-annotations.js';
import { ASSISTANT_DELTA } from './backends/types.js';
import { redactDeep } from './secrets/redact.js';
import { dropRedactStream, flushRedactStream, redactStreamChunk } from './secrets/redact-stream.js';
import type { ProjectEventOrigin } from './plugins/contract/origin.js';
import type { OnboardingStepAction, OnboardingStepDetail, OnboardingStepName } from './onboarding-events.js';
import type { UsageKind } from './onboarding-usage-kind.js';
export type { ProjectEventOrigin } from './plugins/contract/origin.js';

/** A task link, as it stood before the cascade of a delete removed it. */
export type TaskDeletedLink = Readonly<{
  provider: string;
  ref: string;
  url: string | null;
  label: string | null;
  plugin_id: string | null;
  created_at: number;
}>;

/**
 * What `task_deleted` keeps of a task that no longer exists: the identity a
 * board needs to drop its card (never the description, comments or prompts).
 * Taken BEFORE the delete — the cascade removes the links with the row.
 */
export type TaskDeletedSnapshot = Readonly<{
  id: string;
  title: string;
  agent_name: string;
  status: string;
  type: string;
  project: string | null;
  owner_user_id: string | null;
  mirror: boolean;
  links: readonly TaskDeletedLink[];
}>;

/** What `todo_resolved` may carry out of Timon: never the private `notes`. */
export type TodoResolvedSnapshot = Readonly<{
  id: number;
  text: string;
  project: string | null;
  /** Published by `@timon/todo-outcomes`; its closed list lives there. */
  resolution: string;
  public_note: string | null;
  duplicate_of: string | null;
  owner_user_id: string | null;
}>;

/** A link of a deleted idea, as it stood before the cascade removed it. */
export type TodoDeletedLink = Readonly<{
  provider: string;
  ref: string;
  url: string | null;
  label: string | null;
  plugin_id: string | null;
  created_at: number;
}>;

/** What `todo_deleted` keeps of an idea that no longer exists: never `notes`. */
export type TodoDeletedSnapshot = Readonly<{
  id: number;
  text: string;
  project: string | null;
  owner_user_id: string | null;
  links: readonly TodoDeletedLink[];
}>;

/**
 * What the agent events keep of an agent: who it is, never how it runs — no
 * working directory, prompt, tools or MCP servers. `created_by` is the origin
 * mark (`plugin:<id>` for an agent a plugin created).
 */
export type AgentEventSnapshot = Readonly<{
  name: string;
  backend: string;
  model: string | null;
  project: string | null;
  role: string | null;
  has_system_prompt: boolean;
  created_by: string | null;
}>;

/** What an `integration_changed` write touched. `checks` is the forge's stored
 *  reading, compared without its read time; `scope` is a project or series
 *  filled in on a job recorded without it. */
export type IntegrationChange = 'created' | 'state' | 'pull_request' | 'checks' | 'landed' | 'scope';

export type BusEvent =
  | { kind: 'plugin_realtime'; pluginId: string; topic: string; ownerUserId: string; payload: unknown }
  // `id`: the row of `events` the event was stored as, when the publisher has
  // one. The chat anchors a reply on it (`reply-to.ts`).
  | { kind: 'event'; missionId: string; type: string; timestamp: number; payload: unknown; id?: number }
  // Text fragment of an answer being generated. EPHEMERAL: never
  // persisted (neither `events` nor the agent's JSONL log), so never replayed on
  // reconnection — a page reload falls back on the complete message.
  // No `timestamp`: nothing to deduplicate against a DB replay. Carries a
  // missionId, so the per-mission channel `mission:<id>` works unchanged.
  | { kind: 'event_delta'; missionId: string; type: string; payload: unknown }
  // `terminated` = normal end of life without an error (idle reaper, manual kill, config
  // reload, orphan/restart). Distinct from `completed` (explicit end, exit 0) and
  // from `failed` (a real problem: crash, stuck turn, failed spawn).
  // `reason` qualifies the death when it is SUFFERED (rate_limit/killed/timeout/
  // crash) — null on a clean end. The dispatcher uses it to label the
  // task instead of blocking it without a reason (see interruption.ts).
  | { kind: 'mission_complete'; missionId: string; status: 'completed' | 'failed' | 'terminated'; exitCode: number | null; reason?: InterruptionReason | null }
  // Emitted for one-shot backends (codex) when a turn's subprocess exits
  // cleanly but the mission is still alive and waiting for the next user
  // input. UI can use this to drop the "running" spinner without marking
  // the chat as ended.
  // `cancelled`: a steer stopped the turn and its instruction opens the next
  // one (`steerMission`). The turn is over on screen, not in the conversation:
  // whatever waits for the agent's answer waits for the next turn (TODO #568).
  | { kind: 'turn_complete'; missionId: string; outcome?: 'completed' | 'failed' | 'cancelled' }
  // A turn opened on a live process: the first one at launch, a follow-up
  // message, or a turn the CLI opened by itself. Several paths may announce
  // the same turn (a protocol driver confirms the launch turn): a listener
  // counting turns keys on the mission and ignores a start while one is open.
  | { kind: 'turn_started'; missionId: string; at: number }
  // A first-run wizard step answered (`onboarding-events.ts`): step, outcome
  // and detail from closed lists, nothing the person typed. No `missionId`, so
  // the browser stream never relays it.
  | ({ kind: 'onboarding_step'; step: OnboardingStepName; action: OnboardingStepAction } & OnboardingStepDetail)
  // An account answered, or changed, who it uses Timon for
  // (`onboarding-usage-kind.ts`). No `missionId`: never relayed to a browser.
  | { kind: 'usage_kind_set'; usageKind: UsageKind; userId: string }
  // The licence refused a new account the account provider asked for
  // (`account-provider-facade.ts`): the person who asked, `null` for a job.
  // No `missionId`: never relayed to a browser.
  | { kind: 'account_limit_reached'; userId: string | null }
  // A compaction of `missionId` moved on (`mission-compact.ts`): one per phase,
  // transient like `event_delta` (the outcome is persisted as a `compact`
  // event; `GET /api/missions/:id/compact` says what is under way after a
  // reload). `targetMissionId`: the mission the conversation goes on in — the
  // same one for `native`, the fork once it exists for `fork`.
  | {
      kind: 'compact_progress'; missionId: string; operationId: string; mode: 'native' | 'fork';
      phase: 'started' | 'summarizing' | 'forking' | 'compacting' | 'done' | 'error';
      targetMissionId: string | null; error: string | null; at: number;
    }
  // A mission row was created and is about to launch its first turn. Emitted
  // once by `spawnAgent`, whatever the caller (chat, dispatcher, fork, plugin).
  // `channel` is the spawn source (`plugin:<id>`, `agent`, `fork`…), `null` for
  // the human chat; the plugin-facing `origin` is derived from it.
  | { kind: 'mission_started'; missionId: string; agent: string; channel: string | null; ownerUserId: string | null; at: number }
  // Emitted as soon as a task goes BLOCKED, whatever the path (agent
  // `timon task block`, failed mission, verification-loop cap, dispatcher
  // spawn failure). Centralised in dbApi.updateTaskStatus/setTaskStatusOnly so
  // that no blocking path is forgotten. Consumed by recovery.ts.
  // `byPerson`: a person blocked it from the interface — the decision is
  // theirs, the wake loop does not hand it to the pilot.
  | { kind: 'task_blocked'; taskId: string; reason: string | null; byPerson?: boolean }
  // Emitted when an agent enqueues a message to another agent. `missionId`
  // serves the existing SSE routing (per mission) — for messages we broadcast,
  // so the source mission is taken. The inbox UI filters by `toAgent`.
  | {
      kind: 'agent_message';
      missionId: string;
      messageId: string;
      toAgent: string;
      fromAgent: string;
      fromMission: string;
    }
  // Emitted when a task goes DONE, whatever the path (`timon task done`,
  // API closing, guard). Counterpart of `task_blocked`, and for the same reason:
  // it is the task's CLOSING that must go up to the pilot, not the death of the
  // process that ran it — that death sometimes comes much later (11 min
  // measured on review `693469fa` on 2026-08-21). Consumed by wake.ts.
  // Emitted when a mission receives its lineage (`setMissionLineage` with a
  // parent) — the APPEARANCE of a child mission. The delegating pilot had
  // no arrival signal: `mission_complete` and `turn_complete` tell the
  // disappearance, nothing told the birth, and the client was reduced to
  // polling. Carries `missionId` (the child) so that the ownership filter and
  // the per-mission channel of `sse.ts` apply without a special case.
  | { kind: 'mission_child_started'; missionId: string; parentMissionId: string; agent: string }
  | { kind: 'task_done'; taskId: string }
  // A task's FIRST dispatch (PENDING → IN_PROGRESS): never again for a requeue,
  // a restart or a repair of the same task (`tasks.started_at`). `followUp`: the
  // orchestrator created it after another task (review, merge, doc, iteration).
  | { kind: 'task_started'; taskId: string; followUp: boolean }
  /** A TO DO idea whose progress just became `done` (checkbox, tag or chain closure). */
  | { kind: 'todo_done'; todoId: number; previousProgress: string | null }
  /**
   * A mission's title was written (TODO #358): renamed by hand, named by its
   * launcher at spawn, read from the CLI's session or generated at the end of
   * the first turn. `title` null = cleared. Carries `missionId`, so the browser
   * stream relays it under the mission's own visibility, and plugins receive
   * it translated (`mission-events.ts`) under `missions:read`.
   */
  | { kind: 'mission_title_changed'; missionId: string; title: string | null; source: MissionTitleSource | null; origin: MissionTitleOrigin }
  /** A mission was archived (hidden from the default lists) by `by`. */
  | { kind: 'mission_archived'; missionId: string; by: 'user' | 'auto' | 'agent' }
  /** An archived mission came back, by hand or because a message arrived. */
  | { kind: 'mission_unarchived'; missionId: string }
  /** An agent proposed archiving its finished conversation; only a person archives. */
  | { kind: 'mission_archive_suggested'; missionId: string; reason: string | null }
  /**
   * A TO DO idea given a new outcome (`resolution`), closing or not. `todo` is
   * the idea as it stood right after this write: listeners run deferred, and
   * a re-read would show a later write instead (two outcomes in a row would
   * both go out as the second one).
   */
  | { kind: 'todo_resolved'; todoId: number; previousResolution: string | null; todo: TodoResolvedSnapshot }
  /**
   * A TO DO idea deleted. `todo` is taken BEFORE the delete: the cascade
   * removes its links with it, and a connector needs them to know which
   * ticket to close.
   */
  | { kind: 'todo_deleted'; todoId: number; todo: TodoDeletedSnapshot }
  /**
   * A persistent agent written, whoever wrote it (page, CLI, MCP, plugin, boot).
   * No `missionId`: the browser stream drops them. `agent` is the agent as that
   * write left it. `changed` names what the write touched (config keys,
   * `system_prompt`, `doc:<file>`, `name` for a rename, whose old name rides in
   * `previousName`). The writer is `currentWriteOrigin()`, read synchronously.
   */
  | { kind: 'agent_created'; agent: AgentEventSnapshot }
  | { kind: 'agent_updated'; agent: AgentEventSnapshot; changed: readonly string[]; previousName: string | null }
  /** `agent` is taken BEFORE the delete: the directory no longer exists. */
  | { kind: 'agent_deleted'; agent: AgentEventSnapshot }
  // Emitted when a BLOCKED task becomes active again (PENDING/IN_PROGRESS/DONE).
  | { kind: 'task_unblocked'; taskId: string }
  /**
   * A job's integration row moved (`integrations`, the landing of a Kanban
   * job): created, its state, its pull request, its stored checks or its
   * landing. Ids and the state only: a screen reads the job again through its
   * scoped route. No `missionId`: the browser stream relays it on its own
   * rule, the job's visibility (`integrationVisibleTo`).
   */
  | { kind: 'integration_changed'; integrationId: string; project: string | null; seriesId: string | null;
      state: string; changed: readonly IntegrationChange[] }
  /**
   * Kanban lifecycle, for the plugins that mirror the board elsewhere
   * (`plugins/task-events.ts`). None of them carries a `missionId`, so the
   * SSE stream drops them: ids and field names only, the row is re-read by
   * the listener inside the write that caused the event.
   *
   *  - `task_created`: a row was inserted (by anyone: user, agent, chain);
   *  - `task_updated`: watched columns changed (`changed`), with the values
   *    they had before (`previous`) — status moves included, whichever path
   *    wrote them, and a `updated_at`-only touch emits nothing;
   *  - `task_assigned`: the task's `agent_name` changed (a mission attaching
   *    at dispatch is a status move, not an assignment);
   *  - `task_deleted`: `task` is the snapshot taken before the delete.
   */
  | { kind: 'task_created'; taskId: string }
  | { kind: 'task_updated'; taskId: string; changed: readonly string[]; previous: Readonly<Record<string, unknown>> }
  | { kind: 'task_assigned'; taskId: string; previousAgent: string }
  | { kind: 'task_deleted'; taskId: string; task: TaskDeletedSnapshot }
  // Direct navigation under a live grant (`navigate-routes.ts`): the owner's
  // browsers only, on the global stream — never a mission's, which closes when
  // the chat unmounts.
  | { kind: 'ui_navigate'; ownerUserId: string; path: string; params: Record<string, string> }
  | { kind: 'workflow_run'; runId: string; nodeId?: string; status: string }
  | { kind: 'workflow_proposal'; workflowId: string; missionId: string }
  // Generic signal the UI listens to in order to refresh the notification list.
  // `ownerUserId` lets the SSE filter drop pings that are not the viewer's
  // (NULL = system / broadcast, visible only with `:all`).
  // `notificationId` is set only when the ping announces a creation (native
  // triggers listen for exactly that), never on a read or a dismiss.
  | { kind: 'notifications_changed'; ownerUserId?: string | null; notificationId?: string }
  // A proposed write on a project's forge was created, edited, claimed,
  // published, failed or discarded (`forge-proposals.ts`). Ids only: the
  // screens read the proposal again behind its route (`projects:manage`).
  | { kind: 'forge_proposals_changed'; project: string; proposalId: string }
  // Emitted by the daemon on each real recomposition of the plugin tree
  // (add / remove / enable / disable, or a bundle `rev` that changes).
  // Read-only: plugins do not emit (§10.4). The front uses it
  // to load/unload the browser halves without reloading the page.
  | { kind: 'plugins_changed'; plugins: PluginPublic[] }
  // Emitted by the licence renewal loop (`license/refresh.ts`) on
  // each state change: the UI refreshes the banner and the licence page
  // without reloading. Never the token nor the key.
  // Emitted when the LLM backend registry moves: a provider plugin
  // installed, enabled or unloaded (§10.15). The UI reloads its catalogue rather
  // than offering a backend that disappeared — or ignoring one that appeared.
  /**
   * A project registered (route, MCP tool, CLI or plugin). `origin` is the
   * writer, so a connector mirroring projects can drop the echo of its own
   * writes. Carries no `missionId`: the browser stream never relays it.
   */
  | { kind: 'project_created'; slug: string; origin: ProjectEventOrigin }
  /** A project's metadata or roles changed; `changed` names the fields (`roles` for a role pin). */
  | { kind: 'project_updated'; slug: string; changed: readonly string[]; origin: ProjectEventOrigin }
  /**
   * A browser recording's life (TODO #461), relayed to plugins as
   * `browser_recording_*`. Carries metadata only, never a step; no `missionId`,
   * so the browser stream never relays it.
   */
  | { kind: 'browser_recording'; event: BrowserRecordingEventName; profileId: string; recordingId: string | null;
      ownerUserId: string | null; recording: BrowserRecordingMetadata | null; reason?: string; origin: ProjectEventOrigin }
  /**
   * A browser annotation's life (TODO #468), relayed to plugins as `browser_annotation_*`.
   * Metadata only, never the comment nor anything of the page; no top-level `missionId`, so
   * the browser stream never relays it.
   */
  | { kind: 'browser_annotation'; event: BrowserAnnotationEventName; profileId: string; annotationId: string;
      ownerUserId: string | null; annotation: BrowserAnnotationMetadata; reason?: string; origin: ProjectEventOrigin }
  | { kind: 'backends_changed' }
  /**
   * An actor actually moved to its fallback backend (`backend-fallback.ts`): a
   * spawn redirected off a sidelined backend, or a series' pilot or task type
   * switched over. Raw backend ids, account instances included (`claude@<id>`),
   * so a listener that sends them anywhere maps them first. No `missionId`:
   * the browser stream never relays it.
   */
  | { kind: 'backend_fallback'; fromBackend: string | null; toBackend: string }
  | { kind: 'license_changed'; status: 'valid' | 'unlicensed'; reason: string | null; offlineSince: string | null }
  /**
   * `@timon/updates` verified a signed manifest that offers a newer version
   * than the installed one, for the first time since the daemon started.
   * Global stream only: the UI reads `GET /api/updates` again.
   */
  | { kind: 'update_available'; version: string; channel: 'beta' | 'stable' };

class Bus extends EventEmitter {
  publish(ev: BusEvent): void {
    // Output redaction (SECRETS-VAULT.md §7) for the SSE stream, applied at the
    // single point every producer goes through rather than at each of them.
    // Persisted events are already masked by `insertEvent`, and masking is
    // idempotent — the cost of doing it twice is one failed `includes`.
    if (ev.kind === 'event_delta') {
      const red = this.redactDelta(ev);
      // Nothing left to say: a fragment that is itself a strict prefix of a
      // vault value is held whole (see redact-stream.ts). Publishing an empty
      // delta would only make the UI churn.
      if (red === null) return;
      ev = red;
    } else if (ev.kind === 'event') {
      // The complete message is about to land; hand over what the live stream
      // was still holding so the two do not disagree on screen.
      this.releaseHeldDelta(ev.missionId);
      const payload = redactDeep(ev.payload);
      if (payload !== ev.payload) ev = { ...ev, payload };
    } else if (ev.kind === 'turn_complete') {
      // Remaining report is a secret prefix (or a false-positive one): mask
      // it before it hits the wire, then drop the entry.
      this.releaseHeldDelta(ev.missionId);
    } else if (ev.kind === 'mission_complete') {
      // A missing tail is better than a leak (§7.1).
      dropRedactStream(ev.missionId);
    }
    this.dispatch(ev);
  }

  /**
   * Chunk-boundary-safe redaction of a live fragment. A secret straddling two
   * fragments matches neither of them taken alone, so only the ambiguous
   * suffix (a strict prefix of a known value) is held back; everything else
   * goes out immediately. Anything that is not a `{ text }` payload falls
   * back to the structural filter — a dialect could ship another shape, and
   * the safe default is to mask it rather than trust it.
   */
  private redactDelta(ev: Extract<BusEvent, { kind: 'event_delta' }>): BusEvent | null {
    const payload = ev.payload;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      const red = redactDeep(payload);
      return red === payload ? ev : { ...ev, payload: red };
    }
    const shape = payload as { text?: unknown; mode?: unknown };
    if (typeof shape.text !== 'string') {
      const red = redactDeep(payload);
      return red === payload ? ev : { ...ev, payload: red };
    }
    const mode = shape.mode === 'replace' ? 'replace' : 'append';
    const text = redactStreamChunk(ev.missionId, shape.text, mode);
    if (!text) return null;
    if (text === shape.text) return ev;
    return { ...ev, payload: { ...shape, text } };
  }

  /** Emit the placeholder in place of whatever suffix is still held, as one
   *  last fragment. Goes straight to `dispatch`: re-entering `publish` would
   *  send it back through the buffer it just came out of. */
  private releaseHeldDelta(missionId: string): void {
    const tail = flushRedactStream(missionId);
    if (!tail) return;
    this.dispatch({
      kind: 'event_delta',
      missionId,
      type: ASSISTANT_DELTA,
      payload: { text: tail, mode: 'append' },
    });
  }

  private dispatch(ev: BusEvent): void {
    this.emit('event', ev);
    // task_blocked is not attached to a mission → no per-mission channel.
    if ('missionId' in ev) this.emit(`mission:${ev.missionId}`, ev);
  }
}

export const bus = new Bus();
bus.setMaxListeners(0);

/** Live `event` subscribers. `setMaxListeners(0)` silences Node's leak warning,
 *  so this count is the only signal left when a subscriber forgets `off`. */
export function busEventListenerCount(): number {
  return bus.listenerCount('event');
}
