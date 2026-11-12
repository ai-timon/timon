/**
 * Permission-prompt long-poll store.
 *
 * SCOPE: this store only serves backends whose dialect declares
 * `permissionModel: 'mcp-bridge'` (cf. `backends/types.ts`) — the only ones able
 * to delegate a tool use to an external tool during their turn. A `sandbox`
 * backend has its rights fixed at launch: it never calls
 * `/api/permissions/request`, so nothing here runs for it. This is not a
 * degradation to handle, it is the absence of a round-trip that simply
 * doesn't exist for it — the system preamble and the agent editor say so, to
 * the agent and to the human, each reading the capability.
 *
 * Flow:
 *   1. The permission-mcp.mjs subprocess (spawned by the CLI) hits
 *      POST /api/permissions/request with the tool name + input + tool_use_id.
 *      The express handler stashes a Pending entry, emits a permission_request
 *      event on the bus (→ SSE → UI), and keeps the response open via the
 *      `resolve` callback.
 *   2. The user clicks Allow or Deny in the chat (or "Paste into a terminal"
 *      on a one-line `Bash` card, which reaches the CLI as a deny that says
 *      the user runs the command). The UI hits
 *      POST /api/permissions/:id/resolve which calls the stored callback,
 *      unblocking the original /request response.
 *   3. The CLI reads the decision and either proceeds with the tool call or
 *      reports denial back to the model.
 *
 * No timeout: if the user never clicks, the agent just waits. That mirrors an
 * interactive CLI session, where a permission prompt blocks indefinitely.
 */
import { randomUUID } from 'node:crypto';
import { bus, type BusEvent } from './bus.js';
import { dbApi } from './db.js';
import { getTurnState, respawnWithResume, sendToAgent, isAutonomousMission } from './agent.js';
import { notifyUser } from './notify.js';
import { closePushFor, createNotification } from './notifications.js';
import { settingNum } from './settings.js';
import {
  validateSeriesPlanForm,
  validateSeriesPlanAnswer,
  seriesPlanCommands,
  planGroupNames,
  type SeriesPlanAnswer,
  type SeriesPlanRoleConfig,
  type SeriesPlanVolet,
} from './series-plan.js';
import { seriesPlanDefaults } from './series-plan-defaults.js';
import type { ApprovalScope } from './backends/types.js';
import { approvalMotif, findApproval, motifLabel, rememberApproval, rememberableScopes } from './approval-rules.js';
import type { PushFanoutResult } from './notifications.js';
import { ownerCanPaste, pasteReply, shellCommandOf } from './plugins-bundled/terminal-web/command-requests.js';
import { emitQuestionEvent, type QuestionActor, type QuestionSnapshot } from './question-bus.js';
import { formMessageOf, postAgentMessage, withoutFormMessage } from './chat-post.js';

/**
 * Auto-resolution timeout for permission cards on AUTONOMOUS missions
 * (dispatcher/wake/pipeline/recovery — no human behind them). Without this, an
 * op deferred by the `auto` classifier blocks indefinitely at night (the user is
 * asleep) until the reaper's SIGTERM at 45 min → orphaned mission. Past this
 * delay we return an INSTRUCTIVE `deny` ("pick an alternative or
 * `timon task block`"): the agent takes back the initiative instead of rotting
 * blocked. CHAT (human) missions are never auto-resolved — the user may be slow to
 * click, we wait for him (the hung reaper spares them too, cf. agent.ts).
 * 0 or negative disables the auto-timeout.
 *
 * ── Why TWO delays ──────────────────────────────────────────────────────────
 * "No one will click" is an ASSUMPTION, not a fact — and since Web Push we can
 * verify it. The short delay is the default case (no device reachable: no
 * VAPID, no subscription, or a failed send); the long delay only opens on
 * proof that at least one phone received the request. We ALWAYS start on the
 * short one, and only extend after confirmation: the direction of the error
 * matters — too short a delay degrades (the agent falls back), too long a
 * delay hangs the mission until the reaper.
 */
const AUTONOMOUS_TIMEOUT_MS = (): number => settingNum('TIMON_PERMISSION_AUTONOMOUS_TIMEOUT_MS');
const PUSHED_TIMEOUT_MS = (): number => settingNum('TIMON_PERMISSION_PUSHED_TIMEOUT_MS');
/**
 * A form (`ask_user`: `question`, `kanban_plan`) is not an Allow / Deny click:
 * it takes reading and choosing. On the short delay it expired while the user
 * was still filling it in, the agent re-asked, and the ticked choices were lost
 * (SUG-0014). It gets a long delay of its own, still capped by `cappedTimeout`.
 */
const FORM_TIMEOUT_MS = (): number => settingNum('TIMON_PERMISSION_FORM_TIMEOUT_MS');
const DETACH_GRACE_MS = (): number => settingNum('TIMON_PERMISSION_DETACH_GRACE_MS');
/**
 * Hard ceiling: the reaper SIGTERMs a turn that stayed silent for over
 * `TIMON_REAP_HUNG_MS` (45 min). A turn waiting on a card emits nothing, so its
 * silence starts at the latest with the request: an auto-deny landing after
 * that would never actually happen — the mission would already be dead,
 * orphaned, without the instructive deny that made it bounce back. 80% leaves
 * the agent enough room to absorb the refusal and close out cleanly. The turn
 * budget (`TIMON_REAP_TURN_MAX_MS`) is not a ceiling here: it counts from the
 * start of the turn, which no timeout set at request time can bound.
 */
function cappedTimeout(ms: number): number {
  if (!Number.isFinite(ms) || ms <= 0) return 0; // missing/invalid setting = no auto-timeout
  const hung = settingNum('TIMON_REAP_HUNG_MS');
  const ceiling = Number.isFinite(hung) ? Math.floor(hung * 0.8) : 0;
  return ceiling > 0 ? Math.min(ms, ceiling) : ms;
}
/** Delay a card waits before it is auto-resolved (0 = never): only on an
 *  autonomous mission, longer for a form than for an Allow / Deny card. */
export function cardTimeoutMs(toolName: string, autonomous: boolean): number {
  if (!autonomous) return 0;
  return cappedTimeout(toolName === 'ask_user' ? FORM_TIMEOUT_MS() : AUTONOMOUS_TIMEOUT_MS());
}

/** Auto-timeout timers in flight, keyed by pending id. Cleared on resolution. */
const TIMERS = new Map<string, NodeJS.Timeout>();

/** Grace timers of cards whose waiter went away, keyed by pending id (cf. `watchWaiter`). */
const DETACH_TIMERS = new Map<string, NodeJS.Timeout>();

function clearTimer(id: string): void {
  const t = TIMERS.get(id);
  if (t) { clearTimeout(t); TIMERS.delete(id); }
  const d = DETACH_TIMERS.get(id);
  if (d) { clearTimeout(d); DETACH_TIMERS.delete(id); }
}

export type AllowDecision = {
  behavior: 'allow';
  updatedInput?: unknown;
  /** A wider Allow than "this once" (cf. `ApprovalScope`), only one the card
   *  offered. The backend that asked decides what it means. */
  scope?: ApprovalScope;
};
export type DenyDecision = { behavior: 'deny'; message: string };
export type PermissionDecision = AllowDecision | DenyDecision;
/**
 * "Paste into a terminal": the user runs the shell command themselves. It never
 * reaches the agent as such — the CLI only knows allow and deny — but becomes a
 * deny carrying `pasteReply`, so the agent's turn goes on knowing who runs it.
 */
export type PasteDecision = { behavior: 'paste' };
/** What a human can answer on a card: the decisions above, plus `paste` on a shell command. */
export type PermissionAnswer = PermissionDecision | PasteDecision;
/** Buttons of a shell-command card, in display order. Other cards keep Allow / Deny. */
export const SHELL_CARD_CHOICES = ['allow', 'paste', 'deny'] as const;

type Pending = {
  id: string;
  mission_id: string;
  agent: string;
  tool_name: string;
  input: unknown;
  tool_use_id: string;
  /** Wider answers the card offers: the agent's own, or Timon's when `remembers`. */
  scopes?: readonly ApprovalScope[];
  /** Set when Timon keeps the wider Allow itself (`approval-rules.ts`): what it
   *  would cover, as the card shows it. The agent never sees the scope then. */
  remembers?: string;
  /** The one-line shell command of a `Bash` card whose owner can open the web
   *  terminal; absent otherwise. Its presence is what offers `paste`. */
  shell_command?: string;
  /** Buttons the card offers when they differ from Allow / Deny. */
  choices?: readonly PermissionAnswer['behavior'][];
  /** Cf. `RequestInput.onPaste`. */
  onPaste?: (command: string) => void;
  created_at: number;
  /** Auto-deny delay ACTUALLY applied (0 = never). May be extended along the
   *  way if the push reaches a device — cf. `adaptTimeoutToPush`. */
  timeout_ms: number;
  resolve: (decision: PermissionDecision) => void;
};

const PENDING = new Map<string, Pending>();

function recordPermissionSpan(
  missionId: string,
  eventId: number,
  timestamp: number,
  payload: { id?: unknown; tool_name?: unknown },
  status?: 'ok' | 'denied' | 'timeout',
): void {
  const id = typeof payload.id === 'string' ? `permission:${payload.id}` : null;
  const traceId = dbApi.getMission(missionId)?.trace_id;
  if (!id || !traceId) return;
  try {
    if (!status) {
      dbApi.upsertSpans([{ op: 'open', id, trace_id: traceId, mission_id: missionId,
        seq: eventId, kind: 'permission', name: typeof payload.tool_name === 'string' ? payload.tool_name : 'permission',
        started_at: timestamp, event_id_start: eventId }]);
      return;
    }
    dbApi.upsertSpans([{ op: 'close', id, status, ended_at: timestamp, event_id_end: eventId }]);
  } catch (err) {
    console.warn(`[trace:${missionId.slice(0, 8)}] permission span failed: ${(err as Error).message}`);
  }
}

/**
 * Already-resolved decisions, keyed `${mission_id}::${tool_use_id}`. When the
 * shim reconnects (socket dropped, restart) and re-POSTs a tool_use_id that
 * was already resolved while it was disconnected, we return the decision
 * immediately instead of re-blocking. In-memory cache = fast path; to survive
 * an orchestrator restart, dbApi.findResolvedPermission re-reads the same
 * info from the persisted events (payload enriched in resolvePermission).
 */
const RESOLVED = new Map<string, PermissionDecision>();

function resolvedKey(missionId: string, toolUseId: string): string {
  return `${missionId}::${toolUseId}`;
}

export function listPending(missionId?: string): Array<Omit<Pending, 'resolve' | 'onPaste'>> {
  const out: Array<Omit<Pending, 'resolve' | 'onPaste'>> = [];
  for (const p of PENDING.values()) {
    if (missionId && p.mission_id !== missionId) continue;
    const { resolve: _, onPaste: _onPaste, ...rest } = p;
    out.push(rest);
  }
  return out;
}

/** One pending card, or `undefined` once resolved or expired. */
export function getPending(id: string): Omit<Pending, 'resolve' | 'onPaste'> | undefined {
  const p = PENDING.get(id);
  if (!p) return undefined;
  const { resolve: _, onPaste: _onPaste, ...rest } = p;
  return rest;
}

/**
 * Which `ask_user` form a card holds, or `null` for a tool-permission card (or a
 * payload the UI could not render — never produced, since the entry guard
 * refuses it). The plugin question API lists only these: a tool-use approval is
 * not a question.
 */
export function questionKindOf(p: Pick<Pending, 'tool_name' | 'input'>): QuestionSnapshot['kind'] | null {
  if (p.tool_name !== 'ask_user' || validateAskUserPayload(p.input) !== null) return null;
  return (p.input as { form?: { kind?: unknown } }).form?.kind === 'series_plan' ? 'series_plan' : 'question';
}

/** The ask_user card as a question-event or plugin reader sees it, or `null` for any other card. */
export function questionSnapshot(p: Omit<Pending, 'resolve' | 'onPaste'>): QuestionSnapshot | null {
  const kind = questionKindOf(p);
  if (!kind) return null;
  return Object.freeze({
    id: p.id, missionId: p.mission_id, agent: p.agent, kind, input: p.input, createdAt: p.created_at,
    expiresAt: p.timeout_ms > 0 ? p.created_at + p.timeout_ms : null,
  });
}

const SYSTEM_ORIGINS: readonly DecisionOrigin[] = ['auto_timeout', 'mission_end', 'client_disconnected', 'payload_invalid'];

function emitQuestionResolved(
  p: Omit<Pending, 'resolve' | 'onPaste'>,
  status: 'answered' | 'cancelled' | 'expired',
  decisionOrigin: DecisionOrigin,
  resolvedBy?: QuestionActor,
): void {
  const question = questionSnapshot(p);
  if (!question) return;
  const actor: QuestionActor = resolvedBy
    ?? (SYSTEM_ORIGINS.includes(decisionOrigin) ? { kind: 'system', id: null }
      : decisionOrigin === 'unknown' ? { kind: 'unknown', id: null } : { kind: 'user', id: null });
  emitQuestionEvent({ type: 'resolved', question, status, decisionOrigin, resolvedBy: Object.freeze(actor) });
}

/**
 * Clears the `action_required` cards of a mission whose anchor no longer
 * matches a pending permission. Acts as a safety net: normal resolution goes
 * through the targeted dismiss on `permission_resolved` / `permission_expired`
 * (notifications.ts), but an orchestrator restart loses the in-memory PENDING
 * entries and would otherwise leave ghost cards in the rail.
 */
export function dismissStaleNotifications(missionId: string): void {
  const live = new Set([...PENDING.keys()]);
  // A pending command request is not a permission card, and it outlives the
  // turn: its notification stays until the owner decides.
  const owner = dbApi.getMission(missionId)?.owner_user_id;
  if (owner) {
    for (const r of dbApi.listCommandRequests({ ownerUserId: owner, missionId, status: 'pending' })) live.add(r.id);
  }
  for (const n of dbApi.listActiveNotificationsByMission(missionId, 'action_required')) {
    if (n.anchor && live.has(n.anchor)) continue;
    // Only permission cards are this sweep's: an agent's own card (SUG-0048),
    // a document or a layout proposal closes on its own event.
    if (!n.anchor || !dbApi.hasPermissionRequest(missionId, n.anchor)) continue;
    dbApi.dismissNotification(n.id);
  }
}

/**
 * At boot, every permission card still shown is an orphan: PENDING lives in
 * memory, so nothing can answer it any more. They would otherwise stay until
 * the same mission raised a new permission (`dismissStaleNotifications`),
 * which may never happen. Only cards that are provably permissions (a
 * persisted `permission_request` carries their anchor) are closed: a command
 * request, a layout proposal or a document outlives the restart.
 */
export function dismissOrphanedPermissionNotifications(): number {
  let closed = 0;
  for (const n of dbApi.listActiveNotifications('action_required')) {
    if (!n.anchor || !n.mission_id || PENDING.has(n.anchor)) continue;
    if (!dbApi.hasPermissionRequest(n.mission_id, n.anchor)) continue;
    if (dbApi.dismissNotification(n.id)) { closed++; closePushFor(n); }
  }
  if (closed > 0) {
    bus.publish({ kind: 'notifications_changed', ownerUserId: null });
    console.log(`[notifications] ${closed} orphan permission card(s) closed at startup`);
  }
  return closed;
}

/* ─────────────────────────────────────────────────────────────────────────────
 * `ask_user`: a form the UI cannot render must no longer pass for a refusal
 *
 * NAMING. `ask_user` is the name of the form CARD — what the shim posts, what
 * the events persist, what the UI matches. The MCP tools that open it are
 * called `question` and `kanban_plan` since their rename (`ask-mcp.ts`); the
 * card was deliberately left alone so past missions replay as they were. The
 * texts below that go to the AGENT name the tools; the code names the card.
 *
 * INCIDENT 2026-08-21, mission e6893b9e. An orchestrator calls `ask_user` with
 * 4 questions. The user NEVER sees a form. The agent, for its part, receives
 * `denied by user`, deduces that the user refused to answer, falls back to default
 * values, and reports to him that it "refused the form". Two failures at
 * once: a decision made without the human, and a false report.
 *
 * What made it possible: the refusal reason was A SINGLE piece of text for
 * causes that have nothing to do with each other (Deny click, Cancel click,
 * card never rendered, missing payload). An agent cannot distinguish what the
 * system itself does not distinguish — so it invents, and it invents the
 * explanation most flattering to itself: "the human refused".
 *
 * Hence the two halves of the fix:
 *  1. VALIDATE the payload BEFORE creating a card (below). A form the UI
 *     wouldn't know how to render must not produce a card at all: it produces
 *     a refusal that says "this is YOUR fault, here's which field, re-emit".
 *  2. NAME each refusal cause (`DENY_REASONS`) and trace the ACTION that
 *     produced it (`DecisionOrigin`), so that the next incident is
 *     diagnosable instead of a matter of archaeology.
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Refusal reasons, one per REAL CAUSE. None should attribute an intention to
 * the user if they did not perform the corresponding action — that is
 * precisely the mistake from the incident. These strings go straight to the
 * agent as-is: they tell it what to do next, not just what happened.
 */
export const DENY_REASONS = {
  /** The human clicked "Deny" on a card they read. A genuine refusal. */
  userDenied:
    'Explicit refusal from the user ("Deny" button). Do not retry the same request: '
    + 'pick an alternative that does not need this permission, or escalate.',
  /**
   * The human clicked "Cancel" on the form. This is NOT a refusal of the
   * request: they saw the questions and chose not to answer right now. The
   * agent can rephrase, or continue without the answer — but it must not
   * report that the human "refused".
   */
  formCancelled:
    'The user closed the form without answering ("Cancel" button). This is NOT a refusal '
    + 'of your request: they saw the questions and did not decide. Rephrase more simply, or '
    + 'proceed while clearly stating the assumption you are making for lack of an answer.',
  /**
   * The card existed but the UI could not render the form (payload missing at
   * display time) and the human asked for the agent to re-ask. They never saw
   * the questions.
   */
  formUnrenderable:
    'The form could not be displayed on the interface side: the user NEVER saw your questions '
    + 'and therefore neither refused nor cancelled. Call the same tool again (`question` or '
    + '`kanban_plan`) with the same content.',
  /** Refusal received with no reason passed by the client. Assume nothing. */
  noMessage:
    'Refusal with no reason passed by the client. The exact cause is unknown: do not assume '
    + "an intention from the user in your report.",
} as const;

/**
 * Origin of a decision: WHICH action, in WHICH view. Without this trace, there
 * was no way to know afterwards whether the incident's card had even been
 * rendered — that is what made the diagnosis impossible. Persisted in the
 * payload of `permission_resolved` / `permission_expired` / `permission_rejected`.
 */
export const DECISION_ORIGINS = [
  /** ask_user form submitted by the human ("Send" button). */
  'ui_form_submit',
  /** ask_user form cancelled by the human ("Cancel" button). */
  'ui_form_cancel',
  /** ask_user card displayed WITHOUT its payload → the human asked to re-ask. */
  'ui_form_unrenderable',
  /** Generic Allow/Deny card — "Allow" button. */
  'ui_card_allow',
  /** Generic Allow/Deny card — "Deny" button. */
  'ui_card_deny',
  /** Shell-command card — "Paste into a terminal" button. */
  'ui_card_paste',
  /** Buttons embedded in the Web Push notification. */
  'push_action',
  /** Auto-refusal after delay expiry (autonomous mission). */
  'auto_timeout',
  /** Mission ended while the card was still pending. */
  'mission_end',
  /** Nobody waits for the card any more: the agent's call was cancelled or its
   *  MCP bridge went away, and did not come back within the grace delay. */
  'client_disconnected',
  /** Invalid `ask_user` payload: refused at entry, no card created. */
  'payload_invalid',
  /** A third-party plugin answered through `ctx.questions.resolve`. */
  'plugin',
  /** Client that did not pass an origin (older version, direct call). */
  'unknown',
] as const;
export type DecisionOrigin = (typeof DECISION_ORIGINS)[number];

/** Normalizes an origin received from a client. Anything unknown → 'unknown'. */
export function parseDecisionOrigin(value: unknown): DecisionOrigin {
  return (DECISION_ORIGINS as readonly string[]).includes(value as string)
    ? (value as DecisionOrigin)
    : 'unknown';
}

/** Number of questions / options allowed, aligned with the schema announced to
 *  the agent in `bin/permission-mcp.mjs` (1–4 questions, 2–4 options, or none
 *  for a free-text question). */
const ASK_MIN_QUESTIONS = 1;
const ASK_MAX_QUESTIONS = 4;
const ASK_MIN_OPTIONS = 2;
const ASK_MAX_OPTIONS = 4;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Short excerpt of a question's text, so the defect message is locatable. */
function questionLabel(index: number, q: unknown): string {
  const text = isRecord(q) && typeof q.question === 'string' ? q.question.trim() : '';
  const short = text.length > 48 ? `${text.slice(0, 48)}…` : text;
  return short ? `question ${index + 1} ("${short}")` : `question ${index + 1}`;
}

/**
 * Checks that an `ask_user` payload is RENDERABLE by the UI. The MCP schema
 * announces these constraints to the agent, but nothing verified them at
 * runtime: an out-of-schema payload produced an empty card, hence a blind
 * choice.
 *
 * @returns `null` if the payload is renderable, otherwise the NAMED defect
 *          (which field, which question) — meant to be read by the agent at
 *          fault.
 */
export function validateAskUserPayload(input: unknown): string | null {
  if (!isRecord(input)) return 'the payload is not an object';
  // The message posted before the card (`chat-post.ts`), on both kinds of form.
  const message = formMessageOf(input);
  if (message && 'defect' in message) return message.defect;
  // TYPED form (`ask_series_plan` and successors): it replaces `questions`,
  // it does not add to it. The UI renders a dedicated component from `kind`
  // and builds its own menus itself; also asking the agent for a multiple-
  // choice version of the same form would be asking it to enumerate memory
  // models again — the very cause of the problem we are removing here.
  if (input.form !== undefined) {
    const form = input.form;
    if (!isRecord(form)) return 'field `form` is not an object';
    if (form.kind === 'series_plan') return validateSeriesPlanForm(form);
    return `field \`form\` has an unknown type: ${String(form.kind)}`;
  }
  const { questions } = input;
  if (questions === undefined || questions === null) return 'field `questions` missing';
  if (!Array.isArray(questions)) return 'field `questions` is not an array';
  if (questions.length < ASK_MIN_QUESTIONS) return 'empty `questions` array';
  if (questions.length > ASK_MAX_QUESTIONS) {
    return `${questions.length} questions (maximum ${ASK_MAX_QUESTIONS})`;
  }
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    const where = questionLabel(i, q);
    if (!isRecord(q)) return `${where}: not an object`;
    if (typeof q.question !== 'string' || q.question.trim() === '') {
      return `${where}: field \`question\` missing or empty`;
    }
    const { options } = q;
    if (q.placeholder !== undefined && typeof q.placeholder !== 'string') {
      return `${where}: field \`placeholder\` is not a string`;
    }
    // No options = a free-text question: the UI renders one text field.
    if (options === undefined || options === null || (Array.isArray(options) && options.length === 0)) {
      if (q.multiSelect === true) {
        return `${where}: \`multiSelect\` needs 2 to 4 options (omit \`options\` only for a free-text question)`;
      }
      continue;
    }
    if (!Array.isArray(options)) return `${where}: field \`options\` is not an array`;
    if (options.length < ASK_MIN_OPTIONS) {
      return `${where}: ${options.length} option(s), minimum ${ASK_MIN_OPTIONS} (or none for a free-text question)`;
    }
    if (options.length > ASK_MAX_OPTIONS) {
      return `${where}: ${options.length} options, maximum ${ASK_MAX_OPTIONS}`;
    }
    for (let j = 0; j < options.length; j++) {
      const o = options[j];
      if (!isRecord(o)) return `${where}, option ${j + 1}: not an object`;
      if (typeof o.label !== 'string' || o.label.trim() === '') {
        return `${where}, option ${j + 1}: field \`label\` missing or empty`;
      }
    }
  }
  return null;
}

/**
 * Escalation threshold: number of CONSECUTIVE `payload_invalid` rejections
 * tolerated on the same mission before closing the `ask_user` channel.
 *
 * WHY BOUND IT. An entry-level rejection creates no card (this is intentional:
 * the human has nothing to see of an unreadable form), so the loop "deny →
 * the agent re-emits the same faulty payload → deny" is entirely invisible to
 * The user. On an overnight autonomous mission it runs until the reaper, burning
 * quota for nothing. The system's other symmetrical loops are all bounded
 * (MAX_ITERATIONS of the verification loop, MAX_REPAIRS of the merge
 * integrity check, requeue cap); this one was not.
 *
 * WHY 3. The refusal NAMES the faulty field: an agent that knows how to fix
 * it does so on the 2nd attempt. Three consecutive failures on a named defect
 * no longer signal a typo but a misunderstanding of the schema — a 4th try
 * will not produce a different result. Same order of magnitude as the
 * system's other bounds, for the same reason: enough to absorb a fluke, too
 * little to let a loop run.
 */
const MAX_INVALID_ASK_USER = 3;

/**
 * Counts the mission's consecutive `payload_invalid` rejections, walking back
 * its events up to the last VALID `ask_user`.
 *
 * We derive the count from the trace already persisted by the entry guard
 * rather than keeping a parallel in-memory counter: a single source of truth,
 * and the count survives an orchestrator restart (the mission itself resumes
 * on restart — an in-memory counter would have handed it a fresh loop).
 *
 * The reset then happens on its own: a valid `ask_user` creates a card, hence
 * a `permission_request` event, which INTERRUPTS the series. An agent that
 * corrects itself does not drag its history along. Other events (tool uses,
 * deltas) do not count: between two attempts the agent works normally.
 *
 * @returns the number of consecutive rejections, including the current call
 *          if it was just inserted.
 */
function countConsecutiveInvalidAskUser(missionId: string): number {
  const events = dbApi.listEvents(missionId);
  let count = 0;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev) continue;
    if (ev.type !== 'permission_rejected' && ev.type !== 'permission_request') continue;
    let payload: unknown;
    try { payload = JSON.parse(ev.payload); } catch { continue; } // unreadable payload: ignored
    if (!isRecord(payload) || payload.tool_name !== 'ask_user') continue;
    if (ev.type === 'permission_request') break; // valid form → end of the series
    if (payload.origin === 'payload_invalid') count++;
  }
  return count;
}

/**
 * Message shown to the agent AT the moment of escalation and afterwards. The
 * `ask_user` channel is closed for this mission: handing it back the defect
 * to fix would invite it to retry, when it just failed N times on it. We give
 * it the only two remaining ways out — deciding for itself while stating the
 * assumption, or closing out by escalating.
 */
export function askUserChannelClosedMessage(defect: string, attempts: number): string {
  return (
    `Form MALFORMED — ${defect}. This is invalid payload #${attempts} `
    + 'in a row on this mission: the form channel (`question`, `kanban_plan`) is CLOSED here, do not retry it, '
    + 'any new call will be refused the same way. The user has been alerted. Proceed otherwise: '
    + 'decide for yourself while EXPLICITLY STATING the assumption you are making for lack of '
    + 'an answer, or close out via `timon task block --reason "..."` if the decision is essential. '
    + "Do not attribute anything to the user: they never saw your questions."
  );
}

/** Refusal message shown to the agent when ITS payload is the problem. */
export function malformedAskUserMessage(defect: string): string {
  return (
    `Form MALFORMED — ${defect}. No card was created: `
    + "the user saw nothing, so they neither refused nor cancelled, and you must not "
    + 'attribute it to them. Fix the payload (`question`: 1 to 4 questions, each with a '
    + 'non-empty text and either 2 to 4 options each with a `label` or no `options` at all for a free-text answer; `kanban_plan`: a chantier title '
    + 'and at least one volet with a title) then re-issue the call.'
  );
}

export type RequestInput = {
  mission_id: string;
  agent: string;
  tool_name: string;
  input: unknown;
  tool_use_id: string;
  /** Cf. `PermissionRequest.scopes`: shown as extra buttons, validated on answer. */
  scopes?: readonly ApprovalScope[];
  /**
   * Timon keeps session / always approvals for this request (`approval-rules.ts`).
   * Set by the claude shim's route only: its tool names are known (`Bash` carries
   * the command), whereas an ACP agent names a call after its kind or title, and
   * a shell call named otherwise would be remembered as "any command".
   */
  timonScopes?: boolean;
  /**
   * Called once, with the command, when the owner answers "Paste into a
   * terminal". For a caller whose agent never reads the deny message: an ACP
   * agent only learns "rejected", so it must be told who runs the command by
   * other means (`permissionHost`). The claude shim needs none: the message is
   * in the deny it receives.
   */
  onPaste?: (command: string) => void;
  /**
   * Aborted when the caller stops waiting for the answer (the shim's HTTP
   * socket closed). The card is then retired after a grace delay instead of
   * staying pending for a call that no longer exists (TIM-0098).
   */
  signal?: AbortSignal;
  /**
   * The waiter never re-asks the same call (a session driver, not the claude
   * shim): an abort retires the card at once, without the grace delay that
   * waits for a reconnecting shim.
   */
  retireAtOnce?: boolean;
};

/**
 * Fills in a `series_plan` form with the values currently in effect, before
 * the card goes out to the UI. Any other payload passes through unchanged.
 *
 * The resolution must never make the form's opening fail: a missing display
 * detail degrades the decision aid, an exception would deprive the user of the
 * entire form.
 */
function withSeriesPlanDefaults(input: RequestInput): unknown {
  const form = (input.input as { form?: unknown } | undefined)?.form;
  if (!isRecord(form) || form.kind !== 'series_plan') return input.input;
  try {
    const defaults = seriesPlanDefaults(input.mission_id, input.agent);
    return { ...(input.input as Record<string, unknown>), form: { ...form, defaults } };
  } catch (err) {
    console.error(`[permissions] series plan defaults unavailable: ${(err as Error).message}`);
    return input.input;
  }
}

/** Why a `series_plan` form must not open in this mission, or null. */
export function seriesPlanRefusal(input: RequestInput): string | null {
  const form = (input.input as { form?: unknown } | undefined)?.form;
  if (!isRecord(form) || form.kind !== 'series_plan') return null;
  const m = dbApi.getMission(input.mission_id);
  if (!m) return null;
  if (m.task_id) {
    return 'This mission runs a Kanban task: its brief is the whole scope. Do the work here, '
      + 'in this mission — do not open the Kanban planner (`kanban_plan`).';
  }
  if (m.parent_mission_id) {
    return `This mission was delegated to you${m.parent_agent ? ` by ${m.parent_agent}` : ''}: its brief is your scope, `
      + 'and the way to run it was already decided. Do the work here, in this mission — do not open the Kanban planner (`kanban_plan`), '
      + 'and do not split it into Kanban tasks or sub-missions.';
  }
  return null;
}

/**
 * Who answers the questions of a mission nobody is watching: the agent that
 * spawned it, or the pilot of its Kanban series. Null when nobody does (routine,
 * wake, recovery…).
 */
export function questionReferent(m: { task_id: string | null; parent_agent: string | null }, missionId: string): string | null {
  if (m.parent_agent) return m.parent_agent;
  if (!m.task_id) return null;
  const creator = dbApi.getTaskByMission(missionId)?.creator_mission_id;
  return creator ? dbApi.getMission(creator)?.agent_name ?? null : null;
}

/**
 * Why a plain `question` must not open on this mission, or null. An autonomous
 * mission (daemon-spawned, Kanban task, sub-mission) runs with nobody in front of
 * it: a card to the user blocks it until someone comes back. Its questions go to
 * its referent, who is an agent and answers at once.
 */
export function userQuestionRefusal(input: RequestInput): string | null {
  if (input.tool_name !== 'ask_user') return null;
  const questions = (input.input as { questions?: unknown } | undefined)?.questions;
  if (!Array.isArray(questions)) return null; // a typed form, judged elsewhere
  const m = dbApi.getMission(input.mission_id);
  if (!m || !isAutonomousMission(m)) return null;
  const referent = questionReferent(m, input.mission_id);
  const target = referent
    ? `Send your question to ${referent}, who spawned this mission${m.task_id ? ' / pilots its Kanban series' : ''}, `
      + `with \`agent_send_message\` (kind: request), then end your turn: the answer comes back to you as a message.`
    : 'Nobody is there to answer. Decide yourself, state the assumption you made in your final report '
      + '(or close the task with `timon task block` if you truly cannot proceed).';
  return 'This mission runs unattended: NEVER ask the user a question (`question` blocks you until they come back). '
    + target;
}

export function requestPermission(input: RequestInput): Promise<PermissionDecision> {
  const key = resolvedKey(input.mission_id, input.tool_use_id);

  // 1. Decision already made while the shim was disconnected → return it right
  //    away. Memory first (fast), then DB (survives an orchestrator restart).
  //    No new card, no re-blocking.
  const cached = RESOLVED.get(key) ?? dbApi.findResolvedPermission(input.mission_id, input.tool_use_id);
  if (cached) return Promise.resolve(cached);

  // 2. `ask_user` entry guard (incident 2026-08-21, cf. header above). A form
  //    the UI wouldn't know how to render must NOT produce a card: the
  //    resulting generic card displayed Approve/Deny over questions it didn't
  //    show. We refuse immediately, with a reason that names the defect and
  //    points to the agent as at fault.
  if (input.tool_name === 'ask_user') {
    const defect = validateAskUserPayload(input.input);
    if (defect) {
      // The event is laid down BEFORE the count: it is both the trace of this
      // rejection and the series counter (cf. countConsecutiveInvalidAskUser).
      const payload = {
        tool_name: input.tool_name,
        tool_use_id: input.tool_use_id,
        origin: 'payload_invalid' satisfies DecisionOrigin,
        defect,
      };
      const row = dbApi.insertEvent(input.mission_id, 'permission_rejected', payload);
      recordPermissionSpan(input.mission_id, row.id, row.timestamp, payload, 'denied');
      bus.publish({
        kind: 'event',
        missionId: input.mission_id,
        type: 'permission_rejected',
        timestamp: row.timestamp,
        payload,
      });
      const attempts = countConsecutiveInvalidAskUser(input.mission_id);
      // Past the threshold the channel is closed: we stop returning "fix and
      // re-emit" (the agent just failed N times on it, repeating it restarts
      // the loop) and give it the remaining ways out.
      const escalating = attempts >= MAX_INVALID_ASK_USER;
      const message = escalating
        ? askUserChannelClosedMessage(defect, attempts)
        : malformedAskUserMessage(defect);
      console.log(
        `[permissions] ask_user rejected at entry (mission ${input.mission_id.slice(0, 8)}, `
        + `agent ${input.agent}, attempt ${attempts}) — ${defect}`,
      );
      // Escalate ONLY ONCE, right at the threshold crossing: subsequent
      // rejections stay refused (channel closed) but do not re-notify — the user
      // already has the information, repeating it would flood the rail.
      if (attempts === MAX_INVALID_ASK_USER) {
        const stuckTask = dbApi.getTaskByMission(input.mission_id);
        notifyUser(
          `Agent form looping: ${input.agent}`,
          `${attempts} invalid form payloads in a row on mission `
          + `${input.mission_id.slice(0, 8)} — last defect: ${defect}. No card could be `
          + `created, so you saw nothing go by. The form channel is closed for this `
          + `mission: the agent was instructed to decide for itself while stating its `
          + `assumption, or to close out via \`timon task block\`. The decision it wanted to `
          + `submit to you is still pending.`,
          { taskId: stuckTask?.id, fromMission: input.mission_id },
        );
      }
      // Memorized like any other decision: a re-POST of the same tool_use_id
      // (shim reconnected) returns the refusal without re-emitting the event.
      const decision: PermissionDecision = { behavior: 'deny', message };
      RESOLVED.set(key, decision);
      return Promise.resolve(decision);
    }
  }

  // 2 ter. The series planner asks the USER how to run a chantier. A mission
  //    another agent delegated (or a Kanban task) already has its answer: its
  //    brief. Opening the form there put a Kanban planning card in front of a
  //    coder that only had to code (GPT coders did it on every direct spawn).
  const planRefusal = seriesPlanRefusal(input);
  if (planRefusal) {
    const decision: PermissionDecision = { behavior: 'deny', message: planRefusal };
    RESOLVED.set(key, decision);
    return Promise.resolve(decision);
  }

  // 2 quater. An unattended mission never asks the human: its question goes to
  //    the agent that spawned it or pilots its series.
  const questionRefusal = userQuestionRefusal(input);
  if (questionRefusal) {
    const decision: PermissionDecision = { behavior: 'deny', message: questionRefusal };
    RESOLVED.set(key, decision);
    return Promise.resolve(decision);
  }

  // 3. Dedup: a re-POST of the SAME (mission, tool_use_id) does not create a
  //    2nd card. The previous socket is dead (which is why the shim
  //    reconnected) → we reattach the resolution to the new socket by
  //    replacing the callback, and reuse the existing card/event.
  for (const p of PENDING.values()) {
    if (p.mission_id === input.mission_id && p.tool_use_id === input.tool_use_id) {
      return new Promise((resolve) => {
        p.resolve = resolve;
        // The shim came back within the grace delay: the card lives on.
        const d = DETACH_TIMERS.get(p.id);
        if (d) { clearTimeout(d); DETACH_TIMERS.delete(p.id); }
        watchWaiter(p.id, resolve, input.signal, input.retireAtOnce === true);
      });
    }
  }

  // 3 bis. An approval the human already widened to this session, or to every
  //    mission of this agent, answers in their place. Only where Timon keeps
  //    them (`timonScopes`, claude): an agent with scopes of its own would not
  //    be asking.
  //    Nothing here reaches past the human click — the classifier's refusals
  //    never come this far (cf. `approval-rules.ts`).
  const nativeScopes = !!input.scopes?.length;
  const timonKeeps = input.timonScopes === true && !nativeScopes;
  if (timonKeeps) {
    const rule = findApproval(input.mission_id, input.tool_name, input.input);
    if (rule) {
      const decision: PermissionDecision = { behavior: 'allow', updatedInput: input.input };
      RESOLVED.set(key, decision);
      dbApi.insertEvent(input.mission_id, 'permission_auto_allowed', {
        tool_name: input.tool_name, tool_use_id: input.tool_use_id, rule_id: rule.id, scope: rule.scope,
      });
      return Promise.resolve(decision);
    }
  }

  // 2 bis. Typed form: we attach WHAT APPLIES TODAY (role model, current
  //    fallback). Neither the agent nor the UI can know it — without this,
  //    "keep the global fallback" is a blind choice.
  // The `message` of a form is posted in the chat, never shown inside the card.
  const formMessage = input.tool_name === 'ask_user' ? formMessageOf(input.input) : null;
  const cardInput = formMessage ? { ...input, input: withoutFormMessage(input.input) } : input;
  const effectiveInput = withSeriesPlanDefaults(cardInput);
  // A shell command the owner could paste into their own terminal: the card
  // gets a third button. Checked now, not at click time only: a card must not
  // show a button its owner cannot use.
  const shellCommand = shellCommandOf(input.tool_name, effectiveInput);
  const pasteable = shellCommand !== null && ownerCanPaste(dbApi.getMission(input.mission_id));
  const timonScopes = timonKeeps ? rememberableScopes(input.mission_id, input.tool_name, input.input) : [];
  const scopes = nativeScopes ? input.scopes : timonScopes.length ? timonScopes : undefined;
  const motif = timonScopes.length ? approvalMotif(input.tool_name, input.input) : null;
  const remembers = motif ? motifLabel(motif) : undefined;

  // Known before the card goes out: the UI shows the countdown from the
  // request event itself, a replay included.
  const m = dbApi.getMission(input.mission_id);
  const autonomous = !!m && isAutonomousMission(m);
  const timeoutMs = cardTimeoutMs(input.tool_name, autonomous);

  const id = randomUUID();
  return new Promise((resolve) => {
    const pending: Pending = {
      id,
      mission_id: input.mission_id,
      agent: input.agent,
      tool_name: input.tool_name,
      input: effectiveInput,
      tool_use_id: input.tool_use_id,
      ...(scopes ? { scopes } : {}),
      ...(remembers ? { remembers } : {}),
      ...(pasteable ? { shell_command: shellCommand, choices: SHELL_CARD_CHOICES } : {}),
      ...(pasteable && input.onPaste ? { onPaste: input.onPaste } : {}),
      created_at: Date.now(),
      timeout_ms: timeoutMs,
      resolve,
    };
    PENDING.set(id, pending);
    watchWaiter(id, resolve, input.signal, input.retireAtOnce === true);
    // Persist the request as an event so a UI reload mid-prompt can replay
    // it and re-render the Allow/Deny card. The matching resolved event is
    // emitted in resolvePermission().
    const payload = {
      id,
      tool_name: input.tool_name,
      input: effectiveInput,
      tool_use_id: input.tool_use_id,
      ...(scopes ? { scopes } : {}),
      ...(remembers ? { approval_motif: remembers } : {}),
      ...(pasteable ? { shell_command: shellCommand, choices: SHELL_CARD_CHOICES } : {}),
      ...(timeoutMs > 0 ? { expires_at: pending.created_at + timeoutMs } : {}),
    };
    // Here and nowhere earlier: only a card that really opens gets its message,
    // once — a refused payload or a reconnecting shim never posts it again.
    // Written right before the card, so the thread reads message then form.
    if (formMessage && 'text' in formMessage) {
      const form = (effectiveInput as { form?: { kind?: unknown } } | undefined)?.form;
      postAgentMessage(input.mission_id, formMessage.text, form?.kind === 'series_plan' ? 'kanban_plan' : 'question');
    }
    const row = dbApi.insertEvent(input.mission_id, 'permission_request', payload);
    recordPermissionSpan(input.mission_id, row.id, row.timestamp, payload);
    bus.publish({
      kind: 'event',
      missionId: input.mission_id,
      type: 'permission_request',
      timestamp: row.timestamp,
      payload,
    });

    // The question inbox of a plugin hears of the card here, once its deadline is known.
    const snapshot = questionSnapshot(pending);
    if (snapshot) emitQuestionEvent({ type: 'pending', question: snapshot });

    // "action_required" notification for ALL missions, autonomous ones
    // included. Historically autonomous missions were excluded "because they
    // have the auto-timeout" — that was the opposite of the right reflex:
    // they are precisely the only ones that expire, hence the only ones that
    // MUST be signaled before the delay refuses them. `anchor` = permission id
    // (deep-link).
    const task = dbApi.getTaskByMission(input.mission_id);
    // Anti-flood: a mission that chains permissions must not stack cards. We
    // clear this mission's notifications whose anchor is no longer pending
    // (resolved out of band, orphaned by a restart) before creating a new
    // one. Permissions that are REALLY still pending, however, stay
    // displayed: they remain actionable.
    dismissStaleNotifications(input.mission_id);
    // A `question` card in a conversation someone is having is not an alert:
    // the card is in front of them and the agent's chip says it needs them.
    // An autonomous mission's form still notifies — nobody is watching it.
    const conversationQuestion = input.tool_name === 'ask_user' && !autonomous;
    if (!conversationQuestion) createNotification({
      type: 'action_required',
      urgent: true,
      title: `Permission required: \`${input.tool_name}\``,
      body:
        `Agent ${input.agent} requests permission to use \`${input.tool_name}\`.` +
        (timeoutMs > 0
          // Announced window = the SHORT one, the one already armed. The long
          // one only opens after delivery confirmation, hence after this
          // message body is sent: better to announce less and hold more than
          // to promise a window we could not yet guarantee.
          ? ` Autonomous mission: with no answer within ${Math.round(timeoutMs / 60_000)} min, automatic refusal.`
          : ''),
      missionId: input.mission_id,
      taskId: task?.id ?? null,
      anchor: id,
      // Approve / Deny buttons directly in the system notification. Not for
      // `ask_user`: this card awaits a form (questions + options), a yes/no
      // would answer the wrong thing — it stays deep-link only.
      pushPermissionId: input.tool_name === 'ask_user' ? null : id,
      onPush: (result) => adaptTimeoutToPush(id, result),
    });

    // Auto-timeout for autonomous missions: no human will click, we unblock
    // the agent after the short delay with an instructive deny. The push
    // fan-out runs in parallel and may still extend this window.
    if (autonomous && timeoutMs > 0) {
      TIMERS.set(id, setTimeout(() => autoTimeoutPending(id), timeoutMs));
    }
  });
}

/**
 * Extends the response window of an autonomous permission WHEN we have proof
 * that a human was reached (at least one Web Push notification accepted by
 * the browser's service). Without this proof we touch nothing: the short
 * delay already armed remains the right one.
 *
 * Called asynchronously, after the fan-out — so after-the-fact and
 * potentially into the void (permission resolved in the meantime, timer
 * already fired): each branch is a safe no-op.
 *
 * The `permission_timeout_adapted` event traces the decision (delay kept +
 * reason + delivery counters) so that a surprising auto-refusal is
 * diagnosable afterwards, rather than a matter of log archaeology.
 */
function adaptTimeoutToPush(id: string, result: PushFanoutResult): void {
  const p = PENDING.get(id);
  if (!p || p.timeout_ms <= 0) return; // resolved in the meantime, or no auto-timeout

  const reason = !result.configured
    ? 'push_not_configured'
    : result.targeted === 0
      ? 'no_subscription'
      : result.delivered > 0
        ? 'delivered'
        : 'delivery_failed';

  const shortMs = p.timeout_ms;
  const longMs = cappedTimeout(PUSHED_TIMEOUT_MS());
  // The long delay may be configured below the short one: in that case there
  // is nothing to extend, we keep the widest window already armed.
  const appliedMs = reason === 'delivered' ? Math.max(shortMs, longMs) : shortMs;

  const payload = {
    id,
    reason,
    timeout_ms: appliedMs,
    expires_at: p.created_at + appliedMs,
    previous_timeout_ms: shortMs,
    delivered: result.delivered,
    targeted: result.targeted,
    failed: result.failed,
  };
  const row = dbApi.insertEvent(p.mission_id, 'permission_timeout_adapted', payload);
  recordPermissionSpan(p.mission_id, row.id, row.timestamp, payload, 'ok');
  bus.publish({
    kind: 'event',
    missionId: p.mission_id,
    type: 'permission_timeout_adapted',
    timestamp: row.timestamp,
    payload,
  });

  if (appliedMs === shortMs) {
    console.log(
      `[permissions] ${id.slice(0, 8)} keeps the short delay (${Math.round(shortMs / 60_000)} min) — ${reason}`,
    );
    return;
  }

  // Re-arms on the time REMAINING since creation: the fan-out consumed some
  // delay, the deadline must stay anchored to the request, not to now.
  const remaining = Math.max(1_000, p.created_at + appliedMs - Date.now());
  p.timeout_ms = appliedMs;
  clearTimer(id);
  TIMERS.set(id, setTimeout(() => autoTimeoutPending(id), remaining));
  console.log(
    `[permissions] ${id.slice(0, 8)} delay extended to ${Math.round(appliedMs / 60_000)} min ` +
      `(push delivered to ${result.delivered}/${result.targeted} device(s))`,
  );
}

/**
 * Expires a permission card of an autonomous mission left unanswered: returns
 * a `deny` that explicitly tells the agent to fend for itself (safe
 * alternative or `timon task block`), rather than leaving it blocked. Flips
 * the UI card to `expired` and purges the pending entry. No-op if already
 * resolved in the meantime.
 */
function autoTimeoutPending(id: string): void {
  TIMERS.delete(id);
  const p = PENDING.get(id);
  if (!p) return;
  PENDING.delete(id);
  // The delay quoted is the one ACTUALLY applied to this request (it may have
  // been extended by adaptTimeoutToPush), not the current setting.
  const msg =
    `Permission not granted within the allotted time (${Math.round(p.timeout_ms / 60_000)} min, ` +
    `autonomous mission with no human available) for tool \`${p.tool_name}\`. ` +
    `Continue with a safe alternative that does not need it, or if the action is ` +
    `essential, close out cleanly via \`timon task block --reason "..."\` to escalate.`;
  try { p.resolve({ behavior: 'deny', message: msg }); } catch { /* */ }
  const payload = { id, behavior: 'expired' as const, origin: 'auto_timeout' satisfies DecisionOrigin };
  const row = dbApi.insertEvent(p.mission_id, 'permission_expired', payload);
  recordPermissionSpan(p.mission_id, row.id, row.timestamp, payload, 'timeout');
  bus.publish({ kind: 'event', missionId: p.mission_id, type: 'permission_expired', timestamp: row.timestamp, payload });
  emitQuestionResolved(p, 'expired', 'auto_timeout');
  console.log(`[permissions] auto-timeout ${id.slice(0, 8)} (autonomous mission ${p.mission_id.slice(0, 8)}, ${p.tool_name}) → instructive deny`);
}

/**
 * Retires a card when the call waiting on it goes away (TIM-0098). Before,
 * a question the agent's CLI had abandoned stayed pending in the UI until the
 * end of the session, and an answer given there reached nobody.
 *
 * A closed socket is not yet a cancellation: the shim re-POSTs the same
 * tool_use_id after a dropped connection, and the dedup path reattaches it.
 * Hence the grace delay, longer than the shim's backoff, and the identity
 * check: only the CURRENT waiter going away counts — the late close of a
 * socket the shim already replaced must not retire a live card.
 */
function watchWaiter(id: string, waiter: (d: PermissionDecision) => void, signal: AbortSignal | undefined, atOnce = false): void {
  if (!signal) return;
  const onAbort = () => {
    const p = PENDING.get(id);
    if (!p || p.resolve !== waiter) return;
    const prev = DETACH_TIMERS.get(id);
    if (prev) clearTimeout(prev);
    if (atOnce) { detachPending(id, waiter); return; }
    const grace = DETACH_GRACE_MS();
    DETACH_TIMERS.set(id, setTimeout(() => detachPending(id, waiter), Number.isFinite(grace) && grace > 0 ? grace : 0));
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
}

function detachPending(id: string, waiter: (d: PermissionDecision) => void): void {
  DETACH_TIMERS.delete(id);
  const p = PENDING.get(id);
  if (!p || p.resolve !== waiter) return;
  PENDING.delete(id);
  clearTimer(id);
  const message = 'the call waiting for this answer was cancelled — permission expired';
  // Settles the abandoned waiter (its route returns without writing) and lets
  // a shim that reconnects after all get this refusal instead of a new card.
  try { p.resolve({ behavior: 'deny', message }); } catch { /* */ }
  RESOLVED.set(resolvedKey(p.mission_id, p.tool_use_id), { behavior: 'deny', message });
  const payload = { id, behavior: 'expired' as const, origin: 'client_disconnected' satisfies DecisionOrigin };
  const row = dbApi.insertEvent(p.mission_id, 'permission_expired', payload);
  recordPermissionSpan(p.mission_id, row.id, row.timestamp, payload, 'timeout');
  bus.publish({ kind: 'event', missionId: p.mission_id, type: 'permission_expired', timestamp: row.timestamp, payload });
  emitQuestionResolved(p, 'expired', 'client_disconnected');
  console.log(`[permissions] retired ${id.slice(0, 8)} (mission ${p.mission_id.slice(0, 8)}, ${p.tool_name}): nobody waits for it any more`);
}

/**
 * Expires all permissions still pending for a mission that just ended
 * (mission_complete). Without this, the Allow/Deny card stays displayed as
 * "pending" indefinitely while the agent is dead → the user would click a
 * ghost (resolved to a 404 on the UI side, but after the fact). Here we flip
 * the card to `expired` as soon as the mission ends — authoritative
 * server-side expiration, more precise than a blind TTL (it happens exactly
 * when the agent can no longer act). The long-poll is resolved to deny to
 * unblock any subprocess that might still be alive (no-op if it has already
 * left).
 */
export function expirePendingForMission(missionId: string): void {
  // Purges this mission's decision cache — it is over, no more legitimate
  // re-POST will come (the DB remains the source of truth if needed).
  for (const k of [...RESOLVED.keys()]) {
    if (k.startsWith(`${missionId}::`)) RESOLVED.delete(k);
  }
  for (const [id, p] of [...PENDING]) {
    if (p.mission_id !== missionId) continue;
    PENDING.delete(id);
    clearTimer(id);
    try { p.resolve({ behavior: 'deny', message: 'mission ended — permission expired' }); } catch { /* */ }
    const payload = { id, behavior: 'expired' as const, origin: 'mission_end' satisfies DecisionOrigin };
    const row = dbApi.insertEvent(missionId, 'permission_expired', payload);
    recordPermissionSpan(missionId, row.id, row.timestamp, payload, 'timeout');
    bus.publish({ kind: 'event', missionId, type: 'permission_expired', timestamp: row.timestamp, payload });
    emitQuestionResolved(p, 'expired', 'mission_end');
    console.log(`[permissions] expired pending ${id.slice(0, 8)} (mission ${missionId.slice(0, 8)} ended)`);
  }
}

/** Hooks card expiry to mission end. Must be registered at boot. */
export function startPermissionExpiry(): () => void {
  const onBusEvent = (ev: BusEvent) => {
    if (ev.kind === 'mission_complete') expirePendingForMission(ev.missionId);
  };
  bus.on('event', onBusEvent);
  return () => void bus.off('event', onBusEvent);
}

/**
 * @param origin ACTION behind the decision (which button, which view).
 *   Persisted in `permission_resolved`: without it, incident 2026-08-21 was
 *   undiagnosable — we couldn't even tell whether the card had been
 *   rendered. `'unknown'` is reserved for clients that don't pass it.
 */
/**
 * Completes a `series_plan` form's decision before it goes to the agent:
 * validates the answer, then ADDS the exact `timon` commands that materialize
 * the plan.
 *
 * It is the agent that applies the plan (the UI collects, it does not
 * execute) — so the only way to guarantee it applies THIS plan and not an
 * approximate reconstruction is to hand it the ready-made commands. An
 * invalid answer is not silently corrected: it goes back as a `deny` with the
 * named defect, otherwise the agent would apply a config the user never saw.
 */
function withSeriesPlan(p: Omit<Pending, 'resolve'>, final: PermissionDecision): PermissionDecision {
  const form = (p.input as { form?: unknown } | undefined)?.form;
  if (!isRecord(form) || form.kind !== 'series_plan') return final;
  if (final.behavior !== 'allow') return final;
  const updated = (final.updatedInput ?? {}) as { plan?: unknown };
  const volets = (Array.isArray(form.volets) ? form.volets : []) as SeriesPlanVolet[];
  // A group the form never showed is a setting the user never saw: refused
  // like an unknown mode, not dropped.
  const defect = validateSeriesPlanAnswer(updated.plan, planGroupNames(volets));
  if (defect) {
    console.log(`[permissions] invalid series plan (mission ${p.mission_id.slice(0, 8)}) — ${defect}`);
    return {
      behavior: 'deny',
      message:
        `The series plan returned by the interface is invalid (${defect}). The user did answer, `
        + `but their answer could not be interpreted: do not guess the execution mode, `
        + `call \`kanban_plan\` again or ask them to decide explicitly.`,
    };
  }
  const plan = updated.plan as SeriesPlanAnswer;
  return {
    behavior: 'allow',
    updatedInput: { ...updated, plan, commands: seriesPlanCommands(plan, volets) },
  };
}

export function resolvePermission(
  id: string,
  answer: PermissionAnswer,
  origin: DecisionOrigin = 'unknown',
  /** Who answered, when the caller knows: the account behind a click, the plugin behind `ctx.questions.resolve`. */
  resolvedBy?: QuestionActor,
): boolean {
  const p = PENDING.get(id);
  if (!p) return false;
  // `paste` only where the card offered it: elsewhere there is no command to paste.
  if (answer.behavior === 'paste' && !(p.shell_command && p.choices?.includes('paste'))) return false;
  const decision: PermissionDecision = answer.behavior === 'paste'
    ? { behavior: 'deny', message: pasteReply(p.shell_command!) }
    : answer;
  PENDING.delete(id);
  clearTimer(id);
  // Claude validates the allow response and requires `updatedInput` to be
  // present — if missing it logs "harness validation error" and retries.
  // Default it to the original input the agent asked about (the common
  // case where the user just approves without modifying).
  let final: PermissionDecision = decision;
  if (decision.behavior === 'allow' && decision.updatedInput === undefined) {
    final = { behavior: 'allow', updatedInput: p.input, ...(decision.scope ? { scope: decision.scope } : {}) };
  }
  final = withSeriesPlan(p, final);
  // Timon keeps the wider Allow, the agent gets a plain one: the claude CLI
  // validates its permission answer and has no word for a scope.
  let remembered: { scope: ApprovalScope; rule_id: string } | undefined;
  if (p.remembers && final.behavior === 'allow' && final.scope) {
    const { scope, ...plain } = final;
    final = plain;
    try {
      const rule = rememberApproval(p.mission_id, p.tool_name, p.input, scope);
      if (rule) remembered = { scope, rule_id: rule.id };
    } catch (err) {
      // The Allow stands: only its reach is lost, and the next card says so.
      console.warn(`[permissions] approval not remembered (${p.mission_id.slice(0, 8)}): ${(err as Error).message}`);
    }
  }
  p.resolve(final);
  if (answer.behavior === 'paste' && p.onPaste) {
    // The decision is already given: a relay that fails must not undo it.
    try { p.onPaste(p.shell_command!); } catch (err) {
      console.warn(`[permissions] paste relay ${p.mission_id.slice(0, 8)}: ${(err as Error).message}`);
    }
  }
  // Memorizes the decision (memory + DB) so that a late re-POST of the same
  // tool_use_id retrieves it instead of re-blocking. `tool_use_id` +
  // `decision` are new in the payload: findResolvedPermission relies on them
  // to survive an orchestrator restart.
  RESOLVED.set(resolvedKey(p.mission_id, p.tool_use_id), final);
  // `behavior` stays allow/deny for every reader written before `paste`;
  // `choice` tells the UI which of the three buttons it was.
  const payload = {
    id, behavior: decision.behavior, tool_use_id: p.tool_use_id, decision: final, origin,
    ...(answer.behavior === 'paste' ? { choice: 'paste' as const } : {}),
    ...(remembered ? { remembered } : {}),
    ...(resolvedBy ? { resolved_by: resolvedBy } : {}),
  };
  const row = dbApi.insertEvent(p.mission_id, 'permission_resolved', payload);
  recordPermissionSpan(p.mission_id, row.id, row.timestamp, { id, tool_name: p.tool_name }, decision.behavior === 'allow' ? 'ok' : 'denied');
  bus.publish({
    kind: 'event',
    missionId: p.mission_id,
    type: 'permission_resolved',
    timestamp: row.timestamp,
    payload,
  });
  emitQuestionResolved(p, final.behavior === 'allow' ? 'answered' : 'cancelled', origin, resolvedBy);

  // Re-trigger on late authorization: if the agent has already closed its
  // turn (turnActive=false) by the time the user clicks Allow, the long-poll
  // resolved above falls into the void — claude no longer waits on that tool
  // call and does not spontaneously resume. We relaunch it with a
  // continuation message.
  // - turn still active → claude was blocked on the prompt, it will resume
  //   on its own: DO NOT inject a message (would break the turn's stream).
  // - process dead (mission no longer in memory) → we cannot reinject: we
  //   escalate so the user relaunches the mission.
  if (final.behavior === 'allow') {
    nudgeIfOrphaned(p, final).catch((err) =>
      console.error(`[permissions] re-trigger ${p.mission_id.slice(0, 8)}: ${(err as Error).message}`),
    );
  }
  return true;
}

/**
 * One answer of a `question` form, in words: a label, a list of labels, or —
 * when the human typed in the question's free-text field — the pick and the
 * text side by side (`{choice|choices, text}`), so a relaunched turn reads the
 * remark that qualifies the pick instead of `[object Object]`.
 */
export function formatAskAnswer(a: unknown): string {
  if (Array.isArray(a)) return a.map(String).join(', ');
  if (typeof a === 'object' && a !== null) {
    const { choice, choices, text } = a as { choice?: unknown; choices?: unknown; text?: unknown };
    const picked = Array.isArray(choices) ? choices.map(String).join(', ') : typeof choice === 'string' ? choice : '';
    const typed = typeof text === 'string' ? text.trim() : '';
    if (picked && typed) return `${picked} — with this remark: ${typed}`;
    return picked || typed || '(no answer)';
  }
  return String(a);
}

/**
 * Builds the continuation message injected when the turn must be relaunched
 * (process dead, or turn already closed). It CARRIES the real answer so the
 * agent resumes usefully — not a generic "resume" with no content.
 * - ask_user: replays each question with the chosen option(s).
 * - request (Allow/Deny): permission-granted semantics for the tool.
 */
export function buildContinuation(p: Omit<Pending, 'resolve'>, final: PermissionDecision): string {
  if (p.tool_name === 'ask_user' && final.behavior === 'allow') {
    const updated = final.updatedInput as
      | { answers?: Record<string, unknown>; note?: string; plan?: SeriesPlanAnswer; commands?: string[] }
      | undefined;
    // Typed form: the plan has no "questions" to replay, it has a mode and
    // commands. Rendering them as-is is better than the empty Q/A list the
    // generic branch below would have produced.
    if (updated?.plan) {
      const describe = (role: string, cfg: SeriesPlanRoleConfig, inherits: string): string => {
        const main = cfg.model ? `${cfg.backend ?? '?'} / ${cfg.model}` : inherits;
        const fallback = cfg.fallbackBackend
          ? `${cfg.fallbackBackend}${cfg.fallbackModel ? ` / ${cfg.fallbackModel}` : ''}`
          : 'global TIMON fallback';
        return `- ${role}: ${main} — fallback ${fallback}`;
      };
      const roles = [
        ...Object.entries(updated.plan.roles ?? {}).map(([role, cfg]) => describe(role, cfg, 'inherits from the project role')),
        // Per-group settings (TODO #433): the series role is their default.
        ...Object.entries(updated.plan.groups ?? {}).flatMap(([group, cfgs]) =>
          Object.entries(cfgs).map(([role, cfg]) => describe(`group \`${group}\`, ${role}`, cfg, 'inherits from the series role'))),
      ].join('\n');
      const cmds = (updated.commands ?? []).map((c) => `  ${c}`).join('\n');
      const note = updated.note?.trim();
      return (
        `[series plan] The user chose mode \`${updated.plan.mode}\`.\n`
        + `${roles || '- (no explicit setting: everything inherits)'}\n`
        + (note ? `Note: ${note}\n` : '')
        + (cmds ? `Commands to run, in this order:\n${cmds}\n` : '')
        + `Apply this plan as-is, then resume the project.`
      );
    }
    const answers = updated?.answers ?? {};
    const lines = Object.entries(answers).map(([q, a]) => `- To your question "${q}": ${formatAskAnswer(a)}`);
    const body = lines.length ? lines.join('\n') : '(no answer captured)';
    // Only a plugin built against the former answer shape still sends a global note.
    const note = typeof updated?.note === 'string' ? updated.note.trim() : '';
    const noteLine = note ? `\nUser's note: ${note}` : '';
    return `[answer to your question] The user answered:\n${body}${noteLine}\nResume your work from these answers.`;
  }
  return (
    `[system] Permission granted (late) for tool \`${p.tool_name}\`. ` +
    `If this action was needed and could not be carried out for lack of timely authorization, resume it now. Otherwise ignore this message.`
  );
}

async function nudgeIfOrphaned(p: Omit<Pending, 'resolve'>, final: PermissionDecision): Promise<void> {
  const state = getTurnState(p.mission_id);
  if (state?.turnActive) return; // turn in progress → claude will resume on its own (long-poll resolved)

  const msg = buildContinuation(p, final);
  // Process still alive between two turns → we write to its stdin.
  const delivered = (await sendToAgent(p.mission_id, msg)) === 'delivered';
  if (delivered) {
    console.log(`[permissions] re-trigger: mission ${p.mission_id.slice(0, 8)} relaunched after late answer (${p.tool_name})`);
    return;
  }
  // Process actually dead → we resurrect the conversation with --resume,
  // injecting the answer as the first input (Layer 2).
  const resumed = await respawnWithResume(p.mission_id, msg).catch((err) => {
    console.error(`[permissions] resume ${p.mission_id.slice(0, 8)}: ${(err as Error).message}`);
    return false;
  });
  if (resumed) {
    console.log(`[permissions] re-spawn --resume: mission ${p.mission_id.slice(0, 8)} resurrected after late answer (${p.tool_name})`);
    return;
  }
  // No session_id (or resume failed) → last resort: alert the human.
  const task = dbApi.getTaskByMission(p.mission_id);
  notifyUser(
    `Late answer could not be replayed: ${p.tool_name}`,
    `You answered \`${p.tool_name}\` for mission ${p.mission_id.slice(0, 8)} but it could not be relaunched (process dead, no resumable session). ` +
      (task ? `Associated task: ${task.id} (${task.title}). Relaunch it if needed.` : `Relaunch the mission if the action is still needed.`),
    { taskId: task?.id, fromMission: p.mission_id },
  );
}
