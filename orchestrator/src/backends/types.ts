/**
 * Backend abstraction over external CLIs (claude / codex).
 *
 * The orchestrator spawns a CLI subprocess per agent turn, streams its JSONL
 * output back to the UI and persists it. Two providers are supported:
 *
 *   - Claude CLI: long-lived process, stream-json on stdin (multi-turn) and
 *     on stdout. Permission requests are bridged via a TIMON-injected MCP
 *     (mcp__timon_ask__request).
 *
 *   - Codex CLI: one-shot per turn (`codex exec --json`), prompt passed as
 *     argv, JSONL events on stdout. Multi-turn = re-spawn with
 *     `codex exec resume <session_id> <prompt>`. No interactive permission
 *     flow in exec mode — sandbox is configured via `--sandbox <mode>`.
 *
 * A Backend exposes everything TIMON needs to:
 *   1. spawn the CLI for one user turn (with system prompt + MCP + resume),
 *   2. push user input (only meaningful for the persistent Claude case),
 *   3. parse a single line of JSONL stdout into TIMON-internal events,
 *   4. extract the provider's session/thread id so we can resume next time.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import type { ProviderAgentConfig } from './provider-agent-config.js';
import type { ReasoningControl } from './reasoning-control.js';

/**
 * Name of an LLM backend. Deliberately open (`string`): the source of truth
 * is the REGISTRY in `./index.js`, not the type system. Adding a backend
 * = adding a registry entry, without touching any union or any comparison
 * site. To validate a value coming from the outside (API, config JSON, DB
 * column), use `isBackendName()` exported by `./index.js`.
 */
export type BackendName = string;

/**
 * One line of JSONL output, after backend-specific normalization. We keep
 * Claude's stream-json shape as the "native" event vocabulary across the
 * orchestrator (everything downstream — DB events table, SSE bus, UI — is
 * already structured around `type` strings like 'system', 'assistant',
 * 'user', 'result'). The Codex backend rewrites Codex-native events into
 * this shape, so the UI doesn't need to learn two dialects.
 *
 * `payload` is the JSON value to persist; `type` is what goes in the events
 * table's `type` column and on the bus.
 */
export type NormalizedEvent = {
  type: string;
  payload: unknown;
};

/**
 * Normalized event type for the partial text of an in-progress reply.
 *
 * EPHEMERAL BY CONTRACT: `processEvent` short-circuits this type BEFORE
 * `insertEvent`/`appendAgentLog` — a 3-minute turn produces thousands of
 * deltas; persisting them would blow up the `events` table (which feeds SSE
 * replay and summary.ts). They only travel on the bus and SSE. The full
 * `assistant` message remains the only persisted source: after a page
 * reload we fall back to block-by-block display.
 */
export const ASSISTANT_DELTA = 'assistant_delta';

/**
 * `mode` exists because dialects do not stream the same way: claude emits
 * increments (`append`); a CLI that re-emitted the accumulated text on every
 * update would declare `replace`. The UI applies the mode without knowing
 * which backend is running.
 */
export type AssistantDeltaPayload = {
  text: string;
  mode: 'append' | 'replace';
};

/**
 * Normalized event type for a request the PROVIDER is retrying on its own
 * (codex's `Reconnecting... 2/5`, claude's `system/api_retry`).
 *
 * NEVER a turn end: the CLI is still working, and the turn closes later with
 * its own `result`. Persisted, so the chat replays the attempt line and the
 * daemon knows how many retries the provider spent before a failure.
 */
export const PROVIDER_RETRY = 'provider_retry';

/** What the provider is retrying against. `rate_limit` is a short throttle the
 *  provider absorbs itself, not the quota wall `rate-limit.ts` detects. */
export const PROVIDER_RETRY_KINDS = ['transport', 'rate_limit', 'overloaded', 'server'] as const;
export type ProviderRetryKind = (typeof PROVIDER_RETRY_KINDS)[number];

/** Payload of a `provider_retry` event. `attempt` and `max` are null when the
 *  provider does not count (codex's `Reconnecting... waiting for network`). */
export type ProviderRetryPayload = {
  type: typeof PROVIDER_RETRY;
  attempt: number | null;
  max: number | null;
  /** The provider's own words for the failure it is retrying. */
  cause: string;
  /** Wait before the next attempt, when the provider announces it. */
  delay_ms: number | null;
  kind: ProviderRetryKind;
};

/** A pasted / attached image accompanying a user turn. `media_type` is
 *  the MIME (image/png, image/jpeg, …), `data` is base64-encoded
 *  contents (no `data:` prefix). Claude forwards these inline over
 *  stream-json; codex writes them to temporary files and passes them
 *  via `-i <FILE>` at spawn (every codex turn re-spawns via buildSpawn,
 *  so both initial and resume are covered). */
export type ImageAttachment = { media_type: string; data: string };

export type BuildSpawnOpts = {
  agentName: string;
  systemPrompt: string;
  /** First user message of the turn. Backends that pass the prompt as argv
   *  (codex) use this; backends that write to stdin (claude) ignore it here
   *  and rely on `writeUserInput` after spawn. */
  message: string;
  /** Optional image attachments for the first turn. */
  images?: ImageAttachment[];
  /** Provider session id to resume, or null for a fresh start. */
  resumeSession: string | null;
  cfg: ProviderAgentConfig;
  missionId: string;
  /** Resolved memory directory to inject via --add-dir, or undefined if
   *  memory_scope is NONE or not set. */
  memoryDir?: string;
  /** `false` when the backend declares `capabilities.timonMcp: false`: the
   *  dialect declares none of Timon's own MCP servers (`timon`, `timon_ask`)
   *  to the agent. Absent = declare them, as always. */
  timonMcp?: boolean;
  /** This mission must run no shell command and read or write no file (the
   *  conversion mission of a browser recording, TODO #469, #471): the dialect
   *  removes or disables every tool of its CLI that runs a command, reads or
   *  writes a file, or reaches a server the daemon did not hand it (an account
   *  connector), whatever `cfg` says; only the mission's MCP servers stay. The
   *  daemon sets it only on a dialect the product declares able to honour it;
   *  absent = the agent's own tools. */
  readOnlyTools?: boolean;
  /** Preserve a mission server replacement after its list has been flattened. */
  searchServerOverride?: 'empty' | 'nonempty';
  /** A minimal one-shot config must not erase an operator's connector choice. */
  searchConfiguredConnectors?: boolean;
  /** The message of this turn is a command of the agent itself, not text for
   *  the model (native compaction, `ProviderDefinition.session.compact`): a
   *  dialect that escapes a leading `/` by default lets this one through.
   *  Absent = an ordinary turn. */
  agentCommand?: boolean;
  /** This launch is one of the daemon's own one-shot prompts (summary,
   *  compaction, title, memory pass: `summary.ts`), whose input may carry text
   *  a third party wrote. A provider whose agent arbitrates its own tool uses
   *  confines it here (ACP `AcpAgentSpec.oneShotEnv`): the daemon's refusal of
   *  every permission request never reaches such an agent. Absent = a mission. */
  oneShot?: boolean;
};

export type SpawnResult = {
  cmd: string;
  args: string[];
  /** Extra env vars merged on top of process.env. Used by Codex to point
   *  at a per-mission CODEX_HOME containing config.toml + auth symlink. */
  env?: Record<string, string>;
  cwd?: string;
  /** stdin payload to write immediately after spawn, or null. Claude uses
   *  this to inject the first stream-json user message; Codex passes the
   *  prompt as argv and returns null here. */
  initialStdin: string | null;
};

/* ── Dialect capabilities ─────────────────────────────────────────────────
   Everything the rest of the orchestrator must know about a CLI WITHOUT
   testing its name. Rule: if a code path is about to write `backend ===
   'claude'`, a capability is missing here. */

/**
 * How the CLI arbitrates tool uses.
 *
 *   - `mcp-bridge`: the CLI can delegate every non-pre-allowed tool use to an
 *     external tool (`--permission-prompt-tool`). TIMON hooks its
 *     `timon_ask` MCP onto it → Allow/Deny card in the UI + auto
 *     classifier.
 *   - `sandbox`: no round-trip possible during the turn; privileges are
 *     frozen at spawn by a sandbox level. `permission_mode` is then
 *     translated into a level by the dialect (cf. `sandboxModeForCodex`),
 *     and there is NEITHER a card NOR a classifier.
 *   - `protocol`: the agent speaks a bidirectional protocol (ACP) and may ask
 *     TIMON for a decision mid-turn as a REQUEST of that protocol
 *     (`session/request_permission`), answered through `SessionHost.
 *     requestPermission`. Same round trip as `mcp-bridge`, carried by the
 *     session driver instead of an injected MCP tool. What the agent never
 *     asks about stays under its own policy: a dialect shared by an agent that
 *     asks (Hermes) and one that never does (opencode) declares `protocol` —
 *     the channel exists, an agent that does not use it simply never triggers
 *     it. A dialect for an agent that ALWAYS decides alone declares `sandbox`
 *     (fixed privileges, no round trip, no card): no extra value is needed
 *     for "decides alone", and the UI and the preamble already say the right
 *     thing for it.
 *   - `none`: the CLI runs everything with no usable guard. No dialect is
 *     in this case today; the value exists so a future CLI can declare it
 *     explicitly instead of pretending to be one of the other two.
 */
export const PERMISSION_MODELS = ['mcp-bridge', 'sandbox', 'protocol', 'none'] as const;
export type PermissionModel = (typeof PERMISSION_MODELS)[number];

/**
 * What the CLI stream says about a usage limit being hit.
 *
 *   - `structured`: a dedicated event and/or an exploitable error status
 *     (`rate_limit_event` with `rateLimitType` + `resetsAt`, `result` carrying
 *     `api_error_status: 429`). We know WHAT and UNTIL WHEN.
 *   - `textual`: only a natural-language error sentence comes back. We know
 *     THAT, never WHEN → `rateLimitType` and `resetsAt` stay null and
 *     display as "unknown window" (cf. `describeInterruption`).
 *   - `none`: the CLI says nothing at all. The absence of a signal then
 *     proves NOTHING — an unexplained death stays `unknown`, never "no
 *     rate limit".
 *
 * This value drives no heuristic: `rate-limit.ts` applies every known rule
 * to every dialect (they are mutually exclusive). It is here to qualify
 * SILENCE, which no probe can do on its own.
 */
export const RATE_LIMIT_REPORTINGS = ['structured', 'textual', 'none'] as const;
export type RateLimitReporting = (typeof RATE_LIMIT_REPORTINGS)[number];

/**
 * Where a mission's session lives (cf. `Backend.sessionStore`).
 *   - `global`      : store internal to the CLI, shared by all missions
 *                     (claude, `~/.claude`). A mission can resume another
 *                     mission's session.
 *   - `per-mission` : scratch built by TIMON for THIS mission (GROK_HOME,
 *                     CODEX_HOME). Outside its mission, the session cannot
 *                     be found.
 */
export const SESSION_STORES = ['global', 'per-mission'] as const;
export type SessionStore = (typeof SESSION_STORES)[number];

/**
 * ACCOUNT quota consumption (not the mission's), as reported by the
 * provider. `windows` is deliberately an open dictionary: the keys
 * (`five_hour`, `seven_day`, …) belong to the provider's vocabulary and are
 * not frozen in the type — a dialect that exposes other windows adds them
 * without touching this definition, and the UI iterates over what it gets.
 *
 * `utilization` is a PERCENTAGE in [0, 100], not a 0..1 ratio.
 */
export type UsageWindow = { utilization: number; resets_at: string };
export type AccountUsage = {
  windows: Record<string, UsageWindow | null>;
  /** Billed overage past the subscription, if the provider exposes one. */
  extra: {
    is_enabled: boolean;
    utilization: number;
    used_credits: number;
    monthly_limit: number;
    currency?: string;
    disabled_reason?: string | null;
  } | null;
};

/**
 * How a usage probe is asked. `force` is a person's explicit refresh (the ↻ of
 * a gauge): the probe skips its own cache, a cached failure included, and asks
 * the provider again. Polling never sets it — the cache is what keeps a
 * provider's usage endpoint from answering 429. A probe that ignores the
 * option stays correct, only slower to show a fresh figure.
 */
export type UsageProbeOptions = { force?: boolean };

/**
 * Custom provider declared to a CLI that knows how to consume one (today:
 * codex, via `[model_providers.<id>]` in its config.toml). Purely
 * declarative — the dialect decides how to materialise it.
 *
 * `wireApi`: `"responses"` is the only value accepted by codex 0.130 for a
 * declared provider — `"chat"` makes config.toml fail to load at startup
 * (explicit CLI message, cf. docs/BACKEND_PROFILES.md). The field stays a
 * `string` so we do not freeze a constraint that belongs to one CLI version.
 */
export type ProviderConfig = {
  /** Provider identifier on the CLI side. Watch reserved IDs: codex
   *  refuses to load if we redeclare a built-in provider (`ollama`…). */
  id: string;
  /** Label displayed by the CLI. */
  name: string;
  baseUrl: string;
  /** Name of the env var the CLI will read the key from. It must therefore
   *  be present in the child process env → the profile's `envFrom`. */
  envKey: string;
  wireApi: string;
};

/**
 * Backend profile: "which binary, which env, which models".
 *
 * A profile carries NO code — it names a `dialect` ("how we talk to the
 * CLI": buildSpawn/parseLine/extractSessionId) and injects its command,
 * env and provider config. Adding a provider that reuses an existing
 * dialect = registering one more profile, zero parsing code.
 */
export type BackendProfile = {
  /** Explicit local availability and display order. */
  disabled?: boolean;
  rank?: number;
  /**
   * C3 — where this backend stands among the candidates of the automatic quota
   * fallback (lowest first). Absent = never chosen automatically: a profile with
   * no declared rank is reachable only through an explicit fallback (task, series,
   * global setting), which is what a custom provider of unknown calibre should be.
   */
  fallbackRank?: number;
  /** Backend identifier exposed to the API / Kanban / UI. */
  id: string;
  /** Dialect that carries the parsing code. Id under which a provider plugin registered its dialect. */
  dialect: string;
  /** Label in the UI selectors. */
  label: string;
  /**
   * VENDOR name, as displayed at the top of a column in the LLM selector
   * ("Anthropic", "xAI"…). Distinct from `label`, which names the product
   * or the CLI ("Claude", "Codex (GPT)"): we pick a house first, then one
   * of its models. Absent → the UI falls back to `label`.
   */
  vendor?: string;
  /**
   * Logo key, resolved to an SVG component by the UI (`brand-icons.tsx`).
   * Separates the profile's visual identity from its React implementation;
   * an unknown key degrades to a badge with the initial, never to an error.
   */
  brand?: string;
  /**
   * Picture chosen by the user for this profile, when `brand` names no logo we
   * ship: an emoji, or a URL served by our OWN uploads route. Never an
   * arbitrary URL — a menu that fetched a third-party host on every opening
   * would leak the install and break offline, which is the case we serve.
   */
  icon?: string;
  /** Binary to spawn. Absent → the dialect's. */
  cmd?: string;
  /**
   * C2 for ONE profile — folders, relative to the home folder, where the CLI keeps THIS
   * profile's sign-in, for a profile whose id differs from its dialect's (`ollama-cloud`
   * on `codex`, folder `.ollama`). The mission keeps them, every other backend has them
   * masked, and they REPLACE what the dialect declared for this profile: it does not
   * inherit the dialect's own folder. Listed in the manifest (`provider.credentialDirs`)
   * and held to the same rules as the dialect's (`credentialDirProblem`).
   */
  credentialDirs?: readonly string[];
  /**
   * Env to inject into the child process: `{ CHILD_SIDE_NAME: 'ORCHESTRATOR_SIDE_NAME' }`.
   * The value is read from the orchestrator's `process.env` AT EACH SPAWN —
   * no key is ever written into the repo, and none is kept between missions.
   */
  envFrom?: Record<string, string>;
  /**
   * Env values set first, `envFrom` overriding them when its source exists.
   * A literal string is a fixed, NON-secret value; a credential is a
   * `{ secret: '<NAME>' }` reference to a vault entry, opened at each spawn
   * (cf. `./credentials.ts`). A reference whose entry is missing or unreadable
   * makes the profile inactive, same as a missing `requiredEnv` variable.
   */
  env?: Record<string, EnvValue>;
  /**
   * `process.env` variables without which the profile is INACTIVE: it
   * enters neither the registry nor the catalogue, and the orchestrator
   * starts normally. A first-party profile declares none.
   */
  requiredEnv?: string[];
  /**
   * Binary whose ABSENCE from PATH makes the profile inactive, same as a
   * missing variable. For a CLI we cannot assume is present (installed
   * separately, backed by a third-party subscription): without this guard
   * the UI would offer a backend whose every mission would die ENOENT at
   * spawn. First-party CLIs do not declare it — their absence is an
   * install anomaly, not a missing capability.
   */
  requiredBinary?: string;
  /** Custom provider to materialise in the CLI config (codex). */
  providerConfig?: ProviderConfig;
  /** Cf. `BackendCapabilities`. Narrows the dialect's: a `false` here wins, a
   *  `true` cannot give back what the dialect declared it cannot do. */
  capabilities?: Partial<BackendCapabilities>;
  /**
   * Oldest CLI version known to accept this profile's model list. Checked
   * once per daemon lifetime before the first spawn (`--version`): an older
   * CLI rejects the newest slugs with an error nobody can act on from the
   * chat. A tester on codex 0.133 could not start gpt-5.6-sol (TIM-0009).
   */
  minCliVersion?: string;
  /** Models offered in the UI. May be empty when the upstream list is not
   *  known from a reliable source — the UI then leaves the field free. */
  models: import('./catalog-model.js').CatalogModel[];
  /**
   * Endpoint that ENUMERATES the models actually served, when the provider
   * exposes one. Aggregators (Ollama Cloud) renew their offering
   * continuously: a list frozen in the code ages between two commits,
   * whereas upstream knows the truth. What is discovered takes precedence
   * over `models`, which remains the fallback (and the source of metadata:
   * `presetLabel`, `contextWindow`, labels). Cf. `model-discovery.ts`.
   */
  modelsEndpoint?: {
    /** Absolute URL to query with GET. */
    url: string;
    /** Response schema. `openai` = `{ data: [{ id }] }`. */
    format: 'openai';
    /** Headers to add, values read from the orchestrator's `process.env`:
     *  `{ Authorization: 'OLLAMA_API_KEY' }` → `Authorization: <value>`.
     *  Omitted when the enumeration is public. */
    authFrom?: Record<string, string>;
  };
  /** Pre-selected model, or null if no known list. */
  defaultModel: string | null;
  /** Literal prefixes claimed as a second resort by `backendForModel`. */
  slugPrefixes?: string[];
  /** Served by a third-party provider rather than a first-party CLI (UI badge). */
  custom?: boolean;
  /**
   * How this backend is billed / authenticated, to display as-is in the
   * agent editor. DECLARATIVE on purpose: it is the only way to have a
   * provider-specific message without the UI comparing `backend.id` to a
   * literal name — adding a provider is writing its sentence here, not an
   * `if`.
   */
  subscription?: {
    /** Sentence displayed under "Subscription" (markdown not interpreted). */
    note: string;
    /** Show the "use plan max" toggle (option specific to the Claude Code
     *  CLI, with no equivalent elsewhere). */
    planMaxToggle?: boolean;
  };
};

/** Reference to a vault entry, by name. Never a value. */
export type SecretRef = { secret: string };

export type EnvValue = string | SecretRef;

/**
 * For WHOM and for WHAT a backend's code is called: the plugin picks the right
 * connection from it (the gateway of the account that launched the mission).
 *
 *   - `mission`: a mission is being launched. `ownerUserId` is the mission's
 *     owner as the daemon recorded it: an account id, `plugin:<id>` for a
 *     mission a plugin started, or null for one the daemon started itself (a
 *     Kanban task with no owner, a routine). Only an account id is accepted by
 *     `ctx.connections.forUser`;
 *   - `probe`: no mission behind this call — the registry's visibility check
 *     (every 15 s at most), a usage probe, a daemon one-shot (a summary). Never
 *     require a user here: answer what SOME mission could get, or the profile
 *     leaves the menus for everyone.
 *
 * A fresh frozen object at every call. Never a credential, never the mission's
 * Timon token.
 */
export type BackendLaunchContext =
  | {
    readonly kind: 'mission';
    readonly missionId: string;
    readonly ownerUserId: string | null;
    readonly agentName: string;
    readonly project: string | null;
  }
  | {
    readonly kind: 'probe';
    readonly missionId: null;
    readonly ownerUserId: null;
    readonly agentName: null;
    readonly project: null;
  };

/** The `probe` context, as its own object so no caller can mutate a shared one. */
export function probeLaunchContext(): BackendLaunchContext {
  return Object.freeze({ kind: 'probe', missionId: null, ownerUserId: null, agentName: null, project: null });
}

/**
 * What a plugin may give as `env` instead of a record: called at EACH spawn,
 * so a short-lived token is refreshed by the plugin and never frozen by the
 * daemon. May be async (an OAuth exchange is a network call). `launch` says
 * for whom (cf. `BackendLaunchContext`); a resolver that takes no argument
 * keeps working unchanged.
 */
export type EnvResolver = (launch?: BackendLaunchContext) => Record<string, string> | Promise<Record<string, string>>;

/**
 * What a plugin may describe. Neither `envFrom` nor `requiredEnv`, which would
 * read the daemon's environment; nor a vault reference, which would take an
 * entry out without going through the plugin's `secrets:read` permission.
 *
 * `env` is either fixed NON-secret values, or a FUNCTION called at every
 * mission launch: that is where a plugin reads `ctx.secrets` or refreshes a
 * short-lived token. A value computed at registration would be frozen for the
 * plugin's whole life.
 */
export type RegisteredProfile = Omit<BackendProfile, 'envFrom' | 'requiredEnv' | 'env'> & {
  env?: Record<string, string> | EnvResolver;
};

/** A model a dialect's own probe found, with what the agent said about it. The
 *  levels are the ones THIS model accepts — an agent declares them per model, so
 *  the slider of the agent editor can follow the model chosen. */
export type DiscoveredModel = {
  slug: string;
  supportedReasoningLevels?: string[];
};

/**
 * What a dialect receives from a profile when building a spawn.
 * Built for that one spawn: `env` is resolved then, and nothing keeps it.
 */
export type ProfileRuntime = {
  /** See `BackendProfile.minCliVersion`. */
  minCliVersion?: string;
  /** = `profile.id`, i.e. the exposed `Backend.name`. */
  id: string;
  cmd: string;
  /** Already-resolved env (`process.env`, vault, plugin resolver), to merge
   *  into `SpawnResult.env`. Empty for first-party profiles. */
  env: Record<string, string>;
  providerConfig?: ProviderConfig;
  /** Slugs the profile itself lists. A discovery bounding its answer must not
   *  cut these: the catalogue keeps a static entry only if upstream lists it. */
  knownModels?: readonly string[];
};


/* ── Trace spans (docs/PRD-WORKFLOWS.md §4) ────────────────────────────────
   A dialect knows its own stream vocabulary; the orchestrator knows nothing
   about it. So the dialect is the one that says "this line opens a tool call,
   this one closes it" — and it says so with the SAME ops the store consumes
   (`dbApi.upsertSpans`), fully addressed (mission, trace, seq). Nothing is
   re-interpreted in between. */

/** One write to `trace_spans`: open a span (possibly already terminal for an
 *  instantaneous one) or close a `running` one. Re-exported from `db.ts` so
 *  a dialect emits exactly what the store applies. */
export type { SpanOp } from './span-types.js';
import type { SpanOp } from './span-types.js';

/** A span the dialect has opened and not yet closed. `seq` is the id of the
 *  event that opened it: the bridge back to the raw stream. */
export type OpenSpan = {
  id: string;
  name: string;
  seq: number;
  startedAt: number;
};

/**
 * Per-mission span state, owned by `RunningAgent` and mutated in place by
 * `Dialect.spans`. Rebuilt on `--resume` from the mission's `running` spans
 * (cf. `trace-recorder.ts`), so a turn cut by a crash is closed by the
 * `result` of the resumed process rather than left open forever.
 */
export type SpanState = {
  missionId: string;
  /** Causal root, copied onto every span (`missions.trace_id`). */
  traceId: string;
  /** The enclosing `turn` span, or null between two turns. */
  turn: OpenSpan | null;
  /** Open `tool` spans by `tool_use_id`, waiting for their `tool_result`. */
  tools: Map<string, OpenSpan>;
  /** Ceiling, in UTF-8 bytes, for `input` / `output` (setting
   *  `TIMON_TRACE_SPAN_MAX_BYTES`). Carried here so the dialect never has to
   *  read settings itself — it stays pure and testable. */
  maxBytes: number;
};

/* ── Bidirectional session drivers ─────────────────────────────────────────
   `buildSpawn` + `parseLine` fit a CLI that only TALKS: one JSON line out, one
   event in. An agent speaking JSON-RPC both ways (ACP) also ASKS — it sends
   requests that block until we answer (`session/request_permission`), and a
   turn ends with the reply to OUR request, not with a line of its own. No
   per-line parser can hold that state. A dialect for such an agent therefore
   supplies a `SessionDriver` next to the usual members: the driver owns the
   process's stdio for the whole session, the runner keeps everything else
   (spawn, stop, persistence, the bus).

   Contract of a session-driven dialect, checked by `contract.test.ts`:
     - `persistentProcess` is true (a driver over a one-shot process is a
       contradiction);
     - `buildSpawn` returns `initialStdin: null` — the driver writes the
       handshake, and the system prompt and message travel through it;
     - `writeUserInput` is never called and writes nothing; `parseLine` is
       never called on the driver's stdout and returns `[]`. They stay on the
       interface because every dialect owes them, not because they are used;
     - the caller checks `backend.openSession` first, never a backend name. */

/** The two pipes a driver speaks over. A `ChildProcess` satisfies it, and so
 *  does a pair of `PassThrough`s — which is how a driver is tested without an
 *  agent. */
export type SessionStdio = {
  readonly stdin: Writable;
  readonly stdout: Readable;
};

/**
 * What THIS agent, in THIS session, will actually do — settled by the
 * handshake, never read off a backend name.
 *
 * A driver reports behaviour, not advertisement: an agent's own capability
 * announcement can be wrong (opencode announces MCP over http/sse only and
 * runs a stdio server; Hermes announces none and runs one), so `mcp` says
 * "a stdio MCP server handed to the session works", as the dialect verified.
 */
export type SessionCapabilities = {
  /** A stored session can be reopened, history replayed by the agent. */
  readonly loadSession: boolean;
  /** A stored session can be reopened WITHOUT replaying its history. */
  readonly resume: boolean;
  /** MCP servers given at session creation are honoured (stdio). */
  readonly mcp: boolean;
  /** Image blocks are accepted in a prompt. */
  readonly image: boolean;
  /** This agent arbitrates its own tool uses and never asks TIMON (opencode
   *  refuses a write outside its cwd without a word). Absent = false: the
   *  round trip through `SessionHost.requestPermission` is what guards it. The
   *  UI reads it to say "permissions handled by the agent" instead of showing
   *  a card that will never come; nothing is fabricated to stand in for the
   *  guard the agent does not offer. */
  readonly permissionsByAgent?: boolean;
};

/**
 * What a backend DECLARES it can do, known before any session opens — so the
 * dispatcher, the routes and the UI respect it instead of discovering it by
 * failing. Closed list:
 *
 *   - `worktree`: the agent works in Timon's own folder (the agent's cwd, a
 *     task's git worktree). False for an agent that runs elsewhere — a remote
 *     gateway works in its own space, so a `code` task is refused for it.
 *   - `timonMcp`: Timon's MCP servers (kanban, messages, memory, ask) can be
 *     handed to the agent.
 *   - `attachments`: files other than images can be joined to a turn (they are
 *     announced by their path on Timon's disk, which only a local agent reads).
 *     The same reach decides whether a skill's file can be opened: without it
 *     and without `timonMcp`, a catalogue skill is pasted whole.
 *   - `timonPreamble`: Timon's runtime preamble (and its "your backend" block)
 *     may head the agent's system prompt. False for an agent that already has
 *     its own identity and runs elsewhere: it is sent the agent's own prompt
 *     (soul, role, system prompt, memory), nothing about Timon's folders.
 *
 * Declared on the dialect and/or the profile (`capabilities`), resolved by
 * `backendCapabilities()`: absent = true, which is what every backend did
 * before the field existed. A profile can only NARROW its dialect, never widen
 * it.
 *
 * Not to be confused with `SessionCapabilities`, which the handshake settles
 * for ONE session: the declared value is the ceiling, the session confirms or
 * narrows it (`timonMcp: true` and `mcp: false` = this agent turned the servers
 * down). Images are the session's business (`SessionCapabilities.image`), not
 * `attachments`.
 */
export const BACKEND_CAPABILITIES = ['worktree', 'timonMcp', 'attachments', 'timonPreamble'] as const;
export type BackendCapability = (typeof BACKEND_CAPABILITIES)[number];
export type BackendCapabilities = { readonly [K in BackendCapability]: boolean };

/** Every backend that declares nothing: the behaviour before capabilities. */
export const DEFAULT_BACKEND_CAPABILITIES: BackendCapabilities = Object.freeze({
  worktree: true, timonMcp: true, attachments: true, timonPreamble: true,
});

/** What a caller assumes when there is no driver to ask: nothing. */
export const NO_SESSION_CAPABILITIES: SessionCapabilities = Object.freeze({
  loadSession: false, resume: false, mcp: false, image: false,
});

/** Result of the handshake. */
export type SessionInfo = {
  /** The provider's id for the session, the same one `extractSessionId` reads
   *  for the other dialects (persisted, and passed back as `resumeSession`). */
  readonly sessionId: string;
  readonly capabilities: SessionCapabilities;
  /** False when a `resumeSession` was asked for and the agent could not honour
   *  it: the driver then opened a fresh session instead of failing, and the
   *  caller must not claim the conversation continued. */
  readonly resumed: boolean;
};

/** A tool use the agent wants approved, in protocol-neutral terms: the driver
 *  maps the agent's option ids back and forth, the runner never sees them. */
export type PermissionRequest = {
  readonly toolCallId: string | null;
  /** Tool name or kind as the agent labels it. */
  readonly tool: string;
  readonly title: string | null;
  /** Raw arguments of the call, for the classifier and the card. */
  readonly input: unknown;
  /** Wider answers than "this once" that the agent understands. The card offers
   *  exactly these next to Allow, and nothing else is accepted back. Absent =
   *  Allow / Deny only. */
  readonly scopes?: readonly ApprovalScope[];
};

/** How far an Allow reaches, for an agent that remembers an approval:
 *  `session` = the rest of this conversation, `always` = it never asks again
 *  for that kind of call. Plain Allow is "this once". */
export const APPROVAL_SCOPES = ['session', 'always'] as const;
export type ApprovalScope = (typeof APPROVAL_SCOPES)[number];

export type PermissionDecision = {
  readonly allow: boolean;
  /** Only with `allow`, and only one the request listed in `scopes`. */
  readonly scope?: ApprovalScope;
};

/** How long the driver waits for a permission answer. */
export type PermissionWait = {
  /** Aborted when the agent dropped the question (a stopped turn, an agent
   *  that cancelled its own dialog): the card is retired at once and the
   *  promise settles to a denial nobody reads. Absent = the card lives until
   *  it is answered or expires. */
  readonly signal?: AbortSignal;
};

/** One question of a card an agent asks outside a tool use (`SessionHost.ask`):
 *  the form the `question` tool opens, in protocol-neutral terms. */
export type SessionQuestion = {
  /** The text shown, and the key of its answer: unique within the card. Line
   *  breaks are kept. */
  readonly question: string;
  /** A very short label shown above the question. */
  readonly header?: string;
  /** 2 to 4 choices with distinct labels; absent or empty = a free-text
   *  question. Every question with choices also takes free text. */
  readonly options?: readonly SessionQuestionOption[];
  readonly multiSelect?: boolean;
  /** Free-text question only: the hint in the empty field. */
  readonly placeholder?: string;
};

export type SessionQuestionOption = {
  readonly label: string;
  readonly description?: string;
};

/** A card of 1 to 4 questions. */
export type SessionAskRequest = {
  /** The agent's own id for the request, when it has one: it ties the card to
   *  it, so the same request never opens two cards. */
  readonly id: string | null;
  readonly questions: readonly SessionQuestion[];
};

/** What the person answered to one question: the labels they picked, in the
 *  order of `options`, and what they typed (`null` when nothing). */
export type SessionAnswer = {
  readonly picked: readonly string[];
  readonly text: string | null;
};

/**
 * The outcome of a card. `answered: false` covers every way it ends without an
 * answer: the person closed it, the mission runs unattended (nobody may be
 * asked: `reason` says who to ask instead), the card could not be shown
 * (`reason` names the defect), the wait ended or was aborted. `reason` is
 * written for the agent and never carries a secret.
 */
export type SessionAskOutcome =
  | { readonly answered: true; readonly answers: Readonly<Record<string, SessionAnswer>> }
  | { readonly answered: false; readonly reason: string };

/** What the runner lends the driver. */
export type SessionHost = {
  /** Same vocabulary as `parseLine`'s output (system:init, assistant,
   *  assistant_delta, user, result): everything downstream is unchanged. The
   *  driver emits the turn's `result` itself, before `prompt` resolves. */
  emit(ev: NormalizedEvent): void;
  /** Only ever called under `permissionModel: 'protocol'`. Rejects → the
   *  driver must answer the agent with a denial, never leave it hanging. */
  requestPermission(req: PermissionRequest, wait?: PermissionWait): Promise<PermissionDecision>;
  /**
   * A question the agent asks outside a tool use (an ACP agent's own blocking
   * request): the same card as the `question` tool, under the same rules — a
   * mission nobody watches never asks the person, a developer account is never
   * answered in their place. Absent on a host nobody can answer (a daemon
   * one-shot): the driver answers the agent "no answer" at once. `wait.signal`
   * retires the card when the agent no longer waits. Never rejects.
   */
  ask?(req: SessionAskRequest, wait?: PermissionWait): Promise<SessionAskOutcome>;
};

/**
 * How a remote session ended on its own. A process says it by exiting; a
 * session with no process says it here, and the runner reads it exactly as
 * the matching exit:
 *   - `completed`: the agent closed the session cleanly — exit 0;
 *   - `failed`: it cannot go on; `message` is shown in the thread and kept as
 *     the mission's last words, like a CLI's stderr — a non-zero exit;
 *   - `cancelled`: someone stopped it on the agent's side — a deliberate stop,
 *     never a failure.
 * A stopped TURN is not a session end: `cancel()` makes `prompt` resolve with
 * `cancelled`, and the session goes on.
 */
export type SessionEnd =
  | { readonly reason: 'completed' }
  | { readonly reason: 'failed'; readonly message: string }
  | { readonly reason: 'cancelled' };

/** What the runner lends a REMOTE driver: the same host, plus the way to say
 *  the session is over when no `prompt` is there to reject. */
export type RemoteSessionHost = SessionHost & {
  /** Once; later calls are ignored, as is a call after the runner stopped the
   *  session itself. */
  end(outcome: SessionEnd): void;
  /**
   * Keep what the driver needs to find its session again after the daemon
   * restarted (`RemoteSessionOpenArgs.resume`), or forget it with `null`.
   * Persisted at once, so call it right after `emit` for the event it follows
   * (a `lastSeq` saved before its event is emitted would skip it). Throws a
   * `TypeError` when the state is not a plain JSON object, weighs more than
   * `REMOTE_RESUME_MAX_BYTES` once serialized, or carries a credential of the
   * profile. Ignored once the session is over.
   */
  saveResume(state: RemoteResumeState | null): void;
};

/** The resume state of a remote session: opaque to the daemon, plain JSON,
 *  small, and never a secret — the key comes back from `env` at every launch. */
export type RemoteResumeState = { readonly [key: string]: unknown };

/** Serialized size limit of a `RemoteResumeState`, in UTF-8 bytes. */
export const REMOTE_RESUME_MAX_BYTES = 4096;

/** What a remote driver receives when the daemon reattaches a mission that was
 *  alive when it stopped. */
export type RemoteSessionResume = {
  /** The last state the driver saved with `host.saveResume`. */
  readonly state: RemoteResumeState;
  /** A turn was running and its `result` never reached the thread: after
   *  `start()`, the driver follows it — emits what the daemon missed, its
   *  `result` included — instead of waiting for a `prompt`. */
  readonly turnActive: boolean;
};

/** How a turn ended, for flow control. Usage and the error flag ride on the
 *  emitted `result` event, not here. */
export type TurnOutcome = {
  /** The agent's own reason (`end_turn`, `cancelled`, …). Open on purpose. */
  readonly stopReason: string;
};

export interface SessionDriver {
  /** Null until `start` resolved. Read it to adapt, instead of testing a name. */
  readonly info: SessionInfo | null;
  /** Handshake, then open (or reopen) the session. Rejects when the agent
   *  cannot speak the protocol or refuses to authenticate; the message is safe
   *  to show. */
  start(): Promise<SessionInfo>;
  /** One turn. Resolves when the agent finished it; rejects when the process
   *  died or the stream closed under it (pending requests never hang). */
  prompt(text: string, images?: ImageAttachment[]): Promise<TurnOutcome>;
  /** Stop the running turn. The turn still resolves, with `cancelled`. */
  cancel(): Promise<void>;
  /** Redirect the turn that is running: an instruction the agent takes into
   *  account before it finishes, instead of waiting for the turn's end. Resolves
   *  `true` when the agent took it, `false` when there is no running turn to
   *  steer (nothing was sent). Absent = the runner steers by stopping the turn
   *  (`cancel`) and sending the instruction as the next prompt of the same
   *  session: the agent loses the step it was in, never the conversation. */
  steer?(text: string): Promise<boolean>;
  /** Cf. `Backend.setModel`, but for the session this driver holds. Absent =
   *  no live switch. NEVER during a turn. */
  setModel?(model: string): Promise<boolean>;
  /** Release listeners and reject what is pending. The runner owns the process
   *  and kills it; the driver never does. */
  close(): void;
}

/** What `Dialect.openSession` receives: the same spawn opts the dialect saw in
 *  `buildSpawn` (system prompt, first message, images, resume id, cfg — and so
 *  the MCP servers to declare), plus the pipes and the host. */
export type SessionOpenArgs = {
  readonly io: SessionStdio;
  readonly spawn: BuildSpawnOpts;
  readonly host: SessionHost;
  /** The profile's id, for an agent's quirks. Never its env: credentials were
   *  resolved for the spawn, and nothing here needs them. */
  readonly profileId: string;
  /** Identity variables (`TIMON_API_TOKEN`) for the MCP servers the driver
   *  declares to the agent. An agent may not hand its own environment on to a
   *  server it starts; the pipes carry only what the runner lists here, and the
   *  driver never logs it. Absent = the servers get the non-secret identity
   *  only. A dialect a PLUGIN registered gets `TIMON_API_TOKEN` as a reference,
   *  not the token: write it where the token belongs and the daemon swaps it on
   *  the way to the process (`mission-token-seal.ts`). */
  readonly mcpEnv?: Readonly<Record<string, string>>;
  /** For whom this session is opened — the same context the profile's `env`
   *  resolver received for this launch. Always set by the daemon; optional in
   *  the type so a driver's own tests, written before it existed, still build. */
  readonly launch?: BackendLaunchContext;
};

/**
 * What `RemoteDialect.openSession` receives: the arguments of a process
 * session minus its pipes — there is no process — plus the credentials.
 */
export type RemoteSessionOpenArgs = Omit<SessionOpenArgs, 'io' | 'host' | 'mcpEnv'> & {
  readonly host: RemoteSessionHost;
  /** The profile's environment, resolved for THIS launch exactly as a CLI
   *  would receive it at spawn (`RegisteredProfile.env`, run again at every
   *  launch so a rotated key is seen). It is how a remote driver finds its
   *  address and key. Never logged, never sent anywhere but where the driver
   *  authenticates. The mission's own Timon token is NOT in it: it must not
   *  leave the machine. */
  readonly env: Readonly<Record<string, string>>;
  /** Present only when the daemon reattaches a mission after a restart. Absent
   *  = a new launch: `start()` opens (or, with `spawn.resumeSession`, reopens)
   *  the session as usual. A state the driver cannot use makes `start()`
   *  reject, with a message the user can read. */
  readonly resume?: RemoteSessionResume;
};

/**
 * Dialect = all the code specific to one way of talking to a CLI. Identical
 * to `Backend`, except that `buildSpawn` also receives the resolved profile
 * (binary, env, provider) instead of hardcoding its own binary.
 *
 * This is the API ≤ 10 way to write a provider. It stays supported: the daemon
 * reaches every dialect through `fromLegacy`, which builds the same
 * `ProviderDefinition` a new-style provider will supply. New providers declare
 * `apiVersion: 11` (registration then refuses a dialect whose declarations
 * contradict each other, `dialectProblems`) and are written with
 * `@timon-ai/sdk/provider`, tested with `@timon-ai/sdk/testing`.
 * Cf. `docs/SDK-COMPAT.md` § 33.
 */
/**
 * What a USER-ADDED profile (a `~/.timon/backends/*.json` file, or the form
 * that writes one) may name in `env` — declared BY the dialect, because only
 * the dialect knows what its CLI reads.
 *
 * The rule is positive and fails closed: a dialect that declares nothing lets
 * a data file set nothing. A blacklist over the environment namespace cannot
 * be closed — `GIT_CONFIG_KEY_0`, `npm_config_script_shell`, `RUBYOPT`,
 * `JAVA_TOOL_OPTIONS`, `PAGER` each turn a data file into code through a
 * different door, and the next one is always unlisted. Naming what a provider
 * legitimately needs is a finite job; naming what an operating system can
 * execute is not.
 *
 * Nothing outside the product may widen this: it is code shipped with the
 * dialect, not configuration. A real provider that needs a name we left out is
 * a change to the dialect, reviewed like any other.
 */
export type LocalEnvPolicy = {
  /** Exact names, in full. */
  readonly names: readonly string[];
  /** Families, `PREFIX_` included, accepted whole. */
  readonly prefixes: readonly string[];
  /** One of `prefixes`, suggested in the refusal of a foreign name
   *  (`OPENROUTER_API_KEY` → `BACKEND_OPENROUTER_API_KEY`). A hint only. */
  readonly renameUnder?: string;
};

export interface Dialect {
  readonly id: string;
  /** Cf. `LocalEnvPolicy`. Absent = a data file may set NO variable on this
   *  dialect — the safe default for a dialect that never needed one. */
  readonly localEnv?: LocalEnvPolicy;
  readonly persistentProcess: boolean;
  readonly finishMissionOnExit: boolean;
  /** Cf. `Backend.sessionResumable`. */
  readonly sessionResumable: boolean;
  /** Cf. `Backend.sessionStore`. */
  readonly sessionStore: SessionStore;
  /** Default binary when the profile does not impose one. */
  readonly defaultCmd: string;
  /** Cf. `PermissionModel`. REQUIRED: a dialect must say how it
   *  arbitrates tool uses, otherwise the caller would have to guess. */
  readonly permissionModel: PermissionModel;
  /** Cf. `RateLimitReporting`. REQUIRED for the same reason: this is what
   *  distinguishes "no limit hit" from "we have no idea". */
  readonly rateLimitReporting: RateLimitReporting;
  /** Does the CLI bring the hosted-account connectors (claude.ai) ON TOP OF
   *  the MCPs TIMON declares to it? Determines what the agent has without
   *  configuration — notably semantic search of the vault. */
  readonly hostedConnectors: boolean;
  /** Line of the backend block telling the model how THIS CLI exposes Timon's
   *  browser, when the preamble's wording does not match what it sees.
   *  Absent = the preamble is enough. */
  readonly browserToolsHint?: string;
  /** Line of the backend block telling the model how THIS CLI words a
   *  refused tool use, when its own message would send it the wrong way.
   *  Absent = the generic permissions line is enough. */
  readonly permissionsHint?: string;
  /** Cf. `BackendCapabilities`. A key left out = true; `false` = this agent
   *  cannot, whatever profile runs it. */
  readonly capabilities?: Partial<BackendCapabilities>;
  /**
   * Account-consumption probe. Absent = the CLI exposes no usage → the
   * caller returns "unknown", NEVER zero. When present, it may still
   * return `null` when the current profile is outside the frame where the
   * probe is true (third-party endpoint behind the same dialect, cf.
   * `kimi` profile).
   * It throws `UsageNotSignedInError` when there is no CLI session, and a
   * generic error on network / provider failure: "supported but disconnected"
   * and "supported but unavailable" are not "unsupported".
   */
  accountUsage?(profile: ProfileRuntime, options?: UsageProbeOptions): Promise<AccountUsage | null>;
  /**
   * Model ids the CLI itself says this account may use, for a provider whose
   * offer depends on the account (an organisation's Copilot policy) and that
   * exposes no public HTTP enumeration (`BackendProfile.modelsEndpoint`).
   * Rejects when it cannot tell; the catalogue then keeps `profile.models`.
   * Absent = the profile's list is all there is.
   */
  discoverModels?(profile: ProfileRuntime): Promise<Array<string | DiscoveredModel>>;
  /**
   * Does the agent behind THIS profile arbitrate its own tool uses and never
   * ask TIMON (cf. `SessionCapabilities.permissionsByAgent`)? Known before any
   * session opens, so the catalogue can say so: the UI shows "permissions
   * handled by the agent" instead of promising a card that will never come.
   * Absent = false.
   */
  permissionsByAgent?(profileId: string): boolean;
  /**
   * The provider applies the agent's `permission_mode` before it asks
   * (`PermissionStrategy.appliesMode`): the catalogue tells the UI, which then
   * does not say the agent's own rules decide. Absent = false.
   */
  readonly appliesPermissionMode?: boolean;
  /**
   * Kinds of thinking control this dialect can send for a CUSTOM provider's
   * model, read from the model's resolved `reasoning`. Absent = levels only:
   * `reasoningEffort` goes to the CLI as a level, so a budget or a switch must
   * not be offered for it.
   */
  readonly thinkingControls?: readonly ReasoningControl['type'][];
  /** Cf. `SessionStrategy.compact`: the message that makes the agent compact
   *  its own session. Absent = no native compaction. */
  readonly nativeCompact?: { readonly command: string };
  buildSpawn(opts: BuildSpawnOpts, profile: ProfileRuntime): Promise<SpawnResult>;
  writeUserInput(
    proc: ChildProcessWithoutNullStreams,
    text: string,
    images?: ImageAttachment[],
  ): void;
  parseLine(line: string): NormalizedEvent[];
  extractSessionId(ev: NormalizedEvent): string | null;
  /**
   * Trace spans this event opens or closes (PRD §4.1). `state` is the
   * mission's open-span bookkeeping, mutated in place; `eventId` is the
   * `events.id` of the persisted line (span `seq` / `event_id_*`). Absent =
   * the dialect is not traced: the caller records nothing, never guesses.
   * Must not throw on an unexpected payload — return `[]` instead.
   */
  spans?(ev: NormalizedEvent, state: SpanState, eventId: number): SpanOp[];
  /** Cf. `Backend.openSession`. Absent = line-oriented dialect (every dialect
   *  before ACP). Present = the contract described at "Bidirectional session
   *  drivers". Must not touch the process's streams before `start()`. */
  openSession?(args: SessionOpenArgs): SessionDriver;
  isSessionNotFoundError?(stderr: string): boolean;
  /** Cf. `Backend.setModel`. Absent = the dialect cannot switch live;
   *  the caller falls back to persisting the override. */
  setModel?(proc: ChildProcessWithoutNullStreams, model: string): Promise<boolean>;
  /** Cf. `Backend.maxPromptBytes`. */
  readonly maxPromptBytes?: number;
  dispose?(missionId: string): void;
  /** Cf. `Backend.enrichEvent`. */
  enrichEvent?(ev: NormalizedEvent, missionId: string): NormalizedEvent;
}

/**
 * A dialect that reaches its agent over the network (HTTP, WebSocket…) with no
 * local process: no binary to resolve or to allow, nothing to spawn, no line
 * stream. Its `openSession` holds the whole conversation, as a session driver
 * does over a process's pipes (cf. "Bidirectional session drivers"), and the
 * runner treats the mission like any other — events, permissions, stop, reaper,
 * end of turn, mission return.
 *
 * Everything the runner reads off a process is decided here instead: the
 * session outlives its turns (`persistentProcess` is implied), and its end ends
 * the mission (`finishMissionOnExit` is implied).
 */
export type RemoteDialect = Omit<
  Dialect,
  | 'persistentProcess' | 'finishMissionOnExit' | 'defaultCmd' | 'buildSpawn' | 'writeUserInput'
  | 'parseLine' | 'openSession' | 'isSessionNotFoundError' | 'setModel' | 'maxPromptBytes'
> & {
  readonly transport: 'remote';
  /** Called at every launch of a mission, once its credentials are resolved.
   *  Must not open a connection before `start()`; must not throw — a failure
   *  belongs to `start()`, where the runner shows it. */
  openSession(args: RemoteSessionOpenArgs): SessionDriver;
};

/** Any dialect the registry holds. */
export type AnyDialect = Dialect | RemoteDialect;

/** The test for "no process behind this dialect" — never its name. */
export function isRemoteDialect(dialect: AnyDialect): dialect is RemoteDialect {
  return (dialect as { transport?: unknown }).transport === 'remote';
}

export interface Backend {
  readonly name: BackendName;

  /** True for backends that keep a single process alive across user turns
   *  (Claude). False for one-shot per-turn backends (Codex). Controls
   *  whether `sendToAgent` writes to stdin or re-spawns. */
  readonly persistentProcess: boolean;

  /** Whether the orchestrator should mark the TIMON mission as finished
   *  when the subprocess exits. Claude: yes (its process exits = chat
   *  ended). Codex: no (each turn is its own process; mission outlives
   *  the process and is closed only on explicit kill or new turn). */
  readonly finishMissionOnExit: boolean;

  /**
   * Does the session survive process death, so that a `--resume` in a NEW
   * process finds the thread again?
   *
   * Do not confuse with `persistentProcess`, which only says whether the CLI
   * keeps a process alive between two turns. The two properties used to be
   * conflated: the wake-loop refused to wake IN PLACE any one-shot mission,
   * so grok missions — whose per-mission GROK_HOME survives and whose `-r`
   * does find the thread (verified) — always restarted on a new mission,
   * without the in-progress plan's context.
   *
   * `true` for codex since #607: its per-mission CODEX_HOME outlives a kill
   * until the retention purge, and a resume that misses the rollout is replayed
   * on a fresh thread by `session.notFound`.
   *
   * Says nothing about whether the backend reports a session at all: a one-shot
   * declared `false` still resumes within its mission when it reports one. What
   * decides a context replay is what the backend did (`owesContextReplay`).
   */
  readonly sessionResumable: boolean;

  /**
   * WHERE the session lives: in a CLI-global store (`global`, cf. claude,
   * whose `~/.claude` survives everything and knows ALL sessions) or in the
   * per-mission scratch TIMON builds for it (`per-mission`, cf. grok and its
   * GROK_HOME, codex and its CODEX_HOME).
   *
   * What this decides: can we resume ANOTHER mission's session? Wake-by-spawn
   * (a new mission started on the agent's latest session) only makes sense
   * in `global` — in `per-mission`, the new mission gets an empty scratch,
   * `--resume` finds nothing and the turn restarts from scratch after a
   * wasted round-trip. Resume INSIDE the same mission depends only on
   * `sessionResumable`.
   */
  readonly sessionStore: SessionStore;

  /** CLI permission model (cf. `PermissionModel`). Every permission
   *  decision on the orchestrator or UI side is read HERE, never from `name`. */
  readonly permissionModel: PermissionModel;

  /** What the stream says about a usage limit (cf. `RateLimitReporting`). */
  readonly rateLimitReporting: RateLimitReporting;

  /** Hosted-account connectors available on top of TIMON MCPs. */
  readonly hostedConnectors: boolean;

  /** Cf. `Dialect.browserToolsHint`. */
  readonly browserToolsHint?: string;

  /** Cf. `Dialect.permissionsHint`. */
  readonly permissionsHint?: string;

  /** Account consumption, or `null` if the probe does not apply to the
   *  profile. Absent = backend with no exposed usage (cf. `Dialect.accountUsage`). */
  accountUsage?(options?: UsageProbeOptions): Promise<AccountUsage | null>;

  /** Build the spawn command, args, env and any initial stdin payload. */
  buildSpawn(opts: BuildSpawnOpts): Promise<SpawnResult>;

  /** Push a follow-up user turn. For persistent backends, write to stdin
   *  of the running process. For one-shot backends, this is a no-op (the
   *  caller re-spawns via buildSpawn with `resumeSession` set).
   *
   *  `images` carries any inline attachments for this turn. Backends
   *  that don't support multimodal stdin input ignore them. */
  writeUserInput(
    proc: ChildProcessWithoutNullStreams,
    text: string,
    images?: ImageAttachment[],
  ): void;

  /** Parse one JSONL line into 0..N normalized TIMON events. Returns an
   *  empty array for lines we want to drop (banners, no-op events).
   *  On a persistent process, an `assistant` after a `result` opens a new turn
   *  (the CLI went back to work by itself): the words of a closed turn come
   *  before its `result`. Only a recording can show it: the conformance bench
   *  checks it, `dialectProblems` cannot. */
  parseLine(line: string): NormalizedEvent[];

  /** Extract a session/thread id from a normalized event, if present.
   *  Returned values are persisted on the mission row and used for the
   *  next spawn's `resumeSession`. Null for events that don't carry one. */
  extractSessionId(ev: NormalizedEvent): string | null;

  /** Cf. `Dialect.spans`. Absent ⇒ no span is ever written for this backend. */
  spans?(ev: NormalizedEvent, state: SpanState, eventId: number): SpanOp[];

  /**
   * Bidirectional session over the process's stdio, for an agent that sends
   * requests of its own (ACP). Present ⇒ the runner hands the spawned process
   * to the driver INSTEAD of reading lines through `parseLine` and writing
   * through `writeUserInput`; the driver's `info.capabilities` then say what
   * the session can do. Absent ⇒ the line-oriented path, unchanged.
   *
   * The test for "does this backend speak a session protocol" is the presence
   * of this member, never a name. `profileId` is bound here, so a caller
   * cannot pass one that is not the backend's own.
   */
  openSession?(args: Omit<SessionOpenArgs, 'profileId' | 'launch'>): SessionDriver;

  /**
   * Present on a backend with no process (`RemoteDialect`): the runner opens
   * the session here instead of spawning anything, and every process-only
   * member above (`buildSpawn`, `writeUserInput`, `parseLine`) refuses to run.
   * Credentials are resolved at `start()`, so a missing key surfaces in the
   * mission's thread like any session that could not open.
   */
  openRemoteSession?(args: Omit<RemoteSessionOpenArgs, 'profileId' | 'env' | 'launch'>): SessionDriver;

  /** True if a chunk of the CLI's stderr signals that the session we tried
   *  to `--resume` no longer exists (pruned, or created under a different
   *  cwd so the provider's local store can't find it). When the orchestrator
   *  sees this on a resuming spawn, it retries the same turn fresh (without
   *  resume) instead of letting the mission die exit 1. Backends that have no
   *  such error (or where resume can't mismatch) leave this undefined → no
   *  fallback ever fires for them. */
  isSessionNotFoundError?(stderr: string): boolean;

  /**
   * Changes the model of the IN-FLIGHT conversation process, with no respawn
   * and no loss of context. Resolves `true` if the CLI confirmed the change,
   * `false` if it refused, did not answer in time, or if stdin is closed.
   *
   * OPTIONAL: absent ⇒ this backend cannot switch live. The only recourse is
   * then to persist the override and wait for a respawn — that is the
   * caller's job, not the backend's.
   *
   * NEVER call during an active turn: the CLI applies the change on the next
   * turn, but the in-flight turn is already committed to the old model and
   * `result.modelUsage` would mix the two. Queuing is handled on the
   * orchestrator side (cf. `setMissionModel`).
   */
  setModel?(proc: ChildProcessWithoutNullStreams, model: string): Promise<boolean>;

  /* Note: the model → backend mapping does NOT live here. It is
     declared in the catalogue (`./catalog.ts`) and resolved by
     `backendForModel()`, so the UI and the dispatcher read the same
     list. A backend has nothing to implement for that. */

  /**
   * Maximum size, in UTF-8 BYTES, of the kickoff message this backend
   * accepts in ONE invocation. Absent = no known ceiling (the message goes
   * through stdin, which has none).
   *
   * Concerns dialects that pass the prompt via argv: Linux refuses any
   * argument exceeding MAX_ARG_STRLEN (128 KiB) with E2BIG, and the spawn
   * fails BEFORE the CLI starts. A caller that builds a large kickoff
   * (cf. `switchMissionBackend`) must therefore bound its context to this.
   */
  readonly maxPromptBytes?: number;

  /** Cf. `Dialect.nativeCompact`. Absent = the agent cannot compact its own
   *  session: a compaction summarizes and forks (`mission-compact.ts`). */
  readonly nativeCompact?: { readonly command: string };

  /** Cleanup of per-mission resources created by the backend (scratch dir,
   *  sockets…), called when the mission is explicitly killed. Optional:
   *  backends with no on-disk state do not implement it. */
  dispose?(missionId: string): void;

  /** Completes a parsed event with what only the mission's on-disk state
   *  knows, before it is persisted (codex: the context-window snapshot, which
   *  its stdout never carries). Must not throw; absent = events pass as-is. */
  enrichEvent?(ev: NormalizedEvent, missionId: string): NormalizedEvent;
}
