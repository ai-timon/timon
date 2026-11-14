/**
 * The shape of a provider as the single engine sees it: a TRANSPORT (who owns
 * the process, if any), a CODEC (how bytes become events and a prompt becomes
 * bytes) and STRATEGIES (everything else a provider declares). cf.
 * `docs/PROVIDERS-SDK.md` § 7.
 *
 * Nothing here knows the core. The signatures only name types of
 * `../types.ts`, which is what the public SDK re-exports, so these pieces can
 * be handed to a third-party provider as they are. The daemon keeps the
 * process: a definition DESCRIBES a transport, it never holds a handle.
 */

import type {
  AccountUsage, BuildSpawnOpts, DiscoveredModel, NormalizedEvent, ImageAttachment, PermissionModel, ProfileRuntime,
  RateLimitReporting, RemoteSessionOpenArgs, SessionDriver, SessionOpenArgs, SessionStdio, SessionStore, SpanOp,
  SpanState, SpawnResult, UsageProbeOptions,
} from '../types.js';
import type { ReasoningControl } from '../reasoning-control.js';
import type { ProviderDeclarations } from '../provider-declarations.js';

/**
 * Who owns the process, and for how long.
 *   - `stdio-persistent`: one process for the whole mission; follow-up turns
 *     are written to its stdin (claude, ACP agents).
 *   - `process-per-turn`: one process per turn, started with the provider's
 *     own resume mechanism (codex, grok, copilot).
 *   - `remote`: no process at all; the session is a connection.
 */
export const PROVIDER_TRANSPORTS = ['stdio-persistent', 'process-per-turn', 'remote'] as const;
export type ProviderTransportKind = (typeof PROVIDER_TRANSPORTS)[number];

/** A line-oriented CLI: it talks, one JSON object per line, and listens on
 *  stdin (or, per turn, on its argv). */
export type LinesCodec = {
  readonly kind: 'lines';
  /** One stdout line into 0..N normalized events; `[]` drops the line. */
  parseLine(line: string): NormalizedEvent[];
  /** The provider's session id carried by an event, if any. Must be pure. */
  extractSessionId(ev: NormalizedEvent): string | null;
  /** A follow-up turn onto the persistent process. Never called for a
   *  `process-per-turn` provider: its next turn is a new launch. */
  writeUserInput(io: SessionStdio, text: string, images?: ImageAttachment[]): void;
};

/** A provider that speaks a session protocol over the process's pipes (ACP):
 *  it supplies the whole `SessionDriver`. */
export type ProcessDriverCodec = {
  readonly kind: 'driver';
  /** `profileId` and `launch` are there for a provider registered natively (the profile it serves, for whom); a definition built from a legacy dialect never has them. */
  openSession(args: Omit<SessionOpenArgs, 'profileId' | 'launch'> & Partial<Pick<SessionOpenArgs, 'profileId' | 'launch'>>): SessionDriver;
  /** The provider's session id carried by an event. Default: the one `system:init` carries (`runtime.events.extractInitSessionId`). */
  extractSessionId?(ev: NormalizedEvent): string | null;
};

/** A provider with no process (HTTP, WebSocket…). */
export type RemoteDriverCodec = {
  readonly kind: 'driver';
  /** `profileId`, `env` and `launch` are there for a provider registered natively; a definition built from a legacy dialect never has them. */
  openSession(args: Omit<RemoteSessionOpenArgs, 'profileId' | 'env' | 'launch'> & Partial<Pick<RemoteSessionOpenArgs, 'profileId' | 'env' | 'launch'>>): SessionDriver;
  /** Cf. `ProcessDriverCodec.extractSessionId`. */
  extractSessionId?(ev: NormalizedEvent): string | null;
};

/** How the provider keeps and finds its conversation again. */
export type SessionStrategy = {
  readonly store: SessionStore;
  /** Does a new process find the thread again? Cf. `Backend.sessionResumable`. */
  readonly resumable: boolean;
  /** Does this stderr chunk say the session to resume no longer exists? */
  notFound?(stderr: string): boolean;
  /** Ceiling, in UTF-8 bytes, of the kickoff message (argv-borne prompts). */
  readonly maxPromptBytes?: number;
  /**
   * Switches the model of the live process, with no respawn. Only a process that
   * outlives a turn has anything to switch (`stdio-persistent`); resolves `true`
   * when the CLI confirmed. Absent = no live switch.
   */
  setModel?(io: SessionStdio, model: string): Promise<boolean>;
  /**
   * The agent compacts its OWN session when it receives `command` as the
   * message of a turn (Claude Code's `/compact`): the conversation goes on in
   * the same mission and session, with a shorter context. Absent = no native
   * compaction; Timon then summarizes the transcript and forks a new mission
   * (docs/MISSION-COMPACT.md). A `process-per-turn` launch sees that turn with
   * `BuildSpawnOpts.agentCommand: true`, so a CLI that reads a leading `/` as
   * plain text by default (Grok's `--verbatim`) can let the command through.
   */
  readonly compact?: { readonly command: string };
  /**
   * Cuts the provider session where a chat rewind cut the thread
   * (docs/specs/rewind.md), at the mission's next spawn, before its prompt is
   * sent. `sessionId` is the session the cut part was spoken in; `events` is the
   * thread as it stands after the cut; `scratch` is the mission's private folder
   * the provider's launches opened (`ctx.provider.scratch.mission`), where a
   * per-mission session store lives, or null when none exists. Resolves the
   * session the turn resumes, or null for a fresh one, and optionally the
   * provider message to resume it at (`BuildSpawnOpts.resumeAt`). Absent, on any
   * throw, or when that launch cannot find the session (`notFound`), Timon starts
   * a fresh session seeded with a summary of the visible thread.
   */
  readonly rewind?: (ctx: {
    readonly missionId: string;
    readonly sessionId: string;
    readonly events: readonly { readonly id: number; readonly type: string; readonly payload: string }[];
    readonly scratch: string | null;
  }) => Promise<{ readonly resume: string | null; readonly resumeAt?: string }>;
};

/** How tool uses are arbitrated. */
export type PermissionStrategy = {
  readonly model: PermissionModel;
  /**
   * The agent arbitrates its own tool uses and never asks Timon (cf.
   * `SessionCapabilities.permissionsByAgent`), for every profile or per profile.
   * Only a session protocol can say it: `model: 'protocol'`.
   */
  readonly byAgent?: boolean | ((profileId: string) => boolean);
  /**
   * The provider enforces the agent's `permission_mode` (and its grants) itself before
   * it asks, as Pi's gate does: the UI then says the mode applies, instead of the
   * generic `protocol` line where the agent's own rules decide what never reaches a
   * card. Only a session protocol that asks can say it (`model: 'protocol'`, not `byAgent`).
   */
  readonly appliesMode?: boolean;
};

/** What the stream says about a usage limit. The detector stays in the core. */
export type LimitsStrategy = {
  readonly reporting: RateLimitReporting;
};

/** Which of Timon's MCP servers the provider can be handed. */
export type McpStrategy = {
  readonly timon: boolean;
};

/** Account consumption; absent = the provider exposes none (never zero). */
export type UsageStrategy = {
  /** `profile` says whether the probe applies (a third-party endpoint behind the same CLI has no such quota). */
  probe(profile?: ProfileRuntime, options?: UsageProbeOptions): Promise<AccountUsage | null>;
};

/** Model ids the CLI itself says this account may use; rejects when it cannot tell. Never opens a session to ask. */
export type ModelsStrategy = {
  discover(profile: ProfileRuntime): Promise<Array<string | DiscoveredModel>>;
};

/** Kinds of thinking control this provider can send for a custom provider's model; absent = levels only. */
export type ReasoningStrategy = {
  readonly controls: readonly ReasoningControl['type'][];
};

/** Hooks around a mission's life. */
export type LifecycleStrategy = {
  dispose?(missionId: string): void;
  enrich?(ev: NormalizedEvent, missionId: string): NormalizedEvent;
};

/** Builds the command of one launch. The daemon spawns it: a provider describes, it never holds a process. */
export type LaunchStrategy = {
  launch(spawn: BuildSpawnOpts, profile: ProfileRuntime): Promise<SpawnResult>;
};

type ProviderCommon = {
  readonly id: string;
  readonly session: SessionStrategy;
  readonly permission: PermissionStrategy;
  readonly limits: LimitsStrategy;
  readonly mcp: McpStrategy;
  readonly usage?: UsageStrategy;
  readonly models?: ModelsStrategy;
  readonly reasoning?: ReasoningStrategy;
  readonly lifecycle?: LifecycleStrategy;
  /** Trace spans an event opens or closes; absent = the provider is not traced. A native provider declares them in `declares.spans`. */
  spans?(ev: NormalizedEvent, state: SpanState, eventId: number): SpanOp[];
  /** C1 to C9: what the core reads about this provider instead of asking its name. */
  readonly declares?: ProviderDeclarations;
};

/** The transport decides which codecs make sense: a one-shot process has no
 *  protocol to drive, a remote session has no lines to read. */
export type ProviderDefinition =
  | (ProviderCommon & Partial<LaunchStrategy> & {
    readonly transport: { readonly kind: 'stdio-persistent' };
    readonly codec: LinesCodec | ProcessDriverCodec;
  })
  | (ProviderCommon & Partial<LaunchStrategy> & {
    readonly transport: { readonly kind: 'process-per-turn' };
    readonly codec: LinesCodec;
  })
  | (ProviderCommon & {
    readonly transport: { readonly kind: 'remote' };
    readonly codec: RemoteDriverCodec;
  });

export type RemoteProviderDefinition = Extract<ProviderDefinition, { transport: { kind: 'remote' } }>;
export type ProcessProviderDefinition = Exclude<ProviderDefinition, RemoteProviderDefinition>;

/**
 * What a plugin registers (`ctx.provider.registerProvider`): a provider that owns
 * a process says how to launch it. (`fromLegacy` builds the other kind, from a
 * dialect, per launch: the dialect's `buildSpawn` is already the daemon's.)
 */
export type NativeProviderDefinition =
  | (ProcessProviderDefinition & LaunchStrategy)
  | RemoteProviderDefinition;

/** `transport.kind` is nested, so the union does not narrow on it by itself. */
export function isRemoteDefinition(def: ProviderDefinition): def is RemoteProviderDefinition {
  return def.transport.kind === 'remote';
}
