/**
 * `ctx.agents`: a plugin lists, creates and updates Timon agents — "one agent
 * per profile of the system I connect, in one click" — within the rights of
 * the account that acts.
 *
 * Who acts is decided by `context.ts` before this module is reached: a request
 * of an account holding `agents:read` / `agents:manage`, or a job, which acts
 * as `plugin:<id>`. An anonymous request never gets here. This module then
 * applies what `POST /api/agents` and `PATCH /api/agents/:name/config` apply,
 * through the same functions, plus three rules of its own:
 *
 *  - an agent is only CREATED, never overwritten: a name already taken
 *    (case-insensitively, as the dispatcher resolves names) is a conflict;
 *  - a plugin UPDATES, RENAMES, DELETES and re-skins (`setAvatar`) only the
 *    agents it created (`created_by`), unless the caller of the request is a
 *    superadmin. A job never touches another's. The main orchestrator is never
 *    deleted, whoever created it;
 *  - what is read is an agent's identity, never its configuration: no working
 *    directory, prompt, directives, tools, skills or MCP servers;
 *  - what is WRITTEN may name skills, MCP servers and a team (API 15). A skill
 *    that pre-authorises tools, and an MCP server another writer declared,
 *    need a superadmin caller: both would widen what the agent runs, which is
 *    what secu-4 keeps for `agents:privileged-config`.
 *
 * The configuration rules of secu-4 (`agentConfigRefusal`) bind every caller
 * except a superadmin, jobs included. `agents:privileged-config` is NOT
 * honoured here: its ceiling is the caller's mission, and a plugin request
 * carries none — failing closed is the only reading that cannot widen it.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { z } from 'zod';
import { canonicalAgentName, isValidAgentName, loadConfig, validName, type AgentConfig } from '../agent-config.js';
import { agentNameKey, normalizeAgentName } from '../agent-name.js';
import { getRole } from '../agent-roles.js';
import { isBackendName } from '../backends/index.js';
import { dbApi } from '../db.js';
import type { DbViewer } from '../db.js';
import { getMcp } from '../mcp.js';
import { agentDir, skillFile } from '../paths.js';
import { isSkillId, setAgentSkills } from '../skill-attachments.js';
import { declaresAllowedTools } from '../users/skills-mcp-guard.js';
import { agentAvatarSchema, applyAgentAvatar } from '../agent-avatar.js';
import { catalogKeeping, mascotPartCatalog, parseAgentAvatar, parseAgentLook, type AgentAvatarMode, type AgentLook } from '../agent-look.js';
import { checkReportsTo } from '../reports-to.js';
import { mainSeatRemovalRefusal, renameAgentKeepingSeat } from '../main-agent.js';
import { agentConfigRefusal, RESTRICTED } from '../users/privileged-overrides.js';
import { withWriteOrigin } from '../write-origin.js';
import { pluginAgentOrigin } from './agent-origin.js';

import type {
  PluginAgent, PluginAgentInput, PluginAgentPatch, PluginAgentErrorCode, PluginAgentAvatar,
  PluginAgentDeleteOptions, PluginTeam, PluginTeamInput,
} from './contract/agents.js';
export type {
  PluginAgent, PluginAgentInput, PluginAgentPatch, PluginAgentErrorCode, PluginAgentAvatar,
  PluginAgentDeleteOptions, PluginTeam, PluginTeamInput,
} from './contract/agents.js';

export class PluginAgentError extends Error {
  constructor(readonly code: PluginAgentErrorCode, message: string) {
    super(message);
    this.name = 'PluginAgentError';
  }
}

export type AgentCallerScope = {
  pluginId: string;
  /** No request: the plugin acts as itself and sees only its own agents. */
  job: boolean;
  /** The request's caller is a superadmin: secu-4 rules and ownership lifted. */
  superadmin: boolean;
  /** The account of the request, which bounds the teams it sees; absent for a job. */
  viewer?: DbViewer | null;
};

export type ScopedAgents = {
  list(): Promise<PluginAgent[]>;
  create(input: PluginAgentInput): Promise<PluginAgent>;
  update(name: string, patch: PluginAgentPatch): Promise<PluginAgent>;
  /** `true` once the agent is gone. The main orchestrator answers `conflict`. */
  delete(name: string, options?: PluginAgentDeleteOptions): Promise<boolean>;
  /** The agent under its new name; a name already taken answers `conflict`. */
  rename(name: string, newName: string): Promise<PluginAgent>;
  /** The picture's URL, or `null` once removed. */
  setAvatar(name: string, avatar: PluginAgentAvatar): Promise<string | null>;
  /** Teams the caller's account sees (all of them for a superadmin); a job,
   *  or a request without an account, sees only the teams no account owns. */
  listTeams(): Promise<PluginTeam[]>;
  createTeam(input: PluginTeamInput): Promise<PluginTeam>;
  /** `false` for a team the caller does not see. */
  deleteTeam(id: string): Promise<boolean>;
};

/** Agents created by plugins never take a name starting with `_` or `.`:
 *  `_main` and the `_eph-*` agents are the daemon's own. */
const NameSchema = z.string().min(1).max(100).transform(normalizeAgentName)
  .refine((name) => isValidAgentName(name) && !name.startsWith('_'), 'invalid agent name');

const FieldsSchema = z.object({
  systemPrompt: z.string().max(200_000),
  role: z.string().min(1).max(32),
  backend: z.string().min(1).max(64).optional(),
  model: z.string().min(1).max(200).optional(),
  project: z.string().min(1).max(200).nullable().optional(),
  cwd: z.string().min(1).max(4096).optional(),
  directives: z.string().max(20_000).nullable().optional(),
  memoryScope: z.enum(['NONE', 'SESSION', 'AGENT', 'GLOBAL']).optional(),
  skills: z.array(z.string().min(1).max(100)).max(200).optional(),
  mcpServers: z.array(z.string().min(1).max(200)).max(64).optional(),
  team: z.string().min(1).max(200).nullable().optional(),
  reportsTo: z.string().min(1).max(100).nullable().optional(),
  // Checked by `parseAgentLook`, whose refusal names the accepted values.
  look: z.unknown().optional(),
  // Same for `parseAgentAvatar`.
  avatar: z.unknown().optional(),
});
const TeamSchema = z.object({
  name: z.string().trim().min(1).max(160),
  color: z.string().max(64).nullable().optional(),
}).strict();
const DeleteOptionsSchema = z.object({ purge: z.boolean().optional() }).strict();
const TeamIdSchema = z.string().min(1).max(200);
const CreateSchema = FieldsSchema.extend({ name: NameSchema }).strict();
const PatchSchema = FieldsSchema.partial().strict();

/** Same set as the config PATCH route: a running process started with the
 *  old values keeps them until it is respawned. `team` is not one: no spawn
 *  argument carries it, and every reader loads it again from config.json at
 *  each call (`sendAgentMessage`, the messages facade, `teamVisibleAgents`). */
const RESPAWN_KEYS = ['model', 'role', 'directives', 'backend', 'memory_scope', 'mcp_servers'] as const;

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const res = schema.safeParse(value);
  if (!res.success) {
    const issue = res.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new PluginAgentError('invalid', `${where}${issue?.message ?? 'invalid input'}`);
  }
  return res.data;
}

/** An agent name a plugin may address, canonical, or `null`. */
export function addressableAgentName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const parsed = NameSchema.safeParse(name);
  return parsed.success ? canonicalAgentName(parsed.data) : null;
}

/**
 * The agent `name`, when this caller may act on it: it exists, is not
 * ephemeral, and — for a job — was created by this plugin (another's answers
 * like a missing one); for a request, was created by this plugin too unless the
 * caller is a superadmin. Shared by every facade that reaches into an agent.
 */
export function resolveOwnAgent(scope: AgentCallerScope, name: unknown): { name: string; config: AgentConfig } {
  const target = addressableAgentName(name);
  const current = target && existsSync(agentDir(target)) ? loadConfig(target) : null;
  const origin = pluginAgentOrigin(scope.pluginId);
  // A job sees only its own agents: another's answers like a missing one.
  if (!target || !current || current.ephemeral === true || (scope.job && current.created_by !== origin)) {
    throw new PluginAgentError('not_found', `agent not found: ${String(name)}`);
  }
  if (!scope.superadmin && current.created_by !== origin) {
    throw new PluginAgentError('forbidden', `agent ${target} was not created by this plugin`);
  }
  return { name: target, config: current };
}

const teamView = (t: { id: string; name: string; color: string | null; created_at: number }): PluginTeam => ({
  id: t.id, name: t.name, color: t.color, createdAt: t.created_at,
});

export function agentsFor(scope: AgentCallerScope): ScopedAgents {
  const origin = pluginAgentOrigin(scope.pluginId);

  const view = (a: { name: string; backend: string; model: string | null; project: string | null; role: string | null; has_system_prompt: boolean; created_by: string | null; look: AgentLook | null; avatar: AgentAvatarMode | null; reports_to?: string | null }): PluginAgent => ({
    name: a.name,
    backend: a.backend,
    model: a.model,
    project: a.project,
    role: a.role,
    hasSystemPrompt: a.has_system_prompt,
    createdBy: a.created_by,
    mine: a.created_by === origin,
    look: a.look,
    avatar: a.avatar,
    reportsTo: a.reports_to ?? null,
  });

  /** Config fields of an input, checked; `current` is the agent being edited. */
  const configOf = (fields: z.infer<typeof PatchSchema>, current: AgentConfig | null, selfName: string): Partial<AgentConfig> => {
    const cfg: Record<string, unknown> = {};
    if (fields.role !== undefined) {
      if (!getRole(fields.role)) throw new PluginAgentError('invalid', `unknown role: ${fields.role}`);
      if (fields.role === 'orchestrator' && !scope.superadmin) {
        throw new PluginAgentError('forbidden', 'only a superadmin may create or make an orchestrator');
      }
      cfg.role = fields.role;
    }
    if (fields.backend !== undefined) {
      if (!isBackendName(fields.backend)) throw new PluginAgentError('invalid', `unknown backend: ${fields.backend}`);
      cfg.backend = fields.backend;
    }
    if (fields.model !== undefined) cfg.model = fields.model;
    if (fields.project !== undefined) {
      if (fields.project !== null && !dbApi.getProjectRow(fields.project)) {
        throw new PluginAgentError('invalid', `unknown project: ${fields.project}`);
      }
      cfg.project = fields.project ?? undefined;
    }
    if (fields.cwd !== undefined) {
      if (!existsSync(fields.cwd) || !statSync(fields.cwd).isDirectory()) {
        throw new PluginAgentError('invalid', `cwd is not an existing directory: ${fields.cwd}`);
      }
      cfg.cwd = fields.cwd;
    }
    if (fields.directives !== undefined) cfg.directives = fields.directives ?? undefined;
    if (fields.look !== undefined) {
      try {
        // `null` stays in the patch: the config write reads it as "clear the look".
        cfg.look = parseAgentLook(fields.look, catalogKeeping(mascotPartCatalog(), current?.look));
      } catch (err) {
        throw new PluginAgentError('invalid', (err as Error).message);
      }
    }
    if (fields.avatar !== undefined) {
      try {
        cfg.avatar = parseAgentAvatar(fields.avatar);
      } catch (err) {
        throw new PluginAgentError('invalid', (err as Error).message);
      }
    }
    if (fields.memoryScope !== undefined) cfg.memory_scope = fields.memoryScope;
    if (!scope.superadmin) {
      const refusal = agentConfigRefusal(cfg, current, RESTRICTED);
      if (refusal) throw new PluginAgentError('forbidden', refusal);
    }
    // Checked after secu-4, which refuses any `mcp_servers` it was not granted:
    // the servers this plugin declared are its own to hand to its own agents.
    if (fields.mcpServers !== undefined) cfg.mcp_servers = mcpServersOf(fields.mcpServers);
    if (fields.team !== undefined) {
      if (fields.team !== null && !visibleTeams().some((t) => t.id === fields.team)) {
        throw new PluginAgentError('invalid', `unknown team: ${fields.team}`);
      }
      cfg.team = fields.team;
    }
    if (fields.reportsTo !== undefined) cfg.reports_to = reportsToOf(fields.reportsTo, selfName);
    return cfg as Partial<AgentConfig>;
  };

  /** The manager, canonical, or `null` for the derived default. The same check
   *  as the agents routes (existing agent, not itself, no cycle). A job sees
   *  only its own agents, so it may name only those: another's answers like a
   *  missing one, and a plugin cannot hand its agent a manager it cannot see. */
  const reportsToOf = (value: string | null, self: string): string | null => {
    let manager: string | null;
    try {
      manager = checkReportsTo(self, value);
    } catch (err) {
      throw new PluginAgentError('invalid', (err as Error).message);
    }
    if (manager && scope.job && loadConfig(manager).created_by !== origin) {
      throw new PluginAgentError('invalid', `reports_to: unknown agent "${value}"`);
    }
    return manager;
  };

  /** A request: the account's teams. A job acts for no account: only the
   *  teams no account owns, never a user's, whose bots it could then reach.
   *  A request without an account is read like a job: `listTeams(null)` means
   *  "every team", so falling through to it would open all of them. Ownerless
   *  teams, not none: they are what `createTeam` makes without an account, so
   *  the plugin keeps seeing its own, as `visibleTo` lets an automation
   *  facade's caller without an account see what the plugin owns and nothing
   *  of any account. A superadmin always carries its account. */
  const visibleTeams = () => !scope.job && scope.viewer
    ? dbApi.listTeams(scope.viewer)
    : dbApi.listTeams(null).filter((t) => t.owner_user_id === null);

  const mcpServersOf = (ids: readonly string[]): string[] => {
    const out: string[] = [];
    for (const id of ids) {
      const server = getMcp(id);
      if (!server) throw new PluginAgentError('invalid', `unknown MCP server: ${id}`);
      if (!scope.superadmin && server.created_by?.agent !== origin) {
        throw new PluginAgentError('forbidden', `MCP server ${id} was not declared by this plugin`);
      }
      if (!out.includes(id)) out.push(id);
    }
    return out;
  };

  /** Checked before any write, so a refused skill leaves no half-made agent. */
  const checkSkills = (ids: readonly string[]): void => {
    for (const id of ids) {
      if (!isSkillId(id)) throw new PluginAgentError('invalid', `invalid skill id: ${id}`);
      const file = skillFile(id);
      if (!existsSync(file)) throw new PluginAgentError('invalid', `unknown skill: ${id}`);
      if (!scope.superadmin && declaresAllowedTools(readFileSync(file, 'utf8'))) {
        throw new PluginAgentError('forbidden', `skill ${id} pre-authorises tools: attaching it needs a superadmin`);
      }
    }
  };

  const facade: ScopedAgents = {
    async list() {
      const { listAgents } = await import('../agent.js');
      return listAgents()
        .filter((a) => !a.ephemeral && (!scope.job || a.created_by === origin))
        .map(view);
    },

    async create(input) {
      const fields = parse(CreateSchema, input);
      validName(fields.name);
      if (existsSync(agentDir(canonicalAgentName(fields.name)))) {
        throw new PluginAgentError('conflict', `agent already exists: ${fields.name}`);
      }
      if (fields.skills) checkSkills(fields.skills);
      const cfg = configOf(fields, null, fields.name) as AgentConfig;
      const { getAgent, upsertAgent } = await import('../agent.js');
      const { defaultExcludedMcpIds } = await import('../mcp.js');
      // Same default as `POST /api/agents`: external MCP connectors start off,
      // each loads its whole tool catalogue into every turn.
      cfg.excluded_mcp_servers = defaultExcludedMcpIds();
      // The mark is written with the agent: the `agent_created` event the write
      // publishes already says who created it.
      upsertAgent({ name: fields.name, system_prompt: fields.systemPrompt, config: cfg }, { createdBy: origin });
      if (fields.skills) setAgentSkills(canonicalAgentName(fields.name), fields.skills, { prune: true });
      return view(getAgent(fields.name)!);
    },

    async update(name, patch) {
      const fields = parse(PatchSchema, patch);
      const { name: target, config: current } = resolveOwnAgent(scope, name);
      if (fields.skills) checkSkills(fields.skills);
      const cfg = configOf(fields, current, target);
      const { getAgent, killRunningForAgent, patchAgentConfig, upsertAgent } = await import('../agent.js');
      if (fields.systemPrompt !== undefined) {
        upsertAgent({ name: target, system_prompt: fields.systemPrompt, config: { ...current, ...cfg } });
      } else if (Object.keys(cfg).length > 0) {
        patchAgentConfig(target, cfg);
      }
      if (fields.skills) setAgentSkills(target, fields.skills, { prune: true });
      if (fields.systemPrompt !== undefined || fields.skills !== undefined || RESPAWN_KEYS.some((k) => k in cfg)) {
        killRunningForAgent(target);
      }
      return view(getAgent(target)!);
    },

    async delete(name, options = {}) {
      const purge = parse(DeleteOptionsSchema, options).purge === true;
      const { name: target, config } = resolveOwnAgent(scope, name);
      // A purge leaves nothing to restore: only for the plugin's own agents,
      // so a superadmin's request cannot turn it on an agent somebody made.
      if (purge && config.created_by !== origin) {
        throw new PluginAgentError('forbidden', `agent ${target} was not created by this plugin: it cannot be purged`);
      }
      const refusal = mainSeatRemovalRefusal(target);
      if (refusal) throw new PluginAgentError('conflict', refusal);
      const { deleteAgent } = await import('../agent.js');
      return deleteAgent(target, { purge, deletedBy: `plugin:${scope.pluginId}` });
    },

    async rename(name, newName) {
      const { name: target } = resolveOwnAgent(scope, name);
      const fresh = parse(NameSchema, newName);
      validName(fresh);
      // Names are resolved case-insensitively (`create` refuses `Foo` next to
      // `foo`), whatever the file system says; the agent itself may change case.
      const clash = canonicalAgentName(fresh);
      if (agentNameKey(clash) !== agentNameKey(target) && existsSync(agentDir(clash))) {
        throw new PluginAgentError('conflict', `agent already exists: ${fresh}`);
      }
      const result = renameAgentKeepingSeat(target, fresh);
      if (!result.ok) throw new PluginAgentError('conflict', result.error ?? 'rename refused');
      const { getAgent } = await import('../agent.js');
      return view(getAgent(fresh)!);
    },

    async setAvatar(name, avatar) {
      const { name: target } = resolveOwnAgent(scope, name);
      const input = parse(agentAvatarSchema, avatar);
      try {
        return applyAgentAvatar(target, input)?.icon_url ?? null;
      } catch (err) {
        // The picture is refused by the image reader (type, size, signature).
        throw new PluginAgentError('invalid', (err as Error).message);
      }
    },

    async listTeams() {
      return visibleTeams().map(teamView);
    },

    async createTeam(input) {
      const fields = parse(TeamSchema, input);
      const row = dbApi.createTeam(`tm-${randomUUID()}`, fields.name, {
        color: fields.color ?? null,
        ownerUserId: scope.viewer?.id ?? null,
      });
      return teamView(row);
    },

    async deleteTeam(id) {
      const teamId = parse(TeamIdSchema, id);
      if (!visibleTeams().some((t) => t.id === teamId)) return false;
      const { listAgents, patchAgentConfig } = await import('../agent.js');
      const members = listAgents().filter((a) => a.team === teamId);
      // Removing a team frees its members: a plugin frees only its own agents,
      // never one an account put there (superadmin caller aside).
      const foreign = members.find((a) => a.created_by !== origin);
      if (foreign && !scope.superadmin) {
        throw new PluginAgentError('forbidden', `team ${teamId} holds agents this plugin did not create`);
      }
      for (const member of members) patchAgentConfig(member.name, { team: null });
      return dbApi.deleteTeam(teamId, scope.job ? null : scope.viewer ?? null);
    },
  };
  // The events a write causes name this plugin as its writer.
  const writer = { kind: 'plugin', id: scope.pluginId } as const;
  return {
    list: facade.list,
    create: (input) => withWriteOrigin(writer, () => facade.create(input)),
    update: (name, patch) => withWriteOrigin(writer, () => facade.update(name, patch)),
    delete: (name, options) => withWriteOrigin(writer, () => facade.delete(name, options)),
    rename: (name, newName) => withWriteOrigin(writer, () => facade.rename(name, newName)),
    setAvatar: (name, avatar) => withWriteOrigin(writer, () => facade.setAvatar(name, avatar)),
    listTeams: facade.listTeams,
    createTeam: (input) => withWriteOrigin(writer, () => facade.createTeam(input)),
    deleteTeam: (id) => withWriteOrigin(writer, () => facade.deleteTeam(id)),
  };
}
