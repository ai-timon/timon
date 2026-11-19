/**
 * `relayedVia` on `ctx.questions.resolve` and `ctx.approvals.resolve`: a short
 * label of the channel or agent that carried a person's decision ("telegram",
 * "hermes"). It is journaled, so it must not be a secret and must not be able
 * to break a log line.
 */
import { redactText } from '../secrets/redact.js';

export const RELAYED_VIA_MAX = 80;

export type RelayedViaResult =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

export function parseRelayedVia(value: unknown): RelayedViaResult {
  if (value === undefined) return { ok: true, value: null };
  if (typeof value !== 'string') return { ok: false, message: '`relayedVia` must be a string' };
  const label = value.trim();
  if (!label) return { ok: true, value: null };
  if (label.length > RELAYED_VIA_MAX) {
    return { ok: false, message: `\`relayedVia\` must be at most ${RELAYED_VIA_MAX} characters` };
  }
  if (/[\u0000-\u001f\u007f]/.test(label)) {
    return { ok: false, message: '`relayedVia` must be a short label, without line breaks' };
  }
  // Reject rather than store a mask: a redacted label would no longer name the channel.
  if (redactText(label) !== label) return { ok: false, message: '`relayedVia` must not contain a secret' };
  return { ok: true, value: label };
}
