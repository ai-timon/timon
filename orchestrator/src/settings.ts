/**
 * Central registry of TIMON settings.
 *
 * Before this module, ~60 `TIMON_*` variables were read directly via
 * `process.env` all over the place, with their default hardcoded at the
 * read site. Consequence: almost every setting was INVISIBLE — you could
 * not know they existed without grepping the code, and you could not
 * change them without editing a `.env` or the systemd unit.
 *
 * Here, each setting is declared once (type, default, label, group) and
 * resolved in a strict order:
 *
 *     environment variable  >  `settings` table  >  registry default
 *
 * The environment keeps absolute priority: that is what lets you force a
 * setting punctually (debug, one-shot run, leftover systemd override)
 * without touching the persisted configuration. The counterpart is that
 * an env-forced setting is not editable from the UI — hence `resolve()`
 * exposing the SOURCE of the value, so the settings page can say so
 * explicitly instead of looking like a bug.
 *
 * Do NOT declare bootstrap variables here (`TIMON_HOME`, MCP paths,
 * orchestrator URL): they are needed to find and open the database, so
 * reading them from the database would be circular. They stay in the env.
 */
import { dbApi } from './db.js';
import { config } from './config/load.js';
import { memoryPresetSettings, resourceMemoryInfo } from './resource-memory-presets.js';

export type SettingType = 'bool' | 'int' | 'float' | 'string';

export type SettingDef = {
  key: string;
  type: SettingType;
  /** Fallback default; resolve() exposes the effective hardware default. */
  default: boolean | number | string;
  group: string;
  label: string;
  description?: string;
  /** Unit displayed next to the field (ms, days, characters…). */
  unit?: string;
  /** Rare or dangerous setting: collapsed by default in the UI. */
  advanced?: boolean;
  /**
   * Bundled plugin (catalog id) the setting belongs to. Storage and
   * resolution stay here; the UI files the setting under that plugin and
   * hides it while the plugin is disabled.
   */
  owner?: string;
  /** The value is a folder path: the UI offers the OS folder picker where one exists. */
  input?: 'directory';
  /**
   * Inclusive bounds of a numeric setting, enforced on write and sent to the
   * UI. A value already stored out of range is NOT clamped here: the reader
   * that would misbehave on it bounds it itself (`currentProfile`).
   */
  min?: number;
  max?: number;
};

export type SettingSource = 'env' | 'config' | 'db' | 'default';

export type ResolvedSetting = {
  def: SettingDef;
  value: boolean | number | string;
  source: SettingSource;
  /** Raw value stored in the database, if present (for the UI). */
  dbValue: string | null;
};

/* ────────────────────────────────────────────────────────────────────────
   The registry. Defaults reproduce historical behaviour.
   CAUTION with booleans: the original semantics were not homogeneous
   (some `=== '1'` hence off by default, others `=== '0'` hence on by
   default). The `default` field carries that difference; it is intentional.
   ──────────────────────────────────────────────────────────────────────── */

export const SETTINGS: SettingDef[] = [
  // ── Backlog ───────────────────────────────────────────────────────────
  { key: 'TIMON_TODO_OUTCOME_ENABLED', type: 'bool', default: false, group: 'Backlog', owner: '@timon/todo-outcomes',
    label: 'Idea outcomes',
    description: "Shows the Outcome block on backlog ideas and accepts resolution, public note and duplicate reference. "
      + "Meant for a community-feedback setup (a bot relaying outcomes to idea authors); off by default." },

  // ── AI CLIs (filed under @timon/backends) ─────────────────────────────
  { key: 'TIMON_CLI_UPDATE_CHECK', type: 'bool', default: true, group: 'Misc', owner: '@timon/backends',
    label: 'Check for CLI updates',
    description: "Asks each AI CLI's vendor (the npm registry, x.ai) for its newest version, at startup and then on the "
      + "interval below, to show 'Update available' on the provider cards. Off: nothing is requested; the "
      + "installed version is still read from the CLI itself." },
  { key: 'TIMON_CLI_UPDATE_INTERVAL_HOURS', type: 'int', default: 12, group: 'Misc', owner: '@timon/backends',
    unit: 'h', min: 1, max: 168, label: 'CLI update check interval',
    description: "Hours between two checks for newer AI CLI versions. One hour at the least.",
    advanced: true },

  // ── Timon updates (filed under @timon/updates) ────────────────────────
  { key: 'TIMON_UPDATES_CHECK', type: 'bool', default: true, group: 'Misc', owner: '@timon/updates',
    label: 'Check for Timon updates',
    description: "Reads the signed list of Timon releases on timon-ai.com at startup and every 6 hours, to show "
      + "a banner when a newer version is published for this build's channel. The request carries no licence, "
      + "account or machine identifier. Off: nothing is requested. A build run from the sources never checks." },

  // ── Missions & concurrency ────────────────────────────────────────────
  { key: 'TIMON_MAX_LIVE_MISSIONS', type: 'int', default: 12, group: 'Missions',
    label: 'Live missions (soft cap)',
    description: "Ceiling consulted by the autonomous spawners (dispatcher, wake). Human chat does not check it." },
  { key: 'TIMON_HARD_MAX_LIVE_MISSIONS', type: 'int', default: 0, group: 'Missions',
    label: 'Live missions (hard circuit breaker)',
    description: "Absolute ceiling, all sources combined. 0 = automatic (2× the soft cap). Last resort against runaway.",
    advanced: true },
  { key: 'TIMON_MAX_PARALLEL', type: 'int', default: 8, group: 'Missions',
    label: 'Kanban tasks dispatched in parallel',
    description: "Number of Kanban tasks dispatched at the same time. The global live-mission cap bounds the rest." },
  { key: 'TIMON_LOAD_THRESHOLD', type: 'float', default: 0.9, group: 'Missions',
    label: 'Machine load threshold per core',
    description: "1-minute loadavg normalised per core above which spawning is slowed down.",
    advanced: true },
  { key: 'TIMON_SWITCH_TRANSCRIPT_MAX_TOKENS', type: 'int', default: 80_000, group: 'Missions',
    unit: 'tokens', label: 'Full transcript on backend switch',
    description: "Switching backend mid-mission starts from a blank session: "
      + "below this threshold the entire transcript is resent (nothing is lost); "
      + "above it we fall back to a summary, which is lossy. 0 = always summarise." },
  { key: 'TIMON_SWITCH_KICKOFF_MARGIN_BYTES', type: 'int', default: 2_000, group: 'Missions',
    unit: 'bytes', label: 'Handover wrapping margin',
    description: "The handover message wraps the context in a title, an explanation and "
      + "a follow-up. Reserved out of what the target CLI accepts, so the wrapping never "
      + "pushes the prompt past the limit. Only bites on a CLI that reads its prompt from argv.",
    advanced: true },
  { key: 'TIMON_MISSION_TITLE_MODEL', type: 'string', default: 'auto', group: 'Missions',
    label: 'Title model',
    description: "Model that names the conversations you open, for every account that has not chosen "
      + "its own in Settings. `auto`: the lightest model of the conversation's backend. `off`: no "
      + "generated title. `<backend>:<model>`: that one (e.g. `claude:haiku`), on a backend that runs "
      + "a local process. Each title costs one short call on that backend's quota, and the first "
      + "message of the conversation is sent to it." },
  { key: 'TIMON_MISSION_TITLE_TIMEOUT_MS', type: 'int', default: 60_000, group: 'Missions', unit: 'ms',
    label: 'Title generation timeout',
    description: "A conversation you open gets a short title from a one-shot model call at the end of "
      + "its first turn. Past this delay the call is killed and the mission keeps the first "
      + "message as its label; nothing is retried.",
    advanced: true },
  { key: 'TIMON_SUMMARY_TIMEOUT_MS', type: 'int', default: 300_000, group: 'Missions', unit: 'ms',
    label: 'Summariser timeout',
    description: "Compacting a transcript spawns a one-shot CLI that no reaper watches: "
      + "unbounded, a silent one would hold up whoever waits for the summary — a backend "
      + "switch above all. Past this delay it is killed and the caller falls back.",
    advanced: true },
  { key: 'TIMON_SESSION_ONE_SHOT_OPEN_MS', type: 'int', default: 30_000, group: 'Missions', unit: 'ms',
    label: 'Session one-shot opening timeout',
    description: "A summary, a memory pass or a Dreaming prompt on an agent that speaks a session "
      + "protocol (opencode, Hermes) first opens a throwaway session with it. Past this delay "
      + "without a session, the agent is stopped and the call fails, instead of waiting for the "
      + "summariser timeout.",
    advanced: true },

  // ── LLM fallback (exhausted quota) ────────────────────────────────────
  // A single fallback backend for all of TIMON: when a series of tasks runs
  // out of credits, the whole series switches onto it, orchestrator included.
  // cf. backend-fallback.ts.
  { key: 'TIMON_FALLBACK_ENABLED', type: 'bool', default: true, group: 'LLM fallback',
    label: 'Automatic switch on exhausted quota',
    description: "When a backend announces its usage limit, the missions and tasks that depend on it restart on the fallback backend instead of dying in a cascade." },
  { key: 'TIMON_PREFERRED_BACKEND', type: 'string', default: '', group: 'LLM fallback',
    label: 'Preferred provider',
    description: "Provider a new agent, mission or chat runs on when nothing else names one, as long as it is active and signed in. Empty (default) = the first active provider that is signed in." },
  { key: 'TIMON_FALLBACK_BACKEND', type: 'string', default: '', group: 'LLM fallback',
    label: 'Fallback backend (last resort)',
    description: "Fallback used LAST, when neither the task, nor the series, nor the model-equivalence matrix proposed a workable target. Must be the id of a provider that is installed and active (claude, codex, a provider plugin…). Empty (default) = stop at equivalence: nothing assumes a given provider exists." },
  { key: 'TIMON_FALLBACK_MODEL', type: 'string', default: '', group: 'LLM fallback',
    label: 'Fallback model',
    description: "Model used when the fallback backend above is the one that answers. Empty = that backend's default model. Has no effect on fallbacks coming from the series or the equivalence matrix, which carry their own model." },
  { key: 'TIMON_FALLBACK_COOLDOWN_MS', type: 'int', default: 5 * 60 * 60 * 1000, group: 'LLM fallback',
    unit: 'ms', label: 'How long a backend stays sidelined',
    description: "Applied only when the provider does NOT give the time its quota reopens. When it does, that time is the one that counts. Default: 5 h, Anthropic's sliding window.",
    advanced: true },
  { key: 'TIMON_BACKEND_EXHAUSTED_COOLDOWN_MS', type: 'int', default: 24 * 60 * 60 * 1000, group: 'LLM fallback',
    unit: 'ms', label: 'How long a backend WITHOUT CREDIT stays sidelined',
    description: "Applied when the backend answers with a payment error (HTTP 402, 'balance exhausted') rather than a usage limit: no window reopens here, only a top-up brings it back. Longer than the quota cooldown on purpose, and lifted early by the first turn that succeeds on that backend. Default: 24 h.",
    advanced: true },

  // ── Circuit breaker (backend structurally unavailable) ────────────────
  // Reads no error message: N sterile turns in a row (0 turn, 0 token, under
  // two seconds) are enough to sideline a backend. cf. backend-breaker.ts.
  { key: 'TIMON_BREAKER_ENABLED', type: 'bool', default: true, group: 'LLM fallback',
    label: 'Circuit breaker on repeated sterile turns',
    description: "Sidelines a backend that bounces every mission back instantly (broken auth, dead endpoint, account with no credit) without waiting to recognise its error message." },
  // TODO #459: a turn the provider could not finish (dropped stream, 5xx,
  // overloaded) is replayed by Timon on a mission nobody watches. cf. turn-retry.ts.
  { key: 'TIMON_TURN_RETRIES', type: 'int', default: 3, group: 'LLM fallback',
    label: 'Automatic retries of a turn the provider dropped',
    description: "Unattended missions only (Kanban task, wake, routine, sub-mission): once the provider has given up its own retries on a transient failure, Timon replays the same turn in the same session this many times. 0 disables it. A human chat shows a Retry button instead." },
  { key: 'TIMON_TURN_RETRY_BASE_MS', type: 'int', default: 30_000, group: 'LLM fallback', unit: 'ms',
    label: 'Wait before the first automatic retry', advanced: true,
    description: "Doubled at each retry (30 s, 60 s, 120 s by default), and never shorter than the wait the provider itself announced." },
  { key: 'TIMON_BREAKER_THRESHOLD', type: 'int', default: 3, group: 'LLM fallback',
    label: 'Sterile turns before the breaker trips',
    description: "Consecutive bounces on the SAME backend, inside the window below. Minimum 2: a single bounce is a fluke.",
    advanced: true },
  { key: 'TIMON_BREAKER_WINDOW_MS', type: 'int', default: 10 * 60 * 1000, group: 'LLM fallback',
    unit: 'ms', label: 'Window the breaker counts over',
    description: "Older failures are forgotten. What we look for is a burst, not a total: three bounces in ten minutes, not three in a week. Default: 10 min.",
    advanced: true },
  { key: 'TIMON_BREAKER_STERILE_MS', type: 'int', default: 2000, group: 'LLM fallback',
    unit: 'ms', label: 'Below this, a failed turn is a bounce',
    description: "A turn that fails in under this time having produced neither a turn nor a token did not work: it bounced off the provider. Default: 2 s.",
    advanced: true },
  { key: 'TIMON_BREAKER_COOLDOWN_MS', type: 'int', default: 30 * 60 * 1000, group: 'LLM fallback',
    unit: 'ms', label: 'How long the breaker sidelines a backend',
    description: "Shorter than the quota and no-credit cooldowns on purpose: the cause here is UNKNOWN, so it may well be transient (a service outage, an expired token that gets refreshed). Lifted early by the first turn that succeeds. Default: 30 min.",
    advanced: true },

  // ── Resources (anti-freeze guard: day/night profile, cgroups) ─────────
  // Defaults calibrated for the reference machine: 62 GB RAM, 32 cores.
  // Do not raise them without checking that the desktop stays usable under load.
  { key: 'TIMON_RESOURCE_GUARD_ENABLED', type: 'bool', default: true, group: 'Resources',
    label: 'Confine missions (systemd scope)',
    description: "Launches each mission in its own systemd scope (slice timon-missions.slice) with a memory ceiling, nice and ionice inherited by all of its processes — including an ffmpeg started three levels down. Disabling it makes the machine vulnerable to a heavy generation again." },
  { key: 'TIMON_DAY_START_HOUR', type: 'int', default: 8, group: 'Resources', unit: 'h', min: 0, max: 23,
    label: 'Start of the day (local)',
    description: "Start of the window where you work on the machine: missions are throttled then. From 0 to 23." },
  { key: 'TIMON_DAY_END_HOUR', type: 'int', default: 20, group: 'Resources', unit: 'h', min: 0, max: 24,
    label: 'End of the day (local)',
    description: "Outside this window the night profile applies: ceilings are relaxed. From 0 to 24 "
      + "(24 = the day runs until midnight; equal to the start = always night)." },
  { key: 'TIMON_DAY_CPU_QUOTA_PCT', type: 'int', default: 400, group: 'Resources', unit: '%',
    label: 'Mission CPU quota — day',
    description: "In % of one core, for ALL missions combined (400 = 4 cores out of 32). The rest is guaranteed to the desktop." },
  { key: 'TIMON_NIGHT_CPU_QUOTA_PCT', type: 'int', default: 1600, group: 'Resources', unit: '%',
    label: 'Mission CPU quota — night',
    description: "1600 = 16 cores out of 32. We keep half the machine free even at night (thermals, and a remote session remains possible)." },
  { key: 'TIMON_DAY_MEM_MAX_GB', type: 'int', default: 16, group: 'Resources', unit: 'GB',
    label: 'Memory — day hard ceiling',
    description: "COLLECTIVE ceiling of all missions. Past this, the kernel kills a mission process, confined to this cgroup: the machine and the desktop session are left alone. There is deliberately no soft threshold below it: throttling the missions creates memory pressure that the system OOM daemon may answer by killing the whole desktop session." },
  { key: 'TIMON_NIGHT_MEM_MAX_GB', type: 'int', default: 24, group: 'Resources', unit: 'GB',
    label: 'Memory — night hard ceiling',
    description: "Collective night memory ceiling. The automatic default follows the detected RAM class." },
  { key: 'TIMON_MISSION_MEM_MAX_GB', type: 'int', default: 12, group: 'Resources', unit: 'GB',
    label: 'Memory — per-mission ceiling',
    description: "Individual ceiling of a mission and its processes. This is what turns \"the machine freezes\" into \"this particular mission gets killed\": the ffmpeg of 13/08 had climbed to 35 GB." },
  { key: 'TIMON_DAY_NICE', type: 'int', default: 15, group: 'Resources',
    label: 'Mission nice — day',
    description: "CPU priority (0 = normal, 19 = lowest). Inherited by every process of the mission." },
  { key: 'TIMON_NIGHT_NICE', type: 'int', default: 5, group: 'Resources',
    label: 'Mission nice — night' },
  { key: 'TIMON_DAY_IONICE_CLASS', type: 'int', default: 3, group: 'Resources',
    label: 'ionice class — day', advanced: true,
    description: "1 = real-time, 2 = best-effort, 3 = idle. The cgroup io controller is not delegated to the user manager, so disk priority goes through ionice on the process, not IOWeight." },
  { key: 'TIMON_NIGHT_IONICE_CLASS', type: 'int', default: 2, group: 'Resources',
    label: 'ionice class — night', advanced: true },
  { key: 'TIMON_DAY_MAX_LIVE_MISSIONS', type: 'int', default: 4, group: 'Resources',
    label: 'Live missions — day ceiling',
    description: "Lowers the global cap during the day. Four missions each launching an encode is the crash scenario. Clamped to the global cap, never above it." },
  { key: 'TIMON_DAY_MAX_PARALLEL', type: 'int', default: 2, group: 'Resources',
    label: 'Dispatched tasks — day ceiling',
    description: "Lowers Kanban dispatcher parallelism during the day." },
  { key: 'TIMON_RESOURCE_WATCH_MS', type: 'int', default: 30_000, group: 'Resources', unit: 'ms',
    label: 'Watch frequency', advanced: true,
    description: "How often cgroup counters are re-read (profile switch, OOM detection). Floor at 5 s." },

  // ── Reaper (cleanup of dead missions) ─────────────────────────────────
  { key: 'TIMON_REAP_IDLE_MS', type: 'int', default: 600_000, group: 'Reaper', unit: 'ms',
    label: 'Idle time before reap', description: "An autonomous mission whose turn ended is terminated once nothing has been heard from it for this long, unless it still has a background process of its own running (see the next setting)." },
  { key: 'TIMON_REAP_BG_MS', type: 'int', default: 3_600_000, group: 'Reaper', unit: 'ms',
    label: 'Idle time before reap, background job running',
    description: "1 h by default. An autonomous mission whose turn ended but whose CLI still has a process it started (a test suite launched in the background, waiting for its completion notice) is spared past the idle time above, up to this hard ceiling, measured from the end of its turn. Missions with no such process are unaffected." },
  { key: 'TIMON_CHAT_ATTACHMENT_TTL_MS', type: 'int', default: 2_592_000_000, group: 'Reaper', unit: 'ms',
    label: 'Chat attachments kept after a mission ends',
    description: "30 days by default. Files attached in chat are deleted once their mission has been finished for this long — never while it is running, and a resumed mission counts as running again. 0 disables the cleanup." },
  { key: 'TIMON_PROVIDER_SESSION_TTL_MS', type: 'int', default: 2_592_000_000, group: 'Reaper', unit: 'ms',
    label: 'Provider sessions kept after a mission ends',
    description: "30 days by default. A CLI that keeps its conversation in the mission's own folder (Codex) can resume it as long as that folder exists: it outlives a stop or a kill, and is deleted once its mission has been finished for this long — never while it is running, and a resumed mission counts as running again. 0 disables the cleanup." },
  { key: 'TIMON_REAP_HUNG_MS', type: 'int', default: 2_700_000, group: 'Reaper', unit: 'ms',
    label: 'Silent turn before reap',
    description: "45 min by default. A running turn is stopped as hung once its agent has produced nothing for this long — no output, no tool progress, no event. A long turn that keeps working is left alone (see the turn budget below). Also the implicit ceiling of an automatic permission timeout: a longer one is pointless." },
  { key: 'TIMON_REAP_TURN_MAX_MS', type: 'int', default: 14_400_000, group: 'Reaper', unit: 'ms',
    label: 'Turn budget',
    description: "4 h by default, 0 disables it. Hard ceiling on the duration of a single turn, even one still working: past it the turn is stopped with the cause \"turn budget reached\", never reported as hung. For an autonomous mission, the turns its CLI opens by itself (after a background job finishes) count as one, from the end of the last turn Timon started. A turn waiting on a human permission card is spared, like the hung reap." },
  { key: 'TIMON_REAP_CHAT_IDLE_MS', type: 'int', default: 3_600_000, group: 'Reaper', unit: 'ms',
    label: 'Idle time before reaping chats',
    description: "1 h by default. A human chat whose turn is finished keeps its CLI process alive: without this delay it occupies a global-cap slot for life (night of 2026-08-22: 9 idle chats until 4:45am → cap 12/12, nothing else would start). The reap only kills the PROCESS — the session stays resumable, the next message resumes the conversation. Much longer than the autonomous idle reap: someone may come back to their chat." },
  { key: 'TIMON_REAP_INTERVAL_MS', type: 'int', default: 60_000, group: 'Reaper', unit: 'ms',
    label: 'Reaper sweep frequency', advanced: true,
    description: "How often the reaper inspects live missions." },
  { key: 'TIMON_REAP_ORPHAN_GRACE_MS', type: 'int', default: 120_000, group: 'Reaper', unit: 'ms',
    label: 'Grace before reaping orphans', advanced: true,
    description: "Delay granted to a mission with no live process before it is considered orphaned. Avoids killing a mission that is still starting." },

  // ── Worktrees (garbage collection of task branches) ───────────────────
  { key: 'TIMON_WORKTREE_GC_ENABLED', type: 'bool', default: true, group: 'Worktrees',
    label: 'Automatic worktree cleanup',
    description: "Deletes the worktree and branch of a DONE task whose work is already integrated into the base. A branch that is not integrated is NEVER deleted, whatever the age of the task." },
  { key: 'TIMON_WORKTREE_GC_GRACE_MIN', type: 'int', default: 30, group: 'Worktrees', unit: 'min',
    label: 'Grace before cleanup', advanced: true,
    description: "Delay after a task closes before its worktree becomes a candidate. Gives the merger and the following doc task time to work in it." },

  // ── Permissions ───────────────────────────────────────────────────────
  { key: 'TIMON_PERMISSION_AUTONOMOUS_TIMEOUT_MS', type: 'int', default: 300_000, group: 'Permissions', unit: 'ms',
    label: 'Delay before auto-deny (autonomous missions)',
    description: "SHORT delay, for an Allow / Deny card (forms have their own delay), applied when nobody could be notified on their phone (Web Push not configured, no subscription, send failed): the assumption \"nobody will click\" holds, and leaving a night agent hanging is pointless. Past this delay the request is denied with a message inviting the agent to pick an alternative. If the push was delivered, \"Delay before auto-deny (human notified)\" applies instead. Chat missions are NEVER auto-resolved." },
  { key: 'TIMON_PERMISSION_PUSHED_TIMEOUT_MS', type: 'int', default: 2_100_000, group: 'Permissions', unit: 'ms',
    label: 'Delay before auto-deny (human notified)',
    description: "LONG delay, applied as soon as a Web Push notification was delivered to at least one device: someone was notified and can answer from the lock screen, we give them time. Hard-clamped to 80 % of \"Blocked turn before reap\" (45 min): past that the reaper would kill the mission before the denial can fire, which is worse than the denial itself." },

  { key: 'TIMON_PERMISSION_FORM_TIMEOUT_MS', type: 'int', default: 1_800_000, group: 'Permissions', unit: 'ms',
    label: 'Delay before a form expires (autonomous missions)',
    description: "Applies to a form an agent opens (`question`, `kanban_plan`) instead of the delay before auto-deny: a form takes reading and choosing, not a single click. Past it the form expires and the agent is told to go on without the answer. Hard-clamped like the other delays to 80 % of \"Blocked turn before reap\". Chat missions never expire." },

  { key: 'TIMON_PERMISSION_DETACH_GRACE_MS', type: 'int', default: 30_000, group: 'Permissions', unit: 'ms',
    label: 'Grace before retiring an abandoned card', advanced: true,
    description: "When the agent stops waiting for a card (call cancelled, MCP bridge gone), the card is retired after this delay, unless the bridge reconnects to it first. Longer than the bridge's own reconnect backoff, so a dropped socket is not mistaken for a cancellation." },

  // ── Wake ──────────────────────────────────────────────────────────────
  { key: 'TIMON_WAKE_SWEEP_MS', type: 'int', default: 30_000, group: 'Wake', unit: 'ms',
    label: 'Inbox sweep frequency',
    description: "How often the inter-agent inbox is scanned. Determines the max delay before a message addressed to an agent wakes it." },
  { key: 'TIMON_WAKE_PAIR_MAX_MESSAGES', type: 'int', default: 30, group: 'Wake',
    label: 'Agent-to-agent messages before holding',
    description: "Most messages two agents may exchange, both directions counted, within the window below without a human stepping in. Past it, their messages are held in the inbox, neither agent is woken by the other, and you get an alert naming the pair. Writing to either agent in the chat resumes them. Task and mission returns are never counted." },
  { key: 'TIMON_WAKE_PAIR_WINDOW_MS', type: 'int', default: 1_800_000, group: 'Wake', unit: 'ms',
    label: 'Agent-to-agent window', advanced: true,
    description: "Sliding window over which the agent-to-agent messages above are counted." },

  // ── Memory: injection ─────────────────────────────────────────────────
  { key: 'TIMON_MEMORY_INJECTION_ENABLED', type: 'bool', default: true, group: 'Memory — injection',
    label: 'Inject memory into prompts',
    description: "Injects learned rules and pitfalls into every agent's prompt at spawn. Disabling it makes agents amnesic from one mission to the next." },
  { key: 'TIMON_MEMORY_CORE_CAP', type: 'int', default: 10, group: 'Memory — injection',
    label: 'Injected core rules (ceiling)',
    description: "Maximum number of \"core\" rules injected at spawn. Higher = better-informed agents, but a heavier prompt on every mission." },
  { key: 'TIMON_MEMORY_RECALL_MAX_CHARS', type: 'int', default: 12_000, group: 'Memory — injection', unit: 'characters',
    label: 'Memory recall budget',
    description: "Character budget allocated to memory recall in the prompt. Caps the token cost of injection." },
  { key: 'TIMON_MEMORY_SEARCH_CAP', type: 'int', default: 40, group: 'Memory — injection',
    label: 'Max memory search results', advanced: true,
    description: "Number of results returned by a memory search." },

  // ── Memory: fact capture ──────────────────────────────────────────────
  { key: 'TIMON_FACT_CAPTURE_ENABLED', type: 'bool', default: false, group: 'Memory — capture',
    label: 'Capture facts at the end of a mission',
    description: "At the end of each mission, a small model extracts the notable facts (decisions, pitfalls, preferences). That is the source that feeds the overnight synthesis." },
  { key: 'TIMON_FACT_CAPTURE_MODEL', type: 'string', default: 'claude-haiku-4-5-20251001', group: 'Memory — capture',
    label: 'Capture model',
    description: "Model that extracts facts at the end of a mission. Deliberately small and fast: the job is simple and fires on every mission." },

  // ── Memory: overnight synthesis ───────────────────────────────────────
  { key: 'TIMON_MEMORY_SYNTH_ENABLED', type: 'bool', default: true, group: 'Memory — synthesis',
    label: 'Overnight synthesis enabled',
    description: "Overnight pass that turns accumulated raw facts into durable rules, per project. This is what makes memory progress instead of piling up." },
  { key: 'TIMON_MEMORY_SYNTH_MODEL', type: 'string', default: 'claude-sonnet-4-6', group: 'Memory — synthesis',
    label: 'Synthesis model',
    description: "Memory curator's model. It writes the retained rules directly, with no human validation." },
  { key: 'TIMON_MEMORY_SYNTH_AGENT', type: 'string', default: 'TIMON.librarian', group: 'Memory — synthesis',
    label: 'Agent that synthesises',
    description: "Agent under whose identity the synthesis runs (determines cwd, MCP and permissions)." },
  { key: 'TIMON_MEMORY_SYNTH_HOUR', type: 'int', default: 3, group: 'Memory — synthesis', unit: 'h',
    label: 'Start hour (local)',
    description: "Start of the overnight synthesis window. Placed before scoring and dreaming, which consume its result." },
  { key: 'TIMON_MEMORY_SYNTH_WINDOW_H', type: 'int', default: 4, group: 'Memory — synthesis', unit: 'h',
    label: 'Window width',
    description: "How long synthesis may fire. Past this window it waits for the next night." },
  { key: 'TIMON_MEMORY_SYNTH_MIN_FACTS', type: 'int', default: 5, group: 'Memory — synthesis',
    label: 'Minimum facts to trigger',
    description: "Below this number of pending facts the project is skipped: not enough material for a useful synthesis." },
  { key: 'TIMON_MEMORY_SYNTH_MAX_FACTS', type: 'int', default: 80, group: 'Memory — synthesis',
    label: 'Max facts per pass',
    description: "Ceiling of facts processed per pass, to bound the cost of a night." },
  { key: 'TIMON_MEMORY_SYNTH_SPACING_MS', type: 'int', default: 90_000, group: 'Memory — synthesis', unit: 'ms',
    label: 'Spacing between projects', description: "Spreads credit consumption over the window.", advanced: true },

  // ── Memory: promotion & forgetting ────────────────────────────────────
  { key: 'TIMON_MEMORY_PROMOTION_ENABLED', type: 'bool', default: false, group: 'Memory — promotion',
    label: 'Promotion of recurring facts',
    description: "Spots facts that come back often and proposes them as durable rules." },
  { key: 'TIMON_MEMORY_PROMOTE_THRESHOLD', type: 'int', default: 3, group: 'Memory — promotion',
    label: 'Occurrences before promotion',
    description: "How many times a fact must reappear before it is proposed as a durable rule. Lower = more reactive memory, but noisier." },
  { key: 'TIMON_MEMORY_PROMOTE_INTERVAL_MS', type: 'int', default: 21_600_000, group: 'Memory — promotion', unit: 'ms',
    label: 'Interval between passes', advanced: true,
    description: "How often the recurring-fact promoter runs." },
  { key: 'TIMON_MEMORY_DECAY_ENABLED', type: 'bool', default: false, group: 'Memory — promotion',
    label: 'Gradual forgetting (decay)',
    description: "Archives old non-salient facts. Reversible: facts go into learnings.archive.jsonl. The curated project tier is never touched." },
  { key: 'TIMON_MEMORY_DECAY_HALFLIFE_DAYS', type: 'float', default: 30, group: 'Memory — promotion', unit: 'days',
    label: 'Forgetting half-life',
    description: "Forgetting speed: after one half-life, an unused fact has lost half of its score." },
  { key: 'TIMON_MEMORY_DECAY_THRESHOLD', type: 'float', default: 0.1, group: 'Memory — promotion',
    label: 'Archival threshold', advanced: true,
    description: "Score below which a fact is archived. Higher = more aggressive forgetting." },

  // ── Global digest ─────────────────────────────────────────────────────
  { key: 'TIMON_DIGEST_HOT_DAYS', type: 'int', default: 30, group: 'Global digest', unit: 'days',
    label: '"Hot projects" window',
    description: "Activity window past which a project is no longer considered \"hot\" in the global digest." },
  { key: 'TIMON_DIGEST_HOT_MAX', type: 'int', default: 6, group: 'Global digest',
    label: 'Hot projects kept',
    description: "Number of \"hot\" projects kept in the digest injected into project-less agents." },
  { key: 'TIMON_DIGEST_CHAR_CAP', type: 'int', default: 2_500, group: 'Global digest', unit: 'characters',
    label: 'Max digest size',
    description: "Maximum size of the global digest. It is injected into the prompt, so it is paid in tokens on every concerned mission." },

  // ── Project scoring ───────────────────────────────────────────────────
  { key: 'TIMON_SCORE_ENABLED', type: 'bool', default: true, group: 'Scoring', label: 'Scoring enabled',
    description: "Overnight pass that grades each project (profitability × progress) to prioritise attention. Dreaming relies on it to choose what to think about." },
  { key: 'TIMON_SCORE_MODEL', type: 'string', default: 'claude-sonnet-4-6', group: 'Scoring', label: 'Model',
    description: "Model used to evaluate projects." },
  { key: 'TIMON_SCORE_AGENT', type: 'string', default: 'TIMON.librarian', group: 'Scoring', label: 'Agent',
    description: "Agent under whose identity scoring runs." },
  { key: 'TIMON_SCORE_HOUR', type: 'int', default: 5, group: 'Scoring', unit: 'h',
    label: 'Start hour (local)', description: "After memory synthesis (3 h by default)." },
  { key: 'TIMON_SCORE_WINDOW_H', type: 'int', default: 2, group: 'Scoring', unit: 'h', label: 'Window width',
    description: "How long scoring may fire. Past this window it waits for the next night." },
  { key: 'TIMON_SCORE_STALE_DAYS', type: 'int', default: 14, group: 'Scoring', unit: 'days',
    label: 'Age before re-scoring',
    description: "A project not re-graded for this long is re-evaluated, even with no recent activity." },
  { key: 'TIMON_SCORE_SPACING_MS', type: 'int', default: 90_000, group: 'Scoring', unit: 'ms',
    label: 'Spacing between projects', advanced: true,
    description: "Pause between two graded projects. Spreads credit consumption." },

  // ── Dreaming ──────────────────────────────────────────────────────────
  { key: 'TIMON_DREAM_ENABLED', type: 'bool', default: true, group: 'Dreaming', owner: '@timon/dreams', label: 'Dreaming enabled',
    description: "Overnight pass where the dreaming agent explores improvement leads and opportunities. NEVER creates a task: everything lands in a review queue to be validated." },
  { key: 'TIMON_DREAM_MODEL', type: 'string', default: 'claude-sonnet-4-6', group: 'Dreaming', owner: '@timon/dreams', label: 'Model',
    description: "Model used to dream." },
  { key: 'TIMON_DREAM_AGENT', type: 'string', default: '', group: 'Dreaming', owner: '@timon/dreams', label: 'Agent that dreams',
    description: "Agent under whose identity dreaming runs (cwd, MCP, default model). Empty: the main agent." },
  { key: 'TIMON_DREAM_HOUR', type: 'int', default: 6, group: 'Dreaming', owner: '@timon/dreams', unit: 'h',
    label: 'Start hour (local)', description: "After synthesis (3 h) and scoring (5 h)." },
  { key: 'TIMON_DREAM_WINDOW_H', type: 'int', default: 1, group: 'Dreaming', owner: '@timon/dreams', unit: 'h', label: 'Window width',
    description: "How long dreaming may fire. Past this window it waits for the next night." },
  { key: 'TIMON_DREAM_IMPROVE_TOP_N', type: 'int', default: 4, group: 'Dreaming', owner: '@timon/dreams',
    label: 'Projects explored per night',
    description: "Number of projects explored per night, taken from the highest-graded. We do not dream about cold projects." },
  { key: 'TIMON_DREAM_IMPROVE_PER_PROJECT', type: 'int', default: 2, group: 'Dreaming', owner: '@timon/dreams',
    label: 'Leads per project',
    description: "Number of leads proposed per explored project." },
  { key: 'TIMON_DREAM_OPP_MAX', type: 'int', default: 3, group: 'Dreaming', owner: '@timon/dreams',
    label: 'External opportunities per night',
    description: "Number of external opportunities sought per night (web search). 0 disables this phase." },
  { key: 'TIMON_DREAM_MIN_PRIORITY', type: 'int', default: 8, group: 'Dreaming', owner: '@timon/dreams',
    label: 'Minimum project priority', description: "Below this, the project is skipped." },
  { key: 'TIMON_DREAM_DEDUP_DAYS', type: 'int', default: 30, group: 'Dreaming', owner: '@timon/dreams', unit: 'days',
    label: 'Deduplication window',
    description: "A lead already proposed inside this window will not be proposed again. Without this, the same ideas would be re-suggested every night." },
  { key: 'TIMON_DREAM_SPACING_MS', type: 'int', default: 90_000, group: 'Dreaming', owner: '@timon/dreams', unit: 'ms',
    label: 'Spacing between dreams', advanced: true,
    description: "Pause between two dreams. Spreads credit consumption over the overnight window." },
  { key: 'TIMON_DREAM_IMPROVE_TIMEOUT_MS', type: 'int', default: 200_000, group: 'Dreaming', owner: '@timon/dreams', unit: 'ms',
    label: 'Timeout of an "improve" dream', advanced: true,
    description: "Anti-hang guard: an improvement dream is not a tracked mission, so the reaper will not catch it." },
  { key: 'TIMON_DREAM_OPP_TIMEOUT_MS', type: 'int', default: 360_000, group: 'Dreaming', owner: '@timon/dreams', unit: 'ms',
    label: 'Timeout of an "opportunity" dream', advanced: true,
    description: "Same for opportunity hunting, which is longer because it performs web searches." },

  // ── Terminal ──────────────────────────────────────────────────────────
  { key: 'TIMON_TERMINAL_ENABLED', type: 'bool', default: true, group: 'Terminal', owner: '@timon/terminal-native',
    label: '"Open a terminal" button',
    description: "Shows in the chat a button that opens the native terminal of the machine hosting the orchestrator, positioned on the mission folder. Disabling it hides the button AND refuses the call on the server side." },
  { key: 'TIMON_TERMINAL_COMMAND', type: 'string', default: 'hyper', group: 'Terminal', owner: '@timon/terminal-native',
    label: 'Terminal command',
    description: "Executable launched with the folder as its only argument (hyper, gnome-terminal, x-terminal-emulator…). No shell is interposed." },

  { key: 'TIMON_TERMINAL_WEB_ENABLED', type: 'bool', default: true, group: 'Terminal', owner: '@timon/terminal-web',
    label: 'Built-in terminal',
    description: "A terminal emulator inside Timon (desktop, browser, phone) running a shell on this machine as the daemon's user. Only accounts holding the \"terminal:open\" permission can open one (the superadmin always can). Disabling it refuses new sessions and attachments." },
  { key: 'TIMON_TERMINAL_WEB_IDLE_MIN', type: 'int', default: 30, group: 'Terminal', owner: '@timon/terminal-web', unit: 'min',
    label: 'Close a detached terminal after',
    description: "A built-in terminal keeps running when its window closes or the phone locks, so a long command finishes. With no window attached for this long, its shell is killed." },
  { key: 'TIMON_TERMINAL_WEB_SHELL', type: 'string', default: '', group: 'Terminal', owner: '@timon/terminal-web', advanced: true,
    label: 'Built-in terminal shell',
    description: "Executable started in each built-in terminal. Empty: your login shell (PowerShell on Windows)." },

  // ── Backup ────────────────────────────────────────────────────────────
  // Read by the nightly backup (routines.ts) right after each archive.
  { key: 'TIMON_BACKUP_KEEP', type: 'int', default: 7, group: 'Backup', owner: '@timon/routines', unit: 'archives',
    min: 1, max: 3650,
    label: 'Backups kept',
    description: "Number of nightly archives kept in the backups folder of the Timon home. "
      + "Right after each backup, the oldest ones beyond this number are deleted." },
  { key: 'TIMON_BACKUP_MAX_AGE_DAYS', type: 'int', default: 0, group: 'Backup', owner: '@timon/routines', unit: 'days',
    min: 0, max: 3650,
    label: 'Delete backups older than',
    description: "Archives older than this are deleted right after each backup, whatever their number. "
      + "The newest archive is always kept. 0 = no age limit, only the number above applies." },

  // ── Agent trash ───────────────────────────────────────────────────────
  { key: 'TIMON_AGENT_TRASH_ENABLED', type: 'bool', default: true, group: 'Agent trash', owner: '@timon/agents',
    label: 'Keep deleted agents in the trash',
    description: "Deleting an agent moves its folder (configuration, system prompt, identity docs, memory) to the trash "
      + "of the Timon home, from which it can be restored. Off: a deletion is final." },
  { key: 'TIMON_AGENT_TRASH_RETENTION_DAYS', type: 'int', default: 30, group: 'Agent trash', owner: '@timon/agents', unit: 'days',
    min: 0, max: 3650,
    label: 'Empty the trash after',
    description: "A deleted agent is purged for good this many days after its deletion. 0 = kept until purged by hand." },

  // ── Misc ──────────────────────────────────────────────────────────────
  { key: 'TIMON_BRAIN_VAULT', type: 'string', default: '', group: 'Misc', input: 'directory',
    label: 'Obsidian vault folder',
    description: "Empty = automatic detection in the usual locations." },
  { key: 'TIMON_VAULT_MCP_SERVER', type: 'string', default: '', group: 'Misc', advanced: true,
    label: 'Notes connector kept for task agents',
    description: "Id of one external MCP server, as the MCP page lists it (for example the account connector that serves your notes). Task agents and the librarian keep it; every other account connector stays off for them. Empty = none." },
  { key: 'TIMON_WEB_SEARCH_PROVIDER', type: 'string', default: 'parallel', group: 'Misc', advanced: true,
    label: 'Headless web search provider',
    description: 'parallel, native or off. Parallel sends search queries to its anonymous search-only MCP endpoint on eligible official Claude and Codex launches. Existing connector and permission choices take precedence.' },
  { key: 'TIMON_PREAPPROVED_MCP_TOOLS', type: 'string', default: '', group: 'Misc', advanced: true,
    label: 'MCP tools allowed without asking',
    description: "Comma-separated tool names (mcp__server__tool) any agent may call without an Allow/Deny card. List read-only tools only: a write stays behind a decision." },
  { key: 'TIMON_CHROME_PATH', type: 'string', default: '', group: 'Misc', advanced: true,
    label: 'Chrome used to sign in from the built-in browser',
    description: "Empty = Google Chrome, then Microsoft Edge, then Chromium, found automatically. Full path of the Chrome, Edge or Chromium to open for Sign in with Chrome (the file must be named like one of them); needed only when yours is installed somewhere unusual or as a snap or flatpak." },
  { key: 'TIMON_LOG_SYSTEM_PROMPT', type: 'bool', default: false, group: 'Misc',
    label: 'Log the full system prompt',
    description: "Debug: very verbose. Written to prompts-<day>.log in the tmp folder of the Timon home, not to the daemon log.", advanced: true },
  // ── Infra ─────────────────────────────────────────────────────────────
  // These keys were read as `process.env.*` directly, outside the registry:
  // invisible from the UI and impossible to take along in an export. They
  // joined the registry in P0.3. Defaults reproduce EXACTLY the historical
  // default at the read site.
  { key: 'TIMON_ORCH_URL', type: 'string', default: 'http://localhost:3000', group: 'Infra', advanced: true,
    label: 'Orchestrator URL for agents',
    description: "Injected into TIMON MCPs launched in missions." },
  { key: 'TIMON_PUBLIC_API_URL', type: 'string', default: 'http://api.timon.localhost', group: 'Infra', advanced: true,
    label: 'Public API URL',
    description: "Base of the OAuth redirect_uri; must be reachable from the browser." },
  { key: 'TIMON_PUBLIC_APP_URL', type: 'string', default: 'http://timon.localhost', group: 'Infra', advanced: true,
    label: 'Public app URL',
    description: "Where the user returns after an OAuth dance." },
  { key: 'TIMON_TRAEFIK_HOST', type: 'string', default: 'traefik', group: 'Infra', advanced: true,
    label: 'Traefik container name',
    description: "Host reachable for Traefik from the docker network." },
  { key: 'TIMON_BROWSER_IMAGE', type: 'string', default: 'lscr.io/linuxserver/chromium:latest', group: 'Infra', owner: '@timon/browser-embedded', advanced: true,
    label: 'Embedded browser image' },
  { key: 'TIMON_BROWSER_PROXY_IMAGE', type: 'string', default: 'alpine/socat', group: 'Infra', owner: '@timon/browser-embedded', advanced: true,
    label: 'CDP relay image' },
  { key: 'TIMON_BROWSER_NETWORK', type: 'string', default: 'traefik_network', group: 'Infra', owner: '@timon/browser-embedded', advanced: true,
    label: 'Browser docker network' },
  { key: 'TIMON_BROWSER_HOSTS', type: 'string', default: 'timon.localhost', group: 'Infra', owner: '@timon/browser-embedded', advanced: true,
    label: 'Routable hosts of the browser stream',
    description: 'Comma-separated.' },
  { key: 'TIMON_BROWSER_WEB_PORT', type: 'int', default: 3000, group: 'Infra', owner: '@timon/browser-embedded', advanced: true,
    label: 'Browser container web port' },
  { key: 'TIMON_BROWSER_IDLE_MINUTES', type: 'int', default: 30, group: 'Infra', owner: '@timon/browser-embedded', unit: 'min',
    label: 'Auto-close the browser after inactivity',
    description: '≤ 0 disables automatic close.' },
  { key: 'TIMON_BROWSER_RECORDING_RETENTION_DAYS', type: 'int', default: 7, group: 'Infra', owner: '@timon/browser-recording', unit: 'days',
    label: 'Keep unlearned browser recordings',
    description: 'Recordings not turned into a skill are deleted after this many days. ≤ 0 keeps them until deleted by hand.' },
  { key: 'TIMON_BROWSER_ANNOTATION_RETENTION_DAYS', type: 'int', default: 7, group: 'Infra', owner: '@timon/browser-annotations', unit: 'days',
    label: 'Keep open browser annotations',
    description: 'Annotations not resolved or dismissed are deleted after this many days. ≤ 0 keeps them until deleted by hand.' },
  { key: 'TIMON_BROWSER_ANNOTATION_RESOLVED_RETENTION_DAYS', type: 'int', default: 1, group: 'Infra', owner: '@timon/browser-annotations', unit: 'days',
    label: 'Keep resolved browser annotations',
    description: 'Resolved or dismissed annotations are deleted this many days after their resolution. ≤ 0 keeps them until deleted by hand.' },
  { key: 'TIMON_CHROME_DEVTOOLS_MCP', type: 'string', default: 'chrome-devtools-mcp@latest', group: 'Infra', owner: '@timon/browser-embedded', advanced: true,
    label: 'chrome-devtools MCP npm package' },
  { key: 'TIMON_VAPID_SUBJECT', type: 'string', default: 'mailto:timon@localhost', group: 'Infra', owner: '@timon/web-push', advanced: true,
    label: 'VAPID subject (Web Push)' },
  { key: 'TIMON_VAPID_PUBLIC_KEY', type: 'string', default: '', group: 'Infra', owner: '@timon/web-push', advanced: true,
    label: 'VAPID public key',
    description: "The PRIVATE key stays out of the registry (secret, env or secrets.env only)." },
  { key: 'TIMON_ALLOW_HTTP', type: 'bool', default: false, group: 'Infra', advanced: true,
    label: 'Allow remote access over HTTP',
    description: "Local development only: without HTTPS, the remote token travels in the clear. Applied when the app restarts. An app served by Docker Compose ignores this setting: it reads TIMON_ALLOW_HTTP from its .env." },
  { key: 'VF_DB_PATH', type: 'string', default: '', group: 'Infra', owner: '@timon/video-factory', advanced: true,
    label: 'video-factory database',
    description: "Empty disables the Video Factory connection." },
  { key: 'DISPATCHER_INTERVAL_MS', type: 'int', default: 60_000, group: 'Infra', unit: 'ms', advanced: true,
    label: 'Kanban dispatcher cadence' },
  { key: 'TIMON_EVENTS_HOT_DAYS', type: 'int', default: 0, group: 'Infra', unit: 'days',
    label: 'Hot retention of the events table',
    description: "0 = archival disabled. Past this, older events migrate to ~/.timon/archive/events.db. They stay readable, but a default export or backup no longer includes them." },
  { key: 'TIMON_TRACE_SPANS_RETENTION_DAYS', type: 'int', default: 90, group: 'Infra', unit: 'days', advanced: true,
    min: 0, max: 3650,
    label: 'Mission timeline retention',
    description: "The timeline of a mission over for this long is removed, keeping its tool, error and duration totals; a button on the mission rebuilds it from its events. A workflow run's own steps are kept. 0 keeps every timeline." },
  { key: 'TIMON_INTEGRATION_RECEIPT_RETENTION_DAYS', type: 'int', default: 30, group: 'Infra', unit: 'days', advanced: true,
    min: 0, max: 3650,
    label: 'Delivered integration messages retention',
    description: "Messages a messaging integration delivered are kept this long to recognise a provider sending them again, then deleted. A message that ran out of retries is kept this long after its failure, for you to replay it. Messages still being processed are never deleted. 0 keeps them forever." },
  { key: 'TIMON_LOG_RETENTION_DAYS', type: 'int', default: 14, group: 'Infra', unit: 'days',
    label: 'Log retention',
    description: "Daily log files (daemon, desktop app, prompt dumps) in the tmp folder of the Timon home older than this are deleted. 0 keeps them forever." },
  { key: 'TIMON_LOG_MAX_MB', type: 'int', default: 200, group: 'Infra', unit: 'MB',
    label: 'Log size ceiling',
    description: "Past this total, the oldest daily log files are deleted first. 0 = no ceiling." },
  { key: 'TIMON_TRACE_SPAN_MAX_BYTES', type: 'int', default: 4096, group: 'Infra', unit: 'bytes', advanced: true,
    label: 'Trace span payload ceiling',
    description: "Maximum size of a span's input / output (tool arguments, tool result) kept in trace_spans. Larger values are truncated; the events table keeps the full payload." },
  { key: 'TIMON_TTS_URL', type: 'string', default: '', group: 'Infra', owner: '@timon/tts', advanced: true,
    label: 'External TTS service URL',
    description: "Empty = the local TTS service (container) is used." },
  { key: 'TIMON_GPT_LIVE_ENABLED', type: 'bool', default: false, group: 'Voice', owner: '@timon/gpt-live',
    label: 'GPT-Live conversation mode',
    description: "Adds a live voice conversation button to the chat composer. Uses the OPENAI_GPT_LIVE_API_KEY secret, billed per minute by OpenAI." },
];

const BY_KEY = new Map(SETTINGS.map((d) => [d.key, d]));

/** Keys removed from the registry, with the reason a user who still sets them
 *  gets in the log. A removed key is otherwise silently ignored — `timon.config.json`
 *  accepts any key and the env is never validated — and a user tuning a knob
 *  that no longer does anything deserves to be told. */
export const RETIRED_SETTINGS: Readonly<Record<string, string>> = {
  // 19/09/2026: a finite MemoryHigh on the mission slice throttles it into
  // memory pressure, pressure propagates up to user@UID.service, and
  // systemd-oomd then killed the whole graphical session (resources.ts).
  TIMON_DAY_MEM_HIGH_GB: 'the mission slice no longer has a soft memory threshold; TIMON_DAY_MEM_MAX_GB is the only memory ceiling',
  TIMON_NIGHT_MEM_HIGH_GB: 'the mission slice no longer has a soft memory threshold; TIMON_NIGHT_MEM_MAX_GB is the only memory ceiling',
};

/** Retired keys still defined somewhere, with where. Empty in the normal case. */
export function retiredSettingsInUse(): { key: string; source: Exclude<SettingSource, 'default'> }[] {
  const stored = dbApi.getAllSettings();
  const fromConfig = configSettings();
  const out: { key: string; source: Exclude<SettingSource, 'default'> }[] = [];
  for (const key of Object.keys(RETIRED_SETTINGS)) {
    const env = process.env[key];
    if (env !== undefined && env !== '') out.push({ key, source: 'env' });
    else if (fromConfig[key] !== undefined) out.push({ key, source: 'config' });
    else if (stored[key] != null) out.push({ key, source: 'db' });
  }
  return out;
}

/** Cache of resolved values. Invalidated on every write — settings are
 *  read in hot loops (dispatcher, reaper), we do not want a SQLite
 *  query per tick. */
let cache: Map<string, ResolvedSetting> | null = null;

export function invalidateSettingsCache(): void {
  cache = null;
}

function parse(type: SettingType, raw: string): boolean | number | string | null {
  switch (type) {
    case 'bool':
      // Accepts both historical conventions ('1'/'0') and booleans
      // written in full words from the UI.
      if (['1', 'true', 'on', 'yes'].includes(raw.toLowerCase())) return true;
      if (['0', 'false', 'off', 'no'].includes(raw.toLowerCase())) return false;
      return null;
    case 'int': {
      const n = Number(raw);
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case 'float': {
      const n = Number(raw);
      return Number.isFinite(n) ? n : null;
    }
    case 'string':
      return raw;
  }
}

/** `settings` section of the config file. An unreadable config must not
 *  prevent the registry from answering: we fall back to database + env. */
function configSettings(): Record<string, string | number | boolean> {
  try {
    return config().settings;
  } catch {
    return {};
  }
}

function buildCache(): Map<string, ResolvedSetting> {
  const stored = dbApi.getAllSettings();
  const memoryDefaults = memoryPresetSettings(resourceMemoryInfo().autoClassGb);
  const out = new Map<string, ResolvedSetting>();
  for (const registered of SETTINGS) {
    const def = { ...registered, default: memoryDefaults[registered.key] ?? registered.default };
    const dbValue = stored[def.key] ?? null;
    const envRaw = process.env[def.key];
    let value: ResolvedSetting['value'] = def.default;
    let source: SettingSource = 'default';

    if (dbValue !== null) {
      const parsed = parse(def.type, dbValue);
      if (parsed !== null) { value = parsed; source = 'db'; }
    }
    // `timon.config.json` overrides the database: it is the PORTABLE source,
    // the one an export takes along, whereas the `settings` table is local.
    const fromConfig = configSettings()[def.key];
    if (fromConfig !== undefined) {
      const parsed = parse(def.type, String(fromConfig));
      if (parsed !== null) { value = parsed; source = 'config'; }
    }
    // The env overrides everything else: a punctual override always wins.
    if (envRaw !== undefined && envRaw !== '') {
      const parsed = parse(def.type, envRaw);
      if (parsed !== null) { value = parsed; source = 'env'; }
    }
    out.set(def.key, { def, value, source, dbValue });
  }
  return out;
}

function resolveAllCached(): Map<string, ResolvedSetting> {
  if (!cache) cache = buildCache();
  return cache;
}

/** Resolved value + provenance. Used by the API so the UI can
 *  flag "forced by the environment". */
export function resolve(key: string): ResolvedSetting | undefined {
  return resolveAllCached().get(key);
}

export function resolveAll(): ResolvedSetting[] {
  return [...resolveAllCached().values()];
}

/* ── Typed accessors — this is what the rest of the code uses ──────────── */

export function settingBool(key: string): boolean {
  return resolveAllCached().get(key)?.value as boolean;
}

export function settingInt(key: string): number {
  return resolveAllCached().get(key)?.value as number;
}

export function settingNum(key: string): number {
  return resolveAllCached().get(key)?.value as number;
}

export function settingStr(key: string): string {
  return resolveAllCached().get(key)?.value as string;
}

/** Readable refusal when a numeric value falls outside the declared bounds. */
function outOfRange(def: SettingDef, value: boolean | number | string): string | null {
  if (typeof value !== 'number') return null;
  const below = def.min !== undefined && value < def.min;
  const above = def.max !== undefined && value > def.max;
  if (!below && !above) return null;
  const range = def.min !== undefined && def.max !== undefined
    ? `between ${def.min} and ${def.max}`
    : def.min !== undefined ? `at least ${def.min}` : `at most ${def.max}`;
  return `${def.label} (${def.key}) must be ${range}, got ${value}`;
}

/** Writes a setting. `null` restores the default (deletes the row).
 *  Returns a readable error if the key is unknown or the value is invalid. */
export function setSetting(key: string, raw: string | null): { ok: true } | { ok: false; error: string } {
  const def = BY_KEY.get(key);
  if (!def) return { ok: false, error: `unknown setting: ${key}` };
  if (raw === null) {
    dbApi.deleteSetting(key);
    invalidateSettingsCache();
    return { ok: true };
  }
  const parsed = parse(def.type, raw);
  if (parsed === null) {
    return { ok: false, error: `invalid value for ${key} (type ${def.type}): ${raw}` };
  }
  const range = outOfRange(def, parsed);
  if (range) return { ok: false, error: range };
  dbApi.setSetting(key, raw);
  invalidateSettingsCache();
  return { ok: true };
}

export function settingGroups(): string[] {
  return [...new Set(SETTINGS.map((s) => s.group))];
}
