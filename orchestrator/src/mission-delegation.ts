/**
 * Authenticated user-owned agents may delegate unless the account explicitly
 * denies it — and only to the agents their `orchestrates` list covers
 * (`agent-orchestration.ts`).
 *
 * Per-mission overrides (TIM-0074): a mission token never holds
 * `missions:spawn`, so this is its only way to start a mission, and refusing
 * `model` / `backend` / `extra_*` / `idempotency_key` here left no path at all.
 * They go through the same guard as a Kanban task a mission creates
 * (`spawnOverrideRefusal` + `overrideAuthority`): nothing the task route did
 * not already allow.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { listAgents, spawnAgent } from './agent.js';
import { dbApi } from './db.js';
import { delegationRefusal } from './delegation-guard.js';
import { idempotencyKey, idempotentMission, rememberIdempotentMission } from './http-helpers.js';
import { loadConfig } from './agent-config.js';
import { agentCommunicationAllowed, isDeveloperAccount } from './users/agent-permissions.js';
import { overrideAuthority, rejectOverride, spawnOverrideRefusal, spawnWideningDenied } from './users/privileged-overrides.js';

const Ids = z.array(z.string().min(1).max(200)).max(50);
const Body = z.object({
  agent_name: z.string().min(1).max(200),
  mission: z.string().min(1).max(100_000),
  model: z.string().min(1).max(200).optional(),
  backend: z.string().min(1).max(100).optional(),
  extra_skills: Ids.optional(),
  extra_mcp_servers: Ids.optional(),
  extra_allowed_tools: Ids.optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
  /** Display name of the child mission (`preset`). */
  title: z.string().min(1).max(200).optional(),
}).strict();

/** Injection keeps HTTP integration tests from launching a real LLM. */
export function createDelegationHandler(launch: typeof spawnAgent = spawnAgent) {
  return async (req: Request, res: Response): Promise<void> => {
    const auth = req.auth;
    const parent = auth?.kind === 'api-token' && auth.missionId
      ? dbApi.getMission(auth.missionId) : null;
    const owner = auth?.user && dbApi.getUserById(auth.user.id);
    if (!parent || !owner || owner.status !== 'active' || parent.owner_user_id !== owner.id
        || parent.status !== 'running'
        || !agentCommunicationAllowed(owner, dbApi.listPermissionsForUser(owner.id), 'missions:spawn')) {
      res.status(403).json({ error: 'delegation requires a running owned mission and no explicit communication or spawn denial' });
      return;
    }
    const parsed = Body.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: 'invalid delegation body: expected agent_name, mission and optionally model, backend, '
          + 'extra_skills, extra_mcp_servers, extra_allowed_tools, idempotency_key, title',
        reason: parsed.error.issues.map((i) => i.path.join('.') || i.message).join(', '),
      });
      return;
    }
    // Deliberately NOT filtered by team: this listing resolves a name, it does
    // not display choices. Filtering it would turn a cross-team delegation into
    // a "unknown agent" 404 — a new refusal on a path the team rule never
    // claimed. The rule bites on messages (`sendAgentMessage`); spawning a
    // mission for somebody else stays what it was.
    const agents = listAgents();
    const target = agents.find((a) => a.name === parsed.data.agent_name);
    if (!target) {
      res.status(404).json({ error: 'unknown agent; call agent_list and use the exact name' });
      return;
    }
    const refusal = delegationRefusal(req, target.name);
    if (refusal) {
      res.status(403).json({ error: `delegation refused: ${refusal}`, code: 'orchestration_denied' });
      return;
    }
    const data = parsed.data;
    const overrides = {
      ...(data.model !== undefined ? { model_override: data.model } : {}),
      ...(data.backend !== undefined ? { backend_override: data.backend } : {}),
      ...(data.extra_mcp_servers !== undefined ? { extra_mcp_servers: data.extra_mcp_servers } : {}),
      ...(data.extra_allowed_tools !== undefined ? { extra_allowed_tools: data.extra_allowed_tools } : {}),
    };
    const targetConfig = (() => { try { return loadConfig(target.name); } catch { return null; } })();
    const overrideRefusal = spawnWideningDenied(req, { ...overrides, extra_skills: data.extra_skills }, targetConfig, target.name)
      ?? spawnOverrideRefusal(overrides, targetConfig, overrideAuthority(req));
    if (overrideRefusal) {
      rejectOverride(req, res, 'spawn.override_denied', `agent:${target.name}`, overrideRefusal);
      return;
    }
    // A malformed reporting cycle must not create recursive missions.
    let ancestor: typeof parent | null = parent;
    const seen = new Set<string>();
    while (ancestor) {
      if (seen.has(ancestor.id) || (!isDeveloperAccount(owner) && ancestor.agent_name === target.name)) {
        res.status(403).json({ error: 'delegation cycle refused' });
        return;
      }
      seen.add(ancestor.id);
      ancestor = ancestor.parent_mission_id ? (dbApi.getMission(ancestor.parent_mission_id) ?? null) : null;
    }
    const key = data.idempotency_key ? idempotencyKey(data.idempotency_key, owner.id) : null;
    const replayed = key ? idempotentMission(key) : null;
    if (replayed) {
      res.status(200).json({ mission_id: replayed, idempotent: true });
      return;
    }
    try {
      const missionId = await launch(target.name, data.mission, {
        channel: 'agent', meta: { parent_mission_id: parent.id, parent_agent: parent.agent_name },
      }, {
        ownerUserId: owner.id,
        explicitResume: null,
        extraSkills: data.extra_skills,
        extraMcpServers: data.extra_mcp_servers,
        extraAllowedTools: data.extra_allowed_tools,
        modelOverride: data.model ?? null,
        backendOverride: data.backend ?? null,
        title: data.title ?? null,
      });
      if (key) rememberIdempotentMission(key, missionId);
      dbApi.setMissionLineage(missionId, { parentMissionId: parent.id, parentAgent: parent.agent_name });
      res.status(201).json({ mission_id: missionId });
    } catch (err) {
      res.status(500).json({ error: (err as Error).message });
    }
  };
}
