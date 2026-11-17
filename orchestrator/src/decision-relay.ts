/**
 * Who decided when a plugin closes a card inside a person's request, and the
 * channel that carried the decision. `decidedBy` is that account even when
 * the caller gave no channel, so a forgotten label does not lose the human.
 * `relayedVia` is null when no label was given. A click, an expiry and a job
 * with no account in front of it leave `decidedBy` null; a job may still
 * name a channel.
 *
 * Recorded next to `resolved_by` (the plugin) so the journal can say
 * "decided by account X, relayed by plugin P via Y" without putting a secret
 * in the label: `relayedVia` is checked before it is stored.
 */
export type DecisionRelay = Readonly<{
  decidedBy: Readonly<{ kind: 'user'; id: string }> | null;
  relayedVia: string | null;
}>;

export const NO_RELAY: DecisionRelay = Object.freeze({ decidedBy: null, relayedVia: null });
