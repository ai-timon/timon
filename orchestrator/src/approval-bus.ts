/**
 * Lifecycle of the tool-use approvals an agent waits on (Allow / Deny cards),
 * for the readers that are not the conversation: the plugin events
 * `approval_pending` / `approval_resolved`.
 *
 * Same reason as `question-bus.ts`: the mission's `permission_*` events are
 * not relayed to a plugin, and their resolved payload cannot rebuild the card.
 * `permissions.ts` hands this emitter a snapshot at the moment of the write.
 * `ask_user` forms are questions, not approvals, and never arrive here.
 */
import { EventEmitter } from 'node:events';
import type { DecisionRelay } from './decision-relay.js';
import type { DecisionOrigin } from './permissions.js';
import type { QuestionActor } from './question-bus.js';

/** The card as it was when the event happened. `input` is still the agent's. */
export type ApprovalSnapshot = Readonly<{
  id: string;
  missionId: string;
  agent: string;
  tool: string;
  input: unknown;
  createdAt: number;
  expiresAt: number | null;
}>;

export type ApprovalBusEvent =
  | Readonly<{ type: 'pending'; approval: ApprovalSnapshot }>
  | Readonly<{
    type: 'resolved';
    approval: ApprovalSnapshot;
    /** `allowed`, `denied` (including a paste, which the agent receives as a deny) or `expired`. */
    status: 'allowed' | 'denied' | 'expired';
    decisionOrigin: DecisionOrigin;
    resolvedBy: QuestionActor;
    relay: DecisionRelay;
  }>;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function emitApprovalEvent(ev: ApprovalBusEvent): void {
  for (const listener of emitter.listeners('approval') as Array<(ev: ApprovalBusEvent) => void>) {
    // A subscriber that throws must not break the resolution of the card.
    try { listener(ev); } catch (err) { console.error('[approvals] listener failed:', (err as Error).message); }
  }
}

export function onApprovalEvent(listener: (ev: ApprovalBusEvent) => void): () => void {
  emitter.on('approval', listener);
  return () => { emitter.off('approval', listener); };
}
