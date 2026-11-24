/**
 * Management API of native triggers. Every route requires an identity AND the
 * `triggers:manage` permission — a trigger runs actions unattended, so even
 * the first-run open API does not reach it anonymously.
 *
 *   GET    /api/triggers[?source=]           list (own; superadmin: all)
 *   POST   /api/triggers                     create → secret shown ONCE
 *   GET    /api/triggers/:id                 read (never the secret)
 *   PATCH  /api/triggers/:id                 update
 *   DELETE /api/triggers/:id                 delete
 *   POST   /api/triggers/:id/secret          rotate → new secret shown once
 *   POST   /api/triggers/:id/outbound-secret rotate the secret that signs its `webhook`
 *                                            actions → shown once (also born, and shown
 *                                            once, when a first `webhook` action is saved)
 *   POST   /api/triggers/:id/test            dry run by default, `execute` to run
 *   POST   /api/triggers/:id/approve-script  fingerprint its scripts again (a person only);
 *                                            every trigger answer carries `script_approval`
 *   GET    /api/triggers/:id/deliveries      call journal
 *
 * What a trigger may do is frozen in its `grants` when it is saved: the
 * caller's own action permissions. An agent (mission token) editing a trigger
 * can only narrow them, never widen — not even on a trigger an admin made.
 *
 * `triggers:manage` alone never borrows a trigger's rights: running one by
 * hand (`/test` with `execute`) or taking over its webhook (`/secret`) needs
 * the caller to hold every action itself, delegation list included.
 *
 * A trigger runs on after the mission that made it, and after its token is
 * revoked: what an agent sets up never runs before a person switched it on
 * (TODO #529). An agent's trigger is born off; an agent cannot switch one
 * on, and changing what an enabled one does switches it off. A person
 * switching one on stamps `approved_at`; the plugin's boot switches off the
 * agent's triggers that run without it — those made before #529 (TODO #572).
 *
 * A script runs files from a project folder, where missions write: a person's
 * save fingerprints what each script runs (`script_pins`), every run checks it
 * again and refuses a file changed since. Only a person re-approves.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Request, Response, Router } from 'express';
import { z } from 'zod';
import { canonicalAgentName, loadConfig } from '../../agent-config.js';
import { automationOriginOf, emitAutomationEvent } from '../../plugins/automation-events.js';
import { dbApi, type LayoutProposalRow, type LayoutProposalStatus } from '../../db.js';
import {
  createLayoutProposal, decideLayoutProposal, layoutProposalView, registerProposalKind,
} from '../settings/layout-proposals.js';
import { delegatingAgent, delegationRefusal, UNKNOWN_CALLER } from '../../delegation-guard.js';
import { agentDir } from '../../paths.js';
import { PLUGIN_OWNER_PREFIX } from '../../users/api-tokens.js';
import { requestHasPermission, viewerFromRequest, forbidden } from '../../users/identity.js';
import { auditRequest } from '../../users/audit-actor.js';
import { rejectOverride, spawnWideningDenied } from '../../users/privileged-overrides.js';
import { routineTaskExtras } from '../../routines.js';
import { scopedDb } from '../../users/scoped-db.js';
import { ACTION_UNAVAILABLE, actionProvider, grantsAllow } from '../../triggers/actions.js';
import { nextScheduleAt } from '../../triggers/engine.js';
import { webhookUrlRefusal } from '../../triggers/outbound.js';
import {
  ACTION_PERMISSION, TRIGGER_SOURCES, actionSchema, providedSecretSchema, scheduleCadenceProblem, testTriggerSchema,
  triggerDefinitionSchema, updateTriggerSchema, type TriggerAction, type TriggerDefinition, type TriggerSource,
} from '../../triggers/schema.js';
import { pinScripts, scriptApprovalState, scriptCwd } from '../../triggers/script-run.js';
import { generateSecret } from '../../triggers/signature.js';
import { runTriggerTest } from '../../triggers/test-run.js';
import {
  deleteTrigger, getScriptPins, getTriggerRow, insertTrigger, listDeliveries, listTriggerRows, parseTrigger,
  setScriptPins, setTriggerOutboundSecret, setTriggerSecret, updateTriggerRow, type ScriptPin, type TriggerRow,
} from '../../triggers/store.js';
import { unauthenticatedHooksPossible } from '../../triggers/webhook.js';
import { apiError, type ApiErrorBody } from '../../api-error.js';

export const TRIGGERS_PERMISSION = 'triggers:manage';

const ACTION_PERMISSIONS = [...new Set(Object.values(ACTION_PERMISSION))];

function manager(req: Request, res: Response): boolean {
  if (!req.auth) { res.status(401).json({ error: 'unauthorized' }); return false; }
  if (!requestHasPermission(req, TRIGGERS_PERMISSION)) { forbidden(req, res, { kind: 'permission', permission: TRIGGERS_PERMISSION }); return false; }
  return true;
}

/** Mission tokens are agents. Read from the credential, never from a header. */
function callerIsAgent(req: Request): boolean {
  return req.auth?.kind === 'api-token';
}

function callerGrants(req: Request): string[] {
  if (req.auth?.isSuperadmin && !callerIsAgent(req)) return ['*'];
  return ACTION_PERMISSIONS.filter((permission) => requestHasPermission(req, permission));
}

function visible(req: Request, row: TriggerRow): boolean {
  if (req.auth?.isSuperadmin) return true;
  const me = req.auth?.user?.id ?? null;
  return me !== null && row.owner_user_id === me;
}

function paramId(req: Request): string {
  const value: unknown = req.params.id;
  return typeof value === 'string' ? value : '';
}

function loadVisible(req: Request, res: Response): TriggerRow | null {
  const row = getTriggerRow(paramId(req));
  if (!row || !visible(req, row)) { res.status(404).json(apiError('not_found', 'not found')); return null; }
  return row;
}

function safeJson(text: string | null): unknown {
  if (text === null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Read live from the files at every answer: a script rewritten since its
 * approval shows as `changed` before its next run is refused. An action the
 * schema no longer reads counts for nothing here; the run refuses it anyway.
 */
function scriptApprovalOf(row: TriggerRow) {
  const raw = safeJson(row.actions);
  if (!Array.isArray(raw)) return null;
  const actions = raw.flatMap((action: unknown) => {
    const parsed = actionSchema.safeParse(action);
    return parsed.success ? [parsed.data] : [];
  });
  if (!actions.some((action) => action.type === 'script')) return null;
  return scriptApprovalState(actions, getScriptPins(row.id));
}

/** Everything but the secret. */
export function publicTrigger(row: TriggerRow) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    source: row.source,
    enabled: row.enabled === 1,
    config: safeJson(row.config),
    filter: safeJson(row.filter),
    actions: safeJson(row.actions),
    owner_user_id: row.owner_user_id,
    created_by: row.created_by,
    creator_agent: row.creator_agent,
    acting_agent: row.acting_agent,
    grants: safeJson(row.grants),
    has_secret: row.secret !== null,
    has_outbound_secret: (row.outbound_secret ?? null) !== null,
    url: row.source === 'webhook' && row.slug ? `/api/triggers/hooks/${row.slug}` : null,
    /** `approved` | `unapproved` | `changed` for a trigger that runs a script, else null. */
    script_approval: scriptApprovalOf(row),
    last_run_at: row.last_run_at,
    next_run_at: row.next_run_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function zodMessage(error: z.ZodError): string {
  return error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ');
}

type Refusal = { status: number; body: ApiErrorBody };

/**
 * A script runs arbitrary code on the host, unattended: never something an
 * agent sets up, edits or fires by itself, whatever its token holds (a
 * developer-owner mission carries every permission). The user does it.
 */
const SCRIPT_AGENT_REFUSAL = 'an agent cannot change or run a script action: ask the user '
  + '(Triggers page, or `timon trigger …` in their terminal)';

/** What an agent reads when its trigger is waiting for the user. */
export const AGENT_TRIGGER_OFF = 'Saved switched off: a trigger an agent sets up only runs once the user switches it on '
  + '(Triggers page). Tell the user it is waiting for them; do not create it again.';
const AGENT_CANNOT_ENABLE = 'an agent cannot switch a trigger on: the user does it (Triggers page)';

/**
 * What a trigger does, key order aside — everything but its name and its
 * switch. Both sides parsed by the same schemas, so a rename compares equal.
 */
function behaviourOf(t: { source: TriggerSource; slug: string | null; config: unknown; filter?: unknown; actions: readonly TriggerAction[] }): string {
  return canonical({ source: t.source, slug: t.slug, config: t.config, filter: t.source === 'schedule' ? null : t.filter ?? null, actions: t.actions });
}

/**
 * An agent's trigger with a script is not created: it becomes a card the user
 * approves (`trigger_create` answers 202). Approving creates it as the user's,
 * with the user's grants; the agent learns the outcome as a message.
 */
export const TRIGGER_PROPOSAL_KIND = 'trigger';
const PROPOSAL_PENDING = 'A trigger running a script needs the user\'s approval: it is shown as a card in this conversation '
  + '(and in `timon trigger proposals`). Nothing is created yet. Do not propose it again: their decision comes back to you '
  + 'as a message. Carry on, or end your turn.';

function proposalReplyText(status: LayoutProposalStatus, detail: string | null): string {
  if (status === 'applied') return `The user approved your trigger: it is created (trigger ${detail ?? 'id unknown'}) and runs on its own. Do not create it again.`;
  if (status === 'dismissed') return 'The user rejected your trigger. Do not propose it again unless they ask for it.';
  return PROPOSAL_PENDING;
}

/**
 * The agent the caller acts as, stored on the trigger to bound its task
 * actions at every run. A mission token whose mission is gone is refused
 * rather than stored as nobody (which would mean "a human").
 */
function actingAgentOf(req: Request): { agent: string | null } | Refusal {
  const agent = delegatingAgent(req);
  if (agent === UNKNOWN_CALLER) return { status: 403, body: apiError('trigger_mission_unknown', 'this mission is unknown') };
  return { agent };
}

/**
 * Can THIS caller do what the actions do, right now? Checked before any
 * effect a caller can set off by hand, whatever grants the trigger holds.
 * Delegation first, like `createTaskFromBody`: a refused caller learns
 * nothing from the other checks.
 */
function callerMayRun(req: Request, actions: readonly TriggerAction[]): Refusal | null {
  const mine = callerGrants(req);
  for (const action of actions) {
    if (action.type === 'script' && callerIsAgent(req)) return { status: 403, body: apiError('trigger_script_agent_refused', SCRIPT_AGENT_REFUSAL) };
    if (action.type === 'task') {
      const denied = delegationRefusal(req, action.agent);
      if (denied) return { status: 403, body: apiError('orchestration_denied', `task refused: ${denied}`, { detail: denied }) };
    }
    if (!grantsAllow(mine, ACTION_PERMISSION[action.type])) {
      return {
        status: 403,
        body: apiError('trigger_action_not_permitted', `not permitted: ${action.type} needs ${ACTION_PERMISSION[action.type]}`,
          { action: action.type, permission: ACTION_PERMISSION[action.type] }),
      };
    }
  }
  return null;
}

/** Key order aside: a stored action and the same one sent back by a PATCH. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
    : v));
}

/** Same workflow and entry node: what a PATCH may keep without Workflows answering for it. */
function sameWorkflowTarget(a: TriggerAction, b: TriggerAction): boolean {
  return a.type === 'workflow' && b.type === 'workflow' && a.workflow === b.workflow && a.node === b.node;
}

/**
 * The once-a-minute floor of a schedule, on what this write sets. `row`: the
 * trigger being edited. A schedule kept as it was and left as it was (on or
 * off) is not re-checked: a row saved before the floor must still be renamable
 * and switchable off — but not switched back on.
 */
function cadenceRefusal(def: TriggerDefinition, row: TriggerRow | null): Refusal | null {
  if (def.source !== 'schedule') return null;
  if (row) {
    const kept = (safeJson(row.config) as { cron?: unknown; tz?: unknown } | null) ?? {};
    const reconfigured = kept.cron !== def.config.cron || kept.tz !== def.config.tz;
    const switchedOn = row.enabled !== 1 && def.enabled !== false;
    if (!reconfigured && !switchedOn) return null;
  }
  const problem = scheduleCadenceProblem(def.config.cron, def.config.tz);
  return problem ? { status: 400, body: apiError('trigger_cadence_refused', problem, { detail: problem }) } : null;
}

/**
 * Checks a definition can be saved by this caller, with these grants.
 * `stored`: the actions already saved. A workflow action kept as it was is
 * not re-validated by Workflows — with Workflows off, or the workflow since
 * unpublished, the trigger must still be renamable and switchable off. Its
 * grants are still checked, and every run re-checks it in full.
 */
function refusal(
  req: Request, def: TriggerDefinition, actions: readonly TriggerAction[], grants: readonly string[] | null,
  listensOnLoopback: () => boolean, stored: readonly TriggerAction[] = [],
): Refusal | null {
  for (const action of actions) {
    if (action.type === 'script' && callerIsAgent(req)) return { status: 403, body: apiError('trigger_script_agent_refused', SCRIPT_AGENT_REFUSAL) };
    if (action.type === 'task') {
      const denied = delegationRefusal(req, action.agent);
      if (denied) return { status: 403, body: apiError('orchestration_denied', `task refused: ${denied}`, { detail: denied }) };
    }
    if (!grantsAllow(grants, ACTION_PERMISSION[action.type])) {
      return {
        status: 403,
        body: apiError('trigger_action_not_permitted', `not permitted: ${action.type} needs ${ACTION_PERMISSION[action.type]}`,
          { action: action.type, permission: ACTION_PERMISSION[action.type] }),
      };
    }
    // A script kept as it was is not re-checked: a project folder gone must not
    // stop the trigger from being renamed or switched off. Every run re-checks it.
    if (action.type === 'script' && !stored.some((old) => canonical(old) === canonical(action))) {
      const place = scriptCwd(action.cwd);
      if ('error' in place) return { status: 400, body: apiError('trigger_script_cwd_refused', place.error, { detail: place.error }) };
    }
    if (action.type === 'task' && !existsSync(agentDir(canonicalAgentName(action.agent)))) {
      return { status: 400, body: apiError('unknown_agent', `unknown agent: ${action.agent}`, { agent: action.agent }) };
    }
    // Kept as it was, like a script: an older row must stay renamable; every delivery re-checks it.
    if (action.type === 'webhook' && !stored.some((old) => canonical(old) === canonical(action))) {
      const refused = webhookUrlRefusal(action.url);
      if (refused) return { status: 400, body: apiError('trigger_webhook_url_refused', refused, { detail: refused }) };
    }
    if (action.type === 'workflow' && !stored.some((old) => sameWorkflowTarget(old, action))) {
      // Offered only while Workflows runs; the workflow must be the caller's.
      const provider = actionProvider('workflow');
      if (!provider) return { status: 400, body: apiError('trigger_workflows_unavailable', ACTION_UNAVAILABLE) };
      const denied = provider.check(action, {
        ownerUserId: req.auth?.user?.id ?? null,
        seesAll: (grants ?? []).includes('*'),
      });
      if (denied) return { status: 400, body: apiError('trigger_workflow_refused', denied, { detail: denied }) };
    }
  }
  if (def.source === 'webhook' && def.config.auth === 'none' && actions.some((action) => action.type === 'script')) {
    // Any local process — an agent's mission included — could run it by posting.
    return { status: 400, body: apiError('trigger_script_needs_auth', 'a script action needs an authenticated webhook') };
  }
  if (def.source === 'webhook' && def.config.auth === 'none') {
    // No secret = no proof of origin: never something an agent decides, and
    // never on a daemon reachable from another machine.
    if (callerIsAgent(req)) return { status: 403, body: apiError('trigger_unauthenticated_by_agent', 'an agent cannot create an unauthenticated webhook') };
    if (!listensOnLoopback()) return { status: 400, body: apiError('trigger_unauthenticated_not_loopback', 'auth "none" is only allowed while the daemon listens on loopback, not behind a proxy') };
  }
  return null;
}

type CreateAs = {
  ownerUserId: string | null;
  createdBy: 'user' | 'agent';
  creatorAgent: string | null;
  actingAgent: string | null;
  grants: string[];
};

/** Writes a definition already checked; the outbound secret is born here when a `webhook` action needs one. */
function insertDefinition(
  def: TriggerDefinition, secret: string | null, as: CreateAs, pins: readonly ScriptPin[] = [],
): { row: TriggerRow; outboundSecret: string | null } {
  let row = insertTrigger({
    name: def.name,
    slug: def.source === 'webhook' ? def.slug : null,
    source: def.source,
    enabled: def.enabled !== false,
    config: def.config,
    filter: def.source === 'schedule' ? null : def.filter ?? null,
    actions: def.actions,
    secret,
    ...as,
    nextRunAt: nextRunFor(def),
  });
  if (pins.length) {
    setScriptPins(row.id, pins);
    row = getTriggerRow(row.id)!;
  }
  const outboundSecret = sendsWebhooks(def.actions) ? generateSecret('standard') : null;
  if (outboundSecret) {
    setTriggerOutboundSecret(row.id, outboundSecret);
    row = getTriggerRow(row.id)!;
  }
  return { row, outboundSecret };
}

/**
 * An agent's definition holding a script: checked as if the agent created it
 * (every other action must be one it could create itself, so the approval lifts
 * the script restriction and nothing else), then raised as a card. Never a
 * webhook source: its secret is shown once, never on a chat card.
 */
function proposeTrigger(req: Request, def: TriggerDefinition, note: string | null): { status: number; body: unknown } {
  if (def.source === 'webhook') {
    return { status: 403, body: apiError('trigger_proposal_webhook_refused', 'an agent cannot propose a webhook that runs a script: ask the user to create it') };
  }
  const missionId = req.auth?.missionId;
  const mission = missionId ? scopedDb(viewerFromRequest(req)).getMission(missionId) : undefined;
  const owner = req.auth?.user ?? null;
  if (!mission || !owner) return { status: 403, body: apiError('trigger_mission_unknown', 'this mission is unknown') };
  const others = def.actions.filter((action) => action.type !== 'script');
  const refused = refusal(req, def, others, callerGrants(req), () => true);
  if (refused) return refused;
  for (const action of def.actions) {
    if (action.type !== 'script') continue;
    const place = scriptCwd(action.cwd);
    if ('error' in place) return { status: 400, body: apiError('trigger_script_cwd_refused', place.error, { detail: place.error }) };
  }
  const row = createLayoutProposal({
    id: randomUUID(), kind: TRIGGER_PROPOSAL_KIND, mission, owner, payload: def, note,
  });
  return { status: 202, body: { status: 'pending', proposal_id: row.id, message: PROPOSAL_PENDING } };
}

/**
 * The approval itself, inside the transaction that claims the proposal. The
 * approver must be a person holding what the trigger does, `scripts:run`
 * included; the trigger is the proposal owner's, whoever approves.
 */
function approveTrigger(row: LayoutProposalRow, payload: unknown, req: Request) {
  const problem = (code: string, message: string) => ({ problems: [{ code, message }] });
  if (!req.auth || callerIsAgent(req)) return problem('forbidden', 'an agent cannot approve a trigger');
  const parsed = triggerDefinitionSchema.safeParse(payload);
  if (!parsed.success) return problem('invalid_payload', zodMessage(parsed.error));
  const def = parsed.data;
  const grants = callerGrants(req);
  const refused = cadenceRefusal(def, null) ?? refusal(req, def, def.actions, grants, () => true);
  if (refused) return problem(refused.status === 403 ? 'forbidden' : 'invalid', refused.body.error);
  // The person approving vouches for the files as they are at this moment.
  const pinned = pinScripts(def.actions);
  if ('error' in pinned) return problem('invalid', pinned.error);
  const { row: trigger } = insertDefinition(def, null, {
    ownerUserId: row.owner_user_id, createdBy: 'user', creatorAgent: row.agent, actingAgent: null, grants,
  }, pinned.pins);
  return {
    detail: trigger.id,
    after: () => emitAutomationEvent({ kind: 'trigger_created', row: trigger, origin: automationOriginOf(req) }),
  };
}

function sendsWebhooks(actions: readonly TriggerAction[]): boolean {
  return actions.some((action) => action.type === 'webhook');
}

function slugTaken(slug: string, exceptId: string | null): boolean {
  const row = listTriggerRows({ source: 'webhook' }).find((r) => r.slug === slug);
  return !!row && row.id !== exceptId;
}

function definitionOf(row: TriggerRow): Record<string, unknown> {
  return {
    source: row.source, name: row.name, enabled: row.enabled === 1,
    config: safeJson(row.config), actions: safeJson(row.actions),
    ...(row.source === 'webhook' ? { slug: row.slug } : {}),
    ...(row.source !== 'schedule' ? { filter: safeJson(row.filter) } : {}),
  };
}

function nextRunFor(def: TriggerDefinition, now: number = Date.now()): number | null {
  return def.source === 'schedule' && def.enabled !== false ? nextScheduleAt(def.config, now) : null;
}

export function registerRoutes(app: Router, options: { listensOnLoopback?: () => boolean } = {}): void {
  const listensOnLoopback = options.listensOnLoopback ?? unauthenticatedHooksPossible;
  registerProposalKind(TRIGGER_PROPOSAL_KIND, {
    label: 'trigger',
    // Everything is checked again, as the approver, inside the claim.
    revalidate: () => [],
    applyOnServer: approveTrigger,
    reply: proposalReplyText,
    prefix: '[trigger proposal]',
  });
  app.get('/api/triggers', (req, res) => {
    if (!manager(req, res)) return;
    const raw = req.query.source;
    const source = typeof raw === 'string' && (TRIGGER_SOURCES as readonly string[]).includes(raw) ? raw as TriggerSource : undefined;
    if (raw !== undefined && !source) { res.status(400).json(apiError('trigger_source_invalid', `source must be ${TRIGGER_SOURCES.join('|')}`, { expected: TRIGGER_SOURCES.join(', ') })); return; }
    const ownerId = req.auth?.isSuperadmin ? undefined : req.auth?.user?.id ?? null;
    // An account-less caller (`null`) sees nothing rather than every system row.
    const rows = ownerId === null ? [] : listTriggerRows({ source, ownerId });
    res.json({ triggers: rows.map(publicTrigger) });
  });

  app.post('/api/triggers', (req, res) => {
    if (!manager(req, res)) return;
    const { secret: rawSecret, note: rawNote, ...rest } = (req.body ?? {}) as Record<string, unknown>;
    const parsed = triggerDefinitionSchema.safeParse(rest);
    if (!parsed.success) { res.status(400).json(apiError('trigger_definition_invalid', zodMessage(parsed.error), { detail: zodMessage(parsed.error) })); return; }
    let def = parsed.data;
    // Before a proposal too: one the user could only approve into a refusal is noise.
    const tooOften = cadenceRefusal(def, null);
    if (tooOften) { res.status(tooOften.status).json(tooOften.body); return; }
    if (callerIsAgent(req) && def.actions.some((action) => action.type === 'script')) {
      const note = z.string().max(300).optional().safeParse(rawNote);
      if (!note.success || rawSecret !== undefined) { res.status(400).json(apiError('trigger_note_invalid', 'note: up to 300 characters; no secret on a proposal')); return; }
      const reply = proposeTrigger(req, def, note.data ?? null);
      if (reply.status === 202) auditRequest(req, 'trigger.propose', (reply.body as { proposal_id: string }).proposal_id);
      res.status(reply.status).json(reply.body);
      return;
    }
    if (rawNote !== undefined) { res.status(400).json(apiError('trigger_note_not_allowed', 'note: only on a trigger an agent proposes')); return; }
    const byAgent = callerIsAgent(req);
    if (byAgent) def = { ...def, enabled: false };
    let secret: string | null = null;
    if (rawSecret !== undefined) {
      const provided = providedSecretSchema.safeParse(rawSecret);
      if (def.source !== 'webhook' || def.config.auth === 'none' || !provided.success) {
        res.status(400).json(apiError('trigger_secret_invalid', 'secret: a string of 16 to 256 characters, for an authenticated webhook only'));
        return;
      }
      secret = provided.data;
    }
    const acting = actingAgentOf(req);
    if ('body' in acting) { res.status(acting.status).json(acting.body); return; }
    const grants = callerGrants(req);
    const refused = refusal(req, def, def.actions, grants, listensOnLoopback);
    if (refused) { res.status(refused.status).json(refused.body); return; }
    if (def.source === 'webhook' && slugTaken(def.slug, null)) { res.status(409).json(apiError('trigger_slug_taken', `slug already used: ${def.slug}`, { slug: def.slug })); return; }
    if (def.source === 'webhook' && def.config.auth !== 'none' && secret === null) secret = generateSecret(def.config.auth);
    // Only a person gets here with a script (an agent's becomes a proposal above).
    const pinned = byAgent ? { pins: [] } : pinScripts(def.actions);
    if ('error' in pinned) { res.status(400).json(apiError('trigger_script_pin_failed', pinned.error, { detail: pinned.error })); return; }
    const agent = callerIsAgent(req) && req.auth?.missionId
      ? scopedDb(viewerFromRequest(req)).getMission(req.auth.missionId)?.agent_name ?? null
      : null;
    let created: { row: TriggerRow; outboundSecret: string | null };
    try {
      created = insertDefinition(def, secret, {
        ownerUserId: req.auth?.user?.id ?? null,
        createdBy: callerIsAgent(req) ? 'agent' : 'user',
        creatorAgent: agent,
        actingAgent: acting.agent,
        grants,
      }, pinned.pins);
    } catch (err) {
      res.status(400).json(apiError('trigger_save_failed', (err as Error).message, { detail: (err as Error).message }));
      return;
    }
    const { row, outboundSecret } = created;
    emitAutomationEvent({ kind: 'trigger_created', row, origin: automationOriginOf(req) });
    // The only response that ever carries the secrets.
    res.status(201).json({
      trigger: publicTrigger(row), ...(secret ? { secret } : {}), ...(outboundSecret ? { outbound_secret: outboundSecret } : {}),
      ...(byAgent ? { needs_activation: true, message: AGENT_TRIGGER_OFF } : {}),
    });
  });

  app.get('/api/triggers/proposals', (req, res) => {
    if (!manager(req, res)) return;
    if (callerIsAgent(req)) { res.status(403).json(apiError('trigger_proposals_user_only', 'proposals are the user\'s to read and decide')); return; }
    const raw = req.query.status;
    const status = raw === undefined ? 'pending' : raw;
    if (status !== 'pending' && status !== 'applied' && status !== 'dismissed') {
      res.status(400).json(apiError('trigger_proposal_status_invalid', 'status must be pending|applied|dismissed'));
      return;
    }
    const owner = req.auth?.isSuperadmin ? undefined : req.auth?.user?.id ?? null;
    const rows = owner === null ? [] : dbApi.listLayoutProposalsByKind(TRIGGER_PROPOSAL_KIND, { ownerUserId: owner, status });
    res.json({ proposals: rows.map(layoutProposalView) });
  });

  app.post('/api/triggers/proposals/:id/:decision', (req, res) => {
    if (!manager(req, res)) return;
    // A mission never decides, not even on its own card: that is the whole point.
    if (callerIsAgent(req)) { res.status(403).json(apiError('trigger_decide_by_agent', 'an agent cannot approve or reject a trigger')); return; }
    const decision = req.params.decision === 'approve' ? 'applied' : req.params.decision === 'reject' ? 'dismissed' : null;
    if (!decision) { res.status(404).json(apiError('not_found', 'not found')); return; }
    const row = dbApi.getLayoutProposal(paramId(req));
    const mine = !!row && (req.auth?.isSuperadmin || (req.auth?.user?.id ?? null) === row.owner_user_id);
    if (!row || row.kind !== TRIGGER_PROPOSAL_KIND || !mine) { res.status(404).json(apiError('not_found', 'not found')); return; }
    const outcome = decideLayoutProposal(row, decision, req, 'cli');
    if (!outcome.ok) {
      if (outcome.error === 'stale') { res.status(409).json({ error: 'refused', problems: outcome.problems }); return; }
      res.status(outcome.error === 'already_decided' ? 409 : 404).json({ error: outcome.error });
      return;
    }
    auditRequest(req, `trigger.proposal.${decision}`, row.id);
    const created = 'detail' in outcome && outcome.detail ? getTriggerRow(outcome.detail) : undefined;
    res.json({ proposal: layoutProposalView(outcome.row), ...(created ? { trigger: publicTrigger(created) } : {}) });
  });

  app.get('/api/triggers/:id', (req, res) => {
    if (!manager(req, res)) return;
    const row = loadVisible(req, res);
    if (row) res.json({ trigger: publicTrigger(row) });
  });

  app.patch('/api/triggers/:id', (req, res) => {
    if (!manager(req, res)) return;
    const row = loadVisible(req, res);
    if (!row) return;
    const patch = updateTriggerSchema.safeParse(req.body ?? {});
    if (!patch.success) { res.status(400).json(apiError('trigger_definition_invalid', zodMessage(patch.error), { detail: zodMessage(patch.error) })); return; }
    const merged: Record<string, unknown> = { ...definitionOf(row) };
    for (const [key, value] of Object.entries(patch.data)) if (value !== undefined) merged[key] = value;
    const parsed = triggerDefinitionSchema.safeParse(merged);
    if (!parsed.success) { res.status(400).json(apiError('trigger_definition_invalid', zodMessage(parsed.error), { detail: zodMessage(parsed.error) })); return; }
    let def = parsed.data;
    const byAgent = callerIsAgent(req);
    if (byAgent && row.enabled !== 1 && def.enabled !== false) { res.status(403).json(apiError('trigger_enable_by_agent', AGENT_CANNOT_ENABLE)); return; }
    let actions: TriggerAction[] = def.actions;
    if (row.created_by === 'routine') {
      // A routine stays a routine: one task, prompt verbatim unless asked
      // otherwise — `/api/routines` and its readers depend on that shape.
      const only = actions[0];
      if (actions.length !== 1 || only?.type !== 'task') {
        res.status(400).json(apiError('routine_single_task', 'a routine keeps a single task action; create a new trigger instead'));
        return;
      }
      // What the routine tick does not read would be saved, shown, then
      // silently ignored — and wiped by the next PUT /api/routines.
      if (only.title !== undefined || only.priority !== undefined || only.raw === false
        || (def.source === 'schedule' && def.config.tz !== undefined)) {
        res.status(400).json(apiError('routine_fields_unsupported', 'a routine has no title, priority, time zone or template: create a new trigger instead'));
        return;
      }
      actions = [{ ...only, raw: true }];
      // The routine's extras follow it to its new agent: judged again against
      // that agent, as `PUT /api/routines/:id` does.
      const routine = dbApi.getRoutine(row.id);
      if (routine && only.agent !== routine.agent_name) {
        const extras = routineTaskExtras(routine);
        const target = (() => { try { return loadConfig(only.agent); } catch { return null; } })();
        const widening = spawnWideningDenied(req, {
          extra_skills: extras.extraSkills, extra_mcp_servers: extras.extraMcpServers, extra_allowed_tools: extras.extraAllowedTools,
        }, target, only.agent);
        if (widening) { rejectOverride(req, res, 'routine.override_denied', `agent:${only.agent}`, widening); return; }
      }
    }
    // Routines stay system rows (NULL). A human re-grants with their own
    // permissions; an agent can only keep what both it and the trigger hold.
    const acting = actingAgentOf(req);
    if ('body' in acting) { res.status(acting.status).json(acting.body); return; }
    const previous = row.grants === null ? null : (safeJson(row.grants) as string[] | null) ?? [];
    const mine = callerGrants(req);
    // A trigger a plugin owns never widens, whoever edits it: a superadmin's `*` would
    // let it read every account's events (and send them out through a webhook action).
    const pluginOwned = row.owner_user_id?.startsWith(PLUGIN_OWNER_PREFIX) === true;
    // Flipping the switch alone is a consent, or its withdrawal, not an edit:
    // what the trigger may do and whose delegation list bounds it stay as they
    // were — the user switching an agent's trigger on runs what the agent made.
    const switchOnly = Object.entries(patch.data).every(([key, value]) => value === undefined || key === 'enabled');
    const grants = row.created_by === 'routine'
      ? null
      : switchOnly
        ? previous
        : pluginOwned
        ? previous ?? []
        : callerIsAgent(req)
          ? mine.filter((g) => previous === null || previous.includes('*') || previous.includes(g))
          : mine;
    // A routine's NULL grants are unrestricted at run time; whoever edits it
    // must still hold what it does.
    const storedTrigger = parseTrigger(row);
    const stored = storedTrigger?.actions ?? [];
    // An agent reshaping an enabled trigger is an agent setting one up: off until the user looks.
    const switchedOff = byAgent && row.enabled === 1 && def.enabled !== false && (!storedTrigger
      || behaviourOf({ ...def, slug: def.source === 'webhook' ? def.slug : null, actions }) !== behaviourOf(storedTrigger));
    if (switchedOff) def = { ...def, enabled: false };
    // Switching off is always allowed; switching on needs the caller to hold
    // what it does, as saving it would.
    const refused = switchOnly && def.enabled === false
      ? null
      : cadenceRefusal(def, row) ?? refusal(req, def, actions, switchOnly ? mine : grants ?? mine, listensOnLoopback, stored);
    if (refused) { res.status(refused.status).json(refused.body); return; }
    if (def.source === 'webhook' && slugTaken(def.slug, row.id)) { res.status(409).json(apiError('trigger_slug_taken', `slug already used: ${def.slug}`, { slug: def.slug })); return; }
    // A person saving the actions (the editor sends them all) approves the
    // scripts as they are now; flipping the switch or renaming does not. An
    // agent never gets here with a script (`refusal`).
    const pinned = !byAgent && patch.data.actions !== undefined ? pinScripts(actions, { actions: stored, pins: getScriptPins(row.id) }) : null;
    if (pinned && 'error' in pinned) { res.status(400).json(apiError('trigger_script_pin_failed', pinned.error, { detail: pinned.error })); return; }
    // Moving from `none` to a signed scheme: the secret is born here, and
    // this response is the only one that shows it.
    const newSecret = def.source === 'webhook' && def.config.auth !== 'none' && row.secret === null
      ? generateSecret(def.config.auth)
      : null;
    const scheduleMoved = def.source === 'schedule'
      && (patch.data.config !== undefined || patch.data.enabled !== undefined || switchedOff);
    const updated = updateTriggerRow(row.id, {
      name: def.name,
      slug: def.source === 'webhook' ? def.slug : null,
      enabled: def.enabled !== false,
      config: def.config,
      filter: def.source === 'schedule' ? null : def.filter ?? null,
      actions,
      grants,
      // A routine stays a system row; otherwise the last editor's delegation
      // list bounds the task actions, as its permissions bound the grants.
      actingAgent: row.created_by === 'routine' ? null : switchOnly ? row.acting_agent : acting.agent,
      nextRunAt: scheduleMoved ? nextRunFor(def) : row.next_run_at,
      // A person's save that leaves it on is the consent the boot sweep looks
      // for (TODO #572); an agent never gives it, and keeps the one it had
      // only while what the trigger does is unchanged.
      approvedAt: def.enabled === false ? null : byAgent ? undefined : Date.now(),
    });
    if (newSecret) setTriggerSecret(row.id, newSecret);
    if (pinned) setScriptPins(row.id, pinned.pins);
    // A first `webhook` action: its signing secret is born here, shown once.
    const newOutbound = sendsWebhooks(actions) && !row.outbound_secret ? generateSecret('standard') : null;
    if (newOutbound) setTriggerOutboundSecret(row.id, newOutbound);
    if (row.created_by !== 'routine') emitAutomationEvent({ kind: 'trigger_updated', row: getTriggerRow(row.id) ?? updated, origin: automationOriginOf(req) });
    res.json({
      trigger: publicTrigger(newSecret || newOutbound ? getTriggerRow(row.id)! : updated),
      ...(newSecret ? { secret: newSecret } : {}), ...(newOutbound ? { outbound_secret: newOutbound } : {}),
      ...(switchedOff ? { needs_activation: true, message: AGENT_TRIGGER_OFF } : {}),
    });
  });

  app.delete('/api/triggers/:id', (req, res) => {
    if (!manager(req, res)) return;
    const row = loadVisible(req, res);
    if (!row) return;
    deleteTrigger(row.id);
    if (row.created_by !== 'routine') emitAutomationEvent({ kind: 'trigger_removed', row, origin: automationOriginOf(req) });
    res.json({ ok: true });
  });

  app.post('/api/triggers/:id/secret', (req, res) => {
    if (!manager(req, res)) return;
    const row = loadVisible(req, res);
    if (!row) return;
    const trigger = parseTrigger(row);
    if (!trigger || trigger.source !== 'webhook' || trigger.config.auth === 'none') {
      res.status(400).json(apiError('trigger_has_no_secret', 'only an authenticated webhook has a secret'));
      return;
    }
    // Whoever holds the secret fires the actions: owning it needs their rights.
    const denied = callerMayRun(req, trigger.actions);
    if (denied) { res.status(denied.status).json(denied.body); return; }
    const raw = (req.body ?? {}) as { secret?: unknown };
    let secret: string;
    if (raw.secret !== undefined) {
      const provided = providedSecretSchema.safeParse(raw.secret);
      if (!provided.success) { res.status(400).json(apiError('trigger_secret_length', 'secret: a string of 16 to 256 characters')); return; }
      secret = provided.data;
    } else {
      secret = generateSecret(trigger.config.auth);
    }
    setTriggerSecret(row.id, secret);
    res.json({ trigger: publicTrigger(getTriggerRow(row.id)!), secret });
  });

  app.post('/api/triggers/:id/outbound-secret', (req, res) => {
    if (!manager(req, res)) return;
    const row = loadVisible(req, res);
    if (!row) return;
    const trigger = parseTrigger(row);
    if (!trigger || !sendsWebhooks(trigger.actions)) {
      res.status(400).json(apiError('trigger_has_no_outbound_secret', 'only a trigger with a webhook action has an outbound secret'));
      return;
    }
    // Whoever holds it signs in the trigger's name: owning it needs its rights.
    const denied = callerMayRun(req, trigger.actions);
    if (denied) { res.status(denied.status).json(denied.body); return; }
    const outboundSecret = generateSecret('standard');
    setTriggerOutboundSecret(row.id, outboundSecret);
    res.json({ trigger: publicTrigger(getTriggerRow(row.id)!), outbound_secret: outboundSecret });
  });

  app.post('/api/triggers/:id/approve-script', (req, res) => {
    if (!manager(req, res)) return;
    // The approval is what a mission cannot give, not even for its owner's
    // trigger: refused before the lookup, so it learns nothing about the ids.
    if (callerIsAgent(req)) { res.status(403).json(apiError('trigger_script_approve_by_agent', 'an agent cannot approve a script: the user does it')); return; }
    const row = loadVisible(req, res);
    if (!row) return;
    const trigger = parseTrigger(row);
    if (!trigger) { res.status(409).json(apiError('trigger_unreadable', 'stored trigger is unreadable')); return; }
    if (!trigger.actions.some((action) => action.type === 'script')) {
      res.status(400).json(apiError('trigger_runs_no_script', 'this trigger runs no script'));
      return;
    }
    // Approving is vouching that it may run: the caller must be able to run it.
    const denied = callerMayRun(req, trigger.actions);
    if (denied) { res.status(denied.status).json(denied.body); return; }
    const pinned = pinScripts(trigger.actions);
    if ('error' in pinned) { res.status(400).json(apiError('trigger_script_pin_failed', pinned.error, { detail: pinned.error })); return; }
    setScriptPins(row.id, pinned.pins);
    auditRequest(req, 'trigger.script.approve', row.id);
    res.json({
      trigger: publicTrigger(getTriggerRow(row.id)!),
      approved: pinned.pins.map((pin) => ({ command: pin.command, cwd: pin.cwd, files: pin.files.map((file) => file.path) })),
    });
  });

  app.post('/api/triggers/:id/test', (req, res) => {
    if (!manager(req, res)) return;
    const row = loadVisible(req, res);
    if (!row) return;
    const trigger = parseTrigger(row);
    if (!trigger) { res.status(409).json(apiError('trigger_unreadable', 'stored trigger is unreadable')); return; }
    const body = testTriggerSchema.safeParse(req.body ?? {});
    if (!body.success) { res.status(400).json(apiError('trigger_test_invalid', zodMessage(body.error), { detail: zodMessage(body.error) })); return; }
    const done = runTriggerTest(trigger, body.data, () => callerMayRun(req, trigger.actions));
    if ('refused' in done) {
      const refused = done.refused;
      res.status(refused.status).json('body' in refused ? refused.body : apiError('payload_too_large', refused.error));
      return;
    }
    res.json(done.result);
  });

  app.get('/api/triggers/:id/deliveries', (req, res) => {
    if (!manager(req, res)) return;
    const row = loadVisible(req, res);
    if (!row) return;
    const limit = Number(req.query.limit ?? 50);
    res.json({
      deliveries: listDeliveries(row.id, Number.isFinite(limit) ? limit : 50).map((d) => ({ ...d, result: safeJson(d.result) })),
    });
  });
}
