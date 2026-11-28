/**
 * secu-4 — sensitive overrides carried by a request BODY.
 *
 * secu-1 gated the routes (`agents:manage`, `missions:spawn`); this module
 * restricts what a caller who HAS those permissions but is NOT superadmin may
 * put in the payload. The threat is the same one the audit describes
 * (`docs/AUDIT-SECU.md` constat #1): the daemon spawns CLIs as child processes
 * under the user's OS account, so "which tools may run without a card" and "in which
 * directory" are privilege, not preference.
 *
 * Shared by `http-helpers.ts` (spawn) and `plugins-bundled/agents/routes.ts`
 * (agent create/patch) — two owners, hence a module of its own rather than a
 * helper inside either.
 *
 * Everything here fails CLOSED: what cannot be proven safe is refused. That is
 * the opposite polarity of the dispatcher's catalogue lookups, which degrade to
 * "let the CLI decide" on an unknown slug.
 */
import type { Request, Response } from 'express';
import { existsSync, realpathSync } from 'node:fs';
import { sep } from 'node:path';
import { dbApi } from '../db.js';
import { auditRequest } from './audit-actor.js';
import { isPersonAuth, requestHasPermission, forbidden } from './identity.js';
import { isDeveloperAccount } from './agent-permissions.js';
import { userAllows } from './permissions.js';
import { catalogBackend, catalogClaimsModel, resolvedPermissionModeFor } from '../backends/catalog.js';
import { implicitBackendName, defaultBackendName } from '../backends/index.js';
import { accountInstanceRefusal } from '../backends/account-launch.js';
import { loadConfig, storedComputerUseApps, storedComputerUseExcludedApps, type AgentConfig } from '../agent-config.js';
import { delegationRefusal } from '../delegation-guard.js';
import { getMcp } from '../mcp.js';
import { isInjectedMcpServer } from '../injected-mcp.js';
import { readSkillsAllowedTools } from '../skills.js';
import { isSkillId, resolveAgentSkills } from '../skill-attachments.js';
import { projectFromCwd } from '../task-project.js';
import { skillFile } from '../paths.js';

/**
 * A caller who is exempt from these checks.
 *
 * `!req.auth` is the same first-run hole as `rejectIfDenied`: no identity means
 * the users table is still empty (setup) or the deployment never enabled auth,
 * and the historical open API stays. The daemon-token is superadmin, which is
 * what keeps the CLI and the dispatcher working.
 */
export function isPrivilegedCaller(req: Request): boolean {
  return !req.auth || req.auth.isSuperadmin;
}

/**
 * Opt-in to the power-user path: choose the backend, the permission level, the
 * tools and the MCP servers of an agent, a spawn or a task, up to the caller's
 * own level. A superadmin (and the `Administration` preset, `*`) holds it
 * implicitly, mission tokens of such a launcher carry it too
 * (`MISSION_TOKEN_PERMISSIONS`); an employee does not unless a role grants it.
 * For a mission token it never covers adding a tool or a stdio MCP server:
 * that takes a person (`agentWideningRefusal`).
 */
export const PRIVILEGED_CONFIG_PERMISSION = 'agents:privileged-config';

/**
 * What a caller who is NOT unrestricted may put in a payload.
 *
 * `relaxed` = holds `agents:privileged-config`: any recognised permission mode
 * up to `ceiling`, any known backend, tools and MCP servers unbounded here —
 * an agent's token is bounded on those by `agentWideningRefusal` first. The
 * ceiling is the caller's own effective level (its mission's override, else its
 * agent's `permission_mode`): nobody hands out more than they hold, and
 * `bypassPermissions` may be passed on by an agent that already runs in it.
 * `ceiling === null` = no mission behind the call (a human session): no cap.
 * Not relaxed = the conservative rules this module always applied.
 */
export type OverrideAuthority = {
  relaxed: boolean;
  ceiling: string | null;
  /**
   * Whose subscription accounts a `claude@<id>` instance may name: the
   * caller's account id, `null` for a caller nobody owns (a plugin, a mission
   * without owner: instance accounts only, as at launch). Absent = no limit,
   * the unrestricted callers who may use every account.
   */
  accountUser?: string | null;
};

export const RESTRICTED: OverrideAuthority = { relaxed: false, ceiling: null, accountUser: null };

/**
 * Rank of every permission mode a caller may name, both families on one scale.
 * Claude's modes and the sandbox names of the codex-like dialects (`codex.ts`
 * `sandboxModeForCodex`, `copilot.ts` `permissionArgs`) describe the same three
 * steps, so they share a rank:
 *
 *   plan ≈ read-only · acceptEdits · auto ≈ workspace-write · bypassPermissions ≈ danger-full-access
 *
 * What is STORED is the Claude name (`canonicalPermissionMode`).
 *
 * A level absent from this table is refused even when relaxed: a typo must not
 * become "no ceiling" (fail closed).
 */
const PERMISSION_RANK: ReadonlyMap<string, number> = new Map([
  ['plan', 0], ['read-only', 0],
  ['default', 1],
  ['acceptEdits', 2],
  ['auto', 3], ['workspace-write', 3],
  ['dontAsk', 4],
  ['bypassPermissions', 5], ['danger-full-access', 5],
]);

/**
 * The sandbox names, as the Claude mode every dialect understands.
 *
 * Judging `read-only` at rank 0 is not enough: what ends up in `config.json`
 * is read by whichever dialect runs the agent, and not all of them know the
 * name. Claude passes it straight to `--permission-mode` (the agent would fail
 * at spawn). Codex and copilot treat both spellings alike, so storing the
 * Claude name is lossless.
 */
const MODE_ALIAS: ReadonlyMap<string, string> = new Map([
  ['read-only', 'plan'],
  ['workspace-write', 'auto'],
  ['danger-full-access', 'bypassPermissions'],
]);

export function canonicalPermissionMode(mode: string): string {
  return MODE_ALIAS.get(mode) ?? mode;
}

/**
 * Rewrite `body[key]` to its canonical name before it is stored. A value equal
 * to `keep` (what the agent already holds) is left alone: nothing changes, and
 * a re-save must not churn a config an administrator wrote.
 */
export function canonicalizePermissionMode(
  body: { [k: string]: unknown },
  key: string,
  keep?: string | null,
): void {
  const value = body[key];
  if (typeof value !== 'string' || value === keep) return;
  body[key] = canonicalPermissionMode(value);
}

/** What a sandbox dialect runs a plain `default`/`acceptEdits` agent in. */
const SANDBOX_FLOOR = 'auto';

function levelOf(mode: string | null | undefined): number | null {
  return PERMISSION_RANK.get(mode ?? 'default') ?? null;
}

/**
 * The level a caller really runs in, as a mode name.
 *
 * First the mode the backend really honours (`resolvedPermissionModeFor`): on a
 * provider that declares its supported modes, any other one runs in `plan`.
 * Then a sandbox dialect freezes privileges at spawn and has no card: its `default`
 * (and an unset mode, which reads as `default`) is the workspace-write sandbox,
 * not the lowest rung of Claude's ladder. Taking the label at face value would
 * cap a codex agent that never set a mode at `default`, below the very sandbox
 * it runs in, and refuse every mode it asks for. `plan`/`read-only` stay as they
 * are: those sandboxes really are read-only.
 */
export function effectiveLevel(mode: string | null | undefined, backend: string): string {
  const label = resolvedPermissionModeFor(backend, mode) ?? 'default';
  const rank = levelOf(label);
  if (rank === null || rank === 0) return label;
  if (catalogBackend(backend)?.permissionModel !== 'sandbox') return label;
  return rank < (PERMISSION_RANK.get(SANDBOX_FLOOR) ?? rank) ? SANDBOX_FLOOR : label;
}

/** The effective permission level of the mission a request is bound to, or null. */
function callerCeiling(req: Request): string | null {
  const auth = req.auth;
  if (!auth || auth.kind !== 'api-token' || !auth.missionId) return null;
  const mission = dbApi.getMission(auth.missionId);
  if (!mission) return 'plan'; // fails closed: a vanished mission hands nothing out
  let cfg: AgentConfig = {};
  try { cfg = loadConfig(mission.agent_name); } catch { /* an unreadable config is a bare agent */ }
  const backend = mission.backend_override ?? cfg.backend ?? defaultBackendName();
  return effectiveLevel(mission.permission_mode_override || cfg.permission_mode, backend);
}

/**
 * The authority of the account a mission acts as, rebuilt from the data for the
 * moments no request is left to read it from (the dispatcher seeding an agent
 * for a task a mission created, TIM-0082). Same answer `overrideAuthority`
 * gives the mission's own token: an open install has no account to restrict, a
 * developer account is unrestricted, any other account is relaxed only when it
 * holds `agents:privileged-config`, and a mission nobody owns holds nothing.
 */
export function missionOverrideAuthority(missionId: string): OverrideAuthority {
  if (dbApi.countUsers() === 0) return { relaxed: true, ceiling: null };
  const ownerId = dbApi.missionOwnerId(missionId);
  const owner = ownerId ? dbApi.getUserById(ownerId) : undefined;
  if (!owner || owner.status !== 'active') return RESTRICTED;
  if (owner.is_superadmin) return { relaxed: true, ceiling: null };
  const relaxed = isDeveloperAccount(owner)
    || userAllows(owner, dbApi.listPermissionsForUser(owner.id), PRIVILEGED_CONFIG_PERMISSION);
  return { relaxed, ceiling: null, accountUser: owner.id };
}

/** Who is calling, for the refusal functions below. Unrestricted callers never reach them. */
export function overrideAuthority(req: Request): OverrideAuthority {
  if (isPrivilegedCaller(req)) return { relaxed: true, ceiling: null };
  // A mission token authenticates as its mission's owner (`api-tokens.ts`).
  const accountUser = req.auth?.user?.id ?? null;
  if (!requestHasPermission(req, PRIVILEGED_CONFIG_PERMISSION)) return { ...RESTRICTED, accountUser };
  return { relaxed: true, ceiling: callerCeiling(req), accountUser };
}

/**
 * Mode check shared by agents, spawns, tasks and live missions.
 *
 * It judges the HIGHER of the mode asked for and the mode it resolves to on
 * `backend` (a provider that declares its supported modes runs any other one
 * in `plan`). Resolution never raises a mode, so in practice this is the mode
 * as asked; the resolved one only names, in the message, what the agent would
 * really get.
 *
 * Why not the resolved mode alone: spawns, tasks and agent configs store the
 * mode as asked, and a stored mode is not judged again when the backend it runs
 * on changes (a task or a mission falling back to another backend when its
 * quota runs dry). Judged as `plan`, an `auto` asked for on grok by a caller
 * capped at `plan` would run as `auto` the day the task fell back to claude.
 * The live-mission route stores the resolved mode instead, so what it judges
 * is what it keeps.
 *
 * A name nobody knows is refused as such: once stored, it would reach the next
 * backend the agent is moved to.
 */
function modeRefusal(mode: unknown, authority: OverrideAuthority, label: string, backend?: string): string | null {
  if (typeof mode !== 'string') return `${label} is not allowed: ${String(mode)}`;
  const runs = backend === undefined ? mode : resolvedPermissionModeFor(backend, mode) ?? mode;
  const shown = runs === mode ? mode : `${mode} (runs as ${runs} on backend ${backend})`;
  if (!authority.relaxed) {
    return SAFE_PERMISSION_MODES.includes(mode as never) && SAFE_PERMISSION_MODES.includes(runs as never)
      ? null
      : `${label} is not allowed: ${shown} (allowed: ${SAFE_PERMISSION_MODES.join(', ')}; any other level needs the ${PRIVILEGED_CONFIG_PERMISSION} permission)`;
  }
  const asked = levelOf(mode);
  const resolved = levelOf(runs);
  if (asked === null || resolved === null) {
    return `${label} is not a known permission mode: ${mode} (known: ${[...PERMISSION_RANK.keys()].join(', ')})`;
  }
  const wanted = Math.max(asked, resolved);
  if (authority.ceiling !== null) {
    const own = levelOf(authority.ceiling);
    if (own === null || wanted > own) {
      return `${label} ${shown} is above the caller's own level (${authority.ceiling}): an agent hands out at most the level it runs in`;
    }
  }
  return null;
}

/** Whether `mode` names a rung of the permission ladder, in either family. */
export function isKnownPermissionMode(mode: string): boolean {
  return PERMISSION_RANK.has(mode);
}

/**
 * The mode check alone, for a change of level on a mission that is already
 * running (`POST /api/missions/:id/permission-mode`). Raising a live mission is
 * the same decision as launching it at that level, so it takes the same grid,
 * on the backend serving the mission.
 */
export function permissionModeRefusal(mode: string, authority: OverrideAuthority, backend?: string): string | null {
  return modeRefusal(mode, authority, 'permission_mode', backend);
}

/**
 * 403 + audit trail. Every refusal is recorded: an employee probing which
 * overrides are accepted is exactly the signal an operator wants to see, and
 * the 403 alone leaves no trace.
 */
export function rejectOverride(
  req: Request,
  res: Response,
  action: string,
  target: string | null,
  reason: string,
): true {
  // The specific `action.denied` row stays here (it names the override being
  // probed); `forbidden` does not add `authz.denied` for `kind: 'override'`.
  auditRequest(req, action, target ? `${target} — ${reason}` : reason);
  return forbidden(req, res, { kind: 'override', reason });
}

/**
 * Permission modes a non-superadmin may ask for.
 *
 * `plan` (read-only) and `auto` (the mode the product's own dispatcher writes)
 * are included on purpose: on an `mcp-bridge` backend every mode except
 * `bypassPermissions` still binds `--permission-prompt-tool`, so the card and
 * the classifier remain in the loop. Anything not listed — `bypassPermissions`,
 * `dontAsk`, `danger-full-access`, a typo — is refused.
 */
const SAFE_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto'] as const;

/**
 * Backends a non-superadmin may select.
 *
 * The criterion is a CAPABILITY, never a name: only `mcp-bridge` can hand a
 * tool use back to TIMON mid-turn (Allow/Deny card + classifier). A `sandbox`
 * dialect freezes privileges at spawn, with no card: its `default` already
 * edits and runs commands in a workspace sandbox (`effectiveLevel`), so letting
 * a non-admin pick the backend would quietly widen what `SAFE_PERMISSION_MODES`
 * lets through.
 *
 * This only constrains an explicit override: an agent already configured on a
 * sandbox backend by an admin keeps running on it.
 */
function backendRefusal(backend: string, authority: OverrideAuthority): string | null {
  const entry = catalogBackend(backend);
  if (!entry) return `unknown backend: ${backend}`;
  // Checked where the value is written, not only at launch: an account the
  // caller may not use would otherwise sit in an agent or a task until a
  // mission failed on it, under someone else's name.
  if (authority.accountUser !== undefined) {
    const refusal = accountInstanceRefusal(backend, authority.accountUser);
    if (refusal) return refusal;
  }
  // A relaxed caller picks any backend: the level it asks for is already capped
  // by its own, and `modeRefusal` is what binds the sandbox dialects.
  // A remote one starts nothing here: the sandbox escalation this rule guards
  // against (a dialect running guarded modes unarbitrated ON THIS HOST) has no
  // host to land on. Whose gateway it reaches is decided at launch,
  // from the launching account's own connection.
  if (!authority.relaxed && entry.permissionModel !== 'mcp-bridge' && !entry.remote) {
    return `backend ${backend} cannot arbitrate tool uses per call (${entry.permissionModel}): selecting it needs the ${PRIVILEGED_CONFIG_PERMISSION} permission, leave backend unset to inherit`;
  }
  return null;
}

function modelRefusal(backend: string, model: string): string | null {
  if (!catalogClaimsModel(backend, model)) {
    return `model ${model} is not in the catalogue of backend ${backend}`;
  }
  return null;
}

/**
 * Does `declared` already cover `requested`?
 *
 * Conservative on purpose, and never symmetric:
 *   - exact match;
 *   - a bare base (`Bash`) covers any of its specialisations (`Bash(git:*)`);
 *   - a literal prefix (`Bash(git:*)`) covers what extends it (`Bash(git:log)`).
 * A declared specialisation NEVER covers the bare base — that would turn
 * `Bash(git:*)` into a full shell.
 */
function toolCovered(requested: string, declared: readonly string[]): boolean {
  const want = requested.trim();
  if (!want) return true;
  const wantBase = want.split('(')[0]!.trim();
  return declared.some((raw) => {
    const have = raw.trim();
    if (have === want) return true;
    if (!have.includes('(')) return have === wantBase;
    if (!have.endsWith('*)')) return false;
    const prefix = have.slice(0, -2); // "Bash(git:*)" → "Bash(git:"
    return want.startsWith(prefix);
  });
}

function asStringArray(value: unknown): string[] | null {
  if (value === undefined || value === null) return null;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) return null;
  return value as string[];
}

/**
 * Roots a non-superadmin may point a `cwd` at: the working directories the
 * projects already declare. No project with a `cwd` = no arbitrary path at all,
 * which is the intended direction (constat #4: the cwd is not a jail, so the
 * only defence is choosing it).
 */
function projectRoots(): string[] {
  const roots: string[] = [];
  for (const row of dbApi.listProjectRows()) {
    if (row.cwd) {
      const real = safeRealpath(row.cwd);
      if (real) roots.push(real);
    }
  }
  return roots;
}

function safeRealpath(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

/** Segment-aware containment: `/srv/foo-bar` is NOT inside `/srv/foo`. */
function isInside(child: string, root: string): boolean {
  return child === root || child.startsWith(root.endsWith(sep) ? root : root + sep);
}

function cwdRefusal(cwd: string): string | null {
  // Symlinks are resolved FIRST: comparing the raw path would let
  // `<project>/link-to-home` pass a prefix check while landing in ~.
  const real = safeRealpath(cwd);
  if (!real) return `cwd cannot be resolved: ${cwd} (the directory must exist on the host, and lie inside a registered project)`;
  const roots = projectRoots();
  if (!roots.some((root) => isInside(real, root))) {
    return `cwd is outside every project working directory: ${cwd}. `
      + 'Register the project first (project_create with this directory as its cwd), '
      + 'then give the agent that directory or a sub-folder of it';
  }
  return null;
}

/* ── Spawn body (POST /api/missions, POST /api/agents/spawn) ─────────────── */

export type SpawnOverrides = {
  permission_mode?: unknown;
  extra_allowed_tools?: unknown;
  extra_mcp_servers?: unknown;
  mcp_servers?: unknown;
  allowed_tools?: unknown;
  backend_override?: unknown;
  model_override?: unknown;
};

/**
 * Why the target agent's config is the yardstick: an override widens what an
 * admin already granted to that agent. Same set = no escalation; anything more
 * = the caller is asking for a privilege nobody gave the agent.
 */
export function spawnOverrideRefusal(
  body: SpawnOverrides,
  agentConfig: AgentConfig | null,
  authority: OverrideAuthority = RESTRICTED,
): string | null {
  // `permission_mode` is not read by `spawnAgent` today. Refusing it loudly
  // beats ignoring it silently: a caller who sends it believes it applies.
  // Judged on the backend it would run on (the override, else the agent's);
  // an invalid override is refused below.
  if (body.permission_mode !== undefined) {
    const runsOn = typeof body.backend_override === 'string'
      ? body.backend_override
      : agentConfig?.backend ?? implicitBackendName();
    const refusal = modeRefusal(body.permission_mode, authority, 'permission_mode override', runsOn);
    if (refusal) return refusal;
  }
  for (const key of ['allowed_tools', 'mcp_servers'] as const) {
    if (body[key] !== undefined) return `${key} cannot be overridden per spawn`;
  }

  const declaredTools = agentConfig?.allowed_tools ?? [];
  const extraTools = body.extra_allowed_tools;
  if (extraTools !== undefined) {
    const list = asStringArray(extraTools);
    if (!list) return 'extra_allowed_tools must be an array of strings';
    for (const tool of authority.relaxed ? [] : list) {
      if (!toolCovered(tool, declaredTools)) {
        return `extra_allowed_tools widens the agent's tools: ${tool}`;
      }
    }
  }

  const declaredMcp = agentConfig?.mcp_servers ?? [];
  const extraMcp = body.extra_mcp_servers;
  if (extraMcp !== undefined) {
    const list = asStringArray(extraMcp);
    if (!list) return 'extra_mcp_servers must be an array of strings';
    for (const id of authority.relaxed ? [] : list) {
      if (!declaredMcp.includes(id)) {
        return `extra_mcp_servers is not declared by the agent: ${id}`;
      }
    }
  }

  let backend = agentConfig?.backend ?? implicitBackendName();
  const backendOverride = body.backend_override;
  if (backendOverride !== undefined && backendOverride !== null) {
    if (typeof backendOverride !== 'string') return 'backend_override must be a string';
    const refusal = backendRefusal(backendOverride, authority);
    if (refusal) return refusal;
    backend = backendOverride;
  }
  const modelOverride = body.model_override;
  if (modelOverride !== undefined && modelOverride !== null) {
    if (typeof modelOverride !== 'string') return 'model_override must be a string';
    const refusal = modelRefusal(backend, modelOverride);
    if (refusal) return refusal;
  }
  return null;
}

/* ── Widening what an agent runs: a person only ─────────────────────────── */

/**
 * An agent calling with its own token: a mission's (a verified developer-owner
 * one included) or a plugin job's. Never a person: a session cookie and a
 * paired device are people, the daemon-token is the operator's CLI.
 */
export function isAgentToken(req: Pick<Request, 'auth'>): boolean {
  return req.auth?.kind === 'api-token';
}

/**
 * Whether an agent's token may attach MCP server `id` to an agent without a
 * person: an http server (a url, judged by `mcpWriteRefusal` when declared), an
 * account connector, or one Timon injects itself. A stdio server is a command
 * the host runs outside the permission classifier; an id nothing declares yet
 * fails closed, since a person declaring it later as stdio would hand it to the
 * agent without anyone deciding.
 */
function agentAttachableMcp(id: string): boolean {
  let server: ReturnType<typeof getMcp>;
  try { server = getMcp(id); } catch { return false; }
  if (!server) return isInjectedMcpServer(id);
  return server.transport.type === 'http' || server.transport.type === 'external';
}

export type WideningRequest = {
  allowed_tools?: unknown;
  mcp_servers?: unknown;
  disallowed_tools?: unknown;
  computer_use?: unknown;
  computer_use_apps?: unknown;
  computer_use_mode?: unknown;
};

export type WideningGrant = {
  allowed_tools?: readonly string[] | null;
  mcp_servers?: readonly string[] | null;
  disallowed_tools?: readonly string[] | null;
  computer_use?: boolean | null;
  /** As stored: bare names or `{ app, mode }` objects. */
  computer_use_apps?: readonly unknown[] | null;
  computer_use_mode?: string | null;
} | null;

/**
 * The maintainer's decision of 08/11/2026: adding a tool to an agent, or
 * attaching a stdio MCP server to it, needs a person, whatever the calling
 * agent's account holds (`agents:privileged-config` included). An agent a
 * prompt injection steers would otherwise put `Bash` in another agent's
 * `allowed_tools`, or a command of its choosing in its MCP servers, and run it
 * on the host at that agent's next turn, with no card.
 *
 * `granted` is what the agent already holds (null for a new agent): keeping it,
 * or narrowing it, grants nothing and passes. Lifting a `disallowed_tools`
 * entry widens too. An http MCP server stays under the usual rules
 * (`agentConfigRefusal`, `mcpWriteRefusal`). `labels` names the fields as the
 * caller sent them (`extra_allowed_tools` on a spawn or a task).
 *
 * Pure, for the paths with no request (the dispatcher); `agentWideningDenied`
 * applies it to a request.
 */
export function agentWideningRefusal(
  wanted: WideningRequest,
  granted: WideningGrant,
  labels: Partial<Record<keyof WideningRequest, string>> = {},
): string | null {
  const label = (key: keyof WideningRequest): string => labels[key] ?? key;
  const listOf = (key: keyof WideningRequest): string[] | null | 'invalid' => {
    const value = wanted[key];
    if (value === undefined || value === null) return null;
    return asStringArray(value) ?? 'invalid';
  };

  // Controlling the host's mouse and keyboard: only a person grants it.
  if (wanted.computer_use !== undefined && wanted.computer_use !== null) {
    if (typeof wanted.computer_use !== 'boolean') return `${label('computer_use')} must be a boolean`;
    if (wanted.computer_use && granted?.computer_use !== true) {
      return `${label('computer_use')} turns on control of the host's mouse and keyboard: an agent's token cannot grant it, whatever its account holds. `
        + 'A person turns it on from the Agents page of the app. Turning it off, or sending it unchanged, is accepted';
    }
  }

  // The applications the agent may act in: an agent's token can keep or narrow the list, never add to it,
  // and never move an application from background to foreground (foreground takes the user's screen).
  const apps = wanted.computer_use_apps;
  if (apps !== undefined && apps !== null) {
    if (!Array.isArray(apps) || apps.some((entry) => typeof entry !== 'string' && !(entry && typeof entry === 'object' && typeof (entry as { app?: unknown }).app === 'string'))) {
      return `${label('computer_use_apps')} must be an array of strings or { app, mode } objects`;
    }
    const grantedMode = granted?.computer_use_mode === 'background' ? 'background' : 'foreground';
    const held = new Map(storedComputerUseApps({ computer_use_apps: granted?.computer_use_apps as never, computer_use_mode: grantedMode })
      .map((entry) => [entry.app.toLowerCase(), entry.mode]));
    // A bare name inherits the default mode, which an agent cannot change either.
    for (const entry of storedComputerUseApps({ computer_use_apps: apps as never, computer_use_mode: grantedMode })) {
      const mode = held.get(entry.app.toLowerCase());
      if (mode === undefined) {
        return `${label('computer_use_apps')} adds ${entry.app}: an agent's token cannot widen the applications an agent may control, whatever its account holds. `
          + 'A person edits the list from the Agents page of the app. Removing entries, or sending the list unchanged, is accepted';
      }
      if (mode === 'background' && entry.mode === 'foreground') {
        return `${label('computer_use_apps')} moves ${entry.app} from background to foreground: an agent's token cannot widen how an application is driven, whatever its account holds. `
          + 'A person sets the mode from the Agents page of the app. Sending it unchanged, or moving it to background, is accepted';
      }
    }
  }

  // The mode decides whether the agent may take the user's screen, mouse and keyboard: only a person changes it.
  if (wanted.computer_use_mode !== undefined && wanted.computer_use_mode !== null) {
    if (wanted.computer_use_mode !== 'foreground' && wanted.computer_use_mode !== 'background') return `${label('computer_use_mode')} must be 'foreground' or 'background'`;
    const current = granted?.computer_use_mode === 'background' ? 'background' : 'foreground';
    if (wanted.computer_use_mode !== current) {
      return `${label('computer_use_mode')} changes how the agent drives the screen: an agent's token cannot change it, whatever its account holds. `
        + 'A person sets it from the Agents page of the app. Sending it unchanged is accepted';
    }
  }

  const tools = listOf('allowed_tools');
  if (tools === 'invalid') return `${label('allowed_tools')} must be an array of strings`;
  for (const tool of tools ?? []) {
    if (toolCovered(tool, granted?.allowed_tools ?? [])) continue;
    return `${label('allowed_tools')} adds ${tool}: an agent's token cannot add a tool to an agent, whatever its account holds. `
      + 'A person adds it from the Agents page of the app. Removing tools, or sending the list unchanged, is accepted';
  }

  const servers = listOf('mcp_servers');
  if (servers === 'invalid') return `${label('mcp_servers')} must be an array of strings`;
  for (const id of servers ?? []) {
    if ((granted?.mcp_servers ?? []).includes(id) || agentAttachableMcp(id)) continue;
    return `${label('mcp_servers')} attaches ${id}, a stdio MCP server or one that is not declared: it runs a command on the host, `
      + 'outside the permission classifier, and an agent\'s token cannot attach it, whatever its account holds. '
      + 'A person attaches it from the Agents page of the app. An http MCP server (a url) can be attached';
  }

  if ('disallowed_tools' in wanted && wanted.disallowed_tools !== undefined) {
    const kept = listOf('disallowed_tools');
    if (kept === 'invalid') return `${label('disallowed_tools')} must be an array of strings`;
    for (const tool of granted?.disallowed_tools ?? []) {
      if ((kept ?? []).includes(tool)) continue;
      return `${label('disallowed_tools')} lifts ${tool}: an agent's token cannot give an agent back a tool it is denied, whatever its account holds. `
        + 'A person does it from the Agents page of the app';
    }
  }
  return null;
}

/**
 * "All applications" lets an agent drive every window of the machine but the excluded ones: a
 * person turns it on, at the screen, never a token. An agent's or a mission's token, the daemon's
 * (the CLI, the MCP servers, a script) and a plugin job are all refused, whatever their account holds,
 * when they turn it on or take an application out of the exclusions. Turning it off, adding an
 * exclusion or sending the stored values back narrows and passes.
 *
 * `granted` is the stored config (null for a new agent); `actor` says whether a person calls.
 */
export function personOnlyComputerRefusal(
  wanted: { computer_use_all_apps?: unknown; computer_use_excluded_apps?: unknown },
  granted: Pick<AgentConfig, 'computer_use_all_apps' | 'computer_use_excluded_apps'> | null,
  actor: { person: boolean },
): string | null {
  if (actor.person) return null;
  if (wanted.computer_use_all_apps === true && granted?.computer_use_all_apps !== true) {
    return "computer_use_all_apps lets the agent drive every application of the machine: only a person turns it on, "
      + "from the agent's Permissions in the app, never a token (an agent's, a mission's or the daemon's). Turning it off, or sending it unchanged, is accepted";
  }
  // null restores the defaults: judged as that list, so it cannot drop what a person added.
  const excluded = wanted.computer_use_excluded_apps === null
    ? storedComputerUseExcludedApps({})
    : wanted.computer_use_excluded_apps;
  if (Array.isArray(excluded)) {
    const kept = new Set(excluded.filter((entry): entry is string => typeof entry === 'string').map((entry) => entry.trim().toLowerCase()));
    for (const held of storedComputerUseExcludedApps(granted ?? {})) {
      if (kept.has(held.toLowerCase())) continue;
      return `computer_use_excluded_apps lifts ${held}: only a person takes an application out of the exclusions, `
        + "from the agent's Permissions in the app, never a token. Adding exclusions, or sending the list unchanged, is accepted";
    }
  }
  return null;
}

/** `personOnlyComputerRefusal` for a request: a session or a paired device is a person, any token is not. */
export function personOnlyComputerDenied(
  req: Pick<Request, 'auth'>,
  wanted: { computer_use_all_apps?: unknown; computer_use_excluded_apps?: unknown },
  granted: Pick<AgentConfig, 'computer_use_all_apps' | 'computer_use_excluded_apps'> | null,
): string | null {
  return personOnlyComputerRefusal(wanted, granted, { person: isPersonAuth(req.auth) });
}

/** `agentWideningRefusal` for a request: null for anyone but an agent's token. */
export function agentWideningDenied(
  req: Pick<Request, 'auth'>,
  wanted: WideningRequest,
  granted: WideningGrant,
  labels?: Partial<Record<keyof WideningRequest, string>>,
): string | null {
  return isAgentToken(req) ? agentWideningRefusal(wanted, granted, labels) : null;
}

/**
 * The spawn and task spelling of the same rule: extras on top of the agent's
 * own config. `agentName` lets the skills the agent already resolves count as
 * granted when `extra_skills` is judged (`skillWideningRefusal`).
 */
export function spawnWideningDenied(
  req: Pick<Request, 'auth'>,
  body: SpawnExtras,
  agentConfig: AgentConfig | null,
  agentName: string | null,
): string | null {
  return isAgentToken(req) ? spawnWideningRefusal(body, agentConfig, agentName) : null;
}

export type SpawnExtras = { extra_allowed_tools?: unknown; extra_mcp_servers?: unknown; extra_skills?: unknown };

/**
 * `spawnWideningDenied` without a request: the dispatcher judges with it the
 * extras a task stored, when an agent's mission wrote them, since the route's
 * check only ran at creation and a task older than it was never judged.
 */
export function spawnWideningRefusal(
  body: SpawnExtras,
  agentConfig: AgentConfig | null,
  agentName: string | null,
): string | null {
  const refusal = agentWideningRefusal(
    { allowed_tools: body.extra_allowed_tools, mcp_servers: body.extra_mcp_servers },
    agentConfig,
    { allowed_tools: 'extra_allowed_tools', mcp_servers: 'extra_mcp_servers' },
  );
  if (refusal || body.extra_skills === undefined || body.extra_skills === null) return refusal;
  const granted = agentName === null ? [...(agentConfig?.allowed_tools ?? [])] : agentGrantedTools(agentName, agentConfig);
  return skillWideningRefusal(body.extra_skills, granted, { label: 'extra_skills' });
}

/* ── Widening through a skill: a person only ────────────────────────────── */

/**
 * The tools agent `name` already runs with: its `allowed_tools` plus what
 * every skill it resolves pre-authorises (attachments of every scope, an
 * excluded one left out: `resolveSpawnSkills` in agent.ts, which this module
 * cannot import without a cycle).
 */
export function agentGrantedTools(name: string, cfg: AgentConfig | null): string[] {
  const resolved = resolveAgentSkills({
    agent: name,
    project: cfg?.project ?? projectFromCwd(cfg?.cwd),
    role: cfg?.role ?? null,
  });
  return [...(cfg?.allowed_tools ?? []), ...readSkillsAllowedTools(resolved.map((s) => s.id))];
}

/** What skill `id` pre-authorises; nothing for an id that names no skill on disk. */
function skillTools(id: string): string[] {
  if (!isSkillId(id)) return [];
  let file: string;
  try { file = skillFile(id); } catch { return []; }
  return existsSync(file) ? readSkillsAllowedTools([id]) : [];
}

/**
 * Same rule as `agentWideningRefusal`, for the tools a skill's `allowed-tools`
 * pre-authorises: the spawn adds them to the agent's `--allowedTools`, so
 * attaching such a skill adds tools as surely as `allowed_tools` does. An agent
 * a prompt injection steers would otherwise attach a skill that declares
 * `Bash` (a product one like `git-publish`, or any a person wrote) and get a
 * shell at that agent's next turn.
 *
 * `granted` is what the agent already holds (`agentGrantedTools`): a skill
 * whose tools it covers grants nothing and passes, as does a skill that
 * declares none. An empty `granted` with `reach` set judges an attachment that
 * reaches agents nobody named (a project, a role, every agent): any declared
 * tool is refused. Removing a skill is never judged.
 */
export function skillWideningRefusal(
  skillIds: unknown,
  granted: readonly string[],
  opts: { label?: string; reach?: string } = {},
): string | null {
  if (skillIds === undefined || skillIds === null) return null;
  const label = opts.label ?? 'skills';
  const ids = typeof skillIds === 'string' ? [skillIds] : asStringArray(skillIds);
  if (!ids) return `${label} must be an array of skill ids`;
  for (const id of ids) {
    for (const tool of skillTools(id.trim())) {
      if (toolCovered(tool, granted)) continue;
      const whom = opts.reach ? `the agents ${opts.reach}` : 'an agent';
      return `${label} adds skill ${id}, which pre-authorises ${tool}: an agent's token cannot give ${whom} a tool through a skill, `
        + 'whatever its account holds. A person attaches it from the Agents or Skills page of the app. '
        + 'A skill that declares no allowed-tools can be attached; removing a skill, or sending the list unchanged, is accepted';
    }
  }
  return null;
}

/**
 * `skillWideningRefusal` for a request: null for anyone but an agent's token.
 * `skillIds` are the skills the request adds to agent `name` (`cfg` its config,
 * null for a new agent); what it already resolves counts as granted.
 */
export function skillWideningDenied(
  req: Pick<Request, 'auth'>,
  skillIds: unknown,
  name: string,
  cfg: AgentConfig | null,
  label?: string,
): string | null {
  if (!isAgentToken(req) || skillIds === undefined || skillIds === null) return null;
  return skillWideningRefusal(skillIds, agentGrantedTools(name, cfg), label === undefined ? {} : { label });
}

/* ── Agent config (POST /api/agents, PATCH /api/agents/:name/config) ─────── */

/**
 * `current` is the config already on disk, or null for a creation.
 *
 * Asymmetry is deliberate: on a NEW agent a non-superadmin declares no tool and
 * no MCP server at all (a fresh agent with `["Bash"]` IS the audit's attack);
 * on an existing one they may only narrow what an admin granted.
 *
 * A value equal to the one the agent already has grants nothing, so it is never
 * refused. That matters for `agent_update` with a new `system_prompt`, which
 * goes through the full upsert and sends the WHOLE current config back: an
 * agent an admin put on a sandbox backend, in a mode or a directory the caller
 * could not pick itself, must stay updatable.
 */
export function agentConfigRefusal(
  patch: Record<string, unknown>,
  current: AgentConfig | null,
  authority: OverrideAuthority = RESTRICTED,
): string | null {
  const same = (key: 'permission_mode' | 'model' | 'cwd'): boolean => {
    const have = current?.[key];
    const wanted = patch[key];
    if (typeof have !== 'string' || typeof wanted !== 'string') return false;
    return key === 'permission_mode'
      ? canonicalPermissionMode(have) === canonicalPermissionMode(wanted)
      : have === wanted;
  };
  // GET /api/agents/:name reports the effective backend, so an agent that never
  // declared one comes back with the default and sends it back as such.
  const backendOf = (cfg: AgentConfig | null): string => cfg?.backend ?? defaultBackendName();
  const backendSame = typeof patch.backend === 'string' && patch.backend === backendOf(current);
  const runsOn = typeof patch.backend === 'string' ? patch.backend : backendOf(current);

  if ('permission_mode' in patch && !same('permission_mode')) {
    const refusal = modeRefusal(patch.permission_mode, authority, 'permission_mode', runsOn);
    if (refusal) return refusal;
  } else if (current && typeof patch.backend === 'string' && !backendSame) {
    // The stored mode, moved off a backend that ran it lower (one that declares
    // its supported modes runs the others in `plan`): on the new backend it
    // would run as written, so it is judged as if it were asked for now.
    const stored = current.permission_mode ?? 'default';
    const ranBefore = resolvedPermissionModeFor(backendOf(current), stored);
    const runsAfter = resolvedPermissionModeFor(runsOn, stored);
    const before = levelOf(ranBefore);
    const after = levelOf(runsAfter);
    if (ranBefore !== runsAfter && (after === null || before === null || after > before)) {
      const refusal = modeRefusal(stored, authority, 'permission_mode', runsOn);
      if (refusal) return refusal;
    }
  }
  if ('backend' in patch && patch.backend !== undefined && patch.backend !== null && !backendSame) {
    if (typeof patch.backend !== 'string') return 'backend must be a string';
    const refusal = backendRefusal(patch.backend, authority);
    if (refusal) return refusal;
  }
  if ('model' in patch && patch.model !== undefined && patch.model !== null) {
    if (typeof patch.model !== 'string') return 'model must be a string';
    const backend = typeof patch.backend === 'string' ? patch.backend : backendOf(current);
    // The model of an agent that stays on its backend is the admin's choice.
    if (!(same('model') && backend === backendOf(current))) {
      const refusal = modelRefusal(backend, patch.model);
      if (refusal) return refusal;
    }
  }
  if ('cwd' in patch && patch.cwd !== undefined && patch.cwd !== null && patch.cwd !== '' && !same('cwd')) {
    if (typeof patch.cwd !== 'string') return 'cwd must be a string path';
    const refusal = cwdRefusal(patch.cwd);
    if (refusal) return refusal;
  }
  for (const key of ['allowed_tools', 'mcp_servers'] as const) {
    if (!(key in patch) || patch[key] === undefined || patch[key] === null) continue;
    const list = asStringArray(patch[key]);
    if (!list) return `${key} must be an array of strings`;
    if (authority.relaxed) continue;
    const declared = current?.[key] ?? [];
    for (const entry of list) {
      const kept = key === 'allowed_tools'
        ? toolCovered(entry, declared)
        : declared.includes(entry);
      if (!kept) {
        return `${key} widens what the agent declares: ${entry}. `
          + `${current ? 'It is not among what an administrator granted this agent' : 'A new agent declares none'}; `
          + `adding it needs the ${PRIVILEGED_CONFIG_PERMISSION} permission. Leave ${key} unset to inherit`;
      }
    }
  }
  return null;
}

/**
 * secu-4 (point 2 bis): rewriting an agent's prompt is rewriting how every
 * mission that runs with the agent's privileges will behave. The config guard
 * above lets an UNCHANGED mode/backend pass, so without this a caller in
 * `default` could otherwise rewrite the prompt of an agent an administrator
 * put in `auto`/`bypassPermissions` — the one field the guard does not cover
 * (system_prompt goes straight to `upsertAgent`; `directives`/`global_context`
 * ride the PATCH config). Refuse it when the target runs above the caller's
 * own level, or when the caller does not orchestrate the target (the same
 * semantics as delegation). Human sessions and operators have no ceiling and
 * no list: they are unrestricted.
 */
export function promptRewriteRefusal(req: Request, target: string): string | null {
  const ceiling = callerCeiling(req);
  if (ceiling !== null) {
    const current = (() => { try { return loadConfig(target); } catch { return {}; } })();
    const targetLevel = effectiveLevel(current.permission_mode, current.backend ?? defaultBackendName());
    const own = levelOf(ceiling);
    const wanted = levelOf(targetLevel);
    // Fail closed: a level we cannot rank (a mode stored by hand, a typo) is
    // treated as above the caller, never as a free pass.
    if (own === null || wanted === null || wanted > own) {
      return `the prompt of agent "${target}" runs at ${targetLevel}, above the caller's own level (${ceiling}): rewriting it is refused`;
    }
  }
  return delegationRefusal(req, target);
}

/* ── Kanban task (POST /api/tasks, PATCH /api/tasks/:id) ─────────────────── */

export type TaskOverrides = {
  permission_mode_override?: unknown;
  backend_override?: unknown;
  model_override?: unknown;
  extra_allowed_tools?: unknown;
  extra_mcp_servers?: unknown;
  /** Judged by `spawnWideningDenied` only: a skill's tools are the widening, not its id. */
  extra_skills?: unknown;
  fallback_backend_override?: unknown;
  fallback_model_override?: unknown;
};

/**
 * A backend picked now for the dispatcher to run LATER, with nobody asked at
 * that moment: a task's own fallback, a series' role or fallback rule. It lands
 * the work on that backend exactly as a `backend_override` would, so it takes
 * the same grid (TODO #561): without it, a caller refused `backend_override:
 * grok` got grok anyway as the task's fallback, or as its series' role.
 *
 * No backend named (null, '', or the `'none'` sentinel = "do not fall back")
 * selects nothing. A model is judged against the backend it rides with; one
 * sent alone keeps whatever backend is resolved, so it selects none.
 * The operator's global fallback setting is not a caller's choice and never
 * comes here.
 */
export function llmChoiceRefusal(
  choice: { backend?: unknown; model?: unknown },
  authority: OverrideAuthority,
  label: string,
): string | null {
  const { backend, model } = choice;
  if (backend === undefined || backend === null || backend === '' || backend === 'none') return null;
  if (typeof backend !== 'string') return `${label} backend must be a string`;
  const refusal = backendRefusal(backend, authority);
  if (refusal) return `${label}: ${refusal}`;
  if (model !== undefined && model !== null && model !== '') {
    if (typeof model !== 'string') return `${label} model must be a string`;
    const modelError = modelRefusal(backend, model);
    if (modelError) return `${label}: ${modelError}`;
  }
  return null;
}

/**
 * A task is a deferred spawn: the dispatcher launches it with these overrides
 * under the owner's account, so they obey the spawn rules, against the config
 * of the agent the task is assigned to. Same names as `spawnOverrideRefusal`'s
 * body, mapped from the task's columns. Its fallback is a backend selection
 * too (`llmChoiceRefusal`), bounded by no agent config.
 */
export function taskOverrideRefusal(
  body: TaskOverrides,
  agentConfig: AgentConfig | null,
  authority: OverrideAuthority,
): string | null {
  const mapped: SpawnOverrides = {};
  if (body.permission_mode_override != null) mapped.permission_mode = body.permission_mode_override;
  if (body.backend_override != null) mapped.backend_override = body.backend_override;
  if (body.model_override != null) mapped.model_override = body.model_override;
  if (body.extra_allowed_tools != null) mapped.extra_allowed_tools = body.extra_allowed_tools;
  if (body.extra_mcp_servers != null) mapped.extra_mcp_servers = body.extra_mcp_servers;
  return spawnOverrideRefusal(mapped, agentConfig, authority)
    ?? llmChoiceRefusal(
      { backend: body.fallback_backend_override, model: body.fallback_model_override },
      authority,
      'fallback_backend_override',
    );
}
