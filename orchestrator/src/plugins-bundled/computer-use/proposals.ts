/**
 * `computer_use_propose`: an agent asks, a person grants.
 *
 * Widening what an agent may control (`computer_use`, `computer_use_apps`) is
 * a person's decision, never an agent's (`agentWideningRefusal`). "All
 * applications" is not even proposed: a person sets it in the editor. The agent
 * only PROPOSES: the proposal becomes a card in its mission's conversation,
 * the shared layout-proposal mechanism (`settings/layout-proposals.ts`, the one
 * `widgets_propose` and trigger approvals use). Applying it is a decision of a
 * person at the screen (the resolve route accepts a session or a paired device,
 * nothing else), and the daemon writes the target agent's config inside the
 * transaction that claims the card: a proposal applies once, and not after it
 * expired. The outcome reaches the mission as a message.
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { Request } from 'express';
import { z } from 'zod';
import {
  canonicalAgentName, COMPUTER_USE_APP_MAX_LENGTH, loadConfig, storedComputerUseApps, storedComputerUseMode,
  type ComputerUseApp, type ComputerUseMode,
} from '../../agent-config.js';
import { killRunningForAgent, patchAgentConfig } from '../../agent.js';
import { agentDir } from '../../paths.js';
import { apiError } from '../../api-error.js';
import type { LayoutProposalRow, LayoutProposalStatus } from '../../db.js';
import { isPersonAuth, requestHasPermission, viewerFromRequest } from '../../users/identity.js';
import { scopedDb } from '../../users/scoped-db.js';
import { auditRequest } from '../../users/audit-actor.js';
import {
  createLayoutProposal, layoutProposalView, PROPOSAL_PENDING_REPLY, registerProposalKind,
} from '../settings/layout-proposals.js';

export const COMPUTER_USE_PROPOSAL_KIND = 'computer-use';
/** A card nobody answered for this long is no longer applied: the agent asks again. */
export const COMPUTER_USE_PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
export const COMPUTER_USE_PROPOSAL_APPS_MAX = 20;

const AppName = z.string().trim().min(1).max(COMPUTER_USE_APP_MAX_LENGTH);
const Mode = z.enum(['foreground', 'background']);
/** A bare name keeps the agent's default mode; an object carries its own. */
const AppEntry = z.union([AppName, z.object({ app: AppName, mode: Mode }).strict()]);

/** What the agent sends. Strict: nothing else rides along. */
const ProposalBody = z.object({
  agent: z.string().min(1).max(200),
  addApps: z.array(AppEntry).max(COMPUTER_USE_PROPOSAL_APPS_MAX).optional(),
  removeApps: z.array(AppName).max(COMPUTER_USE_PROPOSAL_APPS_MAX).optional(),
  enable: z.boolean().optional(),
  note: z.string().max(300).optional(),
}).strict();

/** What is stored and shown: the request, the state it was made against, and when it stops being valid. */
const StoredProposal = z.object({
  agent: z.string(),
  // Cards drawn before the modes existed hold bare names: they take the agent's default at apply time.
  addApps: z.array(AppEntry).max(COMPUTER_USE_PROPOSAL_APPS_MAX),
  removeApps: z.array(AppName).max(COMPUTER_USE_PROPOSAL_APPS_MAX),
  enable: z.boolean().optional(),
  before: z.object({ enabled: z.boolean(), apps: z.array(AppEntry), defaultMode: Mode.optional() }),
  expiresAt: z.number(),
});
export type ComputerUseProposal = z.infer<typeof StoredProposal>;

type Problem = { code: string; message: string };

const same = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

const nameOf = (entry: string | ComputerUseApp): string => (typeof entry === 'string' ? entry : entry.app);

/** A bare name takes the agent's default mode. */
export function withMode(entry: string | ComputerUseApp, fallback: ComputerUseMode): ComputerUseApp {
  return typeof entry === 'string' ? { app: entry.trim(), mode: fallback } : { app: entry.app.trim(), mode: entry.mode };
}

/**
 * The list once the changes are made: additions at the end, no duplicate (case apart), removals by name.
 * Adding an application already listed sets its mode to the one asked.
 */
export function nextAllowedApps(
  current: readonly (string | ComputerUseApp)[],
  add: readonly (string | ComputerUseApp)[],
  remove: readonly string[],
  fallback: ComputerUseMode = 'foreground',
): ComputerUseApp[] {
  const kept = current.map((entry) => withMode(entry, fallback)).filter((entry) => !remove.some((gone) => same(gone, entry.app)));
  for (const wanted of add.map((entry) => withMode(entry, fallback))) {
    const at = kept.findIndex((have) => same(have.app, nameOf(wanted)));
    if (at >= 0) kept[at] = { app: kept[at]!.app, mode: wanted.mode };
    else kept.push(wanted);
  }
  return kept;
}

function currentState(agent: string): { enabled: boolean; apps: ComputerUseApp[]; defaultMode: ComputerUseMode } | null {
  try {
    // `loadConfig` answers defaults for a folder that is not an agent: the agent's folder says whether it exists.
    if (!existsSync(agentDir(agent))) return null;
    const config = loadConfig(agent);
    return { enabled: config.computer_use === true, apps: storedComputerUseApps(config), defaultMode: storedComputerUseMode(config) };
  } catch {
    return null;
  }
}

function problem(code: string, message: string): { problems: Problem[] } {
  return { problems: [{ code, message }] };
}

/** Valid today, whoever asks: the payload parses, the proposal has not expired, the agent still exists. */
function stillValid(payload: unknown, now: number): { problems: Problem[] } | { proposal: ComputerUseProposal } {
  const parsed = StoredProposal.safeParse(payload);
  if (!parsed.success) return problem('invalid_payload', 'the proposal is malformed');
  const proposal = parsed.data;
  if (now > proposal.expiresAt) {
    return problem('expired', 'this proposal expired: ask the agent to propose it again');
  }
  if (!currentState(proposal.agent)) return problem('agent_gone', `the agent ${proposal.agent} no longer exists`);
  return { proposal };
}

const proposalReply = (status: LayoutProposalStatus, detail: string | null): string => {
  if (status === 'applied') {
    return `The user allowed it: ${detail ?? 'the change is in place'}. The agent's next turn runs with it; do not propose it again.`;
  }
  if (status === 'dismissed') return 'The user refused your computer-use proposal. Do not propose it again unless they ask for it.';
  return PROPOSAL_PENDING_REPLY;
};

/**
 * Inside the claim: only a person (the resolve route already refuses anyone
 * else, this is the second lock), holding `agents:manage`, writes the target
 * agent's config through the usual update path, then its running missions are
 * killed so the next turn spawns with it.
 */
function applyProposal(row: LayoutProposalRow, payload: unknown, req: Request) {
  if (!isPersonAuth(req.auth)) return problem('forbidden', 'only a person can allow computer use');
  if (!requestHasPermission(req, 'agents:manage')) return problem('forbidden', 'allowing computer use needs the agents:manage permission');
  const valid = stillValid(payload, Date.now());
  if ('problems' in valid) return valid;
  const { proposal } = valid;
  // Applied to the config of now, not to the one the card was drawn from.
  const current = currentState(proposal.agent)!;
  const apps = nextAllowedApps(current.apps, proposal.addApps, proposal.removeApps, current.defaultMode);
  const enabled = proposal.enable ?? current.enabled;
  patchAgentConfig(proposal.agent, { computer_use: enabled, computer_use_apps: apps });
  killRunningForAgent(proposal.agent);
  const listing = apps.length ? apps.map((entry) => `${entry.app} (${entry.mode})`).join(', ') : 'none';
  return {
    detail: `${proposal.agent}: computer use ${enabled ? 'on' : 'off'}, allowed applications: ${listing}`,
    after: () => auditRequest(req, 'computer.proposal.applied', row.id),
  };
}

export function registerComputerUseProposalKind(): void {
  registerProposalKind(COMPUTER_USE_PROPOSAL_KIND, {
    label: 'computer-use request',
    revalidate: (payload) => {
      const valid = stillValid(payload, Date.now());
      return 'problems' in valid ? valid.problems : [];
    },
    applyOnServer: applyProposal,
    reply: proposalReply,
    prefix: '[computer-use proposal]',
  });
}

/**
 * Keys that would reach "All applications" or its exclusions, however spelled. The strict schema
 * already refuses them; naming them answers the agent with the reason instead of a shape error.
 */
const EVERYTHING_KEYS = ['allApps', 'all_apps', 'computer_use_all_apps', 'excludedApps', 'excluded_apps', 'computer_use_excluded_apps', 'removeExcludedApps'];

function asksForEverything(raw: unknown): boolean {
  return !!raw && typeof raw === 'object' && EVERYTHING_KEYS.some((key) => Object.prototype.hasOwnProperty.call(raw, key));
}

/** `POST /api/computer/proposals`: a mission's token only. Answers `{ status, body }` like the other proposal routes. */
export function proposeComputerUse(req: Request, raw: unknown): { status: number; body: unknown } {
  const missionId = req.auth?.kind === 'api-token' ? req.auth.missionId : undefined;
  if (!missionId) {
    return { status: 403, body: apiError('computer_proposal_mission_required', 'Only an agent mission can propose computer-use access: a person edits the agent directly.') };
  }
  const mission = scopedDb(viewerFromRequest(req)).getMission(missionId);
  const owner = req.auth?.user ?? null;
  if (!mission || !owner) return { status: 403, body: apiError('computer_proposal_mission_unknown', 'This mission is unknown.') };
  if (asksForEverything(raw)) {
    return {
      status: 403,
      body: apiError('computer_proposal_all_apps_refused', '"All applications" and its exclusions are not proposed: only a person sets them, from the agent\'s Permissions in the app. '
        + 'Propose the applications you need with addApps instead.'),
    };
  }
  const parsed = ProposalBody.safeParse(raw ?? {});
  if (!parsed.success) {
    return { status: 400, body: apiError('computer_proposal_invalid', 'Expected { agent, addApps?: (string | { app, mode })[<=20], removeApps?: string[<=20], enable?: boolean, note?: string }.') };
  }
  const { agent: asked, addApps = [], removeApps = [], enable, note } = parsed.data;
  if (!addApps.length && !removeApps.length && enable === undefined) {
    return { status: 400, body: apiError('computer_proposal_empty', 'Nothing to change: give addApps, removeApps or enable.') };
  }
  let agent: string;
  try { agent = canonicalAgentName(asked); } catch { return { status: 404, body: apiError('agent_not_found', 'agent not found') }; }
  const before = currentState(agent);
  if (!before) return { status: 404, body: apiError('agent_not_found', 'agent not found') };
  const now = Date.now();
  // A bare name is settled now, so the card shows the mode it will get.
  const settled = addApps.map((entry) => withMode(entry, before.defaultMode));
  const payload: ComputerUseProposal = { agent, addApps: settled, removeApps, ...(enable !== undefined ? { enable } : {}), before, expiresAt: now + COMPUTER_USE_PROPOSAL_TTL_MS };
  const row = createLayoutProposal({ id: randomUUID(), kind: COMPUTER_USE_PROPOSAL_KIND, mission, owner, payload, note: note ?? null });
  auditRequest(req, 'computer.proposal.created', row.id);
  return {
    status: 202,
    body: {
      id: row.id,
      status: 'pending',
      message: 'Nothing changed yet: the request is a card in this conversation that the user allows or refuses, and it expires after 24 hours. '
        + 'Their decision comes back to you as a message; do not propose it again. Carry on, or end your turn.',
      proposal: layoutProposalView(row).payload,
    },
  };
}
