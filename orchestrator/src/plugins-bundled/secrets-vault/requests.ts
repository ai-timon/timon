/**
 * `secret_request` — an agent asks its user for a secret it must never see
 * (docs/SECRETS-VAULT.md §9.5). The flow half: the card in the mission's
 * conversation, the user's answer, the message back to the agent, and the end
 * of the request (expiry, end of mission, boot sweep). The store half —
 * the binding and the lifetimes — is `secrets/requests.ts`.
 *
 * The value travels ONE road: the user's browser → `POST
 * /api/secrets/requests/:id/provide` (a session, never a token) → `createSecret`,
 * which seals it. It is in no event, no notification, no tool result, no
 * message to the agent and no log line: what the agent learns is
 * `{ name, status }`. The card's events carry the request (name, reason,
 * lifetime, hosts or page origin), never an answer.
 *
 * An unattended mission (Kanban task, sub-mission, routine) gets no card at all:
 * a human who is not there cannot type anything, and a request that waits for
 * them would stall the mission for nothing. Same rule as `question`
 * (`userQuestionRefusal`), same referent.
 */
import { daemonMessage } from '../../daemon-message.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { isAutonomousMission } from '../../agent.js';
import { bus } from '../../bus.js';
import { db, dbApi, type MissionRow } from '../../db.js';
import { deliverLate } from '../../late-delivery.js';
import { createNotification } from '../../notifications.js';
import { questionReferent } from '../../permissions.js';
import { parseBrokerSpec, VALUE_PLACEHOLDER } from '../../secrets/broker-spec.js';
import { SECRET_NAME_RE } from '../../secrets/resolve.js';
import {
  attachRequestedSecret,
  canonicalRequestOrigin,
  eraseRequestedSecret,
  findPendingSecretRequest,
  getSecretRequest,
  insertSecretRequest,
  listMissionSecretRequests,
  listOpenSecretRequests,
  REQUESTED_CREDENTIAL_PREFIX,
  SECRET_REQUEST_LIFETIMES,
  settleSecretRequest,
  type SecretRequestLifetime,
  type SecretRequestRow,
  type SecretRequestStatus,
} from '../../secrets/requests.js';
import { createSecret, SecretStoreError } from '../../secrets/store.js';
import { proposalOrigin } from '../terminal-web/command-requests.js';

export const SECRET_REQUEST_EVENT = 'secret_request';
export const SECRET_REQUEST_RESOLVED_EVENT = 'secret_request_resolved';

/** How long a card waits for the user. Long enough for a coffee, short enough that a forgotten card does not stay a door. */
export const SECRET_REQUEST_TTL_MS = 30 * 60_000;

/** Bounds of a typed value: a key, a password, a code — not a file. */
export const MAX_SECRET_VALUE_CHARS = 16_384;

const DEFAULT_HEADER = 'Authorization';
const DEFAULT_TEMPLATE = `Bearer ${VALUE_PLACEHOLDER}`;

export const RequestBody = z.object({
  name: z.string().max(128).regex(SECRET_NAME_RE, 'name must match ^[A-Z][A-Z0-9_]*$'),
  reason: z.string().trim().min(1).max(200),
  lifetime: z.enum(SECRET_REQUEST_LIFETIMES),
  /** Where the broker may send it. Absent: the value is for the mission's environment. */
  hosts: z.array(z.string().trim().toLowerCase().min(1).max(253)).min(1).max(10).optional(),
  header: z.string().min(1).max(64).optional(),
  template: z.string().min(1).max(200).optional(),
  /** The page it may be filled into (`fill_credential`). Absent with `hosts` absent: the environment. */
  origin: z.string().trim().min(1).max(2048).optional(),
}).strict().refine((b) => b.hosts !== undefined || (b.header === undefined && b.template === undefined), {
  message: 'header and template only make sense with hosts',
}).refine((b) => b.hosts === undefined || b.origin === undefined, {
  message: 'a value goes either to hosts (API calls) or to an origin (a browser page), not both',
});

/** What the browser sends. Nothing else: an extra field is refused, never ignored. */
export const ProvideBody = z.object({
  value: z.string().min(1).max(MAX_SECRET_VALUE_CHARS),
}).strict();

/** The request as the card, the events and the routes show it. Never a value. */
export type SecretRequestView = {
  id: string;
  missionId: string;
  agent: string;
  name: string;
  reason: string;
  lifetime: SecretRequestLifetime;
  /** Hosts the broker may send it to; null = a page origin or the mission's environment. */
  hosts: string[] | null;
  header: string | null;
  /** The exact page origin a browser fill may put it in; null = hosts or the environment. */
  origin: string | null;
  project: string | null;
  missionTitle: string;
  status: SecretRequestStatus;
  createdAt: number;
  expiresAt: number;
  resolvedAt: number | null;
};

export function secretRequestView(row: SecretRequestRow): SecretRequestView {
  let hosts: string[] | null = null;
  let header: string | null = null;
  if (row.broker_spec) {
    try {
      const spec = parseBrokerSpec(row.broker_spec);
      hosts = spec.hosts;
      header = spec.type === 'http' ? spec.inject.name : null;
    } catch { /* validated at the request: an unreadable spec only loses its display */ }
  }
  return {
    id: row.id,
    missionId: row.mission_id,
    agent: row.agent,
    name: row.name,
    reason: row.reason,
    lifetime: row.lifetime,
    hosts,
    header,
    origin: row.browser_origin,
    project: row.project,
    missionTitle: row.mission_title,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
  };
}

function publish(missionId: string, type: string, payload: object): void {
  const row = dbApi.insertEvent(missionId, type, payload);
  bus.publish({ kind: 'event', missionId, type, timestamp: row.timestamp, payload });
}

/** How the agent uses what it was given: by reference, never by value. */
function usageHint(row: SecretRequestRow): string {
  if (row.broker_spec) {
    return `Use it by reference: \`timon_http_call\` with identity \`${row.name}\` — the daemon injects it, you never see it.`;
  }
  if (row.browser_origin) {
    return `Use it in the built-in browser: open the login or code form on ${row.browser_origin}, then \`fill_credential\` `
      + `with credentialId \`${REQUESTED_CREDENTIAL_PREFIX}${row.id}\` (also listed by \`list_credentials\`) fills its password or one-time-code field; `
      + 'fill the username yourself, and submit the form yourself. Never read the field back: the page holds the value from then on.';
  }
  return `It enters the environment of your next launch as \`$${row.name}\` (not of the process running now). `
    + 'Never print it: anything you run can read it, and only `timon_http_call` really hides a value.';
}

/** What the agent reads once the request is settled: the name and the outcome, never the value. */
export function secretRequestReply(row: SecretRequestRow): string {
  const status = row.status === 'provided' ? 'provided' : 'refused';
  const head = `[secret request] ${JSON.stringify({ name: row.name, status })}`;
  if (row.status === 'provided') return `${head} ${usageHint(row)}`;
  if (row.status === 'expired') return `${head} The request expired without an answer. Do not ask again unless the user asks you to.`;
  return `${head} The user refused. Do not ask for it again: carry on without it, or ask the user what to do.`;
}

export const PENDING_SECRET_REPLY =
  'The request is shown as a card in this conversation, with a masked field. You will NEVER see the value: '
  + 'a message `[secret request] {"name": …, "status": "provided" | "refused"}` comes back once the user answered. '
  + 'Do not ask again and do not ask the user to paste it in the chat. Carry on, or end your turn.';

/**
 * Why no card opens on this mission. The value cannot go to the referent either:
 * an agent that relayed it would hold it.
 */
export function unattendedSecretRefusal(mission: MissionRow, name: string): string {
  const referent = questionReferent(mission, mission.id);
  const next = referent
    ? `Ask ${referent} (\`agent_send_message\`, kind: request) to have the user deposit \`${name}\` on the Secrets page `
      + 'and open it to you — never to send you the value itself.'
    : `Name \`${name}\` in your final report (or block your task with that reason) so the user deposits it on the Secrets page.`;
  return 'This mission runs unattended: nobody is there to type a secret, so `secret_request` refuses instead of waiting. ' + next;
}

export type RaiseOutcome = { status: number; body: Record<string, unknown> };

/**
 * `POST /api/secrets/requests`, past the auth: checks the request and the
 * mission, then puts the card in the conversation. Never waits: the answer
 * comes back to the agent as a message.
 */
export function raiseSecretRequest(missionId: string, rawBody: unknown, now = Date.now()): RaiseOutcome {
  const parsed = RequestBody.safeParse(rawBody ?? {});
  if (!parsed.success) {
    return { status: 400, body: { error: 'invalid_request', message: parsed.error.issues[0]?.message ?? 'invalid body' } };
  }
  const input = parsed.data;
  let brokerSpec: string | null = null;
  let browserOrigin: string | null = null;
  if (input.origin !== undefined) {
    browserOrigin = canonicalRequestOrigin(input.origin);
    if (!browserOrigin) {
      return { status: 400, body: { error: 'invalid_request', message: 'origin must be an http(s) origin without userinfo, like https://app.example.com' } };
    }
  }
  if (input.hosts) {
    const spec = {
      type: 'http' as const,
      hosts: input.hosts,
      inject: { kind: 'header' as const, name: input.header ?? DEFAULT_HEADER, template: input.template ?? DEFAULT_TEMPLATE },
    };
    try {
      parseBrokerSpec(JSON.stringify(spec));
    } catch (e) {
      return { status: 400, body: { error: 'invalid_request', message: (e as Error).message } };
    }
    brokerSpec = JSON.stringify(spec);
  }
  const mission = dbApi.getMission(missionId);
  const owner = mission?.owner_user_id ? dbApi.getUserById(mission.owner_user_id) : undefined;
  if (!mission || !owner || owner.status !== 'active') {
    return { status: 409, body: { error: 'no_owner', status: 'refused', message: 'this mission has no owner account to ask' } };
  }
  if (isAutonomousMission(mission)) {
    return { status: 409, body: { error: 'unattended', status: 'refused', name: input.name, message: unattendedSecretRefusal(mission, input.name) } };
  }
  // A persistent value becomes an ordinary secret: like `secret_create`, it never
  // replaces nor shadows a name the vault already holds. Said now, not after
  // the user typed it.
  if (input.lifetime === 'persistent' && dbApi.getSecretsByName(input.name).length > 0) {
    return {
      status: 409,
      body: { error: 'duplicate', status: 'refused', name: input.name, message: `a secret named ${input.name} already exists: use it through its grant, or ask for another name` },
    };
  }
  const already = findPendingSecretRequest(mission.id, input.name);
  if (already) {
    return { status: 202, body: { id: already.id, status: 'pending', name: already.name, message: PENDING_SECRET_REPLY } };
  }
  const origin = proposalOrigin(mission);
  const row = insertSecretRequest({
    id: randomUUID(),
    mission_id: mission.id,
    owner_user_id: owner.id,
    agent: mission.agent_name,
    name: input.name,
    reason: input.reason,
    lifetime: input.lifetime,
    broker_spec: brokerSpec,
    browser_origin: browserOrigin,
    project: origin.project,
    mission_title: origin.missionTitle,
    created_at: now,
    expires_at: now + SECRET_REQUEST_TTL_MS,
  });
  publish(mission.id, SECRET_REQUEST_EVENT, secretRequestView(row));
  createNotification({
    type: 'action_required',
    urgent: true,
    title: `Secret requested: ${row.agent}`,
    message: daemonMessage('secret_requested', { agent: row.agent }),
    body: `${row.mission_title}${row.project ? ` (${row.project})` : ''} — ${row.name}. ${row.reason}`,
    missionId: mission.id,
    taskId: mission.task_id,
    anchor: row.id,
    ownerUserId: owner.id,
    expiresAt: row.expires_at,
  });
  return { status: 202, body: { id: row.id, status: 'pending', name: row.name, message: PENDING_SECRET_REPLY } };
}

export type Deliver = (missionId: string, text: string) => void;

/** Closes the card (event, notification) and tells the agent. */
function settled(row: SecretRequestRow, deliver: Deliver): void {
  publish(row.mission_id, SECRET_REQUEST_RESOLVED_EVENT, { id: row.id, status: row.status, resolvedAt: row.resolved_at });
  deliver(row.mission_id, secretRequestReply(row));
}

/** Thrown inside the provide transaction to roll it back: another answer got there first. */
class AlreadyDecided extends Error {}

export type AnswerOutcome =
  | { ok: true; request: SecretRequestView }
  | { ok: false; status: number; error: string; message?: string };

const NOT_FOUND: AnswerOutcome = { ok: false, status: 404, error: 'not_found' };

/** The request `userId` may answer: theirs, still pending, not expired. Another owner's card answers like a missing one. */
function answerable(id: string, userId: string, now: number, deliver: Deliver): SecretRequestRow | AnswerOutcome {
  const row = getSecretRequest(id);
  if (!row || row.owner_user_id !== userId) return NOT_FOUND;
  if (row.status !== 'pending') return { ok: false, status: 409, error: 'already_decided' };
  const mission = dbApi.getMission(row.mission_id);
  if (row.expires_at <= now || mission?.status !== 'running') {
    expireSecretRequest(row, now, deliver);
    return { ok: false, status: 410, error: 'expired' };
  }
  return row;
}

/**
 * The user typed the value. Sealed by `createSecret` under a fresh row with no
 * grant, bound to the mission by the request. The settle comes first, in the
 * same transaction: two clicks never create two secrets, and a vault that
 * cannot seal leaves the card pending.
 */
export function provideSecretRequest(id: string, userId: string, value: string, deliver: Deliver = deliverLate, now = Date.now()): AnswerOutcome {
  const row = answerable(id, userId, now, deliver);
  if (!('id' in row)) return row;
  if (row.lifetime === 'persistent' && dbApi.getSecretsByName(row.name).length > 0) {
    return { ok: false, status: 409, error: 'duplicate', message: `a secret named ${row.name} already exists` };
  }
  let secretId: string;
  try {
    secretId = db.transaction(() => {
      if (!settleSecretRequest(row.id, 'provided', null, now)) throw new AlreadyDecided();
      const secret = createSecret({
        name: row.name,
        value,
        mode: row.broker_spec ? 'broker' : 'inject',
        broker_spec: row.broker_spec ?? undefined,
        note: `${row.reason} — requested by ${row.agent} (mission ${row.mission_id}), lifetime ${row.lifetime}`,
      });
      attachRequestedSecret(row.id, secret.id);
      return secret.id;
    })();
  } catch (e) {
    if (e instanceof AlreadyDecided) return { ok: false, status: 409, error: 'already_decided' };
    const code = e instanceof SecretStoreError ? e.code : 'unknown';
    // The code only: a library error built from the input could carry the value.
    console.warn(`[secrets] requested ${row.name} not stored (${code})`);
    return { ok: false, status: code === 'unavailable' ? 503 : 400, error: 'not_stored' };
  }
  dbApi.recordSecretAccess({
    secret_id: secretId,
    name: row.name,
    mission_id: row.mission_id,
    agent: row.agent,
    kind: 'request',
    outcome: 'ok',
    detail: `provided by user ${userId}, lifetime ${row.lifetime}`,
    at: now,
  });
  const done = getSecretRequest(row.id)!;
  settled(done, deliver);
  return { ok: true, request: secretRequestView(done) };
}

export function refuseSecretRequest(id: string, userId: string, deliver: Deliver = deliverLate, now = Date.now()): AnswerOutcome {
  const row = answerable(id, userId, now, deliver);
  if (!('id' in row)) return row;
  if (!settleSecretRequest(row.id, 'refused', null, now)) return { ok: false, status: 409, error: 'already_decided' };
  const done = getSecretRequest(row.id)!;
  settled(done, deliver);
  return { ok: true, request: secretRequestView(done) };
}

/** A card nobody answered in time, or whose mission is over: closed, and the agent told if it still listens. */
export function expireSecretRequest(row: SecretRequestRow, now = Date.now(), deliver: Deliver = deliverLate): void {
  if (!settleSecretRequest(row.id, 'expired', null, now)) return;
  settled(getSecretRequest(row.id)!, deliver);
}

/**
 * The mission ended: its waiting cards close, and the values that were only
 * lent to it (`once` not yet used, `mission`) are destroyed. A `persistent`
 * value stays, daemon-only, for a human to open on the Secrets page.
 */
export function endSecretRequestsOfMission(missionId: string, now = Date.now(), deliver: Deliver = deliverLate): void {
  for (const row of listMissionSecretRequests(missionId)) {
    if (row.status === 'pending') expireSecretRequest(row, now, deliver);
    else if (row.status === 'provided' && row.lifetime !== 'persistent') eraseRequestedSecret(row, 'mission over', now);
  }
}

/**
 * At boot and on a timer: a card past its expiry closes; a lent value whose
 * mission no longer runs (the daemon died with it) is destroyed, and so is a
 * `once` value already spent whose erase failed. Never throws:
 * a sweep that fails must not stop the vault from mounting.
 */
export function sweepSecretRequests(now = Date.now(), deliver: Deliver = deliverLate): void {
  try {
    for (const row of listOpenSecretRequests()) {
      const running = dbApi.getMission(row.mission_id)?.status === 'running';
      if (row.status === 'pending') {
        if (!running || row.expires_at <= now) expireSecretRequest(row, now, deliver);
      } else if (row.spent_at !== null) {
        eraseRequestedSecret(row, 'used once (erase replayed)', now);
      } else if (!running) {
        eraseRequestedSecret(row, 'mission over', now);
      }
    }
  } catch (e) {
    console.warn(`[secrets] request sweep failed: ${(e as Error).message}`);
  }
}
