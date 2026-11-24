/**
 * "Usage limit reached" detection on a NORMALISED event, for every
 * dialect.
 *
 * WHY THIS MODULE: the same question was settled in two places with
 * two different vocabularies.
 *   - `agent.ts` (live stream) knew the three shapes: `rate_limit_event`,
 *     `result` in 429, and the text message a dialect without a structured
 *     status produces.
 *   - `db.ts` (after-the-fact autopsy, `detectMissionDeathSignal`) only knew
 *     the first two — that is the vocabulary of a single dialect.
 * Consequence: a mission killed by the quota on a backend that only reports
 * text died WITHOUT a signal, so its task went back to a silent BLOCKED. Very
 * exactly the incident `interruption.ts` was written to eliminate, left
 * open for the other backends.
 *
 * The rules apply to EVERY dialect, without a name test: they are
 * mutually exclusive (a dialect that emits no `rate_limit_event`
 * will never see one), and a new family of CLIs automatically inherits
 * the textual rule. The `Dialect.rateLimitReporting` capability therefore does NOT drive
 * the detection — it DESCRIBES what can be expected of a dialect, and that is
 * what allows saying of a silent death that it is `unknown` rather than
 * "not a rate limit" (see `interruption.ts`). Necessary, because
 * the autopsy (`db.ts`) works on persisted events whose original backend
 * is no longer reliably known.
 *
 * Shape reminder: every backend rewrites its native stream into
 * TIMON's normalised event vocabulary (`system` / `assistant` / `result` /
 * `rate_limit_event`), which is what makes a single detection possible.
 */

/**
 * What is known about a limit reached.
 *
 * `window` and `resetsAt` are null when the dialect does not expose them
 * (`rateLimitReporting: 'textual'`): it is an explicit UNKNOWN, to display
 * as such, never to replace with a plausible value.
 */
export type RateLimitHit = {
  /**
   * Two families that must NOT be handled alike (incident 2026-09-01, grok):
   *
   *   - `rate_limit`: a usage window is full. It reopens BY ITSELF, so a
   *     time-bounded cooldown is the right answer.
   *   - `exhausted`: the account has no credit left (HTTP 402, "balance
   *     exhausted"). Nothing reopens without a human topping the account up,
   *     so the default 5 h cooldown is doubly wrong — it retries into the wall
   *     and it suggests a reopening that will never come.
   *
   * Everything downstream (series fallback, requeue) branches on the same hit;
   * only the cooldown duration and the notification differ.
   */
  kind: 'rate_limit' | 'exhausted';
  /** Quota window as named by the provider ('five_hour'…), or null. */
  window: string | null;
  /** Reopening of the quota in epoch MILLISECONDS, or null if unknown. */
  resetsAt: number | null;
  /** Where the conclusion comes from — useful to judge its reliability. */
  source: 'event' | 'status' | 'text';
  /**
   * The request is QUEUED while waiting for the quota, not rejected. The turn
   * can still succeed: it is a reason to mark the agent "paused", not
   * to conclude it died of it. The autopsy reads one as a cause only when the
   * mission ended still waiting on it (`queuedQuotaWall`, db.ts).
   */
  pending: boolean;
};

/**
 * Natural-language error message announcing a quota. The only signal
 * available for the `textual` dialects. Deliberately broad: a false
 * positive reclassifies a dead mission as a "recoverable pause" (it is
 * dead anyway), a false negative leaves it in silent failure — the asymmetry
 * leans towards detection.
 */
const RATE_LIMIT_TEXT =
  /rate.?limit|quota|usage limit|too many requests|\b429\b|try again later/i;

/**
 * Same net, for the OTHER family: an account with no credit left. A safety
 * net only — the structured status (`api_error_status: 402`) is what a
 * dialect should report, because an integer survives a provider rephrasing
 * its sentence and a regex does not.
 *
 * Two patterns are deliberately NOT accepted on their own — `billing`, and the
 * bare number 402. Unlike a full quota
 * window, an `exhausted` hit sidelines the backend for the whole account and
 * for a long time, so the module's usual "rather one false positive than one
 * silent death" asymmetry no longer applies as is. `errors: ["TypeError in
 * billing.ts"]` from a task working on a billing feature is a plausible
 * trigger; and `\b402\b` matches the line number in any stack trace sitting in
 * `errors[]` (`at src/agent.ts:402:15` — `:` is a word boundary). Both are only
 * accepted alongside a corroborating word.
 */
const EXHAUSTED_TEXT =
  /payment required|(status|code|http[_ ]?status)["'\s:=]{0,4}402\b|insufficient[\s_-]*(credit|balance|funds|quota)|balance exhausted|out of credits?|billing (issue|problem|error)|(credit|balance|funds|payment).{0,20}billing/i;

/** True if a free error message announces a usage limit. */
export function isRateLimitText(msg: unknown): boolean {
  return typeof msg === 'string' && RATE_LIMIT_TEXT.test(msg);
}

/** True when a free-form error message announces an account with no credit
 *  left, as opposed to a usage window that will reopen on its own. */
export function isExhaustedText(msg: unknown): boolean {
  return typeof msg === 'string' && EXHAUSTED_TEXT.test(msg);
}

/** Family announced by a free-form message, or null. `exhausted` is tested
 *  FIRST: a 402 sentence often also carries the word "limit", and downgrading
 *  it to `rate_limit` would put the backend back in the wall five hours later. */
function textKind(msg: unknown): RateLimitHit['kind'] | null {
  if (isExhaustedText(msg)) return 'exhausted';
  if (isRateLimitText(msg)) return 'rate_limit';
  return null;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : null;
}

/**
 * A limit that IS reached, as opposed to the mere mention of one. Used on the
 * text of a turn that ended WITHOUT an error flag, where `RATE_LIMIT_TEXT` would
 * be far too broad: that text is normally the agent's own answer, and "added
 * rate limiting to the API" is a work report.
 */
const QUOTA_REACHED =
  /\b(?:quota|usage\s+limit|rate[\s_-]?limit)s?\s+(?:has\s+been\s+|was\s+|is\s+)?(?:reached|exceeded|exhausted|hit)\b|\byou(?:['’]ve|\s+have)\s+(?:hit|reached)\s+your\s+(?:\w+\s+){0,2}limit\b|\btoo\s+many\s+requests\b/i;

/**
 * The same phrase OPENING the text as a sentence of its own: at most a symbol
 * (⚠) and an "Error:" / "Warning:" label before it, one qualifier ("Individual
 * quota reached"), and the end of the sentence right after. An answer that
 * goes on ("Quota exceeded means that…") is somebody explaining quotas.
 */
const QUOTA_NOTICE_OPENING = new RegExp(
  '^[^\\p{L}\\p{N}]{0,6}(?:(?:api\\s+)?(?:error|warning)\\s*[:\\-–—]?\\s*)?(?:\\p{L}+\\s+)?(?:'
    + QUOTA_REACHED.source
    + ')\\s*(?:$|[.!:;,·|\\-–—(\\n])',
  'iu',
);

/** The provider talking about its window reopening, or about a bigger plan. */
const QUOTA_REOPENING_HINT =
  /\bresets?\s+(?:in|at|on)\b|\btry\s+again\s+(?:in|at|later)\b|\bupgrade\s+(?:your\s+)?(?:subscription|plan)\b/i;

/** A provider notice is one or two sentences; a work report quoting one is not. */
const QUOTA_NOTICE_MAX_CHARS = 300;

/** "Resets in 1h18m49s", "resets in 29m12s", "Resets in 2d 3h", "resets in 45s". */
const QUOTA_RESETS_IN =
  /\bresets?\s+in\s+(?:(\d+)\s*d)?\s*(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?!s))?\s*(?:(\d+)\s*s)?/i;

/** Reopening time (epoch ms) of a "Resets in 1h18m49s" counted from `at`, or
 *  null when the text names no duration. */
function quotaReopeningFromText(text: string, at: number): number | null {
  const m = QUOTA_RESETS_IN.exec(text);
  if (!m) return null;
  const n = (i: number): number => Number(m[i] ?? 0);
  const ms = (((n(1) * 24 + n(2)) * 60 + n(3)) * 60 + n(4)) * 1000;
  return ms > 0 ? at + ms : null;
}

/**
 * A quota notice sitting in the text of a turn that ended WITHOUT an error
 * flag, or null (Antigravity, 2026-11-21).
 *
 * Some CLIs do not fail the turn when the account is out of quota: they end it
 * normally and print the provider's notice as the answer. The codec has no
 * status to translate, so the turn reaches us as `subtype: "success"` with
 * "⚠ Individual quota reached. … Resets in 29m12s." for a result. Read as a
 * success, it lifted the backend's cooldown, the task waited for the idle
 * reaper and closed with no work done, and its fallback was never tried.
 *
 * Unlike an error message, this text is normally the agent's own answer, so
 * the module's usual leaning towards detection does not hold here: a false
 * positive sidelines a healthy backend and switches a live chat away from it.
 * Two shapes only are accepted: the notice opens the text as its own sentence,
 * or the whole text is a short notice that also says when the window reopens.
 * A long report quoting a quota message in its body matches neither.
 */
function quotaNoticeInAnswer(text: unknown, at: number): RateLimitHit | null {
  if (typeof text !== 'string') return null;
  const t = text.trim();
  if (!t) return null;
  const opens = QUOTA_NOTICE_OPENING.test(t);
  const shortNotice = t.length <= QUOTA_NOTICE_MAX_CHARS && QUOTA_REACHED.test(t) && QUOTA_REOPENING_HINT.test(t);
  if (!opens && !shortNotice) return null;
  // Only a notice is read for its family, never a whole report: same rule as
  // `textKind`, a dry account is not downgraded to a window.
  if (t.length <= QUOTA_NOTICE_MAX_CHARS && isExhaustedText(t)) {
    return { kind: 'exhausted', window: null, resetsAt: null, source: 'text', pending: false };
  }
  return { kind: 'rate_limit', window: null, resetsAt: quotaReopeningFromText(t, at), source: 'text', pending: false };
}

/**
 * Usage limit announced by this event, or null.
 *
 * `pending` (`queued` status on the structured stream side) counts as a hit: the
 * mission is stopped while waiting for the quota, which must be treated as a
 * recoverable pause and not as a failure.
 *
 * `at` is when the event was emitted (epoch ms). It only matters to a notice
 * that gives its reopening as a duration ("Resets in 29m12s"): the autopsy reads
 * events minutes after the fact, and counting from then would push the retry
 * back by as much.
 */
export function rateLimitFromEvent(type: string, payload: unknown, at: number = Date.now()): RateLimitHit | null {
  const p = asRecord(payload);
  if (!p) return null;

  // 1. Dedicated event: the only shape that carries the window AND the reset time.
  if (type === 'rate_limit_event') {
    const info = asRecord(p.rate_limit_info);
    if (!info) return null;
    if (info.status !== 'rejected' && info.status !== 'queued') return null;
    return {
      // A dedicated rate-limit event only ever describes a window: an account
      // out of credit is reported as an error, never here.
      kind: 'rate_limit',
      window: typeof info.rateLimitType === 'string' ? info.rateLimitType : null,
      // The provider sends epoch SECONDS → normalised to ms, the unit of
      // all the rest of the code (Date.now, event timestamps).
      resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt * 1000 : null,
      source: 'event',
      pending: info.status === 'queued',
    };
  }

  if (type !== 'result') return null;

  // 1b. A turn that ended without an error flag, whose answer is the provider's
  //     quota notice. Much stricter than the text rule of step 3.
  if (p.is_error !== true) return quotaNoticeInAnswer(p.result, at);

  // 2. Same family seen on the `result` side: structured HTTP status, without a window.
  //    402 (Payment Required) is the SAME probe but the other family: the
  //    account is dry, and no window will reopen.
  if (p.api_error_status === 402) {
    return { kind: 'exhausted', window: null, resetsAt: null, source: 'status', pending: false };
  }
  if (p.api_error_status === 429) {
    return { kind: 'rate_limit', window: null, resetsAt: null, source: 'status', pending: false };
  }

  // 3. Last resort: the error message itself. It is all a
  //    `textual` dialect reports.
  //
  //    Two shapes depending on the CLI, and BOTH must be read: a string on
  //    `error`, or an `errors` array (grok puts the quota message there, which
  //    made a mission merely out of quota be classified as "crash" —
  //    hence unrecoverable instead of resumable).
  const fromError = textKind(p.error);
  if (fromError) {
    return { kind: fromError, window: null, resetsAt: null, source: 'text', pending: false };
  }
  if (Array.isArray(p.errors)) {
    // `exhausted` wins over a `rate_limit` found in another entry of the same
    // array, for the reason given on `textKind`.
    const kinds = p.errors.map(textKind).filter((k): k is RateLimitHit['kind'] => k !== null);
    if (kinds.length) {
      const kind = kinds.includes('exhausted') ? 'exhausted' : 'rate_limit';
      return { kind, window: null, resetsAt: null, source: 'text', pending: false };
    }
  }
  return null;
}

/**
 * A provider refusing a turn because the MODEL is at capacity: codex reports
 * `Selected model is at capacity. Please try a different model.`
 * (`codex_error_info: server_overloaded`), Anthropic an `overloaded_error` with
 * HTTP 529.
 *
 * Neither a quota nor a crash. A quota sidelines the account for hours; this is
 * one model, for minutes, and its own message asks for another model. Reading it
 * as `crash` replayed the task three times into the same full model, then
 * blocked it (05/10/2026, two reviews in one morning) — and never tried the
 * fallback plan.
 */
const OVERLOADED_TEXT = /\bat capacity\b|server[_ ]overloaded|overloaded[_ ]error|\boverloaded\b/i;

export function isOverloadedText(msg: unknown): boolean {
  return typeof msg === 'string' && OVERLOADED_TEXT.test(msg);
}

/** True when this event is an error `result` saying the model is overloaded.
 *  Callers test it AFTER `rateLimitFromEvent`: a message that also names a
 *  quota is a quota. */
export function isOverloadedEvent(type: string, payload: unknown): boolean {
  const p = asRecord(payload);
  if (!p || type !== 'result' || p.is_error !== true) return false;
  if (p.api_error_status === 529) return true;
  if (isOverloadedText(p.error)) return true;
  return Array.isArray(p.errors) && p.errors.some(isOverloadedText);
}

/** Decreasing reliability: the dedicated event is the only one to carry the window and
 *  the reopening time, the text is a heuristic. */
const SOURCE_RANK: Record<RateLimitHit['source'], number> = { event: 3, status: 2, text: 1 };

/** An `exhausted` hit outranks any `rate_limit` one, whatever its source: the
 *  two say different things about the SAME backend, and treating a dry account
 *  as a full window would schedule a retry that cannot succeed. */
function hitRank(hit: RateLimitHit): number {
  return (hit.kind === 'exhausted' ? 10 : 0) + SOURCE_RANK[hit.source];
}

/**
 * Best hit of a list of events, or null.
 *
 * The most INFORMATIVE one is kept, not the first one met: the same limit
 * often comes up twice (the dedicated event, then the `result` in 429), and the
 * events are read from the most recent to the oldest — taking the first one
 * would always throw away the reopening time, the only info that says
 * when to retry.
 *
 * `pending` hits are IGNORED by default: queueing alone is not a
 * cause of death. Pass `includePending` for an agent's live tracking, where it
 * does mean "paused on the quota".
 */
export function bestRateLimit(
  events: Iterable<{ type: string; payload: unknown; timestamp?: number }>,
  opts: { includePending?: boolean } = {},
): RateLimitHit | null {
  let best: RateLimitHit | null = null;
  for (const ev of events) {
    // A persisted event carries its own date: a relative reopening time
    // ("Resets in 29m12s") is counted from it, not from the time of the reading.
    const hit = rateLimitFromEvent(ev.type, ev.payload, ev.timestamp);
    if (!hit) continue;
    if (hit.pending && !opts.includePending) continue;
    if (!best || hitRank(hit) > hitRank(best)) best = hit;
    // No early exit any more: a `rate_limit_event` is the most informative
    // form of ITS family, never a proof that no 402 sits further down the list.
  }
  return best;
}
