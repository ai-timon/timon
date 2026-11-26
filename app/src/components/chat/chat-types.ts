/**
 * The shapes the chat shares with its panels.
 *
 * They lived in `chat-client.tsx` while Missions / Files / Git were functions
 * of the same file. Extracted as widgets (§10.12), they need the same types
 * without depending on the page: a pure types module avoids the import cycle a
 * crossed `import type` would produce.
 */

import type { AccountUsageView } from '@/lib/account-usage';

export type Agent = {
  name: string;
  backend?: string;
  model?: string;
  /** Explicit role from the agent config (coder/reviewer/…). */
  role?: string | null;
  kind?: string;
  status?: string;
  project?: string | null;
  cwd?: string;
  skills?: string[];
  mcp_servers?: string[];
  excluded_mcp_servers?: string[];
  emoji?: string | null;
  color?: string | null;
  icon_url?: string | null;
  /** Mascot look (`config.look`), any value: `agentIdentity` checks it field by field. */
  look?: unknown;
  /** Picked head (`config.avatar`): `emoji`, `image`, `mascot`, or absent. */
  avatar?: unknown;
};

/** Who a mission belongs to (TIM-0118); `null` before setup or once the
 *  account is gone, absent from an older daemon. */
export type MissionOwner = { id: string; name: string; avatar_url: string | null };

export type MissionSummary = {
  id: string;
  mission: string;
  status: string;
  running: boolean;
  started_at: number;
  ended_at: number | null;
  total_cost_usd?: number | null;
  tokens_in?: number | null;
  tokens_out?: number | null;
  event_count?: number;
  /** Timestamp (ms) of the earliest unresolved permission request for this
   *  mission, or null. Used to render the "action required" badge in the
   *  sidebar so the user can spot pending prompts without opening the chat. */
  pending_action_at?: number | null;
  /** request_id of that earliest unresolved permission — used as deep-link
   *  target to scroll the conversation straight to the right card. */
  pending_action_id?: string | null;
  /** Kanban task that spawned this mission (null = direct user→agent chat,
   *  pinned at top of the rail). */
  task_id?: string | null;
  /** `setup` = the main agent's first-run conversation: listed, never re-opened on its own. */
  source_channel?: string | null;
  task_title?: string | null;
  /** Who started it (`lib/mission-origin.ts`); absent from an older daemon. */
  origin?: string | null;
  owner?: MissionOwner | null;
  /** Display name: set by hand, by the launcher, read from the CLI or generated (`title_source` says which). */
  title?: string | null;
  /** Unix ms when the mission was archived (hidden from the default lists); null/absent = visible. */
  archived_at?: number | null;
  /** Unix ms when the agent proposed archiving it; null/absent = no proposal pending. */
  archive_suggested_at?: number | null;
  archive_suggest_reason?: string | null;
  title_source?: 'manual' | 'preset' | 'native' | 'generated' | null;
  /** The backend CLI's own session id (claude session, codex thread…); null until
   *  the CLI reports it, absent from an older daemon. */
  session_id?: string | null;
  /** The mission that launched this one (mission_spawn, Kanban series
   *  orchestrator); null for a mission started by hand, absent from an older daemon. */
  parent_mission_id?: string | null;
  task_type?: string | null;
  /** Timestamp (ms) of the last event in this mission. Drives the rail
   *  ordering so a freshly active conversation bubbles up. */
  last_event_at?: number | null;
  /** The agent is mid-turn on THIS mission (turn state on the orchestrator
   *  side, not just "process alive"). Used by the rail to animate every
   *  mission that's thinking, not just the one open. */
  turn_active?: boolean;
  /** Fine state from the daemon (working / turn_done / open / interrupted / ended),
   *  plus what feeds it and the work still owed. */
  turn_complete?: boolean;
  liveness?: string | null;
  interrupted_reason?: string | null;
  pending_messages?: number;
  open_deliveries?: number;
  /** Optional agent identity copied onto each row so the rail can render
   *  emoji + accent without a separate /agents lookup. */
  agent_emoji?: string | null;
  agent_color?: string | null;
  agent_icon_url?: string | null;
  /** Model that ran this mission (e.g. "opus-4-7", "sonnet-4-6"). */
  model?: string | null;
  /** Agent that owns this mission. */
  agent_name?: string | null;
  /** Role configured on the agent (e.g. "coder", "reviewer", "merger"). */
  agent_role?: string | null;
};

/* ─── An agent's file tree ─── */
/** `abs`: the entry's absolute path on the host, built by the daemon with the OS's own separators. */
export type FileEntry = { name: string; kind: 'file' | 'dir' | 'symlink' | 'other'; size: number; modified: number; abs?: string };
export type DirListing = { kind: 'dir'; path: string; abs?: string; entries: FileEntry[] };
/** `external`: a file outside the agent's folder, `path` is then absolute. */
export type FileBody = { external?: boolean; kind: 'file'; path: string; size: number; modified: number; binary: boolean; truncated: boolean; content: string };
export type FilesResponse = DirListing | FileBody;

export type SkillSource = 'timon' | 'claude-user' | 'project' | 'plugin';

export type SkillItem = {
  id: string;
  title?: string;
  description?: string;
  source: SkillSource;
  format?: 'timon' | 'claude-skill' | 'claude-cmd';
  argument_hint?: string;
  shadowed?: boolean;
};

export type McpItem = {
  id: string;
  name?: string;
  transport_type: 'stdio' | 'http' | 'external';
  tools_count: number;
  source?: 'timon' | 'claude_ai' | 'claude_cli';
};

export type AgentTodoStatus = 'pending' | 'in_progress' | 'completed' | 'cancelled';

export type AgentTodo = {
  id: string;
  subject: string;
  description?: string;
  status: AgentTodoStatus;
};

/** Image attached to a user turn (clipboard or paperclip). */
export type PendingImage = {
  id: string;
  mediaType: string;
  base64: string;
  /** Transient blob:// for the composer's thumbnail — revoked on removal. */
  previewUrl: string;
  size: number;
};

export type VoiceMode = 'text' | 'conversation';

export type RateLimitInfo = {
  status: 'allowed' | 'warned' | 'blocked' | string;
  resetsAt: number;
  /** Anthropic's overage tier is consumed once the regular quota is
   *  exhausted — when this flips true we surface the overage line in
   *  the status bar (otherwise it's hidden, since users on the
   *  subscription don't want to see a $ figure for normal usage). */
  isUsingOverage?: boolean;
  /** Exact utilization as a percentage in [0, 100], populated from
   *  the OAuth usage endpoint (same source Claude Code's statusLine
   *  uses). Optional because the SSE rate_limit_event itself doesn't
   *  carry it — we poll /api/ui/usage (current backend) in parallel and merge. */
  utilization?: number;
};

export type LiveStats = {
  /** From the most recent system:init event, or null while still queued. */
  model: string | null;
  /** Effective context size of the last Anthropic API call
   *  (input + cache_read + cache_create from a single assistant
   *  message's usage). Used as the "context window usage" proxy on
   *  the status line. Not summed across turn-internal tool round-trips
   *  — claude's result.usage is the sum and overflows wildly. */
  lastContextTokens: number;
  /**
   * Context windows REPORTED BY THE RUNTIME, indexed by model slug
   * (versioned id, short form, canonical). Fed by
   * `result.modelUsage[*].contextWindow` — the only value that stays
   * correct when a new model ships, since it comes from the engine itself
   * rather than a hand-written table.
   *
   * History replay goes through the same `ingest()`, so a page reload
   * rebuilds the map instead of starting from a guess.
   */
  contextWindows: Record<string, number>;
  /** Cumulative across all turns of this mission. */
  totalIn: number;
  totalOut: number;
  /** Latest rate_limit_event per limit type — claude emits each window
   *  (five_hour / seven_day) on its own event, so we keep them indexed
   *  rather than overwriting one with the other. */
  rateLimits: {
    five_hour?: RateLimitInfo;
    seven_day?: RateLimitInfo;
    /** Monthly allowance (Copilot premium requests): only the usage poll
     *  feeds it, no stream event carries it. */
    monthly?: RateLimitInfo;
  };
  /** Anthropic overage tier — extra paid credits consumed once the
   *  subscription quota is exhausted. Same OAuth usage endpoint
   *  source. Null until the first successful poll, or when the
   *  account doesn't have an overage budget configured. */
  extraUsage: {
    isEnabled: boolean;
    utilization: number; // [0, 100]
    usedCredits: number;
    monthlyLimit: number;
    currency: string;
  } | null;
  /** Idle / error of GET /api/ui/usage. Absent while the gauges carry numbers. */
  accountUsage?: AccountUsageView;
};
