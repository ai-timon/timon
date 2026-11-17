/**
 * Lifecycle of the questions an agent asks the human (`question`, `kanban_plan`
 * — the `ask_user` cards of `permissions.ts`), for the readers that are not the
 * conversation: the plugin events `question_pending` / `question_resolved`.
 *
 * The mission transcript carries `permission_*` events whose payloads are not
 * enough to rebuild a card once it is gone (the resolved one has no questions),
 * and `event` bus kinds are never relayed to a plugin. `permissions.ts` hands
 * this emitter a SNAPSHOT of the card at the moment of the write instead, so a
 * subscriber sees exactly what that write saw — the same reason the TO DO and
 * document events are translated synchronously.
 */
import { EventEmitter } from 'node:events';
import type { DecisionRelay } from './decision-relay.js';
import type { DecisionOrigin } from './permissions.js';

export type QuestionKind = 'question' | 'series_plan';

/** The card as it was when the event happened. `input` is the `ask_user` payload. */
export type QuestionSnapshot = Readonly<{
  id: string;
  missionId: string;
  agent: string;
  kind: QuestionKind;
  input: unknown;
  createdAt: number;
  /** When an unattended mission will refuse it by itself; `null` = never. */
  expiresAt: number | null;
}>;

/** Who closed the card: `user` (account id when known), `plugin` (plugin id), `system`. */
export type QuestionActor = Readonly<{ kind: 'user' | 'plugin' | 'system' | 'unknown'; id: string | null }>;

export type QuestionBusEvent =
  | Readonly<{ type: 'pending'; question: QuestionSnapshot }>
  | Readonly<{
    type: 'resolved';
    question: QuestionSnapshot;
    /** `answered` (the form was sent), `cancelled` (denied or closed), `expired` (nobody answered in time, or nobody waits any more). */
    status: 'answered' | 'cancelled' | 'expired';
    decisionOrigin: DecisionOrigin;
    resolvedBy: QuestionActor;
    /** The account a plugin relayed, and the channel label. Both null when this close was not a relay. */
    relay: DecisionRelay;
  }>;

const emitter = new EventEmitter();
emitter.setMaxListeners(0);

export function emitQuestionEvent(ev: QuestionBusEvent): void {
  for (const listener of emitter.listeners('question') as Array<(ev: QuestionBusEvent) => void>) {
    // A subscriber that throws must not break the resolution of the card.
    try { listener(ev); } catch (err) { console.error('[questions] listener failed:', (err as Error).message); }
  }
}

export function onQuestionEvent(listener: (ev: QuestionBusEvent) => void): () => void {
  emitter.on('question', listener);
  return () => { emitter.off('question', listener); };
}
