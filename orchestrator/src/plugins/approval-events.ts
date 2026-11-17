/**
 * Approval events as a third-party plugin receives them (`ctx.events.on`):
 * `approval_pending` when an agent opens a tool-use card, and
 * `approval_resolved` when it closes — allowed, denied or expired.
 *
 * `permissions.ts` hands `approval-bus.ts` a snapshot at the moment of each
 * write; the translation below is built synchronously from it. The mission's
 * own `permission_*` events are never relayed. An `ask_user` form is a
 * question and never arrives here.
 *
 * Audience and delivery match the question events: the owner of the mission,
 * one card at a time, in order, inside that account's identity.
 */
import { dbApi } from '../db.js';
import { onApprovalEvent, type ApprovalBusEvent } from '../approval-bus.js';
import { runPluginRequest, type PluginRequestIdentity } from './als.js';
import { projectApproval } from './approvals-facade.js';
import { todoEventAudience } from './todo-events.js';

import type {
  PluginApprovalEventKind, PluginApprovalEvent, PluginApprovalEventHandler,
} from './contract/approvals.js';
import type { Assert, Equals } from '../type-equality.js';
export type {
  PluginApprovalEventKind, PluginApprovalActor, PluginApprovalPendingEvent, PluginApprovalResolvedEvent,
  PluginApprovalEvent, PluginApprovalEventMap, PluginApprovalEventHandler,
} from './contract/approvals.js';

export const PLUGIN_APPROVAL_EVENT_KINDS = Object.freeze(['approval_pending', 'approval_resolved'] as const);
/** `PluginApprovalEventKind` spells this list out in the public contract; compilation fails if they part. */
type _PluginApprovalEventKindsMatchContract = Assert<Equals<(typeof PLUGIN_APPROVAL_EVENT_KINDS)[number], PluginApprovalEventKind>>;

export function isPluginApprovalEventKind(kind: unknown): kind is PluginApprovalEventKind {
  return typeof kind === 'string' && (PLUGIN_APPROVAL_EVENT_KINDS as readonly string[]).includes(kind);
}

function actorOf(kind: string, id: string | null): PluginApprovalEvent['origin'] {
  return Object.freeze({ kind, id });
}

/** The plugin's translation of an approval write, with the account it belongs to. */
export function pluginApprovalEventFromBus(ev: ApprovalBusEvent): { ev: PluginApprovalEvent; ownerUserId: string | null } | null {
  const mission = dbApi.getMission(ev.approval.missionId);
  if (!mission) return null;
  const approval = projectApproval(ev.approval);
  if (ev.type === 'pending') {
    return {
      ownerUserId: mission.owner_user_id,
      ev: Object.freeze({
        kind: 'approval_pending', approvalId: approval.id, approval,
        origin: actorOf('agent', ev.approval.agent),
      }),
    };
  }
  return {
    ownerUserId: mission.owner_user_id,
    ev: Object.freeze({
      kind: 'approval_resolved', approvalId: approval.id, status: ev.status, approval,
      origin: actorOf(ev.resolvedBy.kind, ev.resolvedBy.id),
      decisionOrigin: ev.decisionOrigin,
      decidedBy: ev.relay.decidedBy ? actorOf(ev.relay.decidedBy.kind, ev.relay.decidedBy.id) : null,
      relayedVia: ev.relay.relayedVia,
    }),
  };
}

type Delivery = { ev: PluginApprovalEvent; identity: PluginRequestIdentity | null };

class PluginApprovalEventHub {
  private readonly handlers = new Map<PluginApprovalEventKind, Set<PluginApprovalEventHandler>>();
  private readonly queue: Delivery[] = [];
  private draining = false;
  private stopListening: (() => void) | null = null;

  constructor(private readonly pluginId: string, private readonly onEmpty: () => void) {}

  private readonly onBus = (bus: ApprovalBusEvent): void => {
    const kind: PluginApprovalEventKind = bus.type === 'pending' ? 'approval_pending' : 'approval_resolved';
    if (!this.handlers.get(kind)?.size) return;
    let translated: ReturnType<typeof pluginApprovalEventFromBus>;
    try { translated = pluginApprovalEventFromBus(bus); } catch (err) {
      console.error(`[plugin:${this.pluginId}] approval event translation failed:`, (err as Error).message);
      return;
    }
    if (!translated) return;
    const identity = todoEventAudience(this.pluginId, translated.ownerUserId);
    if (identity === undefined) return;
    this.queue.push({ ev: translated.ev, identity });
    if (!this.draining) { this.draining = true; setImmediate(() => { void this.drain(); }); }
  };

  subscribe(kind: PluginApprovalEventKind, handler: PluginApprovalEventHandler): () => void {
    let set = this.handlers.get(kind);
    if (!set) { set = new Set(); this.handlers.set(kind, set); }
    const entry: PluginApprovalEventHandler = (ev) => handler(ev);
    set.add(entry);
    this.stopListening ??= onApprovalEvent(this.onBus);
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

const hubs = new Map<string, PluginApprovalEventHub>();

export function subscribePluginApprovalEvent(
  pluginId: string,
  kind: PluginApprovalEventKind,
  handler: PluginApprovalEventHandler,
): () => void {
  let hub = hubs.get(pluginId);
  if (!hub) {
    const created: PluginApprovalEventHub = new PluginApprovalEventHub(pluginId, () => { if (hubs.get(pluginId) === created) hubs.delete(pluginId); });
    hub = created;
    hubs.set(pluginId, hub);
  }
  return hub.subscribe(kind, handler);
}
