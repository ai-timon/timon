/**
 * Layout proposals: a screen arrangement an agent asks its owner to apply.
 *
 * The maintainer's rule (14/10/2026): an agent never changes the screen by itself. Its
 * proposal becomes a card in its mission's conversation — "Apply this
 * arrangement", with a schematic preview — modelled on `terminal_propose`'s
 * command requests. The owner's browser applies it with the very model the
 * drag uses, then tells the daemon; the agent hears the decision as a message
 * once its turn is over (`late-delivery.ts`).
 *
 * Amendment (15/10/2026): while the owner runs a guided tour for a mission
 * (`navigate-routes.ts`, a grant only their browser can create), that mission's
 * navigation opens at once, without a card. Layout changes always need the card.
 *
 * One mechanism for every kind of arrangement: `widgets` (cards and chat
 * columns, `widget-routes.ts`) today, island layouts next. A kind brings its
 * own schema and its own revalidation; the card, the events, the notification
 * and the decision are shared.
 *
 * Every route a browser calls here is the owner's alone, from a browser
 * session. A proposal of another account answers like a missing one.
 */
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { bus } from '../../bus.js';
import { db, dbApi, type CardOriginKind, type LayoutProposalRow, type LayoutProposalStatus, type MissionRow, type UserRow } from '../../db.js';
import { deliverLate } from '../../late-delivery.js';
import { createNotification } from '../../notifications.js';
import { daemonMessage } from '../../daemon-message.js';
import { auditRequest } from '../../users/audit-actor.js';
import { proposalOrigin } from '../terminal-web/command-requests.js';
import type { ProposalProblem } from './widget-model.js';
import { isPersonAuth } from '../../users/identity.js';
import { apiError } from '../../api-error.js';

export const LAYOUT_PROPOSAL_EVENT = 'layout_proposal';
export const LAYOUT_PROPOSAL_RESOLVED_EVENT = 'layout_proposal_resolved';
export const PROPOSAL_DECISIONS = ['applied', 'dismissed'] as const;
export type ProposalDecision = (typeof PROPOSAL_DECISIONS)[number];

/** A kind of arrangement: what it is called, and how a stored payload is checked again. */
export type ProposalKind = {
  /** Shown in the notification: "Arrangement to review: …". */
  label: string;
  /**
   * The payload against what the owner may see NOW. A grant withdrawn between
   * the proposal and the click must not be applied on the strength of the
   * first check.
   */
  revalidate: (payload: unknown, owner: UserRow, req: Request) => ProposalProblem[];
  /**
   * A kind the DAEMON applies (a trigger), not the browser. Runs inside the
   * transaction that claims the proposal: a problem returned, or a throw, rolls
   * the claim back and the proposal stays pending. `after` runs once committed
   * (events), `detail` goes to the agent with the decision.
   */
  applyOnServer?: (row: LayoutProposalRow, payload: unknown, req: Request)
    => { problems: ProposalProblem[] } | { detail: string; after?: () => void };
  /** What the agent reads once decided; the screen wording otherwise. */
  reply?: (status: LayoutProposalStatus, detail: string | null) => string;
  /** Prefix of the delivered message; `[layout proposal]` otherwise. */
  prefix?: string;
};

const KINDS = new Map<string, ProposalKind>();

export function registerProposalKind(kind: string, handler: ProposalKind): void {
  KINDS.set(kind, handler);
}

/** The proposal as the card and the agent see it, in the events and the routes alike. */
export type LayoutProposalView = {
  id: string;
  kind: string;
  missionId: string;
  agent: string;
  payload: unknown;
  note: string | null;
  project: string | null;
  missionTitle: string;
  taskId: string | null;
  /** `agent` unless a plugin raised it. */
  origin: { kind: CardOriginKind; id: string | null };
  status: LayoutProposalStatus;
  createdAt: number;
  resolvedAt: number | null;
};

export function layoutProposalView(row: LayoutProposalRow): LayoutProposalView {
  let payload: unknown = null;
  try { payload = JSON.parse(row.payload) as unknown; } catch { payload = null; }
  return {
    id: row.id,
    kind: row.kind,
    missionId: row.mission_id,
    agent: row.agent,
    payload,
    note: row.note,
    project: row.project,
    missionTitle: row.mission_title,
    taskId: row.task_id,
    origin: { kind: row.origin_kind, id: row.origin_id },
    status: row.status,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  };
}

/**
 * Who raises a card when it is not the mission's agent: a third-party plugin
 * (`ctx.layout`, `ctx.chat`). Its card shows the plugin as the proposer
 * (`plugin:<id>` in the `agent` column) and its decision is never delivered to the
 * mission's agent, who proposed nothing.
 */
export type ProposalOrigin = { kind: 'plugin'; id: string };

/** What a route answers, kept apart from `res` so a plugin facade can reuse the very same logic. */
export type Reply = { status: number; body: unknown };
/** The audit row of the caller: a request writes its own, a plugin facade its own. */
export type AuditFn = (action: string, target: string | null) => void;

/** What the agent reads right after proposing: the answer is not waited for. */
export const PROPOSAL_PENDING_REPLY =
  'The arrangement is shown as a card in this conversation; the user applies or ignores it. '
  + 'Do not propose it again: their decision comes back to you as a message. Carry on, or end your turn.';

/** What the agent reads once the owner decided. */
export function proposalReply(status: LayoutProposalStatus, label: string): string {
  if (status === 'applied') return `The user applied your ${label}: it is on their screen now.`;
  if (status === 'dismissed') {
    return `The user ignored your ${label}. Do not propose it again unless they ask for another one.`;
  }
  return PROPOSAL_PENDING_REPLY;
}

function publish(missionId: string, type: string, payload: object): void {
  const row = dbApi.insertEvent(missionId, type, payload);
  bus.publish({ kind: 'event', missionId, type, timestamp: row.timestamp, payload });
}

/** Records the proposal, puts its card in the conversation and notifies the owner. */
export function createLayoutProposal(input: {
  id: string;
  kind: string;
  mission: MissionRow;
  owner: UserRow;
  payload: unknown;
  note?: string | null;
  /** Absent: the mission's agent raised it. */
  origin?: ProposalOrigin;
}): LayoutProposalRow {
  const { mission, owner } = input;
  const origin = proposalOrigin(mission);
  const row = dbApi.insertLayoutProposal({
    id: input.id,
    kind: input.kind,
    mission_id: mission.id,
    owner_user_id: owner.id,
    agent: input.origin ? `plugin:${input.origin.id}` : mission.agent_name,
    payload: JSON.stringify(input.payload),
    origin_kind: input.origin ? 'plugin' : 'agent',
    origin_id: input.origin?.id ?? null,
    note: input.note ?? null,
    project: origin.project,
    mission_title: origin.missionTitle,
    task_id: origin.taskId,
  });
  publish(mission.id, LAYOUT_PROPOSAL_EVENT, layoutProposalView(row));
  const label = KINDS.get(input.kind)?.label ?? 'arrangement';
  createNotification({
    type: 'action_required',
    urgent: false,
    title: `${label[0]!.toUpperCase()}${label.slice(1)} to review: ${row.agent}`,
    body: `${row.mission_title}${row.project ? ` (${row.project})` : ''}${row.note ? ` — ${row.note}` : ''}`,
    // Every kind is registered by a bundled plugin: the webview words it by its id
    // (`none` stands for an absent project or note, as the message's select reads it).
    message: daemonMessage('layout_proposal_to_review', {
      kind: input.kind.replace(/-/g, '_'), agent: row.agent,
      mission: row.mission_title, project: row.project || 'none', note: row.note || 'none',
    }),
    missionId: mission.id,
    taskId: row.task_id,
    // The card's id: the notification is dismissed with it, and deep-links to it.
    anchor: row.id,
    ownerUserId: owner.id,
  });
  return row;
}

export type ProposalResolveOutcome =
  | { ok: true; row: LayoutProposalRow }
  | { ok: false; error: 'not_found' | 'already_decided' };

/** Settles a pending proposal and tells the agent. Who may call it: the route. */
export function resolveLayoutProposal(
  id: string,
  decision: ProposalDecision,
  origin: string,
  deliver: (missionId: string, text: string) => void = deliverLate,
  detail: string | null = null,
): ProposalResolveOutcome {
  const before = dbApi.getLayoutProposal(id);
  if (!before) return { ok: false, error: 'not_found' };
  if (!dbApi.settleLayoutProposal(id, decision)) return { ok: false, error: 'already_decided' };
  return { ok: true, row: announceDecision(id, origin, deliver, detail) };
}

/** Once settled: the card's event, and the agent's answer. */
function announceDecision(
  id: string, origin: string, deliver: (missionId: string, text: string) => void, detail: string | null,
): LayoutProposalRow {
  const row = dbApi.getLayoutProposal(id)!;
  publish(row.mission_id, LAYOUT_PROPOSAL_RESOLVED_EVENT, {
    id, status: row.status, origin, resolvedAt: row.resolved_at,
  });
  const kind = KINDS.get(row.kind);
  const text = kind?.reply ? kind.reply(row.status, detail) : proposalReply(row.status, kind?.label ?? 'arrangement');
  // The agent proposed nothing when a plugin did: the answer is the plugin's to read (`ctx.layout.proposals`).
  if (row.origin_kind === 'agent') deliver(row.mission_id, `${kind?.prefix ?? '[layout proposal]'} ${text}`);
  return row;
}

export type ProposalDecideOutcome =
  | ProposalResolveOutcome
  | { ok: true; row: LayoutProposalRow; detail: string }
  | { ok: false; error: 'stale'; problems: ProposalProblem[] };

class ApplyRefused extends Error {
  constructor(readonly problems: ProposalProblem[]) { super('apply refused'); }
}

/**
 * Settles a proposal for a caller already allowed to (the route checks who).
 * A kind applied by the daemon is claimed and applied in ONE transaction: two
 * clicks never apply it twice, and a refused apply leaves it pending.
 */
export function decideLayoutProposal(
  row: LayoutProposalRow,
  decision: ProposalDecision,
  req: Request,
  origin: string,
  deliver: (missionId: string, text: string) => void = deliverLate,
): ProposalDecideOutcome {
  const kind = KINDS.get(row.kind);
  if (decision !== 'applied' || !kind?.applyOnServer) return resolveLayoutProposal(row.id, decision, origin, deliver);
  const apply = kind.applyOnServer;
  let applied: { detail: string; after?: () => void };
  try {
    applied = db.transaction(() => {
      if (!dbApi.settleLayoutProposal(row.id, 'applied')) throw new ApplyRefused([]);
      const result = apply(row, layoutProposalView(row).payload, req);
      if ('problems' in result) throw new ApplyRefused(result.problems);
      return result;
    })();
  } catch (err) {
    if (!(err instanceof ApplyRefused)) throw err;
    if (!err.problems.length) return { ok: false, error: dbApi.getLayoutProposal(row.id) ? 'already_decided' : 'not_found' };
    return { ok: false, error: 'stale', problems: err.problems };
  }
  applied.after?.();
  return { ok: true, row: announceDecision(row.id, origin, deliver, applied.detail), detail: applied.detail };
}

const ProposalId = z.string().regex(/^[0-9a-f-]{36}$/i);

const ResolveBody = z.object({
  decision: z.enum(PROPOSAL_DECISIONS),
  /** Which button, in which view: kept in the event for a later diagnosis. */
  origin: z.string().regex(/^[a-z_]{1,40}$/).optional(),
}).strict();

const ListQuery = z.object({
  mission_id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
  status: z.enum(['pending', ...PROPOSAL_DECISIONS]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();

/** The owner's browser, or an answer already sent. */
function browserUser(req: Request, res: Response): UserRow | null {
  const auth = req.auth;
  if (!auth) { res.status(401).json({ error: 'unauthorized' }); return null; }
  if (!isPersonAuth(auth) || !auth.user) {
    res.status(403).json({ error: 'session_required', message: 'a layout proposal is answered from a browser session' });
    return null;
  }
  return auth.user;
}

export type ProposalRouteOptions = {
  /** Tests stand in for the agent a decision goes to. */
  deliver?: (missionId: string, text: string) => void;
};

export function registerLayoutProposalRoutes(app: Router, opts: ProposalRouteOptions = {}): void {
  // The caller's proposals, for one conversation or the whole account.
  app.get('/api/layout/proposals', (req, res) => {
    const user = browserUser(req, res);
    if (!user) return;
    const q = ListQuery.safeParse(req.query);
    if (!q.success) { res.status(400).json(apiError('invalid_request', 'invalid_request')); return; }
    const rows = dbApi.listLayoutProposals({
      ownerUserId: user.id, missionId: q.data.mission_id, status: q.data.status, limit: q.data.limit,
    });
    res.json({ proposals: rows.map(layoutProposalView) });
  });

  /**
   * The browser claims the proposal BEFORE writing the rows: two tabs clicking
   * Apply together must not open the same new column tab twice. `applied` is
   * checked again against the owner's grants of now.
   */
  app.post('/api/layout/proposals/:id/resolve', (req, res) => {
    const user = browserUser(req, res);
    if (!user) return;
    const id = ProposalId.safeParse(req.params.id);
    const body = ResolveBody.safeParse(req.body ?? {});
    if (!id.success || !body.success) {
      res.status(400).json({ error: 'invalid_request', message: 'expected { decision: "applied" | "dismissed", origin? }' });
      return;
    }
    const row = dbApi.getLayoutProposal(id.data.toLowerCase());
    if (!row || row.owner_user_id !== user.id) {
      res.status(404).json(apiError('not_found', 'not_found'));
      return;
    }
    if (body.data.decision === 'applied' && row.status === 'pending') {
      const kind = KINDS.get(row.kind);
      const problems = kind ? kind.revalidate(layoutProposalView(row).payload, user, req) : [{ code: 'unknown_kind', message: row.kind }];
      if (problems.length) {
        res.status(409).json({ error: 'stale', problems });
        return;
      }
    }
    const outcome = decideLayoutProposal(row, body.data.decision, req, body.data.origin ?? 'unknown', opts.deliver);
    if (!outcome.ok) {
      if (outcome.error === 'stale') { res.status(409).json({ error: 'stale', problems: outcome.problems }); return; }
      res.status(outcome.error === 'already_decided' ? 409 : 404).json({ error: outcome.error });
      return;
    }
    auditRequest(req, `layout.proposal.${body.data.decision}`, row.id);
    res.json({ ok: true, proposal: layoutProposalView(outcome.row) });
  });
}
