/**
 * HTTP helpers shared by SEVERAL bundled modules.
 *
 * A helper only lands here if it has at least two owners: otherwise it
 * leaves with its module (rule of step 1.4). Today, a single case —
 * `handleSpawn`, served both by `/api/agents/spawn` (`@timon/agents`) and
 * by `POST /api/missions` (`@timon/missions`). The two routes are the SAME
 * gesture under two public names, and the idempotency cache must be shared:
 * duplicating it would leave two independent deduplication windows, hence
 * double spawns on a mere network retry.
 *
 * Extracted verbatim from `index.ts` (step 1.4).
 */
import { randomUUID } from 'node:crypto';
import express from 'express';
import { channelReceipt, findChannelMission, serializeReceipt } from './channel-receipts.js';
import { loadConfig, spawnAgent } from './agent.js';
import { dbApi } from './db.js';
import { expandSlashCommand } from './slash.js';
import { delegationRefusal } from './delegation-guard.js';
import {
  composeChatTurn,
  discardChatAttachments,
  persistChatAttachments,
  skippedAttachmentsField,
  type SkippedAttachment,
} from './chat-attachments.js';
import { defaultBackendName } from './backends/index.js';
import { ATTACHMENTS_UNSUPPORTED, attachmentsRefusal } from './backends/capabilities.js';
import { rejectIfDenied } from './users/identity.js';
import { launchErrorStatus, missionLaunchErrorBody } from './resources.js';
import { isPrivilegedCaller, overrideAuthority, rejectOverride, type SpawnOverrides, spawnOverrideRefusal, spawnWideningDenied } from './users/privileged-overrides.js';

type SpawnBody = {
  trace_id?: string;
  agent_name?: string;
  agent?: string;
  mission?: string;
  input?: string;
  source_channel?: string;
  source_meta?: unknown;
  /**
   * Explicit session control:
   *   undefined → auto: orchestrator resumes the agent's latest session
   *   string    → resume this exact session (e.g. continuing a specific past mission)
   *   null      → fresh start: do NOT pass --resume to claude
   */
  resume_session_id?: string | null;
  /**
   * Optional caller-supplied dedup key. If a spawn with the same key has
   * already produced a mission in the last IDEMPOTENCY_TTL ms, that
   * mission_id is returned instead of starting a duplicate. Useful for
   * LLM orchestrators that re-issue the same `timon spawn` after seeing a
   * permission card resolve, and for network retries.
   */
  idempotency_key?: string;
  /** Inline images for the first user turn (base64, no data: prefix). */
  images?: Array<{ media_type: string; data: string }>;
  /** Anything that is not an image: written to disk, announced by its path. */
  attachments?: unknown;
  /** Long clipboard pastes the composer pulled out of the input. */
  pasted?: unknown;
  /** Recent spoken exchanges, when GPT-Live delegated this turn. */
  voiceContext?: unknown;
  /** Skill IDs to inject for this spawn only, merged on top of agent config. */
  extra_skills?: string[];
  /** MCP server IDs to inject for this spawn only. */
  extra_mcp_servers?: string[];
  /** Tool patterns to pre-allow for this spawn (Bash(timon:*), …). */
  extra_allowed_tools?: string[];
  /** Per-mission override of the LLM model (e.g. 'sonnet', 'opus',
   *  'haiku'). If given, supersedes agent.model for this mission
   *  and all its respawns (the value is persisted on the mission
   *  row via setMissionLlmOverrides). */
  model_override?: string | null;
  reasoning_effort?: string | null;
  /** Per-mission override of the backend (claude / codex). */
  backend_override?: string | null;
  /** Display name set by the launcher (`title_source = 'preset'`); absent, a
   *  conversation gets a generated title at the end of its first turn. */
  title?: string | null;
};

/** Recent (key → missionId) for spawn dedup. Cleared opportunistically on
 *  every spawn so the map can't grow unbounded; lookups also skip stale
 *  entries past IDEMPOTENCY_TTL. */
const IDEMPOTENCY_TTL = 5 * 60 * 1000;
const idempotency = new Map<string, { missionId: string; at: number }>();

/**
 * secu-9 — the bucket is per owner, never global.
 *
 * `idempotency_key` is caller-chosen and often a readable slug
 * (`example-project-init-2026-05-15`). Shared across users, two accounts picking the
 * same string collide: the second gets back a `mission_id` it does not own —
 * a mission that `scopedDb` then hides from it — and its spawn silently never
 * happens. Scoping on the same value passed as `ownerUserId` keeps dedup and
 * ownership in agreement.
 */
export function idempotencyKey(key: string, ownerUserId: string | null): string {
  return `${ownerUserId ?? 'anonymous'}\u0000${key}`;
}

/**
 * The ONE dedup window, also read by the delegation route (TIM-0074): a second
 * map there would let a retry that switched routes spawn twice.
 */
export function idempotentMission(key: string): string | null {
  const now = Date.now();
  for (const [k, v] of idempotency) {
    if (now - v.at > IDEMPOTENCY_TTL) idempotency.delete(k);
  }
  return idempotency.get(key)?.missionId ?? null;
}

export function rememberIdempotentMission(key: string, missionId: string): void {
  idempotency.set(key, { missionId, at: Date.now() });
}

const SPAWN_CONTENT_REQUIRED = 'agent (or agent_name) and mission (or input) required';

/** Does the first turn carry anything to say? A paste the composer pulled out
 *  of the input leaves `input` empty: the turn IS the paste, and refusing it
 *  refused the whole message (#109). Same for a file sent alone. */
export function spawnHasContent(body: Pick<SpawnBody, 'mission' | 'input' | 'pasted' | 'attachments'>): boolean {
  const text = body.mission ?? body.input ?? '';
  if (typeof text !== 'string') return false;
  const carried = (v: unknown) => Array.isArray(v) && v.length > 0;
  return text.trim().length > 0 || carried(body.pasted) || carried(body.attachments);
}

const handleSpawnOnce = async (req: express.Request, res: express.Response) => {
  if (rejectIfDenied(req, res, 'missions:spawn')) return;
  const body = req.body as SpawnBody;
  const receipt = channelReceipt(body);
  const previousMission = receipt && findChannelMission(receipt, req.auth?.user?.id ?? null);
  if (previousMission) { res.status(200).json({ mission_id: previousMission, idempotent: true }); return; }
  if (body.trace_id !== undefined && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.trace_id)) {
    res.status(400).json({ error: 'trace_id must be a UUID' });
    return;
  }
  const agent = body.agent_name ?? body.agent;
  const rawMission = body.mission ?? body.input ?? '';
  if (!agent || !spawnHasContent(body)) {
    res.status(400).json({ error: SPAWN_CONTENT_REQUIRED });
    return;
  }
  if (body.title != null && (typeof body.title !== 'string' || body.title.length > 200)) {
    res.status(400).json({ error: 'title must be a string of at most 200 characters' });
    return;
  }
  // Delegation list: an agent (its mission-bound token, or the mission its CLI
  // names) hands work only to the agents its `orchestrates` covers. A human or
  // an operator has no list. Before any side effect, like the checks below.
  const parentMission = body.source_meta && typeof body.source_meta === 'object'
    ? (body.source_meta as Record<string, unknown>).parent_mission_id : null;
  const orchestrationRefusal = delegationRefusal(req, agent, typeof parentMission === 'string' ? parentMission : null);
  if (orchestrationRefusal) {
    res.status(403).json({ error: `spawn refused: ${orchestrationRefusal}`, code: 'orchestration_denied' });
    return;
  }
  // secu-4: the body may widen what an admin granted to the target agent
  // (tools, MCP servers, backend). Checked BEFORE any side effect, against
  // that agent's own config — an override that stays inside it is a no-op.
  const agentConfig = (() => { try { return loadConfig(agent); } catch { return null; } })();
  // Extra tools, a skill that pre-authorises tools or a stdio MCP server need a
  // person, whatever an agent's token holds.
  const widening = spawnWideningDenied(req, body, agentConfig, agent);
  if (widening) {
    rejectOverride(req, res, 'spawn.override_denied', `agent:${agent}`, widening);
    return;
  }
  if (!isPrivilegedCaller(req)) {
    const refusal = spawnOverrideRefusal(body as SpawnOverrides, agentConfig, overrideAuthority(req));
    if (refusal) {
      rejectOverride(req, res, 'spawn.override_denied', `agent:${agent}`, refusal);
      return;
    }
  }
  // Chat slash command: `/<skill> …` at the head of the message → rewritten as an
  // imperative instruction wrapping the request in the skill. No-op if it
  // is not a recognised command. The agent's cwd → resolves the project's skills/commands
  // and serves as execution cwd for the `!`cmd`` blocks.
  const attachmentRefusal = attachmentsRefusal(
    body.backend_override ?? agentConfig?.backend ?? defaultBackendName(), body.attachments,
  );
  if (attachmentRefusal) {
    res.status(400).json({ error: attachmentRefusal, code: ATTACHMENTS_UNSUPPORTED });
    return;
  }
  const slashCwd = agentConfig?.cwd;
  const slash = await expandSlashCommand(rawMission, { cwd: slashCwd });
  // The id is drawn HERE, not by `spawnAgent`: the attachments of this first
  // turn live under it, and their paths are inside the message it spawns with.
  const missionId = randomUUID();
  const skipped: SkippedAttachment[] = [];
  const persisted = persistChatAttachments(missionId, body.attachments, skipped);
  const turn = composeChatTurn(slash, persisted, body.pasted, body.voiceContext);
  const mission = turn.text;
  if (!mission.trim()) {
    discardChatAttachments(persisted);
    res.status(400).json({ error: SPAWN_CONTENT_REQUIRED });
    return;
  }
  if (slash.skill) console.log(`[slash] spawn ${agent} with skill /${slash.skill}`);
  // Idempotency: replay the cached mission_id when the same key fires
  // again within TTL. Cleared inline of any stale entries to keep the
  // map bounded without a separate sweeper.
  const ownerUserId = req.auth?.user?.id ?? null;
  const key = body.idempotency_key ? idempotencyKey(body.idempotency_key, ownerUserId) : undefined;
  if (key) {
    const hit = idempotentMission(key);
    if (hit) {
      // A replay: the first call already carried its own files.
      discardChatAttachments(persisted);
      res.status(200).json({ mission_id: hit, idempotent: true });
      return;
    }
  }
  const source = body.source_channel
    ? { channel: body.source_channel, meta: body.source_meta }
    : undefined;
  // The lineage code after the spawn can throw while the mission is alive: only
  // a spawn that did not happen frees the files.
  let started = false;
  try {
    await spawnAgent(agent, mission, source, {
      missionId,
      // 'resume_session_id' must be present on the parsed object to count as
      // explicit — `in` distinguishes the absent case from `null`.
      explicitResume:
        'resume_session_id' in body ? body.resume_session_id ?? null : undefined,
      images: body.images,
      presentation: turn.presentation,
      extraSkills: body.extra_skills,
      extraMcpServers: body.extra_mcp_servers,
      extraAllowedTools: body.extra_allowed_tools,
      modelOverride: body.model_override ?? null,
      reasoningEffort: body.reasoning_effort ?? null,
      backendOverride: body.backend_override ?? null,
      // Owner BEFORE the child starts: the injected `TIMON_API_TOKEN` is
      // issued from `missions.owner_user_id` (M.5). Setting it after spawn
      // left the process running as the daemon.
      ownerUserId,
      traceId: body.trace_id ?? null,
      title: body.title ?? null,
    });
    started = true;
    if (key) rememberIdempotentMission(key, missionId);
    // Denormalises lineage from source_meta to allow indexed graph queries
    // (parent→children, task→missions) without re-parsing the JSON.
    if (source && source.meta && typeof source.meta === 'object') {
      const meta = source.meta as Record<string, unknown>;
      const lineage = {
        parentMissionId: typeof meta.parent_mission_id === 'string' ? meta.parent_mission_id : null,
        parentAgent: typeof meta.parent_agent === 'string' ? meta.parent_agent : null,
        taskId: typeof meta.task_id === 'string' ? meta.task_id : null,
        routineId: typeof meta.routine_id === 'string' ? meta.routine_id : null,
      };
      if (lineage.parentMissionId || lineage.taskId || lineage.routineId || lineage.parentAgent) {
        dbApi.setMissionLineage(missionId, lineage);
      }
    }
    res.status(201).json({ mission_id: missionId, ...skippedAttachmentsField(skipped) });
  } catch (err) {
    if (!started) discardChatAttachments(persisted);
    res.status(launchErrorStatus(err, 500)).json(missionLaunchErrorBody(err));
  }
};

export const handleSpawn = async (req: express.Request, res: express.Response): Promise<void> => {
  const receipt = channelReceipt(req.body ?? {});
  if (!receipt) return handleSpawnOnce(req, res);
  const key = JSON.stringify([req.auth?.user?.id ?? null, receipt.channel, receipt.id]);
  return serializeReceipt(key, () => handleSpawnOnce(req, res));
};
