/**
 * Agent configuration — the type and its reading on disk, separate from the rest.
 *
 * Extracted from `agent.ts` to break the cycle `agent ↔ backends ↔
 * browser-sessions`: the backend dialects only needed the `AgentConfig`
 * TYPE, but importing it from `agent.ts` dragged along the whole spawn
 * engine. This module only depends on the file system and the paths.
 *
 * Verbatim move: nothing was renamed or retouched. `agent.ts`
 * re-exports everything that was public, no existing import moves.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AGENTS_DIR, agentConfig, agentDir, agentSystemPrompt } from './paths.js';
import { agentNameKey, isValidAgentName } from './agent-name.js';
import type { BackendName } from './backends/types.js';
import type { AgentRoleId } from './agent-roles.js';
import type { AgentAvatarMode, AgentLook } from './agent-look.js';

export type AgentConfig = {
  /** Manager of this agent — the single source of the agents hierarchy
   *  (graph, Company chart). Null/absent = the default: its project's lead,
   *  else its pole's lead, else the main agent (app/src/lib/hierarchy.ts).
   *  Written through PATCH /api/agents/:name/config, checked by
   *  `checkReportsTo` (existing agent, no cycle). */
  reports_to?: string | null;
  /**
   * Team id (`teams` table) for bots without a project. `null`/absent = agent
   * outside any team, i.e. the historical behaviour: it addresses and is
   * addressed by everyone. The cloisonnement only bites when the SENDER has a
   * team — see `sendAgentMessage`.
   */
  team?: string | null;
  cwd?: string;
  /** undefined inherits; null disables browsing; a profile id is an explicit,
   * owner-checked assignment frozen when each mission starts. */
  browser_profile_id?: string | null;
  /** The agent may drive the host's mouse and keyboard through the computer-use
   *  tools (`timon-computer`). Absent = off. Turning it on is a person's act: an
   *  agent's token cannot (`agentWideningRefusal`). */
  computer_use?: boolean;
  /** The only applications the agent may type or click in (bundle id, displayed name or
   *  executable name, case ignored). Empty or absent = no keyboard or mouse action at all.
   *  Widening it is a person's act, like `computer_use`. */
  computer_use_apps?: ComputerUseAppEntry[];
  /** How the agent drives the screen: `background` = accessibility only, never the user's screen,
   *  mouse or keyboard. Absent = `foreground`. Changing it is a person's act, like `computer_use_apps`. */
  computer_use_mode?: ComputerUseMode;
  /** Every application is allowed, the unlisted ones in `computer_use_mode`, minus `computer_use_excluded_apps`.
   *  Absent = off. Only a person at the screen (a session or a paired device) turns it on: an agent's,
   *  a mission's and the daemon's token cannot (`personOnlyComputerRefusal`). */
  computer_use_all_apps?: boolean;
  /** The applications never driven while `computer_use_all_apps` is on, an explicit entry included.
   *  Absent or null = `DEFAULT_COMPUTER_USE_EXCLUDED_APPS` (null is how a save restores them, since an absent key keeps
   *  the stored list). Removing an entry is a person's act, like turning the switch on. */
  computer_use_excluded_apps?: string[] | null;
  /** DEFAULT LLM backend of the agent. 'claude' (default) = long-lived Claude
   *  CLI; 'codex' = one-shot OpenAI Codex CLI on the ChatGPT subscription.
   *  The agent is AGNOSTIC: this field is only a default, overridable per
   *  mission AND per task. Single resolution chain (symmetrical with model):
   *    backend = task.backend_override ?? roleSpec.backend ?? cfg.backend ?? 'claude'
   *    model   = task.model_override   ?? roleSpec.model   ?? cfg.model   ?? default(backend)
   *  → an Opus mission and a GPT-5.5 mission can run on the SAME agent
   *  in parallel (through mission.backend_override / fork) without touching this config. */
  backend?: BackendName;
  /** DEFAULT LLM model. Prefer an alias (`opus`/`sonnet` → follows the latest
   *  version) or a full slug (`gpt-5.5`). A default
   *  overridable per mission/task — see `backend`. Must stay consistent with
   *  `backend` (a claude-* slug on the codex backend is ignored by the dispatcher). */
  model?: string;
  /** Reasoning level ("low", "medium", "high", "xhigh"). Passed to the codex
   *  CLI through -c model_reasoning_effort=<value>. null = the model's default. */
  reasoningEffort?: string | null;
  permission_mode?: string;
  allowed_tools?: string[];
  /** Tool name patterns passed to claude via --disallowedTools. We compute
   *  this at spawn time from the set of external (claude.ai) MCPs the user
   *  has *not* enabled for this agent — but the user can also append manual
   *  entries. */
  disallowed_tools?: string[];
  /**
   * @deprecated Checked skills are agent-scope attachments (`skill-attachments.ts`).
   * No longer read by the spawn or the agent views: a config.json written by an
   * older Timon (imported, restored) only yields its skills when the next boot or
   * write moves them to attachments (`agent-skills-migration.ts`, `absorbConfigSkills`).
   * Sent on a write, it is the agent's whole checked set and never stored here.
   */
  skills?: string[];
  /** TIMON-managed MCP server ids attached to this agent (stdio/http only).
   *  Externals are enabled by default — see excluded_mcp_servers below. */
  mcp_servers?: string[];
  /** External (claude.ai) MCP ids that the user has explicitly *disabled*
   *  for this agent. Inverted because externals load by default from the
   *  user's claude.ai account — toggling one off means "block its tools
   *  via --disallowedTools for this agent". */
  excluded_mcp_servers?: string[];
  /**
   * Project slug. If absent, we auto-derive it from `cwd` (first segment
   * under /workspace/). Use it to group agents across the UI and to scope
   * sub-agent spawns to the same project.
   */
  project?: string;
  /**
   * Memory persistence strategy for this agent:
   *   NONE    – no memory dir injected (default)
   *   SESSION – per-mission dir, created at spawn, deleted at mission_complete
   *   AGENT   – per-agent persistent dir (~/.timon/agents/<name>/memory/)
   *   GLOBAL  – shared across all agents (~/.timon/memory/)
   */
  memory_scope?: 'NONE' | 'SESSION' | 'AGENT' | 'GLOBAL';
  /**
   * Marker: this agent is ephemeral and will be destroyed at the end of its mission.
   * Its config + its system prompt live in `~/.timon/agents/_eph-<uuid>/`
   * (same layout as normal agents, simplifies all the downstream code),
   * but the folder is purged on `proc.exit` when the last mission
   * completes. Protected field: only `createEphemeralAgent` can set it —
   * `upsertAgent` and `patchAgentConfig` strip it silently to
   * prevent a privilege escalation through POST/PATCH /api/agents. */
  ephemeral?: boolean;
  /**
   * Business role of the agent (coder, reviewer, librarian, ops, orchestrator).
   * Determines the pictogram shown in the UI AND injects a block of default
   * directives into the system prompt. See `agent-roles.ts` for the registry.
   */
  role?: AgentRoleId;
  /**
   * Free extra custom directives. Concatenated after the role's
   * default directives in the system prompt. Allows adapting
   * a generic role to a specific project/context without touching the
   * `system-prompt.md`.
   */
  directives?: string;
  /** Visual identity: emoji (1-4 chars) shown in the canvas, the
   *  chat header, and the active-agents strip instead of the fallback
   *  based on the name's hash.
   *  @deprecated replaced by the role's pictogram (`role`). Kept for the
   *  existing configs — the UI no longer offers editing it. */
  emoji?: string;
  /** Accent colour (hex `#RRGGBB`, `hsl(...)`, or any valid CSS
   *  value). Replaces the auto palette for the avatar / the
   *  stroke of the canvas node.
   *  @deprecated the visual identity now comes from the project — kept
   *  for the existing configs. */
  color?: string;
  /** Mascot look drawn when the agent has no picture (`icon_url`). Checked
   *  against the mascot's own lists (`agent-look.ts`) on every write; a value
   *  edited by hand that fails the check reads back as no look. */
  look?: AgentLook;
  /** Which head the agent shows: `emoji`, `image` (`icon_url`) or `mascot`
   *  (`look`). Absent = the historical order (picture, project logo, emoji,
   *  initial). Choosing one keeps the settings of the others. */
  avatar?: AgentAvatarMode;
  /** Optional URL of a logo. When defined, the UI can use it
   *  instead of the emoji/initial (highest priority).
   *  @deprecated see `color`. */
  icon_url?: string;
  /**
   * Role marker: this agent has the right to spawn ephemeral agents
   * (or more generally, to use the orchestrator-only tools).
   * `_main` has it by default (hardcoded on the permission check side); any other
   * agent must declare it explicitly. Protected field: `upsertAgent`
   * and `patchAgentConfig` strip it — granted only by editing the
   * config.json on disk directly (local admin), never through the API.
   */
  orchestrator?: boolean;
  /**
   * Whom this agent may delegate to (`mission_spawn`, `timon spawn`, Kanban
   * tasks assigned to another agent): a list of agent names, or `'*'` for
   * everybody. Absent = derived (`agent-orchestration.ts`): everybody for the
   * main agent and for an `orchestrator` (flag or role), otherwise the agents
   * below it in the `reports_to` tree. `[]` = nobody. Protected key like
   * `orchestrator`: it is a delegation right, so an agent that could write it
   * through the API would grant itself the run of the fleet — it is written by
   * `PUT /api/agents/:name/orchestrates` (operator only), not by the config
   * routes.
   */
  orchestrates?: string[] | '*';
  /**
   * Injects the CROSS-PROJECT DIGEST (hot projects + objectives) into the system
   * prompt at spawn. Conditioned on the flag — NOT on `project == null` — so that a
   * project-less business agent (priority orchestration) as well as a project agent
   * can have it. Assembled without an LLM from the `projects` table + the knowledge vault
   * front-matter. Default false. Editable through the UI (PATCH allow-list).
   */
  global_context?: boolean;
  /**
   * Who created the agent when it was not a person: `plugin:<id>` for an agent
   * made through `ctx.agents.create`. Protected key — only that facade writes
   * it (`plugins/agent-origin.ts`), so a plugin may later update the agents it
   * made, and only those, and its uninstall can name them.
   */
  created_by?: string;
  /**
   * Stable identity of the agent, kept across renames: the folder (and this
   * file) moves with the name, the id does not change. Minted on first need
   * (`ensureAgentUid`, the agent export), never taken from a request, so a
   * copy made through the API never inherits another agent's id.
   */
  uid?: string;
  /**
   * Folders outside `cwd` the agent's missions may read (`read`) or read and
   * write (`write`), set by a person (`agent-extra-dirs.ts`). Protected key:
   * written only by `setAgentExtraDirs`, behind the routes that take a person
   * or `agents:privileged-config`, never by an agent write, an import or a
   * prompt rewrite.
   */
  extra_dirs?: Array<{ path: string; mode: 'read' | 'write' }>;
};

/**
 * Privileged flags never let in through the public paths
 * (POST /api/agents, PATCH /api/agents/:name/config, upsertAgent,
 * patchAgentConfig). Without this filter, any HTTP caller could
 * hoist itself to the orchestrator role and trigger ephemeral spawns, or
 * get itself purged automatically at the end of a mission.
 *
 * Set internally by `createEphemeralAgent` (ephemeral) or by manual
 * editing of the config.json on disk (orchestrator for a custom agent).
 */
const PROTECTED_CONFIG_KEYS = ['ephemeral', 'orchestrator', 'orchestrates', 'created_by', 'uid', 'extra_dirs'] as const;


export function stripProtectedKeys(cfg: AgentConfig): AgentConfig {
  const out: AgentConfig = { ...cfg };
  for (const k of PROTECTED_CONFIG_KEYS) {
    delete (out as Record<string, unknown>)[k];
  }
  return out;
}

/** Resolves an agent name to the EXACT name of its on-disk folder,
 *  CASE-INSENSITIVELY and whatever its Unicode normalisation. On Linux the FS
 *  is case-sensitive, so a task created for `timon.main` did not find the real
 *  agent `TIMON.main` → spawn failing with "Missing system prompt" → BLOCKED in
 *  a loop. We canonicalise at the resolution point by reading the real entries
 *  of AGENTS_DIR: an `existsSync` shortcut would answer yes for `foo` when the
 *  folder is `Foo` on Windows or macOS (and for a decomposed name on APFS),
 *  and hand back a name that matches no entry. Unknown → the name in NFC
 *  (lets the clear error come up for a real unknown, and keeps the literal
 *  name for the CREATION of a new agent). */
export function canonicalAgentName(name: string): string {
  agentDir(name); // a path, not a name, still throws here as it always did
  return resolveAgentFolder(name, agentFolderEntries()) ?? name.normalize('NFC');
}

/**
 * The existing agent folder `name` designates once case and Unicode
 * normalisation are set aside (`Foo` for `foo`, an accented letter typed
 * decomposed for the composed one), or null. A case-insensitive disk would merge the two
 * folders, and a case-sensitive one would hold two agents nobody can tell
 * apart: a creation under such a name is refused.
 */
export function findAgentFolder(name: string): string | null {
  return resolveAgentFolder(name, agentFolderEntries());
}

/**
 * The entry of `entries` that `name` designates: the exact entry first (two
 * legacy folders differing only by case on a case-sensitive disk each keep
 * their own name), otherwise the one equal in NFC and lower case, otherwise
 * null. Pure, so the rule is tested without depending on the test machine's
 * file system.
 */
export function resolveAgentFolder(name: string, entries: readonly string[]): string | null {
  if (entries.includes(name)) return name;
  const key = agentNameKey(name);
  return entries.find((entry) => agentNameKey(entry) === key) ?? null;
}

function agentFolderEntries(): string[] {
  try {
    return readdirSync(AGENTS_DIR);
  } catch {
    return []; // AGENTS_DIR missing: nothing to find
  }
}

export function loadConfig(agentName: string): AgentConfig {
  const path = agentConfig(canonicalAgentName(agentName));
  if (!existsSync(path)) return {};
  return JSON.parse(readFileSync(path, 'utf8')) as AgentConfig;
}

/**
 * The working directory the agent's config file holds, read fresh: never a
 * task's worktree a mission switched to. Undefined when the file holds none or
 * cannot be read. The fence trusts it for one thing only (`FenceTarget.agentCwd`).
 */
export function configuredAgentCwd(agentName: string): string | undefined {
  try {
    const cwd = loadConfig(agentName).cwd;
    return typeof cwd === 'string' && cwd !== '' ? cwd : undefined;
  } catch {
    return undefined; // an unreadable config: no exception, the depth rule applies
  }
}

export function loadSystemPrompt(agentName: string): string {
  const path = agentSystemPrompt(canonicalAgentName(agentName));
  if (!existsSync(path)) {
    throw new Error(`Missing system prompt for agent "${agentName}" at ${path}`);
  }
  return readFileSync(path, 'utf8');
}

/**
 * `SOUL.md` — the agent's own identity, written by the user rather than by
 * Timon: who it is, what it is for, how it should behave. Kept apart from
 * `system-prompt.md`, which carries the technical instructions Timon seeds and
 * which onboarding must never overwrite.
 *
 * Read case-insensitively because the file is offered under that exact name in
 * the UI, and a user-created `soul.md` is the same intent.
 */
export function loadSoul(agentName: string): string {
  const dir = agentDir(canonicalAgentName(agentName));
  if (!existsSync(dir)) return '';
  try {
    const file = readdirSync(dir).find((entry) => entry.toLowerCase() === 'soul.md');
    return file ? readFileSync(join(dir, file), 'utf8').trim() : '';
  } catch { return ''; }
}

/** One identity doc is sent up to this size: a note pasted whole must not
 *  swallow the context window of every mission of the agent. */
const IDENTITY_DOC_CAP = 32 * 1024;

/**
 * The agent's other `.md` files (`charter.md`, `rules.md`, `style.md`…): notes
 * the user wrote about who the agent is, sent to the model after `SOUL.md`.
 * `system-prompt.md` and `SOUL.md` have their own place in the prompt and are
 * left out. Alphabetical, so the order does not depend on the filesystem.
 */
export function loadIdentityDocs(agentName: string): { name: string; content: string; truncated: boolean }[] {
  const dir = agentDir(canonicalAgentName(agentName));
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && /^[\w.-]+\.md$/.test(d.name)
        && d.name.toLowerCase() !== 'system-prompt.md' && d.name.toLowerCase() !== 'soul.md')
      .map((d) => d.name)
      .sort((a, b) => a.localeCompare(b))
      .flatMap((name) => {
        const text = readFileSync(join(dir, name), 'utf8').trim();
        if (!text) return [];
        const truncated = text.length > IDENTITY_DOC_CAP;
        return [{ name, content: truncated ? text.slice(0, IDENTITY_DOC_CAP) : text, truncated }];
      });
  } catch { return []; }
}

// The rule lives in `agent-name.ts`, shared with the web and desktop clients.
// No leading dot: `.` and `..` are path segments, not folders of `agents/`,
// and a hidden folder is not an agent. `_` stays a valid first character
// (`_main`, the ephemeral `_eph-…` agents).
export { isValidAgentName };

export function validName(name: string): void {
  if (!isValidAgentName(name)) throw new Error(`invalid agent name: ${name}`);
}

export type ComputerUseMode = 'foreground' | 'background';

/** The mode as stored, read defensively: anything but 'background' is the foreground. */
export function storedComputerUseMode(cfg: Pick<AgentConfig, 'computer_use_mode'>): ComputerUseMode {
  return cfg.computer_use_mode === 'background' ? 'background' : 'foreground';
}

/** Why a `computer_use_mode` value is not acceptable, or null. */
export function computerUseModeRefusal(value: unknown): string | null {
  return value === 'foreground' || value === 'background' ? null : "computer_use_mode must be 'foreground' or 'background'";
}

export const COMPUTER_USE_APPS_MAX = 100;
export const COMPUTER_USE_APP_MAX_LENGTH = 200;

/** One entry of `computer_use_apps`: a bare name keeps the agent's default mode, an object carries its own. */
export type ComputerUseAppEntry = string | { app: string; mode: ComputerUseMode };

/** An allowed application with the mode it is driven in (the normalised form). */
export type ComputerUseApp = { app: string; mode: ComputerUseMode };

/**
 * The allowed applications as stored, read defensively and normalised: a bare name takes the
 * agent's default mode (`computer_use_mode`), an object keeps its own. Only non-empty names
 * survive; a repeated name keeps its first entry.
 */
export function storedComputerUseApps(cfg: Pick<AgentConfig, 'computer_use_apps' | 'computer_use_mode'>): ComputerUseApp[] {
  const raw: unknown = cfg.computer_use_apps;
  if (!Array.isArray(raw)) return [];
  const fallback = storedComputerUseMode(cfg);
  const seen = new Set<string>();
  const out: ComputerUseApp[] = [];
  for (const entry of raw) {
    let app: string;
    let mode: ComputerUseMode = fallback;
    if (typeof entry === 'string') app = entry.trim();
    else if (entry && typeof entry === 'object' && typeof (entry as { app?: unknown }).app === 'string') {
      app = (entry as { app: string }).app.trim();
      const own = (entry as { mode?: unknown }).mode;
      if (own === 'foreground' || own === 'background') mode = own;
    } else continue;
    if (!app || seen.has(app.toLowerCase())) continue;
    seen.add(app.toLowerCase());
    out.push({ app, mode });
    if (out.length >= COMPUTER_USE_APPS_MAX) break;
  }
  return out;
}

export const COMPUTER_USE_EXCLUDED_APPS_MAX = 200;

/**
 * What "All applications" leaves out until a person edits the list: password managers, the usual
 * terminals of the three systems (a shell runs anything), and Timon itself (an agent would reach its
 * own permissions). Each application is named by every spelling the desktop may read for it: the
 * macOS bundle id, the displayed name, the executable name or the X11 window class.
 */
export const DEFAULT_COMPUTER_USE_EXCLUDED_APPS: readonly string[] = Object.freeze([
  // Password managers and key stores.
  'KeePassXC', 'org.keepassxc.keepassxc', 'KeePass', 'KeeWeb',
  '1Password', 'com.1password.1password', 'com.agilebits.onepassword7',
  'Bitwarden', 'com.bitwarden.desktop',
  'Dashlane', 'LastPass', 'Enpass', 'Proton Pass', 'ProtonPass', 'NordPass', 'RoboForm', 'Keeper Password Manager',
  'Keychain Access', 'com.apple.keychainaccess', 'Passwords', 'com.apple.Passwords',
  'Seahorse', 'org.gnome.seahorse.Application', 'kwalletmanager5', 'KWalletManager',
  // Terminals.
  'Terminal', 'com.apple.Terminal', 'iTerm2', 'com.googlecode.iterm2', 'Warp', 'dev.warp.Warp-Stable',
  'Ghostty', 'com.mitchellh.ghostty', 'Alacritty', 'kitty', 'WezTerm', 'wezterm-gui', 'org.wezfurlong.wezterm',
  'Hyper', 'Tabby',
  'gnome-terminal', 'gnome-terminal-server', 'org.gnome.Terminal', 'kgx', 'org.gnome.Console', 'ptyxis', 'org.gnome.Ptyxis',
  'konsole', 'xterm', 'uxterm', 'urxvt', 'rxvt', 'xfce4-terminal', 'tilix', 'terminator', 'mate-terminal', 'lxterminal',
  'qterminal', 'foot', 'terminology', 'deepin-terminal', 'guake', 'yakuake', 'tilda', 'st',
  'WindowsTerminal', 'Windows Terminal', 'wt', 'cmd', 'powershell', 'pwsh', 'Windows PowerShell', 'conhost', 'OpenConsole', 'mintty',
  // Timon itself, packaged and run from the sources.
  'Timon', 'com.timon.desktop', 'timon-desktop', 'timon-dev',
]);

/** The switch as stored, read defensively: only `true` turns it on. */
export function storedComputerUseAllApps(cfg: Pick<AgentConfig, 'computer_use_all_apps'>): boolean {
  return cfg.computer_use_all_apps === true;
}

/**
 * The excluded applications as stored, read defensively: the defaults when the field is absent or
 * not a list, the stored names otherwise (trimmed, non-empty, a repeated name once, case apart).
 */
export function storedComputerUseExcludedApps(cfg: Pick<AgentConfig, 'computer_use_excluded_apps'>): string[] {
  const raw: unknown = cfg.computer_use_excluded_apps;
  if (!Array.isArray(raw)) return [...DEFAULT_COMPUTER_USE_EXCLUDED_APPS];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'string') continue;
    const app = entry.trim();
    if (!app || seen.has(app.toLowerCase())) continue;
    seen.add(app.toLowerCase());
    out.push(app);
    if (out.length >= COMPUTER_USE_EXCLUDED_APPS_MAX) break;
  }
  return out;
}

/** Why a `computer_use_all_apps` value is not acceptable, or null. */
export function computerUseAllAppsRefusal(value: unknown): string | null {
  return typeof value === 'boolean' ? null : 'computer_use_all_apps must be a boolean';
}

/** Why a `computer_use_excluded_apps` value is not acceptable, or null. `null` restores the default list. */
export function computerUseExcludedAppsRefusal(value: unknown): string | null {
  if (value === null) return null;
  const shape = `computer_use_excluded_apps must be null (the default list) or an array of non-empty names of at most ${COMPUTER_USE_APP_MAX_LENGTH} characters`;
  if (!Array.isArray(value)) return shape;
  if (value.some((entry) => typeof entry !== 'string' || entry.trim() === '' || entry.length > COMPUTER_USE_APP_MAX_LENGTH)) return shape;
  if (value.length > COMPUTER_USE_EXCLUDED_APPS_MAX) return `computer_use_excluded_apps holds at most ${COMPUTER_USE_EXCLUDED_APPS_MAX} applications`;
  return null;
}

/** Why a `computer_use_apps` value is not acceptable, or null. */
export function computerUseAppsRefusal(value: unknown): string | null {
  const shape = `computer_use_apps must be an array of non-empty names of at most ${COMPUTER_USE_APP_MAX_LENGTH} characters, `
    + "each a string or an object { app, mode: 'foreground' | 'background' }";
  if (!Array.isArray(value)) return shape;
  for (const entry of value) {
    if (typeof entry === 'string') {
      if (entry.trim() === '' || entry.length > COMPUTER_USE_APP_MAX_LENGTH) return shape;
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      const { app, mode } = entry as { app?: unknown; mode?: unknown };
      if (typeof app !== 'string' || app.trim() === '' || app.length > COMPUTER_USE_APP_MAX_LENGTH) return shape;
      if (mode !== 'foreground' && mode !== 'background') return shape;
    } else return shape;
  }
  if (value.length > COMPUTER_USE_APPS_MAX) return `computer_use_apps holds at most ${COMPUTER_USE_APPS_MAX} applications`;
  return null;
}
