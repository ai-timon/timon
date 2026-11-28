/**
 * Mission events as a third-party plugin receives them (`ctx.events.on`, API 10):
 * `mission_started` and `turn_complete` (permission `missions:read`), and the
 * transcript stream `event` / `event_delta` (permission `missions:transcript`).
 *
 * The bus events stay as they are. A plugin gets a translation instead, and
 * only for the missions it may see: the mission's owner decides the audience
 * (`todoEventAudience`), exactly as for the TO DO and document events — a
 * mission of the plugin's own job comes to its job, one of a user who may use
 * the plugin comes in that user's identity, any other never leaves.
 *
 * `event` carries a complete transcript row; `event_delta` a live fragment of
 * the answer being written (ephemeral, never replayed). Together they are
 * everything the agent reads and writes, hence their own permission.
 *
 * Delivery is deferred and SERIAL per plugin, like the other hubs. A transcript
 * stream is chatty, so the queue is bounded: past `MAX_QUEUED` the oldest
 * `event_delta` fragments are dropped first (a lost fragment is repaired by the
 * `event` row that completes it), and complete rows only when nothing else is
 * left to drop.
 */
import { bus, type BusEvent } from '../bus.js';
import { dbApi } from '../db.js';
import { runPluginRequest, type PluginRequestIdentity } from './als.js';
import { todoEventAudience } from './todo-events.js';

import type {
  PluginMissionEventKind, PluginMissionOrigin, PluginMissionEvent, PluginMissionEventHandler,
} from './contract/missions.js';
import type { Assert, Equals } from '../type-equality.js';
export type {
  PluginMissionEventKind, PluginMissionOrigin, PluginMissionStartedEvent,
  PluginMissionTurnCompleteEvent, PluginMissionTitleChangedEvent, PluginMissionArchivedEvent, PluginMissionUnarchivedEvent, PluginMissionTranscriptEvent,
  PluginMissionTranscriptDeltaEvent, PluginMissionEvent, PluginMissionEventMap,
  PluginMissionEventHandler,
} from './contract/missions.js';

export const PLUGIN_MISSION_EVENT_KINDS = Object.freeze(['mission_started', 'turn_complete', 'mission_title_changed', 'mission_archived', 'mission_unarchived', 'event', 'event_delta'] as const);
/** `PluginMissionEventKind` spells this list out in the public contract; compilation fails if they part. */
type _PluginMissionEventKindsMatchContract = Assert<Equals<(typeof PLUGIN_MISSION_EVENT_KINDS)[number], PluginMissionEventKind>>;

/** The kinds that read the transcript, not just the mission's lifecycle. */
export const PLUGIN_TRANSCRIPT_EVENT_KINDS = Object.freeze(['event', 'event_delta'] as const);

export function isPluginMissionEventKind(kind: unknown): kind is PluginMissionEventKind {
  return typeof kind === 'string' && (PLUGIN_MISSION_EVENT_KINDS as readonly string[]).includes(kind);
}

export function isPluginTranscriptEventKind(kind: unknown): kind is (typeof PLUGIN_TRANSCRIPT_EVENT_KINDS)[number] {
  return typeof kind === 'string' && (PLUGIN_TRANSCRIPT_EVENT_KINDS as readonly string[]).includes(kind);
}

const PLUGIN_CHANNEL = 'plugin:';

function originOf(channel: string | null, ownerUserId: string | null): PluginMissionOrigin {
  if (channel === null) return Object.freeze({ kind: 'user', id: ownerUserId });
  if (channel.startsWith(PLUGIN_CHANNEL)) return Object.freeze({ kind: 'plugin', id: channel.slice(PLUGIN_CHANNEL.length) });
  return Object.freeze({ kind: channel, id: null });
}

/** A mission's owner and agent: stable for its life, looked up once per mission. */
type MissionFacts = { agent: string; ownerUserId: string | null };
const FACTS_CAP = 500;
const AUDIENCE_TTL_MS = 5_000;
const MAX_QUEUED = 2_000;

/** The plugin's translation of a bus event, or `null` for anything else. */
export function pluginMissionEventFromBus(ev: BusEvent, facts: MissionFacts): PluginMissionEvent | null {
  switch (ev.kind) {
    case 'mission_started':
      return Object.freeze({ kind: 'mission_started', missionId: ev.missionId, agent: ev.agent, at: ev.at, origin: originOf(ev.channel, ev.ownerUserId) });
    case 'turn_complete':
      return Object.freeze({ kind: 'turn_complete', missionId: ev.missionId, agent: facts.agent, outcome: ev.outcome === 'failed' || ev.outcome === 'cancelled' ? ev.outcome : 'completed' });
    case 'mission_title_changed':
      return Object.freeze({ kind: 'mission_title_changed', missionId: ev.missionId, agent: facts.agent, title: ev.title, source: ev.source, origin: ev.origin });
    case 'mission_archived':
      return Object.freeze({ kind: 'mission_archived', missionId: ev.missionId, agent: facts.agent, by: ev.by });
    case 'mission_unarchived':
      return Object.freeze({ kind: 'mission_unarchived', missionId: ev.missionId, agent: facts.agent });
    case 'event':
      return Object.freeze({ kind: 'event', missionId: ev.missionId, agent: facts.agent, type: ev.type, timestamp: ev.timestamp, payload: ev.payload });
    case 'event_delta':
      return Object.freeze({ kind: 'event_delta', missionId: ev.missionId, agent: facts.agent, type: ev.type, payload: ev.payload });
    default:
      return null;
  }
}

type Delivery = { ev: PluginMissionEvent; identity: PluginRequestIdentity | null };

class PluginMissionEventHub {
  private readonly handlers = new Map<PluginMissionEventKind, Set<PluginMissionEventHandler>>();
  private readonly queue: Delivery[] = [];
  private readonly facts = new Map<string, MissionFacts | null>();
  private readonly audiences = new Map<string, { at: number; identity: PluginRequestIdentity | null | undefined }>();
  private draining = false;
  private listening = false;

  constructor(private readonly pluginId: string, private readonly onEmpty: () => void) {}

  private factsOf(ev: BusEvent & { missionId: string }): MissionFacts | null {
    if (ev.kind === 'mission_started') return { agent: ev.agent, ownerUserId: ev.ownerUserId };
    if (this.facts.has(ev.missionId)) return this.facts.get(ev.missionId) ?? null;
    const row = dbApi.getMission(ev.missionId);
    const facts = row ? { agent: row.agent_name, ownerUserId: row.owner_user_id ?? null } : null;
    // A mission that is not there yet (its row lands after the first event) is not remembered as absent.
    if (facts) {
      if (this.facts.size >= FACTS_CAP) this.facts.delete(this.facts.keys().next().value as string);
      this.facts.set(ev.missionId, facts);
    }
    return facts;
  }

  /** Account lookups are database reads: a deltas stream must not repeat them per fragment. */
  private audience(ownerUserId: string | null): PluginRequestIdentity | null | undefined {
    const key = ownerUserId ?? '';
    const now = Date.now();
    const known = this.audiences.get(key);
    if (known && now - known.at < AUDIENCE_TTL_MS) return known.identity;
    const identity = todoEventAudience(this.pluginId, ownerUserId);
    this.audiences.set(key, { at: now, identity });
    return identity;
  }

  private readonly onBus = (ev: BusEvent): void => {
    if (!isPluginMissionEventKind(ev.kind) || !this.handlers.get(ev.kind)?.size) return;
    const facts = this.factsOf(ev as BusEvent & { missionId: string });
    if (!facts) return;
    let translated: PluginMissionEvent | null;
    try { translated = pluginMissionEventFromBus(ev, facts); } catch (err) {
      console.error(`[plugin:${this.pluginId}] mission event translation failed:`, (err as Error).message);
      return;
    }
    if (!translated) return;
    const identity = this.audience(facts.ownerUserId);
    if (identity === undefined) return;
    this.enqueue({ ev: translated, identity });
  };

  private enqueue(delivery: Delivery): void {
    if (this.queue.length >= MAX_QUEUED) {
      const droppable = this.queue.findIndex((d) => d.ev.kind === 'event_delta');
      this.queue.splice(droppable >= 0 ? droppable : 0, 1);
      console.warn(`[plugin:${this.pluginId}] mission event queue full (${MAX_QUEUED}): oldest fragment dropped — the handler is too slow`);
    }
    this.queue.push(delivery);
    if (!this.draining) { this.draining = true; setImmediate(() => { void this.drain(); }); }
  }

  subscribe(kind: PluginMissionEventKind, handler: PluginMissionEventHandler): () => void {
    let set = this.handlers.get(kind);
    if (!set) { set = new Set(); this.handlers.set(kind, set); }
    const entry: PluginMissionEventHandler = (ev) => handler(ev);
    set.add(entry);
    if (!this.listening) { bus.on('event', this.onBus); this.listening = true; }
    return () => {
      set.delete(entry);
      if ([...this.handlers.values()].some((s) => s.size)) return;
      bus.off('event', this.onBus);
      this.listening = false;
      this.onEmpty();
    };
  }

  private async drain(): Promise<void> {
    try {
      for (let next = this.queue.shift(); next; next = this.queue.shift()) {
        const { ev, identity } = next;
        for (const handler of [...(this.handlers.get(ev.kind) ?? [])]) {
          const run = () => handler(ev);
          try {
            await (identity ? runPluginRequest(identity, run) : run());
          } catch (err) {
            console.error(`[plugin:${this.pluginId}] ${ev.kind} handler failed:`, (err as Error).message);
          }
        }
      }
    } finally {
      this.draining = false;
    }
  }
}

const hubs = new Map<string, PluginMissionEventHub>();

export function subscribePluginMissionEvent(
  pluginId: string,
  kind: PluginMissionEventKind,
  handler: PluginMissionEventHandler,
): () => void {
  let hub = hubs.get(pluginId);
  if (!hub) {
    const created: PluginMissionEventHub = new PluginMissionEventHub(pluginId, () => { if (hubs.get(pluginId) === created) hubs.delete(pluginId); });
    hub = created;
    hubs.set(pluginId, hub);
  }
  return hub.subscribe(kind, handler);
}
