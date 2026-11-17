/**
 * Question events as a third-party plugin receives them (`ctx.events.on`):
 * `question_pending` when an agent opens a question or a Kanban plan, and
 * `question_resolved` when it closes — answered, cancelled or expired.
 *
 * `permissions.ts` hands `question-bus.ts` a snapshot of the card at the moment
 * of each write; the translation below is built synchronously from it, so the
 * event shows the card as that write left it. The mission's own `permission_*`
 * events are never relayed (they are not in `PLUGIN_EVENT_KINDS`).
 *
 * Audience: the owner of the mission, filtered like the plugin's reads
 * (`todoEventAudience`) — a card on a mission of its job comes to its job, one
 * on a mission of a user who may use the plugin comes in that user's identity,
 * the rest never leaves. Delivery is deferred and serial per plugin, like the
 * TO DO and document events.
 */
import { dbApi } from '../db.js';
import { onQuestionEvent, type QuestionBusEvent } from '../question-bus.js';
import { runPluginRequest, type PluginRequestIdentity } from './als.js';
import { projectQuestion } from './questions-facade.js';
import { todoEventAudience } from './todo-events.js';

import type {
  PluginQuestionEventKind, PluginQuestionEvent, PluginQuestionEventHandler,
} from './contract/questions.js';
import type { Assert, Equals } from '../type-equality.js';
export type {
  PluginQuestionEventKind, PluginQuestionActor, PluginQuestionPendingEvent, PluginQuestionResolvedEvent,
  PluginQuestionEvent, PluginQuestionEventMap, PluginQuestionEventHandler,
} from './contract/questions.js';

export const PLUGIN_QUESTION_EVENT_KINDS = Object.freeze(['question_pending', 'question_resolved'] as const);
/** `PluginQuestionEventKind` spells this list out in the public contract; compilation fails if they part. */
type _PluginQuestionEventKindsMatchContract = Assert<Equals<(typeof PLUGIN_QUESTION_EVENT_KINDS)[number], PluginQuestionEventKind>>;

export function isPluginQuestionEventKind(kind: unknown): kind is PluginQuestionEventKind {
  return typeof kind === 'string' && (PLUGIN_QUESTION_EVENT_KINDS as readonly string[]).includes(kind);
}

/** The plugin's translation of a question write, with the account it belongs to. */
export function pluginQuestionEventFromBus(ev: QuestionBusEvent): { ev: PluginQuestionEvent; ownerUserId: string | null } | null {
  const mission = dbApi.getMission(ev.question.missionId);
  if (!mission) return null;
  const question = projectQuestion(ev.question);
  if (ev.type === 'pending') {
    return {
      ownerUserId: mission.owner_user_id,
      ev: Object.freeze({
        kind: 'question_pending', questionId: question.id, question,
        origin: Object.freeze({ kind: 'agent', id: ev.question.agent }),
      }),
    };
  }
  return {
    ownerUserId: mission.owner_user_id,
    ev: Object.freeze({
      kind: 'question_resolved', questionId: question.id, status: ev.status, question,
      origin: Object.freeze({ kind: ev.resolvedBy.kind, id: ev.resolvedBy.id }),
      decisionOrigin: ev.decisionOrigin,
      decidedBy: ev.relay.decidedBy ? Object.freeze({ kind: ev.relay.decidedBy.kind, id: ev.relay.decidedBy.id }) : null,
      relayedVia: ev.relay.relayedVia,
    }),
  };
}

type Delivery = { ev: PluginQuestionEvent; identity: PluginRequestIdentity | null };

class PluginQuestionEventHub {
  private readonly handlers = new Map<PluginQuestionEventKind, Set<PluginQuestionEventHandler>>();
  private readonly queue: Delivery[] = [];
  private draining = false;
  private stopListening: (() => void) | null = null;

  constructor(private readonly pluginId: string, private readonly onEmpty: () => void) {}

  private readonly onBus = (bus: QuestionBusEvent): void => {
    const kind: PluginQuestionEventKind = bus.type === 'pending' ? 'question_pending' : 'question_resolved';
    if (!this.handlers.get(kind)?.size) return;
    let translated: ReturnType<typeof pluginQuestionEventFromBus>;
    try { translated = pluginQuestionEventFromBus(bus); } catch (err) {
      console.error(`[plugin:${this.pluginId}] question event translation failed:`, (err as Error).message);
      return;
    }
    if (!translated) return;
    const identity = todoEventAudience(this.pluginId, translated.ownerUserId);
    if (identity === undefined) return;
    this.queue.push({ ev: translated.ev, identity });
    if (!this.draining) { this.draining = true; setImmediate(() => { void this.drain(); }); }
  };

  subscribe(kind: PluginQuestionEventKind, handler: PluginQuestionEventHandler): () => void {
    let set = this.handlers.get(kind);
    if (!set) { set = new Set(); this.handlers.set(kind, set); }
    const entry: PluginQuestionEventHandler = (ev) => handler(ev);
    set.add(entry);
    this.stopListening ??= onQuestionEvent(this.onBus);
    return () => {
      set.delete(entry);
      if ([...this.handlers.values()].some((s) => s.size)) return;
      this.stopListening?.();
      this.stopListening = null;
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

const hubs = new Map<string, PluginQuestionEventHub>();

export function subscribePluginQuestionEvent(
  pluginId: string,
  kind: PluginQuestionEventKind,
  handler: PluginQuestionEventHandler,
): () => void {
  let hub = hubs.get(pluginId);
  if (!hub) {
    const created: PluginQuestionEventHub = new PluginQuestionEventHub(pluginId, () => { if (hubs.get(pluginId) === created) hubs.delete(pluginId); });
    hub = created;
    hubs.set(pluginId, hub);
  }
  return hub.subscribe(kind, handler);
}
