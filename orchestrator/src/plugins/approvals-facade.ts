/**
 * `ctx.approvals` (API 18): the tool-use cards (Allow / Deny) that wait for a
 * person, as the CALLER sees them. Bounded like `ctx.questions`: in a request,
 * that account's missions; in a job, the missions owned by `plugin:<id>`. A
 * card outside that view answers as one that does not exist. An `ask_user`
 * form is a question, not an approval.
 *
 * `resolve` goes through `resolvePermission`, the function a click calls, so
 * the card closes and the agent resumes the same way. The plugin cannot change
 * the input and cannot widen the allow: both stay with the card the person saw.
 * What the plugin reads is a projection, never the raw payload.
 */
import { getAgent } from '../agent.js';
import { type DbViewer } from '../db.js';
import { type DecisionRelay } from '../decision-relay.js';
import {
  DENY_REASONS, getPending, listPending, approvalSnapshot, resolvePermission,
} from '../permissions.js';
import type { ApprovalSnapshot } from '../approval-bus.js';
import { redactDeep, redactText } from '../secrets/redact.js';
import { scopedDb } from '../users/scoped-db.js';
import { parseRelayedVia } from './relayed-via.js';

import type {
  PluginApproval, PluginApprovalDecision, PluginApprovalListFilter, PluginApprovalResolution,
  PluginApprovalErrorCode,
} from './contract/approvals.js';
export type {
  PluginApproval, PluginApprovalActor, PluginApprovalDecision, PluginApprovalErrorCode,
  PluginApprovalListFilter, PluginApprovalResolution,
} from './contract/approvals.js';

export class PluginApprovalError extends Error {
  constructor(readonly code: PluginApprovalErrorCode, message: string = code) {
    super(message);
    this.name = 'PluginApprovalError';
  }
}

export type ScopedApprovals = {
  list(filter?: PluginApprovalListFilter): PluginApproval[];
  get(id: string): PluginApproval | undefined;
  resolve(id: string, decision: PluginApprovalDecision): PluginApprovalResolution;
};

export type ApprovalCallerScope = {
  pluginId: string;
  viewer: DbViewer | null;
  /** Account of the request, when this call relays a person's decision. */
  decidedByUserId: string | null;
};

const STRING_MAX = 400;
const DEPTH_MAX = 4;
const KEYS_MAX = 30;
const ARRAY_MAX = 20;
const JSON_MAX = 4_000;
const MESSAGE_MAX = 500;
/** A field whose value is a credential, whatever the tool called it. The name stays; the value does not. */
const SECRET_KEY = /password|passwd|secret|token|api[_-]?key|authorization|credential|private[_-]?key/i;

function bound(value: unknown, depth: number): unknown {
  if (value === null) return null;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const redacted = redactText(value);
    return redacted.length > STRING_MAX ? `${redacted.slice(0, STRING_MAX)}...` : redacted;
  }
  if (depth >= DEPTH_MAX) return '...';
  if (Array.isArray(value)) {
    const items = value.slice(0, ARRAY_MAX).map((item) => bound(item, depth + 1));
    if (value.length > ARRAY_MAX) items.push(`... ${value.length - ARRAY_MAX} more`);
    return items;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return '...';
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    const out: Record<string, unknown> = {};
    for (const key of keys.slice(0, KEYS_MAX)) {
      const safeKey = redactText(key).slice(0, 80);
      out[safeKey] = SECRET_KEY.test(key) ? '***' : bound(record[key], depth + 1);
    }
    if (keys.length > KEYS_MAX) out['...'] = `${keys.length - KEYS_MAX} more keys`;
    return out;
  }
  return null;
}

/** The tool input a plugin may see: bounded, vault values masked, credential fields replaced. */
export function projectApprovalInput(input: unknown): unknown {
  const bounded = redactDeep(bound(input, 0));
  const json = JSON.stringify(bounded);
  if (json !== undefined && json.length > JSON_MAX) return { truncated: true };
  return bounded;
}

/** The card as a plugin reads it. */
export function projectApproval(card: ApprovalSnapshot): PluginApproval {
  return Object.freeze({
    id: card.id,
    missionId: card.missionId,
    agent: card.agent,
    tool: card.tool,
    input: projectApprovalInput(card.input),
    createdAt: card.createdAt,
    expiresAt: card.expiresAt,
  });
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function denyMessage(value: unknown): string {
  if (value === undefined) return DENY_REASONS.userDenied;
  if (typeof value !== 'string') throw new PluginApprovalError('invalid', '`message` must be a string');
  const trimmed = value.trim();
  if (!trimmed) return DENY_REASONS.userDenied;
  const cut = trimmed.length > MESSAGE_MAX ? `${trimmed.slice(0, MESSAGE_MAX)}...` : trimmed;
  return redactText(cut);
}

export function approvalsFor(scope: ApprovalCallerScope): ScopedApprovals {
  const { pluginId, viewer, decidedByUserId } = scope;
  const visible = (card: ApprovalSnapshot): boolean => !!scopedDb(viewer).getMission(card.missionId);
  const open = (id: unknown): ApprovalSnapshot | undefined => {
    if (typeof id !== 'string') return undefined;
    const pending = getPending(id);
    const card = pending && approvalSnapshot(pending);
    return card && visible(card) ? card : undefined;
  };
  const relayOf = (label: string | null): DecisionRelay => ({
    decidedBy: decidedByUserId ? { kind: 'user', id: decidedByUserId } : null,
    relayedVia: label,
  });

  return {
    list(filter = {}) {
      const limit = Math.max(1, Math.min(500, Math.floor(filter.limit ?? 100)));
      if (filter.tool !== undefined && typeof filter.tool !== 'string') throw new PluginApprovalError('invalid', '`tool` must be a string');
      if (filter.project !== undefined && typeof filter.project !== 'string') throw new PluginApprovalError('invalid', '`project` must be a string');
      const out: PluginApproval[] = [];
      for (const pending of listPending()) {
        const card = approvalSnapshot(pending);
        if (!card || !visible(card)) continue;
        if (filter.tool !== undefined && card.tool !== filter.tool) continue;
        if (filter.project !== undefined && getAgent(card.agent)?.project !== filter.project) continue;
        out.push(projectApproval(card));
      }
      return out.sort((a, b) => a.createdAt - b.createdAt).slice(0, limit);
    },
    get(id) {
      const card = open(id);
      return card ? projectApproval(card) : undefined;
    },
    resolve(id, decision) {
      const card = open(id);
      if (!card) throw new PluginApprovalError('not_found', 'approval not found (already resolved or expired)');
      const raw: unknown = decision;
      if (!isRecord(raw)) throw new PluginApprovalError('invalid', 'the decision must be an object');
      const extra = Object.keys(raw).find((key) => key !== 'behavior' && key !== 'message' && key !== 'relayedVia');
      if (extra) throw new PluginApprovalError('invalid', `unknown field \`${extra.slice(0, 40)}\``);
      if (raw.behavior !== 'allow' && raw.behavior !== 'deny') {
        throw new PluginApprovalError('invalid', "`behavior` must be 'allow' or 'deny'");
      }
      if (raw.behavior === 'allow' && raw.message !== undefined) {
        throw new PluginApprovalError('invalid', '`message` is only accepted when denying');
      }
      const relayed = parseRelayedVia(raw.relayedVia);
      if (!relayed.ok) throw new PluginApprovalError('invalid', relayed.message);
      const answer = raw.behavior === 'allow'
        ? { behavior: 'allow' as const }
        : { behavior: 'deny' as const, message: denyMessage(raw.message) };
      const ok = resolvePermission(card.id, answer, 'plugin', { kind: 'plugin', id: pluginId }, relayOf(relayed.value));
      if (!ok) throw new PluginApprovalError('not_found', 'approval not found (already resolved or expired)');
      return Object.freeze({ id: card.id, status: raw.behavior === 'allow' ? 'allowed' : 'denied' });
    },
  };
}
