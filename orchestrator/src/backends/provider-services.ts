/**
 * The shapes of what `ctx.provider.*` returns (`docs/PROVIDERS-SDK.md` § 6.1),
 * apart from the code that builds them: this file is types only, so the SDK can
 * publish it without a line of the daemon behind it.
 *
 * What each service gives back is a RESULT that carries no privilege. Where a
 * value the plugin must not hold has to travel (the mission's token, the
 * credentials of the user's own MCP servers), the field holds a REFERENCE
 * (`timon-seal-…`) the daemon swaps at the points where the data leaves for the
 * agent's process (`launch-seal.ts`).
 */

import type { BuildSpawnOpts, ProfileRuntime } from './types.js';
import type { COMMAND_POLICY } from './command-policy.js';
import type { McpLaunchServer } from './mcp-serialize.js';
import type { ProviderScratchDir } from './scratch-dir.js';

/** Which of Timon's servers, or whose, a server of the plan is. */
export type ProviderMcpRole = 'timon' | 'forms' | 'grepai' | 'browser' | 'user' | 'search';

export type ProviderMcpServer = McpLaunchServer & { readonly role: ProviderMcpRole };

export type ProviderMcpOptions = {
  /**
   * The CLI sends the tool uses it does not pre-allow to Timon's permission tool
   * (`--permission-prompt-tool`, the `mcp-bridge` model): the forms server then
   * lists `request`, and `permissionTool` is set. Default: forms only, which is
   * what a sandboxed or protocol-driven CLI needs.
   */
  readonly permissionPrompt?: boolean;
};

/**
 * Timon's MCP servers for ONE mission, neutral: the plugin serializes them for its
 * CLI with `runtime.mcp.serialize*`.
 */
export type ProviderMcpPlan = {
  /** `timon`, `timon_ask`, the project's `grepai` and browser, then the agent's own servers. */
  readonly servers: readonly ProviderMcpServer[];
  /** Optional for older SDK fixtures. Native search suppression is independent of other tools. */
  readonly webSearch?: { readonly mode: 'native' | 'parallel' | 'off'; readonly preApproved: boolean };
  /**
   * The environment that identifies the mission to the servers above: the daemon's
   * address, the mission and the agent — and `TIMON_API_TOKEN` as a REFERENCE the
   * daemon swaps for the token. Absent outside a launch (a probe has no mission,
   * hence no identity to give).
   */
  readonly identityEnv: Readonly<Record<string, string>>;
  readonly daemonUrl: string;
  /** Where the bundled scripts of the `timon` and forms servers live. */
  readonly scripts: { readonly timon: string; readonly forms: string };
  /** The tool a CLI routes permission requests to, when `permissionPrompt` was asked. */
  readonly permissionTool: string | null;
  /** Tools every agent may call without a card (`mcp__<server>__<tool>`); a decision of the product. */
  readonly preApprovedTools: readonly string[];
  /** Names of account-hosted connectors this agent excluded, without credentials. */
  readonly excludedServers?: readonly string[];
  /** What no agent may run, and the Timon CLI commands a mission needs: decisions of the product. */
  readonly commandPolicy: typeof COMMAND_POLICY;
};

/** The base environment of a mission's process. */
export type ProviderEnvPlan = {
  /**
   * What the daemon would give the CLI of this mission before its own spec: the
   * system variables, the identity pointers (`TIMON_MISSION_ID`, `TIMON_API`…) and
   * the variables the provider declared `passthroughEnv`. Never `TIMON_API_TOKEN`
   * (it travels as a reference, `ProviderMcpPlan.identityEnv`). For a provider
   * shipped inside the product it also holds the vault slice the mission was
   * granted; for any other, never a vault value nor the daemon's environment.
   */
  readonly env: Readonly<Record<string, string>>;
  /** The project the mission works for, from the agent's declaration or the cwd. */
  readonly project: string | null;
};

/** S3 — private per-mission state. */
export type ProviderScratch = {
  /**
   * The private folder of this mission, created on first use under the daemon's own
   * run folder and removed when the mission is disposed. Needs a launch in progress:
   * a probe has no mission to keep a folder for, and nothing is created for it.
   */
  mission(spawn: BuildSpawnOpts): Promise<ProviderScratchDir>;
};

/** S5 — masks, in what a provider emits, the values only the daemon knows. */
export type ProviderRedact = {
  /** `text` with every vault value of 12 characters or more replaced by `***`. */
  text(text: string): string;
  /** The same for every string inside `value`, arrays and objects included; the input is not modified. */
  deep<T>(value: T): T;
};

export type ProviderProbeOptions = {
  /** Default 10 000 ms, ceiling 60 000: a probe is a question, not a job. */
  readonly timeoutMs?: number;
  readonly cwd?: string;
  /** Variables for the process, on top of the system whitelist. The daemon's own environment and the mission's token are never inherited. */
  readonly env?: Readonly<Record<string, string>>;
};

export type ProviderProbeResult = {
  readonly code: number;
  /** Capped at 1 MiB each: what a probe prints is a few lines, and a runaway one must not fill the daemon's memory. */
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

export type ProviderServeOptions = {
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  /** A regular expression (source text, up to 200 characters) the server prints when it is ready; its first group, if any, is handed back as `match`. */
  readonly ready?: string;
  /** How long to wait for it. Default 15 000 ms, ceiling 60 000. */
  readonly readyTimeoutMs?: number;
};

/** A headless server a provider started (`opencode serve`): the daemon owns the process and ends it with its tree. */
export type ProviderServer = {
  readonly pid: number | null;
  /** The first capture group of `ready`, or the whole match; null when `ready` was not given. */
  readonly match: string | null;
  /** The last output the process printed, secrets masked. */
  output(): string;
  /** Resolves when the process is gone, however it went. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Stops the process and what it started. Safe to call twice. */
  stop(): Promise<void>;
};

export type ProviderConverseOptions = {
  /** Variables for the process, on top of the system whitelist. The daemon's own environment and the mission's token are never inherited. */
  readonly env?: Readonly<Record<string, string>>;
  /** Default 20 000 ms, ceiling 60 000: a conversation is a question, not a job. The daemon stops the process when the time is up. */
  readonly timeoutMs?: number;
};

/** A short exchange with a declared program over its pipes (a JSON-RPC question a CLI answers on stdin / stdout). */
export type ProviderConversation = {
  readonly pid: number | null;
  /** The folder the process runs in: the daemon's own home, where an empty session the CLI keeps will not sit in a project. */
  readonly cwd: string;
  /** Writes to the process's stdin; a closed pipe is reported by `exited`, not thrown. */
  write(data: string | Uint8Array): void;
  /** Receives each chunk of stdout, in order, as raw bytes (a framed protocol counts bytes). Returns the way to stop listening. */
  onData(listener: (chunk: Uint8Array) => void): () => void;
  /** The last output the process printed on stderr, secrets masked. */
  stderr(): string;
  /** Resolves when the process is gone, however it went. */
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Ends stdin and stops the process with its tree. Safe to call twice. */
  stop(): Promise<void>;
};

/** S4 — the programs the manifest declared (`provider.binaries`), and nothing else. */
export type ProviderBinary = {
  /** Where `name` resolves on this host (the operator's pins, the PATH, the vendor's known folders and what the provider declared), or null. */
  resolve(name: string): Promise<string | null>;
  /** The first `x.y.z` that `<name> --version` prints, or null (not installed, or unreadable). Never opens a session. */
  version(name: string): Promise<string | null>;
  /** A short command with a bounded output and a deadline. */
  probe(name: string, args: readonly string[], options?: ProviderProbeOptions): Promise<ProviderProbeResult>;
  /** A headless server, watched until it is ready. At most four per plugin; all are stopped when the plugin unloads. */
  serve(name: string, args: readonly string[], options?: ProviderServeOptions): Promise<ProviderServer>;
  /**
   * A question asked of the program over its pipes — `copilot --acp`, a headless server that speaks JSON-RPC on stdin / stdout —
   * with a deadline. The process is the daemon's: stopped with its tree at the deadline, on `stop()`, and with the plugin. At
   * most four conversations and servers together per plugin.
   */
  converse(name: string, args: readonly string[], options?: ProviderConverseOptions): Promise<ProviderConversation>;
};

/** The working tree of a mission, as far as git is concerned. */
export type ProviderGit = {
  /**
   * The folders a sandboxed CLI has to be allowed to write for `git add` / `git commit` / a fast-forward to work
   * in `cwd`: the git directory and the common one (a linked worktree has both), and the main working tree when
   * `cwd` is a linked worktree. Resolved paths, existing folders only; empty outside a repository. The daemon
   * asks git itself — the only way to cover a normal repository, a worktree, a subfolder and an externalised
   * `.git` in one go — because a plugin has no way to run `git` and a root it named would widen a sandbox.
   */
  writableRoots(cwd: string): readonly string[];
};

/** A picture the daemon kept in the mission's chat; put the list in the turn's `result` as `generated_media`. */
export type ProviderGeneratedMedia = {
  readonly file: string;
  readonly kind: 'image' | 'video';
  readonly mime: string;
  readonly name: string;
};

/** S6 — adopting into a turn the files a CLI produced. */
export type ProviderMedia = {
  /**
   * The pictures the CLI wrote into `directory` since `sinceMs`, copied into the
   * mission's chat. The daemon applies the ceilings (12 per turn, 25 MiB each), checks
   * the bytes (a real image, whatever the name), copies each file once, and refuses a
   * `directory` that is neither inside this mission's scratch folder nor its working
   * directory. Needs the mission to be running on a backend this plugin registered.
   */
  adopt(missionId: string, directory: string, sinceMs: number): Promise<readonly ProviderGeneratedMedia[]>;
  /**
   * `adopt`, answered at once. The hook that puts `generated_media` into a turn's `result` (`lifecycle.enrich`)
   * is synchronous — it runs on the line of the stream that carries the result — so it cannot await. The
   * mission's launch is still open then (the daemon closes it with the process, after the last line).
   */
  adoptSync(missionId: string, directory: string, sinceMs: number): readonly ProviderGeneratedMedia[];
  /**
   * Lets the agent show (`chat_show_media`) a file from `directory` of the mission's
   * scratch folder, as it can for its working directory. Forgotten with the mission.
   */
  allowShow(missionId: string, directory: string): void;
};

/** S8 — one entry of the OS credential store, read-only. */
export type ProviderOsCredentials = {
  /** Forget a cached miss after an explicit sign-in or usage refresh; only a declared entry. */
  invalidate(service: string, account?: string): void;
  /**
   * The secret stored under `service` (and `account`, when the manifest named one) in
   * the macOS login keychain, or null: not macOS, no such entry, locked, refused. Only
   * an entry the manifest declared in `provider.osCredentials`; never logged. The
   * secret is the CLI's own sign-in: read it, do not refresh it — a rotated refresh
   * token would sign the CLI out.
   */
  read(service: string, account?: string): Promise<string | null>;
};

/** The subscription account a launch runs on. */
export type ProviderAccountContext = {
  readonly id: string;
  readonly name: string;
  /** The account's own private folder (0700): where the CLI keeps THIS sign-in. Point the CLI at it (`CODEX_HOME`, `CLAUDE_CONFIG_DIR`) so it does not fall back on the host's. */
  readonly configDir: string;
};

/** S7 — which account a launch is for. Who may use which account is the core's; the sign-in flow is `declares.accounts`. */
export type ProviderAccount = {
  /**
   * The account the profile of this launch runs on, or undefined for the host's own
   * sign-in. A provider that declared `accounts` MUST honour it: ignoring it would run
   * the mission on the host's subscription without a word. Only for a profile this plugin
   * registered.
   */
  of(profile: ProfileRuntime): ProviderAccountContext | undefined;
};

/** A release-owned opaque credential. Values never enter an HTTP response. */
export type ProviderCredentialStore = {
  read(): string | null;
  status(): { configured: boolean; readable: boolean };
  /** Strict zod HTTP body validation; null means malformed. */
  parseBody(body: unknown): string | null;
  write(value: string): void;
  clear(): boolean;
  syncMarker(): void;
};
