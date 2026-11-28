/**
 * Mission spawn input and remote MCP tokens (`ctx.missions.spawn`, `ctx.mcp`).
 *
 * Extracted verbatim from `plugins/context.ts`, which re-exports it: the public
 * contract lives in leaf modules so `@timon-ai/sdk` can name it without the
 * implementation (TODO #512, option B).
 */

// Moved from `mission-title-source.ts`, which re-exports it (TODO #512, volet 3).
/** Who caused a title change: an account, an agent's mission, a plugin, or the daemon itself. */
export type MissionTitleOrigin = Readonly<{ kind: 'user' | 'agent' | 'plugin' | 'system'; id: string | null }>;

// Spelled out from the constant of `mission-title-source.ts`, which proves at compilation that both agree (TODO #512, volet 3).
/** Where a mission's title comes from, by decreasing authority. */
export type MissionTitleSource = 'manual' | 'preset' | 'native' | 'generated';

export type PluginMissionInput = {
  agent: string;
  mission: string;
  /** Free metadata attached to the source. `channel` is enforced by the facade. */
  meta?: unknown;
  /** Display name of the mission (`title_source = 'preset'`, ≤ 200 characters); absent, Timon generates one for a user conversation. */
  title?: string;
} & PluginMissionSpawnOverrides;

/** `ctx.mcp.issueToken` input. `ttl` in milliseconds, 60 s to 24 h, default 1 h. */
export type PluginMcpTokenInput = {
  missionId: string;
  /** Tool names (`kanban_add`) or families (`kanban_*`); at least one, nothing broader. */
  scopes: readonly string[];
  ttl?: number;
};

/**
 * A remote MCP token. `token` is the only copy of the secret: hand it to the
 * remote agent in an `Authorization: Bearer` header, never in a URL, never in
 * a log. `path` is the endpoint on the daemon (`/api/remote-mcp`).
 */
export type PluginMcpToken = { id: string; token: string; expiresAt: number; scopes: string[]; path: string };

export type PluginMissionErrorCode =
  | 'invalid' | 'not_found' | 'forbidden' | 'not_running' | 'turn_in_progress'
  | 'backend_exhausted' | 'override_denied' | 'failed';

export type PluginMissionSendResult = {
  /** `true` when the process had died and the mission was resumed in place (same id, same session). */
  resumed: boolean;
};

export type PluginMissionSummary = { summary: string; cached: boolean };

export type PluginMissionForkInput = {
  /** Target agent: it runs the continuation with its own config. */
  to: string;
  /** First message of the fork; a one-line acknowledgement by default. */
  message?: string;
};

export type PluginMissionFork = {
  missionId: string;
  cached: boolean;
  /** The summary the fork was seeded with — transcript content, so only with `missions:transcript`. */
  summary?: string;
};

export type PluginMissionSearchFilter = {
  agent?: string;
  project?: string;
  /** Epoch milliseconds, ISO date or relative (`2h`, `7d`) — the CLI's forms. */
  since?: string | number;
  until?: string | number;
  limit?: number;
};

export type PluginMissionSearchResult = {
  q: string;
  count: number;
  hits: unknown[];
  /** Index backfill state: until it is done, zero hits do not mean "it does not exist". */
  progress: unknown;
};

export type PluginStopScope = { agent: string } | { project: string };

export type PluginStopReport = Readonly<Record<string, unknown>>;

export type PluginTraceOptions = {
  /** Most spans returned, 1–2000 (default 500). */
  spanLimit?: number;
  /** Span payloads (tool inputs and outputs); only honoured with `missions:transcript`. */
  payload?: boolean;
};

/** Overrides a plugin may ask `missions.spawn` for, beyond agent and brief. */
export type PluginMissionSpawnOverrides = {
  model?: string;
  backend?: string;
  extraSkills?: string[];
  extraMcp?: string[];
  allow?: string[];
};

export type PluginMissionEventKind =
  | 'mission_started'
  | 'turn_complete'
  | 'mission_title_changed'
  | 'mission_archived'
  | 'mission_unarchived'
  | 'event'
  | 'event_delta';

/** Who caused the mission: `user` (account id), `plugin` (plugin id), or the spawn channel (`agent`, `fork`, `routine`…). */
export type PluginMissionOrigin = Readonly<{ kind: string; id: string | null }>;

export type PluginMissionStartedEvent = Readonly<{
  kind: 'mission_started';
  missionId: string;
  agent: string;
  /** Epoch milliseconds. */
  at: number;
  origin: PluginMissionOrigin;
}>;

export type PluginMissionTurnCompleteEvent = Readonly<{
  kind: 'turn_complete';
  missionId: string;
  agent: string;
  /** `cancelled`: a steer stopped the turn and its instruction opens the next
   *  one — the agent's answer comes with that next turn. */
  outcome: 'completed' | 'failed' | 'cancelled';
}>;

/**
 * The mission's title was written (TODO #358). `source` ranks who set it
 * (`manual` > `preset` > `native` > `generated`; null = cleared) and `origin`
 * says who caused the write — a plugin's own rename comes back as
 * `{ kind: 'plugin', id: <its id> }`, so it can ignore its echo.
 */
export type PluginMissionTitleChangedEvent = Readonly<{
  kind: 'mission_title_changed';
  missionId: string;
  agent: string;
  title: string | null;
  source: MissionTitleSource | null;
  origin: MissionTitleOrigin;
}>;

/** The mission was archived: hidden from the default lists, its status untouched. `by` says who did it. */
export type PluginMissionArchivedEvent = Readonly<{
  kind: 'mission_archived';
  missionId: string;
  agent: string;
  by: 'user' | 'auto' | 'agent';
}>;

/** An archived mission came back, by hand or because a new message (any `user` row, a delegation return included) arrived. */
export type PluginMissionUnarchivedEvent = Readonly<{
  kind: 'mission_unarchived';
  missionId: string;
  agent: string;
}>;

export type PluginMissionTranscriptEvent = Readonly<{
  kind: 'event';
  missionId: string;
  agent: string;
  /** Transcript row type: `user`, `assistant`, `result`… */
  type: string;
  timestamp: number;
  payload: unknown;
}>;

export type PluginMissionTranscriptDeltaEvent = Readonly<{
  kind: 'event_delta';
  missionId: string;
  agent: string;
  type: string;
  payload: unknown;
}>;

export type PluginMissionEvent =
  | PluginMissionStartedEvent | PluginMissionTurnCompleteEvent | PluginMissionTitleChangedEvent
  | PluginMissionArchivedEvent | PluginMissionUnarchivedEvent
  | PluginMissionTranscriptEvent | PluginMissionTranscriptDeltaEvent;

export type PluginMissionEventMap = {
  mission_started: PluginMissionStartedEvent;
  turn_complete: PluginMissionTurnCompleteEvent;
  mission_title_changed: PluginMissionTitleChangedEvent;
  mission_archived: PluginMissionArchivedEvent;
  mission_unarchived: PluginMissionUnarchivedEvent;
  event: PluginMissionTranscriptEvent;
  event_delta: PluginMissionTranscriptDeltaEvent;
};

export type PluginMissionEventHandler = (ev: PluginMissionEvent) => void | Promise<void>;
