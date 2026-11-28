/**
 * An agent asks its owner to decide on a command it cannot run itself.
 *
 * The agent never writes to a shell. Its request becomes a card in its
 * mission's conversation (`command-requests.ts`); the owner allows it (the
 * daemon runs it, outside the mission's fence, and the agent reads the result), pastes it (their browser types it into the project's
 * terminal WITHOUT the final Enter, through their own WebSocket) or refuses
 * it. Every route a browser calls here is the owner's alone, from a human
 * browser session: the web terminal's rule (`access.ts`) holds for the cards
 * that lead to it.
 */
import type { Request, Response, Router } from 'express';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isAutonomousMission, missionPermissionModel } from '../../agent.js';
import type { PermissionModel } from '../../backends/types.js';
import { dbApi, type MissionRow, type UserRow } from '../../db.js';
import { auditRequest } from '../../users/audit-actor.js';
import { forbidden, isPersonAuth } from '../../users/identity.js';
import type { RunDeps } from './run-context.js';
import { decideAccess, denialBody, denialStatus } from './access.js';
import {
  COMMAND_DECISIONS,
  commandReply,
  commandRequestView,
  createCommandRequest,
  expectLateAnswer,
  isSingleLineCommand,
  MAX_COMMAND_CHARS,
  offeredChoices,
  ownerCanPaste,
  PENDING_REPLY,
  proposalOrigin,
  type RequestOrigin,
  runReportOf,
  resolveCommandRequest,
  UNATTENDED_REPLY,
  waitForDecision,
} from './command-requests.js';
import { apiError } from '../../api-error.js';

export { isSingleLineCommand, MAX_COMMAND_CHARS, proposalOrigin };

const ProposalBody = z.object({
  command: z.string().max(MAX_COMMAND_CHARS).refine(isSingleLineCommand, 'single line, no control characters'),
  note: z.string().max(300).optional(),
  session_id: z.string().regex(/^[0-9a-f-]{36}$/i).optional(),
}).strict();

const RequestId = z.string().regex(/^[0-9a-f-]{36}$/i);

const ResolveBody = z.object({
  decision: z.enum(COMMAND_DECISIONS),
  /** Which button, in which view: kept in the event for a later diagnosis. */
  origin: z.string().regex(/^[a-z_]{1,40}$/).optional(),
}).strict();

const ListQuery = z.object({
  mission_id: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
  status: z.enum(['pending', ...COMMAND_DECISIONS]).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
}).strict();

/**
 * How long the agent's call waits for the answer before it is told the
 * decision will come as a message. Under every caller's own limit: codex cuts
 * an MCP tool call at 60 s (`tool_timeout_sec`), and the timon MCP server's
 * `fetch` gives up after 300 s; claude has neither, so it waits longer.
 */
export function defaultProposalWaitMs(model: PermissionModel | null): number {
  return model === 'mcp-bridge' ? 240_000 : 45_000;
}

export type ProposalRouteOptions = {
  waitMs?: (model: PermissionModel | null) => number;
  /** Tests stand in for a live mission's backend, and for the agent a late answer goes to. */
  permissionModel?: (missionId: string) => PermissionModel | null;
  deliverLate?: (missionId: string, text: string) => void;
  /** Tests stand in for the shell the daemon runs an allowed command with. */
  run?: RunDeps;
};

/** The owner's browser, or an answer already sent. */
function browserUser(req: Request, res: Response): UserRow | null {
  const auth = req.auth;
  if (!auth) { res.status(401).json({ error: 'unauthorized' }); return null; }
  if (!isPersonAuth(auth) || !auth.user) {
    res.status(403).json(apiError('command_request_session_required', 'a command request is answered from a browser session'));
    return null;
  }
  return auth.user;
}

/**
 * What `raiseCommandRequest` hands back: a refusal to send as is, or the card
 * that now waits in the conversation.
 */
export type RaisedCommand =
  | { reply: { status: number; body: unknown } }
  | { id: string; mission: MissionRow; model: PermissionModel | null; choices: ReturnType<typeof commandRequestView>['choices'] };

/**
 * `POST /api/terminal/web/proposals`, up to the card: checks the request and
 * the owner, then puts the command in the mission's conversation. Waiting for
 * the answer is the route's business; a plugin facade never waits.
 */
export function raiseCommandRequest(
  missionId: string,
  rawBody: unknown,
  audit: (action: string, target: string | null) => void,
  permissionModel: (missionId: string) => PermissionModel | null,
  origin?: RequestOrigin,
): RaisedCommand {
  const parsed = ProposalBody.safeParse(rawBody ?? {});
  if (!parsed.success) {
    return { reply: { status: 400, body: { error: 'invalid_request', message: 'expected { command: single line, note?, session_id? }' } } };
  }
  const mission = dbApi.getMission(missionId);
  const owner = mission?.owner_user_id ? dbApi.getUserById(mission.owner_user_id) : undefined;
  if (!mission || !owner) {
    return { reply: { status: 409, body: { error: 'no_owner', message: 'this mission has no owner account to show the command to' } } };
  }
  if (!ownerCanPaste(mission)) {
    return { reply: { status: 403, body: { error: 'terminal_unavailable', message: 'the owner cannot open a web terminal' } } };
  }
  const id = randomUUID();
  const model = permissionModel(mission.id);
  const created = createCommandRequest({
    id, mission, owner,
    command: parsed.data.command,
    note: parsed.data.note ?? null,
    sessionId: parsed.data.session_id?.toLowerCase() ?? null,
    origin,
  });
  // The text itself stays out of the audit trail: it may quote a secret.
  audit('terminal.propose', id);
  return { id, mission, model, choices: commandRequestView(created).choices };
}

export function registerProposalRoute(app: Router, opts: ProposalRouteOptions = {}): void {
  const waitMs = opts.waitMs ?? defaultProposalWaitMs;
  const permissionModel = opts.permissionModel ?? missionPermissionModel;

  app.post('/api/terminal/web/proposals', async (req, res) => {
    const auth = req.auth;
    // Only an agent, through its own mission's token. Neither a browser nor the
    // daemon token: the first has the terminal itself, the second is not a mission.
    if (!auth) { res.status(401).json({ error: 'unauthorized' }); return; }
    if (auth.kind !== 'api-token' || !auth.missionId) {
      forbidden(req, res, { kind: 'scope', reason: 'only an agent mission can propose a command', hint: 'Run the command yourself; a command request is raised by an agent from its own mission.' });
      return;
    }
    const raised = raiseCommandRequest(auth.missionId, req.body, (action, target) => auditRequest(req, action, target), permissionModel);
    if ('reply' in raised) { res.status(raised.reply.status).json(raised.reply.body); return; }
    const { id, mission, model, choices } = raised;
    if (isAutonomousMission(mission)) {
      // Not waited for, not forgotten either: a decision taken while the mission runs reaches it.
      expectLateAnswer(id);
      res.status(202).json({ id, status: 'pending', choices, message: UNATTENDED_REPLY });
      return;
    }
    req.setTimeout(0);
    res.setTimeout(0);
    // The agent's call gone (MCP timeout, process death): the answer goes out as a message.
    const gone = new AbortController();
    res.on('close', () => gone.abort());
    const decided = await waitForDecision(id, waitMs(model), gone.signal);
    if (res.writableEnded || res.destroyed) return;
    if (!decided || decided.status === 'pending') {
      res.status(202).json({ id, status: 'pending', choices, message: PENDING_REPLY });
      return;
    }
    res.json({ id, status: decided.status, choices, message: commandReply(decided.status, decided.command, runReportOf(decided)) });
  });

  // The caller's requests, for one conversation or the whole account.
  app.get('/api/terminal/web/proposals', (req, res) => {
    const user = browserUser(req, res);
    if (!user) return;
    const q = ListQuery.safeParse(req.query);
    if (!q.success) { res.status(400).json(apiError('invalid_request', 'invalid_request')); return; }
    const rows = dbApi.listCommandRequests({
      ownerUserId: user.id, missionId: q.data.mission_id, status: q.data.status, limit: q.data.limit,
    });
    res.json({ requests: rows.map((row) => commandRequestView(row, offeredChoices(row))) });
  });

  // The per-project badge: the caller's pending requests, by project slug.
  app.get('/api/terminal/web/proposals/pending', (req, res) => {
    const user = browserUser(req, res);
    if (!user) return;
    const projects = dbApi.countPendingCommandRequests(user.id).map((r) => ({ project: r.project, pending: r.n }));
    res.json({ total: projects.reduce((sum, p) => sum + p.pending, 0), projects });
  });

  app.post('/api/terminal/web/proposals/:id/resolve', (req, res) => {
    const user = browserUser(req, res);
    if (!user) return;
    const id = RequestId.safeParse(req.params.id);
    const body = ResolveBody.safeParse(req.body ?? {});
    if (!id.success || !body.success) {
      res.status(400).json(apiError('command_request_invalid', 'expected { decision: "allow" | "paste" | "deny", origin? }'));
      return;
    }
    // Another owner's card answers like a missing one: its existence is not the caller's to learn.
    const row = dbApi.getCommandRequest(id.data.toLowerCase());
    if (!row || row.owner_user_id !== user.id) {
      res.status(404).json(apiError('not_found', 'not_found'));
      return;
    }
    if (body.data.decision !== 'deny') {
      // Pasting opens the owner's terminal and allowing runs a command as the daemon's user:
      // the terminal's own rule, checked again now.
      const access = decideAccess(req.auth);
      if ('denied' in access) { res.status(denialStatus(access.denied)).json(denialBody(access.denied)); return; }
    }
    const outcome = resolveCommandRequest(row.id, body.data.decision, body.data.origin ?? 'unknown', {
      deliver: opts.deliverLate, run: opts.run,
    });
    if (!outcome.ok) {
      if (outcome.error === 'already_decided') res.status(409).json(apiError('command_request_decided', 'this command request was already answered'));
      else if (outcome.error === 'not_offered') res.status(400).json(apiError('command_request_not_offered', 'this choice is not offered for this command'));
      else res.status(404).json(apiError('not_found', 'not_found'));
      return;
    }
    auditRequest(req, `terminal.request.${body.data.decision}`, row.id);
    // The run is not waited for: the card follows it through its events.
    res.json({ ok: true, request: commandRequestView(outcome.row) });
  });
}
