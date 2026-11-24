/**
 * Automatic backend switchover when a quota runs dry.
 *
 * FOUNDING INCIDENT (2026-08-20). Right in the middle of a job,
 * the account's Claude quota ran out. Every task in the series was running on
 * other backends (grok for code, codex for review/merge) — those were fine.
 * But two actors were still on Claude: the librarian and, above all, THE
 * ORCHESTRATOR, the one every task return goes back to. Its mission died on
 * the usage limit. The next task return woke a fresh `.main`, which died on
 * the same limit. Then the next one. Result: a cascade of dead missions, no
 * return processed, and a job stopped dead while half the fleet still had
 * quota left.
 *
 * Two distinct causes, both handled here:
 *
 *  1. NO FALLBACK. A dry backend was not a state the system knew about: every
 *     spawn drove straight back into the wall. So we keep a registry of
 *     exhausted quotas (`backend_cooldowns`, in the database — restarting the
 *     orchestrator does not reopen a provider's quota) and a single,
 *     configurable backup backend (`TIMON_FALLBACK_BACKEND`).
 *
 *  2. THE SERIES SCATTERS. Every return woke a brand-new mission, hence an
 *     orchestrator with no plan in mind — that is no longer orchestration. So
 *     the switchover acts at the SERIES level (`tasks.series_id`), not the
 *     task level: we swap the pilot mission's backend WITHOUT changing its id
 *     (`switchMissionBackend` replays the transcript: same thread, different
 *     CLI), and repoint every non-terminal task of the series at that pilot.
 *
 * Three families of exclusion live here, and each has its own lifetime because
 * each says something different about when the backend comes back:
 * `rate_limit` (a window that reopens on its own, see rate-limit.ts),
 * `exhausted` (an account with no credit, only a top-up brings it back), and
 * `unavailable` (the circuit breaker of `backend-breaker.ts` observed N sterile
 * turns; the cause is unknown, so the exclusion is the shortest). None is
 * permanent: `isBackendCoolingDown` gates the spawns too, so an exclusion with
 * no end would seal itself shut — nothing would ever run there again to prove
 * it is back.
 */
import { db, dbApi, type FallbackScope, type TaskType } from './db.js';
import { settingBool, settingInt, settingStr } from './settings.js';
import { asBackendName, type BackendName } from './backends/index.js';
import { catalogBackend } from './backends/catalog.js';
import { defaultEquivalentFallback } from './backends/equivalence.js';
import { isAccountInstanceId, splitBackendInstance } from './backends/instance-id.js';
import { getBackendAccount, setBackendAccountStatus } from './backends/accounts.js';
import { launchBackendName, ownConnections, replaceMissionLaunch } from './backends/account-launch.js';
import type { RateLimitHit } from './rate-limit.js';
import { hasProvenTurn, type BreakerTrip } from './backend-breaker.js';
import { notifyUser } from './notify.js';
import { backendStillDry } from './backend-recheck.js';
import { backendBinaryAvailable } from './backends/binary-check.js';
import { providerSignedOut } from './backends/sign-in-state.js';
import { messageDateTime, messageTime } from './message-dates.js';
import { bus } from './bus.js';
import { daemonMessage } from './daemon-message.js';

export type FallbackTarget = { backend: BackendName; model: string | null };

/** Explicit fallback set on ONE task at creation time (`--fallback-backend`),
 *  more specific than a series rule. `backend: 'none'` means "I want no
 *  fallback at all for this task", a refusal that must win over everything
 *  else — same symmetry as the `--backend none` sentinel of series rules. */
export type TaskFallbackOverride = { backend: string | null; model: string | null };

/**
 * Records that a backend has no quota left.
 *
 * The provider's `resetsAt` wins whenever it exists: it is the only exact
 * figure. Otherwise we apply a configurable duration — too short and we drive
 * back into the wall, too long and we deprive ourselves of a backend that has
 * become available again. The default (5 h) mirrors Anthropic's rolling
 * window, the most common one here.
 *
 * PRECEDENCE (2026-08-22 incident). A single exhaustion is reported several
 * times and in several shapes: first the `five_hour` event carrying the exact
 * time (04:40), then `result` 429s whose text carries none. Treating both the
 * same let the "now + 5 h" estimate overwrite the exact time ON EVERY 429 —
 * and since 429s repeat every minute, the exclusion drifted along with them
 * (07:05, then 07:30, 07:34...) long after the real reopening. So an exact
 * figure always wins, in both directions; an estimate can neither shorten nor
 * extend a time announced by the provider.
 *
 * `pending` is ignored: the request is queued, not rejected — the turn may
 * still succeed, and sidelining the backend would be premature.
 */
export function noteBackendRateLimit(backend: string | null | undefined, hit: RateLimitHit): void {
  const name = asBackendName(backend);
  if (!name || hit.pending) return;
  const known = dbApi.getBackendCooldown(name);
  if (hit.kind === 'exhausted') {
    noteBackendExhausted(name, known);
    return;
  }
  // An account with no credit left is not shortened by a full window announced
  // afterwards: the 429 describes a quota that will reopen, the 402 describes
  // an account that will not. Without this, the first 429 after a 402 would
  // bring the backend back into rotation five hours later, into the wall.
  if (known?.kind === 'exhausted' && known.until > Date.now()) return;
  const exact = Boolean(hit.resetsAt && hit.resetsAt > Date.now());
  const until = exact
    ? hit.resetsAt!
    : Date.now() + Math.max(60_000, settingInt('TIMON_FALLBACK_COOLDOWN_MS'));
  if (known) {
    // An estimate never touches an exact time already known, not even to push
    // it further out: the provider is the one who knows when its window reopens.
    if (!exact && known.exact === 1) return;
    // Between two figures of equal quality we never shorten a running
    // cooldown: two successive hits on the same window would otherwise
    // announce an ever closer reopening.
    if (exact === (known.exact === 1) && known.until >= until) return;
  }
  dbApi.setBackendCooldown(name, until, hit.window, exact, 'rate_limit');
  console.warn(
    `[fallback] backend ${name} is dry (${hit.window ?? 'unknown window'}, source ${hit.source}) ` +
    `— sidelined until ${messageTime(until)}`,
  );
}

/**
 * Records that a backend has NO CREDIT LEFT (HTTP 402 / "balance exhausted").
 *
 * The difference with a full quota window is not a matter of degree. Nothing
 * reopens here on its own: the exclusion lasts until the account is topped up,
 * i.e. until a human acts. Which is why:
 *
 *   - the cooldown is a long one of its own (`TIMON_BACKEND_EXHAUSTED_COOLDOWN_MS`,
 *     24 h by default) rather than the quota-window duration. Not "forever":
 *     `isBackendCoolingDown` gates the SPAWNS too, so a permanent exclusion
 *     would seal itself shut — nothing would ever run on that backend again to
 *     prove it is back. The only thing that lifts it early is a turn that
 *     succeeds (`clearBackendCooldown`), empirical proof of a top-up;
 *   - the user is notified EXPLICITLY, because the fallback alone changes
 *     nothing about the underlying cause: the account stays dry until someone
 *     pays. Notified once per exclusion, not on every hit — an exhausted
 *     backend reports its 402 on every attempt.
 */
function noteBackendExhausted(
  name: BackendName,
  known: { until: number; kind: string } | undefined,
): void {
  const until = Date.now() + Math.max(60_000, settingInt('TIMON_BACKEND_EXHAUSTED_COOLDOWN_MS'));
  const alreadyKnown = known?.kind === 'exhausted' && known.until > Date.now();
  if (alreadyKnown && known.until >= until) return;
  dbApi.setBackendCooldown(name, until, 'balance exhausted', false, 'exhausted');
  console.warn(
    `[fallback] backend ${name} has NO CREDIT LEFT (402) ` +
    `— sidelined until ${messageDateTime(until)}, top up the account`,
  );
  if (alreadyKnown) return;
  notifyUser(
    `Backend ${name}: no credit left`,
    [
      `\`${name}\` answers with a payment error (HTTP 402 / balance exhausted): the account has no credit left.`,
      '',
      'Unlike a usage limit, **this does not reopen on its own** — the account has to be topped up.',
      '',
      `- Backend sidelined until ${messageDateTime(until)} (or until a turn succeeds on it again).`,
      '- Missions and tasks that depend on it switch onto their fallback plan.',
    ].join('\n'),
    { message: daemonMessage('backend_no_credit', { backend: name, until }) },
  );
}

/**
 * Records that a backend is STRUCTURALLY UNAVAILABLE, as concluded by the
 * circuit breaker (`backend-breaker.ts`) — not by anything the provider said.
 *
 * The difference with the two other families is the CAUSE, which here is
 * unknown: broken auth, dry account, dead endpoint, provider outage. That
 * uncertainty is exactly why the cooldown is the shortest of the three
 * (30 min by default): an unknown cause may well be transient, and the first
 * turn that succeeds lifts the exclusion anyway (`clearBackendCooldown`).
 *
 * Never shortens nor overwrites a cooldown that KNOWS why it is there: a 402
 * seen five minutes ago says more than "it bounces", and bringing an account
 * with no credit back into rotation in 30 minutes would put it straight back
 * into the wall.
 */
/** Sidelining of a backend that never produced a turn since boot: long enough
 *  to stop a burst, short enough to retry once the setup is fixed. */
const UNPROVEN_BREAKER_COOLDOWN_MS = 5 * 60_000;

export function noteBackendUnavailable(trip: BreakerTrip): void {
  const name = asBackendName(trip.backend);
  if (!name) return;
  // A signed-out ACCOUNT (TODO #52) is marked so on its row: the launch then
  // refuses it by name until someone signs it in again, whatever the cooldown
  // below says, and the other accounts of the backend keep running.
  const { accountId } = splitBackendInstance(name);
  if (trip.cause === 'auth' && accountId) setBackendAccountStatus(accountId, 'reauth');
  const known = dbApi.getBackendCooldown(name);
  const informed = known && known.kind !== 'unavailable' && known.until > Date.now();
  // An unproven backend (no turn since boot) is sidelined briefly: the user
  // fixing their setup must be able to retry without waiting out a cooldown
  // sized for a provider outage, or resetting anything by hand (TIM-0009).
  const proven = hasProvenTurn(name);
  const full = Math.max(60_000, settingInt('TIMON_BREAKER_COOLDOWN_MS'));
  const until = Date.now() + (proven ? full : Math.min(full, UNPROVEN_BREAKER_COOLDOWN_MS));
  // The verdict is logged even when a better-informed cooldown wins: the
  // point of a breaker is to be able to say afterwards why it fired, and a
  // silent trip is exactly the night of investigation this is meant to save.
  console.warn(
    `[breaker] backend ${name}: ${trip.failures} sterile turn(s) in ${Math.round(trip.spanMs / 1000)} s ` +
    `(threshold ${trip.threshold}, window ${Math.round(trip.windowMs / 60_000)} min, last ${trip.signature}) ` +
    `— ${trip.cause === 'auth' ? 'authentication failed' : 'structurally unavailable'}, ${informed ? `already sidelined as ${known!.kind}` : `sidelined until ${messageTime(until)}`}`,
  );
  if (informed) return;
  const alreadyTripped = known?.kind === 'unavailable' && known.until > Date.now();
  const auth = trip.cause === 'auth';
  dbApi.setBackendCooldown(name, until, auth ? 'authentication failed' : 'circuit breaker', false, 'unavailable');
  if (alreadyTripped) return;
  if (auth) {
    notifyAuthFailure(name, until);
    return;
  }
  notifyUser(
    `Backend ${name}: sidelined by the circuit breaker`,
    [
      `\`${name}\` has returned ${trip.failures} mission(s) in a row without producing a single turn ` +
      `(${trip.signature}), inside ${Math.round(trip.spanMs / 1000)} s.`,
      '',
      '**The cause is unknown** — no usable error message. This signature matches a broken login, ' +
      'an account with no credit, or a dead endpoint. Worth checking the backend CLI by hand.',
      ...(proven ? [] : [
        '',
        `This backend has not completed a single turn since the daemon started, so a setup problem is the ` +
        `likeliest cause (login, CLI version, binary not found). It is sidelined for ` +
        `${Math.round((until - Date.now()) / 60_000)} min only: fix, then send the message again.`,
      ]),
      '',
      `- Backend sidelined until ${messageDateTime(until)}, or until a turn succeeds on it.`,
      '- Missions and tasks that depend on it switch onto their fallback plan.',
    ].join('\n'),
    {
      message: daemonMessage('backend_breaker_tripped', {
        backend: name,
        failures: trip.failures,
        signature: trip.signature,
        seconds: Math.round(trip.spanMs / 1000),
        // 0 for a proven backend: the message then leaves out the setup paragraph.
        minutes: proven ? 0 : Math.max(1, Math.round((until - Date.now()) / 60_000)),
        until,
      }),
    },
  );
}

/**
 * A logged-out CLI is the one outage no automation repairs: the session waits
 * for a human to sign in again. Hence an URGENT alert in the notification
 * centre, naming the gesture — not a message to the manager agent, who can do
 * nothing about it (night of 2026-09-17: 2 h 10 of bounces nobody was told of).
 */
function notifyAuthFailure(name: string, until: number): void {
  const { backend, accountId } = splitBackendInstance(name);
  if (accountId) {
    notifyAccountSignedOut(backend, accountId);
    return;
  }
  void import('./notifications.js').then(({ createNotification }) => {
    createNotification({
      type: 'alert',
      urgent: true,
      title: `Backend ${name}: signed out — log in again`,
      message: daemonMessage('backend_signed_out', { backend: name, until }),
      body: [
        `The \`${name}\` CLI reports an authentication failure (its session expired and could not be refreshed).`,
        '',
        `**Action needed:** sign in to the \`${name}\` CLI again on this machine. Nothing retries it into working.`,
        '',
        `- Backend sidelined until ${messageDateTime(until)}, or until a turn succeeds on it.`,
        '- Missions and tasks that depend on it switch onto their fallback plan.',
      ].join('\n'),
    });
  }).catch((err: unknown) => {
    console.error(`[breaker] could not raise the sign-in alert for ${name}: ${(err as Error).message}`);
  });
}

/** Same alert for one subscription account: it names the account, and says
 *  that its missions stop rather than move to another subscription — save a
 *  series' pilot, which may move to another connection of its owner (#701). */
function notifyAccountSignedOut(backend: string, accountId: string): void {
  const label = getBackendAccount(accountId)?.name ?? accountId;
  void import('./notifications.js').then(({ createNotification }) => {
    createNotification({
      type: 'alert',
      urgent: true,
      title: `${backend} account "${label}": signed out — sign in again`,
      message: daemonMessage('backend_account_signed_out', { backend, account: label }),
      body: [
        `The \`${backend}\` CLI reports an authentication failure on the account "${label}".`,
        '',
        '**Action needed:** sign this account in again. Until then its missions are refused;'
          + ' they never move to another subscription (an orchestrator piloting a series may move to another'
          + ' connection of its owner), and the other accounts keep running.',
      ].join('\n'),
    });
  }).catch((err: unknown) => {
    console.error(`[breaker] could not raise the sign-in alert for ${backend} account ${accountId}: ${(err as Error).message}`);
  });
}

/** Quota reopened: we lift the exclusion. Called as soon as a turn succeeds on
 *  this backend — empirical proof wins over the announced time. */
export function clearBackendCooldown(backend: string | null | undefined): void {
  const name = asBackendName(backend);
  if (!name || !dbApi.getBackendCooldown(name)) return;
  dbApi.clearBackendCooldown(name);
  console.log(`[fallback] backend ${name} available again`);
}

/**
 * Interruption cause to record for a turn REFUSED because its backend is
 * sidelined — the registry already knows why, so we do not flatten it.
 *
 * `unavailable` (circuit breaker) maps to `backend_unavailable`, `exhausted` to
 * itself, everything else to `rate_limit`. The three trigger the same series
 * switchover; they simply do not tell the human the same thing, and only one of
 * the three announces a reopening time.
 */
export function interruptionForCooldown(
  backend: string | null | undefined,
): 'rate_limit' | 'exhausted' | 'backend_unavailable' {
  const name = asBackendName(backend);
  const kind = name ? dbApi.getBackendCooldown(name)?.kind : undefined;
  if (kind === 'exhausted') return 'exhausted';
  if (kind === 'unavailable') return 'backend_unavailable';
  return 'rate_limit';
}

/**
 * Why a backend is sidelined, as a phrase to drop into a user-facing sentence.
 *
 * Only a provider-reported limit or an empty balance means "out of quota". A
 * circuit-breaker cooldown (`unavailable`) is OUR inference from failed turns:
 * saying "no quota" there sent a tester at 16 % of their weekly limit hunting
 * for a quota that was never measured (TIM-0111).
 */
export function cooldownReason(backend: string | null | undefined): string {
  const cause = cooldownCause(backend);
  if (cause === 'quota') return 'out of quota';
  const by = cause === 'auth' ? 'after an authentication failure' : 'by the circuit breaker';
  const until = dbApi.getBackendCooldown(asBackendName(backend) ?? '')?.until ?? 0;
  return `sidelined ${by} until ${messageTime(until)}, no quota measured`;
}

/** Which of `cooldownReason`'s sentences applies: the param a translated message selects on. */
export function cooldownCause(backend: string | null | undefined): 'quota' | 'auth' | 'breaker' {
  const name = asBackendName(backend);
  const row = name ? dbApi.getBackendCooldown(name) : undefined;
  if (row?.kind !== 'unavailable') return 'quota';
  return row.quota_window === 'authentication failed' ? 'auth' : 'breaker';
}

/** True if the registry still records an exclusion for this backend. An expired
 *  cooldown is purged on read: nothing else runs to do it for us.
 *
 *  A RECORD, not a verdict: it serves display and the choice of a fallback
 *  target. Whether a spawn may start is `backendStillDry` (backend-recheck.ts),
 *  which re-tests the backend first. */
export function isBackendCoolingDown(backend: string | null | undefined): boolean {
  const name = asBackendName(backend);
  if (!name) return false;
  const row = dbApi.getBackendCooldown(name);
  if (!row) return false;
  if (row.until <= Date.now()) {
    dbApi.clearBackendCooldown(name);
    return false;
  }
  return true;
}

/**
 * Where to look for a fallback from: a task stores a bare backend, but its
 * mission may run on an account of it (TODO #52) — what is dry, and what must
 * not fall back on its own, is that account. Resolved only when the caller
 * names the owner; a mission row already carries its frozen account.
 */
function fallbackSource(from: string | null | undefined, scope?: FallbackScopeArg): string | null | undefined {
  if (!from || !scope || scope.ownerUserId === undefined) return from;
  return launchBackendName(from, scope.ownerUserId);
}

type FallbackScopeArg = {
  seriesId: string | null;
  scope: FallbackScope;
  fromModel?: string | null;
  /** The owner of the TASK whose stored backend `from` is (see `fallbackSource`). */
  ownerUserId?: string | null;
  /** The owner of the PILOT mission whose backend `from` already is (a mission
   *  row carries its resolved account, so it is not re-resolved). Read by the
   *  `orchestrator` scope alone, to pick another connection of theirs on the
   *  same provider; `ownerUserId` stands in when absent. Neither given = the
   *  owner is unknown, and no account is tried. */
  missionOwnerUserId?: string | null;
  /** The task's group of volets (`tasks.plan_group`): its rules are read
   *  before the series-wide ones. Absent or null = no group. */
  planGroup?: string | null;
};

/**
 * Backup backend usable in place of `from`, or null.
 *
 * Null covers every case where switching would make no sense: switchover
 * disabled, no workable fallback anywhere, or an explicit refusal.
 *
 * The cascade runs from the most intentional to the most generic. Each level
 * only applies if its target is WORKABLE (known to the catalog, different from
 * what we are fleeing, and not dry itself); otherwise we drop to the next one —
 * "otherwise" means otherwise, an unworkable fallback must not make the whole
 * cascade fail:
 *
 *   1. `taskOverride` — a decision made when ONE task was created
 *      (`--fallback-backend`), the most specific there is;
 *   2. SERIES RULE (`timon series fallback set`) — the orchestrator's decision,
 *      since it knows its job: what calibre for the code, which small model for
 *      the reviews, what for itself;
 *   2 bis. THE PILOT ONLY (`orchestrator` scope): another connection of the
 *      same provider its owner holds — the host's sign-in, one of their
 *      accounts, one granted to them — same model;
 *   3. EQUIVALENCE MATRIX (`equivalence.ts`) — absent any decision, the model
 *      closest to the one being left behind. It comes BEFORE the fixed setting
 *      (2026-08-22): a single global fallback demotes everyone to the same
 *      place, whereas equivalence preserves the original calibre. An opus that
 *      falls deserves an opus-class model, not the account default.
 *   4. FIXED SETTING (`TIMON_FALLBACK_BACKEND`) — last resort, when equivalence
 *      finds nothing (model unknown to the matrix, all equivalents dry).
 *
 * The two refusal sentinels stay hard stops, never an "otherwise":
 * `taskOverride.backend === 'none'` and a series rule with a null backend both
 * say "I would rather it stopped than continued somewhere else".
 *
 * ACCOUNTS (TODO #52, amended by TODO #701 on 31/10/2026). A subscription
 * account is a choice of subscription: for a TASK, only a fallback someone
 * declared (levels 1-2) may move it, never the automatic levels. The PILOT is
 * the exception. On 31/10/2026 `timon.main` ran dry on `claude@aeeca8b0ac`,
 * its series rule named that same account, and the guard stopped the cascade
 * there: pilot not swapped, every wake refused, while the host's `claude` and
 * `codex` still had quota. The pilot holds the plan of the whole job and
 * receives every return; leaving it dead stops the job, which is worse than
 * moving it to another subscription its owner holds. So for the `orchestrator`
 * scope the cascade goes on: level 2 bis first (same provider, so the same
 * model and a transcript the CLI reads natively), then 3 and 4. Never to
 * another user's account (`ownConnections`). A pilot that still finds nothing
 * stays stopped, and its owner gets one urgent alert saying what to do.
 */
export function fallbackFor(
  stored: string | null | undefined,
  scope?: FallbackScopeArg,
  taskOverride?: TaskFallbackOverride | null,
): FallbackTarget | null {
  if (!settingBool('TIMON_FALLBACK_ENABLED')) return null;
  const from = fallbackSource(stored, scope);

  /** The target we keep, or null if it is not workable — in which case the
   *  caller drops one level. With no explicit model, the arrival backend's
   *  default: we NEVER carry over the original one, a slug belongs to its
   *  provider and passing it to another CLI's `--model` makes it fail at
   *  launch. */
  const usable = (backend: string | null | undefined, model: string | null | undefined) => {
    const target = asBackendName(backend);
    if (!target || target === asBackendName(from)) return null;
    if (isBackendCoolingDown(target)) return null;
    // A target whose CLI is not on this machine dies at spawn: switching onto
    // it turns a dry backend into a dead mission.
    if (!backendBinaryAvailable(target)) return null;
    // Nor onto one whose CLI is there but signed out: the turn would end on
    // "Not logged in", and with a single signed-in provider there is simply
    // nowhere to go (rc.8 tester, 20/10/2026).
    if (providerSignedOut(target)) return null;
    return {
      backend: target,
      model: (model ?? '').trim() || catalogBackend(target)?.defaultModel || null,
    };
  };

  if (taskOverride?.backend === 'none') return null;
  if (taskOverride?.backend) {
    const target = usable(taskOverride.backend, taskOverride.model);
    if (target) return target;
  }

  const plan = scope ? seriesRule(scope.seriesId, scope.scope, scope.planGroup) : undefined;
  if (plan && !plan.backend) return null;
  if (plan?.backend) {
    const target = usable(plan.backend, plan.model);
    if (target) return target;
  }

  const pilot = scope?.scope === 'orchestrator';
  // An account is a choice of subscription (TODO #52): for a task, only a
  // fallback someone declared above may move it, never the levels below.
  if (isAccountInstanceId(from) && !pilot) return null;

  const owner = scope?.missionOwnerUserId !== undefined ? scope.missionOwnerUserId : scope?.ownerUserId;
  if (pilot && from) {
    if (owner !== undefined) {
      for (const connection of ownConnections(from, owner)) {
        // Same provider, same CLI: the slug means the same thing there.
        const target = usable(connection, scope.fromModel);
        if (target) return target;
      }
    }
  }

  // No applicable decision: the nearest neighbour of the model being left.
  const equivalent = defaultEquivalentFallback(
    from,
    scope?.fromModel,
    (b) => !isBackendCoolingDown(b) && backendBinaryAvailable(b) && !providerSignedOut(b),
  );
  if (equivalent) return equivalent;

  const global = usable(settingStr('TIMON_FALLBACK_BACKEND').trim(), settingStr('TIMON_FALLBACK_MODEL'));
  if (global) return global;
  if (pilot && scope) alertPilotStranded(from, scope.seriesId, owner ?? null);
  return null;
}

/** Last alert raised per dry backend, keyed to the end of its exclusion: one
 *  alert per outage, however many wakes, chats and tasks ask in between. */
const strandedAlerts = new Map<string, number>();

/**
 * The pilot found nowhere to go: nothing retries it into working, and every
 * return of the series waits behind it. So its owner is told once, urgently,
 * with the gestures that unblock it — a log line nobody reads is how the
 * 31/10/2026 outage went unnoticed. Raised only while `from` really is
 * sidelined: a rule posted by hand on a healthy pilot strands nothing.
 */
function alertPilotStranded(from: string | null | undefined, seriesId: string | null, ownerUserId: string | null): void {
  const name = asBackendName(from) ?? from;
  if (!name || !isBackendCoolingDown(name)) return;
  const until = dbApi.getBackendCooldown(name)?.until ?? 0;
  if (strandedAlerts.get(name) === until) return;
  strandedAlerts.set(name, until);
  const { backend } = splitBackendInstance(name);
  const series = seriesId ? ` --series ${seriesId}` : '';
  console.warn(`[fallback] pilot on ${name} stranded: no usable fallback, owner alerted`);
  void import('./notifications.js').then(({ createNotification }) => {
    createNotification({
      type: 'alert',
      urgent: true,
      ownerUserId,
      title: `Orchestrator stopped: no usable fallback for ${name}`,
      message: daemonMessage('orchestrator_stranded', {
        backend: name,
        provider: backend,
        series: seriesId ? seriesId.slice(0, 8) : 'none',
        seriesFlag: series,
        cause: cooldownCause(name),
        until,
      }),
      body: [
        `The orchestrator${seriesId ? ` of series \`${seriesId.slice(0, 8)}\`` : ''} runs on \`${name}\`, which is ${cooldownReason(name)}.`,
        `Its declared fallback, the other ${backend} connections it may use, the equivalent models and the global fallback are all unavailable: it stays stopped, and the returns of its tasks wait.`,
        '',
        '**Action needed** (one is enough):',
        `- sign in another ${backend} account, or another provider, in Settings → Models → Subscription accounts;`,
        `- give the orchestrator a fallback that works: \`timon series fallback set${series} --scope orchestrator --backend <backend> --model <model>\`;`,
        `- or wait: it can resume once \`${name}\` is back (${messageDateTime(until)}).`,
      ].join('\n'),
    });
  }).catch((err: unknown) => {
    console.error(`[fallback] could not raise the stranded-pilot alert for ${name}: ${(err as Error).message}`);
  });
}

/**
 * The fallback rule that applies to this scope in this series, or undefined.
 *
 * Cascade: the exact scope, then the `'*'` wildcard. `'orchestrator'` is
 * deliberately excluded from the wildcard — the fallback picked for reviews
 * (often a small model) does not suit the actor that holds the plan for the
 * whole job and absorbs every alert.
 *
 * A task of a GROUP of volets (`planGroup`) reads the group's rules first, with
 * the same cascade, and only then the series-wide ones: a group rule, exact or
 * wildcard, wins over every series rule (task override > group > series >
 * global). The pilot has no group, so `orchestrator` never reads one.
 */
function seriesRule(
  seriesId: string | null,
  scope: FallbackScope,
  planGroup?: string | null,
): { backend: string | null; model: string | null } | undefined {
  if (!seriesId) return undefined;
  if (planGroup && scope !== 'orchestrator') {
    const group = dbApi.getSeriesGroupFallback(seriesId, planGroup, scope)
      ?? dbApi.getSeriesGroupFallback(seriesId, planGroup, '*');
    if (group) return { backend: group.backend, model: group.model };
  }
  const exact = dbApi.getSeriesFallback(seriesId, scope);
  if (exact) return { backend: exact.backend, model: exact.model };
  if (scope === 'orchestrator') return undefined;
  const wildcard = dbApi.getSeriesFallback(seriesId, '*');
  return wildcard ? { backend: wildcard.backend, model: wildcard.model } : undefined;
}

/** Whether a group has a fallback rule of its own for this type (exact or
 *  wildcard): if so, no series-wide rule governs the group's tasks of that type. */
function groupHasOwnRule(seriesId: string, planGroup: string, type: TaskType): boolean {
  return !!dbApi.getSeriesGroupFallback(seriesId, planGroup, type) || !!dbApi.getSeriesGroupFallback(seriesId, planGroup, '*');
}

/**
 * Backend/model to use for a spawn, taking exhausted quotas into account.
 *
 * Returns `null` when nothing changes — the caller then keeps its own values
 * and has no decision to make. Deliberately pure: this is the same question
 * asked by the dispatcher (for a task) and by the wake loop (for an
 * orchestrator mission), and it must get the same answer.
 */
export function redirectIfExhausted(
  backend: string | null | undefined,
  scope?: FallbackScopeArg,
  taskOverride?: TaskFallbackOverride | null,
): FallbackTarget | null {
  if (!isBackendCoolingDown(fallbackSource(backend, scope))) return null;
  return fallbackFor(backend, scope, taskOverride);
}

/**
 * Same question as `redirectIfExhausted`, asked of the backend itself rather
 * than of the registry: the exclusion is re-tested first (`backend-recheck.ts`),
 * so a quota that reopened before its estimated time is used again instead of
 * being routed around. What a pilot's wake calls: with no answer to read, its
 * spawn is the test, because moving a pilot costs more than one trial.
 */
export async function redirectIfStillDry(
  backend: string | null | undefined,
  scope?: FallbackScopeArg,
  taskOverride?: TaskFallbackOverride | null,
): Promise<FallbackTarget | null> {
  if (!(await backendStillDry(fallbackSource(backend, scope), { claimTrial: false }))) return null;
  const target = fallbackFor(backend, scope, taskOverride);
  if (target) announceFallback(fallbackSource(backend, scope), target.backend);
  return target;
}

/**
 * Says on the bus that an actor really moves to its fallback. Only where a move
 * is applied (a spawn redirect, a series switch): `fallbackFor` and
 * `redirectIfExhausted` merely answer a question, which `backendResumeRoute` and
 * the dispatcher also ask without moving anything.
 */
function announceFallback(from: string | null | undefined, to: string): void {
  if (from === to) return;
  try {
    bus.publish({ kind: 'backend_fallback', fromBackend: from ?? null, toBackend: to });
  } catch { /* a listener never stops a switchover */ }
}

/**
 * The same question for a task's spawn, with one difference: a backend nothing
 * could re-test stays sidelined (TODO #738). The trial of the 2026-10-18 decision
 * is for a task with nowhere else to go; `backendStillDry` lets any caller through
 * when the probe is silent, so a task requeued "on its fallback" went back to the
 * sidelined backend and served as the probe.
 *
 * The re-test still runs for what it settles: a probe that answers lifts the
 * exclusion or confirms it, and the registry read next holds the result. With
 * nowhere to go this returns null and `spawnTurn` takes the trial slot.
 */
export async function redirectTaskSpawn(
  backend: string | null | undefined,
  scope: FallbackScopeArg,
  taskOverride?: TaskFallbackOverride | null,
): Promise<FallbackTarget | null> {
  await backendStillDry(fallbackSource(backend, scope), { claimTrial: false });
  const target = redirectIfExhausted(backend, scope, taskOverride);
  if (target) announceFallback(fallbackSource(backend, scope), target.backend);
  return target;
}

/**
 * Whether a task its backend stopped can leave again, and by which way:
 * `'reopened'` when the backend it would launch on is no longer sidelined (the
 * registry purges an exclusion past its time, the usage sweep and a successful
 * turn lift one early), `'fallback'` when it still is but the same cascade the
 * dispatcher applies at spawn finds a workable target, `null` to keep waiting.
 * Same arguments as `redirectTaskSpawn`, so the answer cannot diverge from where
 * the spawn will actually send the task.
 *
 * `reopenedAt`: a reopening the provider announced for this task, now past. An
 * ESTIMATE recorded before it no longer holds the task (TIM-0134): a text-only
 * 429 from a pilot woken on the same account writes "now + 5 h", with no idea the
 * window closes sooner. An exact time, or an estimate recorded after that
 * reopening, is newer evidence and keeps its weight. The row stays: the spawn of
 * a task with no fallback re-tests it (`backendStillDry`), and its success is what
 * lifts it.
 */
export function backendResumeRoute(
  backend: string | null | undefined,
  scope?: FallbackScopeArg,
  taskOverride?: TaskFallbackOverride | null,
  reopenedAt?: number | null,
): 'reopened' | 'fallback' | null {
  const source = fallbackSource(backend, scope);
  if (!isBackendCoolingDown(source)) return 'reopened';
  // Before the estimate below: `redirectTaskSpawn` reads the same row, and a
  // workable fallback is where that spawn goes.
  if (fallbackFor(backend, scope, taskOverride)) return 'fallback';
  if (reopenedAt != null) {
    const name = asBackendName(source);
    const row = name ? dbApi.getBackendCooldown(name) : undefined;
    if (row?.kind === 'rate_limit' && row.exact !== 1 && row.noted_at <= reopenedAt) return 'reopened';
  }
  return null;
}

/** Whether a fallback switch may move the series' pilot (see its call site). */
export function pilotIsGoverned(ruleScope: FallbackScope | undefined, pilotBackendCoolingDown: boolean): boolean {
  return ruleScope === 'orchestrator' || pilotBackendCoolingDown;
}

/**
 * Switches a whole series over to its backup backend.
 *
 * The order is deliberate: the pilot mission FIRST (it is the one receiving
 * the returns; as long as it is dead, nothing moves), then the tasks. Tasks IN
 * FLIGHT are left alone — cutting them would lose their work while they may
 * well be running on a backend that still has quota.
 *
 * Idempotent: called again on an already switched series, it finds nothing
 * left to change and does not notify a second time.
 *
 * `ruleScope` (set only by `timon series fallback set`, see
 * `applySeriesFallbackRule`) narrows the switchover to what the rule just
 * posted actually governs. Without it, setting one rule for `code` would
 * silently repoint review, merge and doc too — each of them resolving through
 * the wildcard, the equivalence matrix or the global setting, none of which the
 * human just asked for. The automatic path passes nothing and keeps its
 * whole-series behaviour for the TASKS: it fires because a backend really is
 * dry, and then everything that depends on it has to move. The pilot is the
 * exception: it moves only when its own backend is dry (`pilotIsGoverned`).
 *
 * `respawnDeadPilot: false` (set by the boot reconciliation, see
 * `reconcileOrphanedTasks`) repoints a pilot that is NOT running instead of
 * switching it: `switchMissionBackend` reopens the mission and spawns a turn,
 * which at boot would resurrect an orchestrator nobody asked to restart — a
 * whole series' worth of them, on a daemon that has just come up. A pilot still
 * running is switched normally, flag or not.
 *
 * What repointing buys, exactly: any path that spawns a turn on THAT mission id
 * reads `missions.backend_override` (cf. `resolveConfig` in `agent.ts`), so it
 * leaves on the fallback instead of the dry backend. What it does NOT buy: an
 * in-place resume by the wake loop, since we clear the session — it belonged to
 * the CLI we are leaving, and `--resume`ing it on another provider fails at
 * launch. The wake loop then starts a fresh mission for that agent, where the
 * backend cooldown decides. Unlike `switchMissionBackend`, no transcript is
 * handed over: this path spawns nothing, so it has nowhere to hand it to. Its
 * `backend_switch` event says the context is still owed (`pending`), which is
 * what sends it with the next message written in the thread.
 */
export function switchSeriesToFallback(
  seriesId: string,
  opts: SeriesSwitchOptions = {},
): Promise<FallbackTarget | null> {
  // One pass at a time per series. Every task that dies on the dry backend
  // fires its own switchover: four of them in the same second (31/10/2026)
  // raced on the pilot and announced the same move four times.
  const previous = seriesSwitches.get(seriesId) ?? Promise.resolve();
  const run = previous.then(() => switchSeriesNow(seriesId, opts));
  const tail = run.then(() => undefined, () => undefined);
  seriesSwitches.set(seriesId, tail);
  void tail.then(() => { if (seriesSwitches.get(seriesId) === tail) seriesSwitches.delete(seriesId); });
  return run;
}

type SeriesSwitchOptions = {
  pilotMissionId?: string | null;
  reason?: string;
  ruleScope?: FallbackScope;
  /** With `ruleScope`: the rule governs that group of volets only. */
  ruleGroup?: string | null;
  respawnDeadPilot?: boolean;
};

const seriesSwitches = new Map<string, Promise<void>>();

/** Per series, per (type, group): the backend the last automatic pass moved
 *  those tasks to. A later pass must not move them on again from there — that
 *  backend is not dry, and the cascade run from it lands somewhere else. */
const seriesMoves = new Map<string, Map<string, string>>();

/** Per series, what the last notification announced and when: the same
 *  switchover reported again within the window is logged, not re-sent. */
const seriesNotices = new Map<string, { at: number; key: string }>();
const SERIES_NOTICE_WINDOW_MS = 10 * 60_000;

async function switchSeriesNow(seriesId: string, opts: SeriesSwitchOptions): Promise<FallbackTarget | null> {
  const tasks = dbApi.listTasksBySeries(seriesId);
  if (tasks.length === 0) return null;

  const pilotId = opts.pilotMissionId ?? tasks.find((t) => t.creator_mission_id)?.creator_mission_id ?? null;
  const pilot = pilotId ? dbApi.getMission(pilotId) : null;

  // Lazy import: `agent.ts` imports the db/settings chain this module is part
  // of. Loading it at call time avoids wiring an import cycle at load time for
  // a path that only serves a quota outage.
  const { switchMissionBackend, loadConfig, logBackendSwitch } = await import('./agent.js');

  /** The backend this agent actually uses today — the row's override if there
   *  is one, otherwise its config. Without this we would "switch over" an actor
   *  already on the backup backend, that is, cut it off for nothing. */
  const effective = (override: string | null, agentName: string): string | null => {
    if (override) return override;
    try { return loadConfig(agentName).backend ?? null; } catch { return null; }
  };

  // The pilot has ITS OWN scope. It is the one receiving alerts for the whole
  // job: the fallback picked for reviews (often a small model) does not suit
  // the actor that has to hold the plan.
  const effectiveModel = (override: string | null, agentName: string): string | null => {
    if (override) return override;
    try { return loadConfig(agentName).model ?? null; } catch { return null; }
  };

  // The pilot moves only when a rule asked for it (`--scope orchestrator`) or
  // when its OWN backend is dry — on the automatic path too. A task whose
  // backend ran out (codex on the reviews) says nothing about the orchestrator
  // on claude: `switchMissionBackend` replays the transcript on a LIVE mission,
  // and doing that to a healthy pilot swaps the actor out from under itself,
  // mid-plan, for nothing (2026-10-07: claude-opus-5-5 → claude-fable-5-5).
  const pilotGoverned = pilotIsGoverned(
    opts.ruleScope,
    pilot ? isBackendCoolingDown(effective(pilot.backend_override, pilot.agent_name)) : false,
  );

  const pilotTarget = pilot && pilotGoverned
    ? fallbackFor(effective(pilot.backend_override, pilot.agent_name), {
        seriesId,
        scope: 'orchestrator',
        fromModel: effectiveModel(pilot.model_override, pilot.agent_name),
        missionOwnerUserId: pilot.owner_user_id ?? null,
      })
    : null;

  // "pilot unchanged" with no cause cost a night of investigation on
  // 2026-08-22: reading the log, there was no way to tell whether the fallback
  // was refused, missing, or dry itself. We say which of the three it is.
  if (pilot && pilotGoverned && !pilotTarget) {
    const from = effective(pilot.backend_override, pilot.agent_name) ?? 'default';
    console.warn(
      `[fallback] series ${seriesId.slice(0, 8)}: pilot ${pilot.id.slice(0, 8)} not swapped — ` +
      `no applicable fallback from ${from} (orchestrator scope: fallback refused, ` +
      `unconfigured, identical, or out of quota itself)`,
    );
  } else if (!pilot) {
    console.warn(
      `[fallback] series ${seriesId.slice(0, 8)}: no pilot identified ` +
      `(pilotMissionId=${pilotId?.slice(0, 8) ?? 'null'}) — only the tasks will switch over`,
    );
  }

  let pilotSwitched = false;
  let pilotFailure: string | null = null;
  const repointOnly = opts.respawnDeadPilot === false && pilot?.status !== 'running';
  if (pilot && pilotTarget && repointOnly) {
    // Already on the target (a previous pass moved it): nothing to write, and
    // above all nothing to announce a second time.
    if (pilot.backend_override !== pilotTarget.backend || pilot.model_override !== pilotTarget.model) {
      try {
        const previousBackend = effective(pilot.backend_override, pilot.agent_name);
        const previousModel = effectiveModel(pilot.model_override, pilot.agent_name);
        // All or nothing: a move without its event would leave what the previous
        // backend proved standing for the next one, which then starts blind.
        db.transaction(() => {
          // What the pilot was frozen on would otherwise win over the target at
          // its next launch, on the same provider (`launchForMission`).
          replaceMissionLaunch(pilot.id, pilotTarget.backend, pilot.owner_user_id);
          dbApi.setMissionLlmOverrides(pilot.id, pilotTarget.backend, pilotTarget.model);
          // The session belonged to the CLI we are leaving: keeping it would make
          // the next resume attempt an impossible `--resume` on another provider.
          dbApi.clearMissionSession(pilot.id);
          logBackendSwitch(pilot.id, {
            backend: pilotTarget.backend,
            previous_backend: previousBackend,
            model: pilotTarget.model,
            previous_model: previousModel,
            context_mode: 'pending',
            context_tokens: 0,
            cause: 'fallback',
            cause_detail: opts.reason ?? `${previousBackend} ${cooldownReason(previousBackend)}`,
          });
        })();
        pilotSwitched = true;
        announceFallback(previousBackend, pilotTarget.backend);
        console.warn(
          `[fallback] series ${seriesId.slice(0, 8)}: pilot ${pilot.id.slice(0, 8)} repointed to `
          + `${pilotTarget.backend} without respawn (mission ${pilot.status})`,
        );
      } catch (err) {
        pilotFailure = (err as Error).message;
        console.warn(
          `[fallback] series ${seriesId.slice(0, 8)}: pilot ${pilot.id.slice(0, 8)} not repointed `
          + `(${pilotFailure})`,
        );
      }
    }
  } else if (pilot && pilotTarget) {
    try {
      const previousBackend = effective(pilot.backend_override, pilot.agent_name);
      await switchMissionBackend(pilot.id, {
        backend: pilotTarget.backend,
        model: pilotTarget.model,
        cause: 'fallback',
        causeDetail: opts.reason ?? `${effective(pilot.backend_override, pilot.agent_name)} ${cooldownReason(effective(pilot.backend_override, pilot.agent_name))}`,
        message:
          `Your previous backend is unavailable (${cooldownReason(effective(pilot.backend_override, pilot.agent_name))}): you are resuming this job on ` +
          `${pilotTarget.backend}. The context above is that of YOUR mission — ` +
          'pick the plan up where it stood.',
      });
      pilotSwitched = true;
      announceFallback(previousBackend, pilotTarget.backend);
    } catch (err) {
      // Turn in flight, mission not found, summary impossible... Switching the
      // tasks over is still worth it: they will start again on their fallback
      // at the next dispatch even if the pilot could not be swapped right now.
      pilotFailure = (err as Error).message;
      console.warn(
        `[fallback] series ${seriesId.slice(0, 8)}: pilot ${pilot.id.slice(0, 8)} not swapped ` +
        `(${pilotFailure})`,
      );
    }
  }

  // One target per task TYPE — per (type, group of volets) since a group has
  // its own rules: that is the whole point of a series plan. A type whose scope
  // says "no fallback" (or whose backup is dry itself) is simply left in place.
  const moved: string[] = [];
  const movedKeys: { type: TaskType; planGroup: string | null }[] = [];
  let firstTaskTarget: FallbackTarget | null = null;
  let changed = 0;
  /** Types a hot-posted rule governs: the exact type it names, or — for the
   *  wildcard — every type that has no rule of its own, since an exact rule
   *  wins over `'*'` (cf. `seriesRule`). `orchestrator` governs no task. A
   *  group rule governs its group alone; a series rule governs the tasks
   *  outside any group and those whose group has no rule of its own. */
  const governs = (type: TaskType, planGroup: string | null): boolean => {
    if (!opts.ruleScope) return true;
    if (opts.ruleGroup) {
      if (planGroup !== opts.ruleGroup) return false;
      if (opts.ruleScope === type) return true;
      return opts.ruleScope === '*' && !dbApi.getSeriesGroupFallback(seriesId, planGroup, type);
    }
    if (planGroup && groupHasOwnRule(seriesId, planGroup, type)) return false;
    if (opts.ruleScope === type) return true;
    return opts.ruleScope === '*' && !dbApi.getSeriesFallback(seriesId, type);
  };

  const keys = new Map<string, { type: TaskType; planGroup: string | null }>();
  for (const t of tasks) {
    if (t.status !== 'PENDING' && t.status !== 'BLOCKED') continue;
    const planGroup = t.plan_group ?? null;
    keys.set(`${t.type}\u0000${planGroup ?? ''}`, { type: t.type, planGroup });
  }
  const isDry = (t: (typeof tasks)[number]): boolean => isBackendCoolingDown(fallbackSource(
    effective(t.backend_override, t.agent_name),
    { seriesId, scope: t.type, ownerUserId: t.owner_user_id ?? null },
  ));
  const movesOfSeries = seriesMoves.get(seriesId) ?? new Map<string, string>();
  for (const [key, { type, planGroup }] of keys) {
    if (!governs(type, planGroup)) continue;
    const ofKey = tasks.filter((t) => t.type === type && (t.plan_group ?? null) === planGroup);
    // A task still on the dry backend speaks for the type, not one a previous
    // pass already moved: the cascade has to start from what is dry.
    const sample = ofKey.find((t) => (t.status === 'PENDING' || t.status === 'BLOCKED') && isDry(t)) ?? ofKey[0]!;
    const already = movesOfSeries.get(key);
    if (!opts.ruleScope && already && !isDry(sample) && effective(sample.backend_override, sample.agent_name) === already) continue;
    const target = fallbackFor(
      effective(sample.backend_override, sample.agent_name),
      { seriesId, scope: type, planGroup, fromModel: effectiveModel(sample.model_override, sample.agent_name), ownerUserId: sample.owner_user_id ?? null },
      { backend: sample.fallback_backend_override, model: sample.fallback_model_override },
    );
    if (!target) continue;
    const n = dbApi.setSeriesLlmOverride(seriesId, type, target.backend, target.model, planGroup);
    if (n === 0) continue;
    changed += n;
    announceFallback(effective(sample.backend_override, sample.agent_name), target.backend);
    if (!opts.ruleScope) movesOfSeries.set(key, target.backend);
    movedKeys.push({ type, planGroup });
    firstTaskTarget ??= target;
    moved.push(`${type}${planGroup ? `@${planGroup}` : ''} → ${target.backend}${target.model ? `/${target.model}` : ''} (${n})`);
  }

  if (movesOfSeries.size > 0) seriesMoves.set(seriesId, movesOfSeries);

  // Tasks stopped by the usage limit ALONE start again: their blockage
  // described the state of the account, not the state of the work, and the
  // account has changed.
  // Only the types that moved: a scope left in place (no fallback, or a backup
  // dry itself) must stay BLOCKED. Unblocking it would send it back onto the
  // very backend that stopped it, which is the requeue turned against itself.
  const requeued = movedKeys.length > 0
    ? dbApi.requeueRateLimitedTasks(seriesId, movedKeys)
    : 0;
  if (!pilotSwitched && changed === 0) return null;

  // What we return is "the switchover that actually happened": the pilot's if
  // it took place, otherwise the tasks'. Returning null while a type has moved
  // would make the caller believe nothing happened.
  const applied = (pilotSwitched ? pilotTarget : null) ?? firstTaskTarget;
  console.warn(
    `[fallback] series ${seriesId.slice(0, 8)}: pilot ${pilotSwitched ? `→ ${pilotTarget?.backend}` : 'unchanged'}` +
    `${moved.length ? ` | ${moved.join(', ')}` : ''}`,
  );

  // A pilot that should have moved and did not is the news: "series switched"
  // over a stopped orchestrator sent the user looking for a live one (31/10/2026).
  const pilotStuck = !!pilot && pilotGoverned && !pilotSwitched;
  const orchestratorLine = !pilot
    ? 'none identified'
    : pilotSwitched
      ? repointOnly
        ? `repointed to \`${pilotTarget?.backend}\` (mission not running — not respawned here)`
        : `swapped to \`${pilotTarget?.backend}\` without changing id (context preserved)`
      : pilotStuck
        ? pilotFailure
          ? `NOT moved — the switch failed (${pilotFailure}); it stays stopped`
          : 'NOT moved — no usable fallback; it stays stopped until its backend is back or a fallback is set'
        : 'unchanged (its backend is not the one out of quota)';
  const pilotState = !pilot ? 'none'
    : pilotSwitched ? (repointOnly ? 'repointed' : 'swapped')
      : pilotStuck ? (pilotFailure ? 'failed' : 'stuck')
        : 'unchanged';
  const title = opts.ruleScope
    // A hand-posted rule is not an outage: saying "quota exhausted" to someone
    // who has just typed the command would report a provider incident that did
    // not happen.
    ? `Fallback rule applied — series moved (scope ${opts.ruleScope})`
    : pilotSwitched
      ? 'Quota exhausted — series switched to its fallback plan'
      : pilotStuck
        ? 'Quota exhausted — tasks switched, orchestrator NOT moved'
        : 'Quota exhausted — tasks switched to their fallback plan';

  // The same move announced again (one switchover per task that died on the
  // dry backend) is logged above, not re-sent.
  const noticeKey = [title, orchestratorLine, ...moved.map((m) => m.replace(/ \(\d+\)$/, '')).sort()].join('\u0000');
  const lastNotice = seriesNotices.get(seriesId);
  if (lastNotice?.key === noticeKey && Date.now() - lastNotice.at < SERIES_NOTICE_WINDOW_MS) return applied;
  seriesNotices.set(seriesId, { at: Date.now(), key: noticeKey });

  notifyUser(
    title,
    [
      `Series \`${seriesId.slice(0, 8)}\` (${tasks.length} task(s)) — ${pilotStuck ? 'its tasks are' : 'it is'} restarting on backup backends.`,
      '',
      `- Orchestrator: ${orchestratorLine}`,
      `- Tasks repointed by type: ${moved.length ? moved.join(' · ') : 'none'}`,
      `- Tasks requeued (blocked by the backend, not by the work): ${requeued}`,
      opts.reason ? `- Trigger: ${opts.reason}` : '',
    ].filter(Boolean).join('\n'),
    // To the agent piloting THIS series, not to the cross-project orchestrator.
    {
      toAgent: pilot?.agent_name ?? null,
      message: daemonMessage('series_fallback_applied', {
        outcome: opts.ruleScope ? 'rule' : pilotSwitched ? 'switched' : pilotStuck ? 'stuck' : 'tasks',
        scope: opts.ruleScope ?? 'none',
        series: seriesId.slice(0, 8),
        tasks: tasks.length,
        pilot: pilotState,
        backend: pilotTarget?.backend ?? 'none',
        failure: pilotFailure ?? 'none',
        moved: moved.length ? moved.join(' · ') : 'none',
        requeued,
        trigger: opts.reason || 'none',
      }),
    },
  );
  return applied;
}

/**
 * Applies a fallback rule POSTED BY HAND, right now, to a series already
 * running (`timon series fallback set`, `PUT /api/series/:id/fallbacks`).
 *
 * WHY (night of 2026-09-01). Setting a rule only WROTE it: the real switchover
 * (`setSeriesLlmOverride` + requeue) lived solely in the automatic path, on an
 * interruption that says "the backend shut down". So the rule the maintainer posted at
 * 22:06 changed nothing — the next task left on the dry backend anyway, hit
 * another 402, and each blocked task had to have its `backend_override`
 * rewritten by hand, one at a time.
 *
 * DECISION: applying is the DEFAULT, and it is unconditional on the tasks. Not
 * gated on the backend being known-dry, because the human posts a rule exactly
 * when automatic detection did NOT fire — gating the manual escape hatch on the
 * automatic path having worked defeats its purpose. Naming a scope and a
 * backend IS the decision. Before a chantier starts the series has no
 * PENDING/BLOCKED task, so the default is a no-op there; `apply: false` remains
 * available for recording a plan while explicitly touching nothing.
 *
 * What it does NOT do: it never moves a task in flight (`switchSeriesToFallback`
 * only ever touches PENDING/BLOCKED), never touches a type the rule does not
 * govern, and never swaps a healthy pilot unless the rule names
 * `orchestrator`.
 */
export async function applySeriesFallbackRule(
  seriesId: string,
  scope: FallbackScope,
  /** A rule of one group of volets moves that group's tasks only. */
  group: string | null = null,
): Promise<FallbackTarget | null> {
  return switchSeriesToFallback(seriesId, {
    ruleScope: scope,
    ruleGroup: group,
    reason: `fallback rule set by hand for scope "${scope}"${group ? ` of group "${group}"` : ''}`,
  });
}
