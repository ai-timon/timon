/** Public plugin types, extracted from the host implementations (TODO #512). */
import type { WriteOrigin } from './origin.js';

// Spelled out from the zod schema of `agent-avatar.ts`, which proves at compilation that both agree (TODO #512, volet 3).
export type AgentAvatarInput =
  | { clear: true }
  | { dataUrl: string }
  | { mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string };

// Spelled out from the lists of `agent-look.ts`, which proves at compilation that both agree (TODO #874).
/** Head silhouette of an agent's mascot. */
export type PluginAgentLookShape = 'squircle' | 'tri' | 'gem' | 'round' | 'bean' | 'cloud' | 'hex';
/** The fur palette, the picker's three bright colours, then the default looks' own. Lower-case. */
export type PluginAgentLookColor =
  | '#d4a373' | '#b8743d' | '#e6c9a2' | '#8a5a3b' | '#c98e5a' | '#a8826a' | '#d9b48a' | '#7a4f35' | '#e0b07a'
  | '#ff5fbf' | '#3fa9ff' | '#7ed957'
  | '#ffc233' | '#ff8a2a' | '#a35bff';
/** One hexadecimal digit of a `#rrggbb` fur, either case. */
type HexDigit =
  | '0' | '1' | '2' | '3' | '4' | '5' | '6' | '7' | '8' | '9'
  | 'a' | 'b' | 'c' | 'd' | 'e' | 'f' | 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
/**
 * A fur off the palette, mixed with the colour picker: `#` then exactly six
 * hexadecimal digits (`^#[0-9a-fA-F]{6}$`), either case on write, read back
 * lower-case. TypeScript cannot count the digits (six positions would make a
 * union of over a hundred million members), so the type checks the `#` and the
 * first and last digits; any other length is refused by the daemon with
 * `invalid`.
 */
export type PluginAgentLookCustomColor = `#${HexDigit}${string}${HexDigit}`;
/** Resting eye expression. */
export type PluginAgentLookEyes =
  | 'pill' | 'big' | 'happy' | 'wink' | 'surprised' | 'squint' | 'sleepy' | 'heart' | 'star' | 'code';
/** Job accessory, `none` included. */
export type PluginAgentLookAccessory =
  | 'none' | 'loupe' | 'pen' | 'quill' | 'hammer' | 'wrench' | 'baton' | 'telescope' | 'envelope' | 'calendar'
  | 'clipboard' | 'hourglass' | 'teacher' | 'calculator' | 'chart' | 'brush' | 'globe' | 'megaphone' | 'shield' | 'coffee'
  | 'whip' | 'wizard' | 'chef' | 'crown' | 'idea' | 'rocket' | 'chemist' | 'gamer' | 'photographer' | 'gardener' | 'musician';

/**
 * A part a mascot pack adds (API 15): `<pluginId>:<part>`, declared in the
 * pack's manifest (`timon.mascot`). The product's ids stay bare.
 */
export type PluginMascotPartId = `${string}:${string}`;

/**
 * The mascot an agent is drawn with when it has no picture, as stored and read
 * back. A field may hold a pack's part, even one whose plugin was removed
 * since: draw an id you do not know with a default.
 */
export type PluginAgentLook = {
  shape: PluginAgentLookShape | PluginMascotPartId;
  color: PluginAgentLookColor | PluginAgentLookCustomColor | PluginMascotPartId;
  eyes: PluginAgentLookEyes | PluginMascotPartId;
  acc: PluginAgentLookAccessory | PluginMascotPartId;
};

/**
 * A look to write: `acc` may be left out (no accessory), `color` is compared
 * case-insensitively. A pack's part is accepted while its plugin is installed
 * and enabled and declares it for that field. Any other value, or any other
 * key, is refused with `invalid` and a message naming the accepted values.
 */
export type PluginAgentLookInput = Omit<PluginAgentLook, 'acc'> & { acc?: PluginAgentLook['acc'] };

/**
 * Which head the agent shows: its emoji, its picture or its mascot (`look`).
 * Spelled out from `AGENT_AVATAR_MODES` in `agent-look.ts`, which proves both agree.
 */
export type PluginAgentAvatarMode = 'emoji' | 'image' | 'mascot';

/** An agent as a plugin sees it: who it is, not how it runs. */
export type PluginAgent = {
  name: string;
  backend: string;
  model: string | null;
  /** Project slug, explicit or derived from the agent's directory. */
  project: string | null;
  role: string | null;
  hasSystemPrompt: boolean;
  /** `plugin:<id>` when a plugin created it, `null` for any other agent. */
  createdBy: string | null;
  /** Created by THIS plugin: `update` accepts it. */
  mine: boolean;
  /** Its mascot look, `null` when none is set (the app then draws a default one). */
  look: PluginAgentLook | null;
  /** The head it shows, `null` when none was picked (picture, project logo, emoji, initial, in that order). */
  avatar: PluginAgentAvatarMode | null;
};

/**
 * A new agent. `role` is required: an agent without one would default to
 * `orchestrator`, which may delegate to the whole fleet. `orchestrator` itself
 * is refused unless the caller is a superadmin.
 */
export type PluginAgentInput = {
  name: string;
  systemPrompt: string;
  role: string;
  /** A backend registered right now (built-in or provided by a plugin). */
  backend?: string;
  model?: string;
  project?: string | null;
  /** Existing directory inside a project's working directory (secu-4). */
  cwd?: string;
  directives?: string | null;
  /** What the agent remembers across missions; see the Memory page. */
  memoryScope?: 'NONE' | 'SESSION' | 'AGENT' | 'GLOBAL';
  /**
   * Skill ids the agent holds itself (its checked skills, catalogue mode):
   * the whole set, so `update` removes the ones it no longer names. Each must
   * exist. A skill whose frontmatter pre-authorises tools (`allowed-tools`)
   * needs a superadmin caller: it would widen what the agent may run.
   */
  skills?: string[];
  /**
   * Timon MCP server ids attached to the agent, the whole set. Each must
   * exist; unless the caller is a superadmin, only the servers THIS plugin
   * declared (`ctx.mcpServers.put`), so a plugin never hands out a server an
   * administrator configured.
   */
  mcpServers?: string[];
  /** Team id (`ctx.agents.teams`); `null` takes the agent out of any team. */
  team?: string | null;
  /** Its mascot look (API 15); `null` clears it. Same lists as the Agents page. */
  look?: PluginAgentLookInput | null;
  /** The head it shows (API 15); `null` clears the choice. Never erases the picture, emoji or look. */
  avatar?: PluginAgentAvatarMode | null;
};

/** Fields of `PluginAgentInput` to change; `null` clears `project` / `directives` / `team` / `look` / `avatar`. */
export type PluginAgentPatch = Partial<Omit<PluginAgentInput, 'name'>>;

/**
 * Options of `ctx.agents.delete` (API 15). `purge: true` removes the agent
 * for good instead of moving it to the agent trash: nothing is left to
 * restore. Reserved to the agents THIS plugin created, whoever the caller is
 * (a superadmin included): undoing its own half-made agent is the use, not
 * erasing somebody else's.
 */
export type PluginAgentDeleteOptions = { purge?: boolean };

/** A team of bots: a label on agents that bounds who they may talk to. */
export type PluginTeam = {
  id: string;
  name: string;
  color: string | null;
  createdAt: number;
};

export type PluginTeamInput = {
  /** 1 to 160 characters. */
  name: string;
  color?: string | null;
};

/** `code` of `PluginAgentError`: `invalid` (input), `not_found`, `conflict`
 *  (name taken), `forbidden` (not this plugin's agent, or a secu-4 refusal). */
export type PluginAgentErrorCode = 'invalid' | 'not_found' | 'conflict' | 'forbidden';

/** A picture for an agent: inline image bytes, or the order to remove it. */
export type PluginAgentAvatar = AgentAvatarInput;

/**
 * A routine of an agent, as `ctx.agents.export` reads it: a `schedule`
 * trigger whose first action is a task for this agent. Its prompt is the
 * routine's instruction; nothing else of the trigger (secret, filter, other
 * actions) is read.
 */
export type PluginAgentExportRoutine = {
  name: string;
  cron: string;
  /** IANA time zone of the schedule; `null` = the daemon's. */
  tz: string | null;
  enabled: boolean;
  prompt: string;
};

/**
 * An agent's portable definition (API 15, `agents:export`): what another
 * Timon needs to make the same agent, and nothing that only this machine or
 * this owner holds — no secret, token, log, transcript, memory file, session
 * or tool permission.
 */
export type PluginAgentExport = {
  name: string;
  /** It is the main agent here (`mainAgentName()`), whatever its name. */
  main: boolean;
  role: string | null;
  /** As configured; `null` = Timon's default. */
  backend: string | null;
  model: string | null;
  /** Explicit project slug; `null` when the agent has none. */
  project: string | null;
  /** Absolute working directory on THIS machine, `null` when none. */
  cwd: string | null;
  memoryScope: 'NONE' | 'SESSION' | 'AGENT' | 'GLOBAL' | null;
  /** `system-prompt.md`. */
  systemPrompt: string;
  /** The extra directives added after the role's. */
  directives: string | null;
  /** The identity documents at the agent's root (`SOUL.md`, `USER.md`…), `system-prompt.md` excepted. */
  docs: Array<{ name: string; content: string }>;
  /** Skill ids the agent holds itself (its checked skills). */
  skills: string[];
  /** Timon MCP server ids attached to it. */
  mcpServers: string[];
  /** Its team, when the caller's account sees it; `null` otherwise. */
  team: PluginTeam | null;
  /** The picture this daemon stores for it, as `setAvatar` takes it. */
  avatar: { mime: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'; data: string } | null;
  /** Its routines the caller's account sees (all of them for a superadmin). */
  routines: PluginAgentExportRoutine[];
};

/** A document as the listing shows it. */
export type PluginAgentDoc = { name: string; size: number; modified: number };

export type PluginAgentEventKind = 'agent_created' | 'agent_updated' | 'agent_deleted';

/** Who wrote: `kind: 'plugin', id: ctx.id` is this plugin's own write. */
export type PluginAgentOrigin = WriteOrigin;

/** The agent as an event carries it: its identity, as `PluginAgent` minus `mine`. */
export type PluginAgentSnapshot = Readonly<{
  name: string;
  backend: string;
  model: string | null;
  project: string | null;
  role: string | null;
  hasSystemPrompt: boolean;
  createdBy: string | null;
}>;

export type PluginAgentCreatedEvent = Readonly<{
  kind: 'agent_created';
  agent: PluginAgentSnapshot;
  origin: PluginAgentOrigin;
}>;

export type PluginAgentUpdatedEvent = Readonly<{
  kind: 'agent_updated';
  agent: PluginAgentSnapshot;
  /** What the write touched: config keys, `system_prompt`, `doc:<file>`, or `name` for a rename. */
  changed: readonly string[];
  /** The name before a rename; `null` otherwise. */
  previousName: string | null;
  origin: PluginAgentOrigin;
}>;

export type PluginAgentDeletedEvent = Readonly<{
  kind: 'agent_deleted';
  /** Taken before the removal. */
  agent: PluginAgentSnapshot;
  origin: PluginAgentOrigin;
}>;

export type PluginAgentEvent = PluginAgentCreatedEvent | PluginAgentUpdatedEvent | PluginAgentDeletedEvent;

export type PluginAgentEventMap = {
  agent_created: PluginAgentCreatedEvent;
  agent_updated: PluginAgentUpdatedEvent;
  agent_deleted: PluginAgentDeletedEvent;
};

export type PluginAgentEventHandler = (ev: PluginAgentEvent) => void | Promise<void>;
