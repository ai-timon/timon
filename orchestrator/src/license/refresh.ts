import { daemonMessage, type DaemonMessage } from '../daemon-message.js';
import { createHash } from 'node:crypto';
/**
 * Licence refresh loop — L.3 of PRD 03, SECU-LICENCES L-1 / L-2 / L-7.
 *
 * Until 04/09/2026 the licence was verified ONCE (boot or install) and the
 * state then lived in memory forever: a revoked licence stayed `valid` until
 * the next restart, i.e. never for a systemd daemon. This module is the
 * missing half of the contract:
 *
 *   1. **Network refresh** every `every` seconds (the value the SERVER sent on
 *      activation, persisted in `license.state.json`, 300 s by default):
 *      `renew(key)` with the persisted activation key, then install the new
 *      token exactly like the route would.
 *   2. **Local re-evaluation** every minute, independent of the network: the
 *      current token is re-verified, so an expired one goes `unlicensed` even
 *      when the server is unreachable — after the offline tolerance.
 *   3. **Answer semantics.** A refusal the server MADE (`403 revoked |
 *      expired | deactivated | not_active`) switches the licence off at once.
 *      `409 device_mismatch` means another machine holds this device id: off,
 *      `invalid:machine`, no rotation (that is the interactive route's call).
 *      `429` changes NOTHING (a 429 was once mistaken for a revocation on the
 *      server side — never again). Unreachable, 5xx, unsigned: offline
 *      counter, the token stays good until `offlineHours` (plan value, from
 *      the server) after the last successful contact.
 *
 * Every state change is published on the bus (`license_changed`) so the UI,
 * the bundled reconciler and the plugin loader follow without a restart.
 *
 * What the person is told (the maintainer's decision, 18/11/2026): nothing
 * while the server is only unreachable and the paid rights hold — an outage
 * that is not theirs is not worth a word, so it stays in this log. Once paid
 * rights are really lost on a build that falls back to Free (tolerance run
 * out, or a refusal the server made), the state says so (`paidRightsLapse`)
 * and the web app shows ONE bottom-left card; no notification doubles it. A
 * beta build has no Free to fall back on: it locks, and that still raises one
 * alert, since nothing else works until a key is entered.
 *
 * Logs carry the `status` and the reason, NEVER the token nor the key.
 */
import { fingerprintReadable } from './fingerprint.js';
import { assertLicenseCompatible } from './compliance.js';
import { LicenseCapabilityError } from './capabilities.js';
import { fixedComposition } from './capabilities.js';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import type { Application } from 'express';
import { bus } from '../bus.js';
import { LICENSE_FILE, LICENSE_KEY_FILE } from '../paths.js';
import { deviceId } from './device.js';
import { LicenseServerError, renew, type ClientOptions } from './client.js';
import { installLicenseToken, readLicense, unlicensed, verifyLicenseToken, type LicenseReason, type LicenseState, type VerifyOptions } from './license.js';
import { licenseRevision, licenseState, reevaluateBuildPolicy, setLicenseState } from './runtime.js';
import { licenseStoreDamaged, readLicenseStore, writeFileDurably, writeLicenseStore, type LicenseStore } from './store.js';

/** §5.1 defaults, used only until the server has announced its own. */
const DEFAULT_EVERY_SECONDS = 300;
const DEFAULT_OFFLINE_HOURS = 24;
const LOCAL_TICK_MS = 60_000;
/**
 * Delays of the quick retries after a boot whose first renewal found no
 * network, before the regular interval takes over. A retry that would land at
 * or past the first regular tick is dropped (the server may announce a short
 * interval), so the two never send a renewal at the same time.
 */
const BOOT_RETRY_MS: readonly number[] = [30_000, 60_000, 120_000];

// ── Persistence of the activation key ───────────────────────────────────────

export function readLicenseKey(file = LICENSE_KEY_FILE): string | null {
  try {
    const key = readFileSync(file, 'utf8').trim();
    return key === '' ? null : key;
  } catch { return null; }
}

export function writeLicenseKey(key: string, file = LICENSE_KEY_FILE): void {
  writeFileDurably(file, key.trim() + '\n');
}

export function forgetLicenseKey(file = LICENSE_KEY_FILE): void {
  rmSync(file, { force: true });
}

/** Records what a successful `activate` / `renew` told us. */
export function recordServerContact(refresh: { every: number; offlineHours: number } | undefined, now = Date.now()): void {
  writeLicenseStore({
    ...(refresh ? { every: refresh.every, offlineHours: refresh.offlineHours } : {}),
    lastContact: Math.floor(now / 1000),
  });
}

// ── Boot-time read with offline tolerance ───────────────────────────────────

/**
 * What the boot installs as the initial state. An expired token is still
 * accepted while the last server contact is within the plan's offline
 * tolerance — a laptop restarted on a plane keeps its licence — and the state
 * says so (`offlineSince`) so the banner can.
 */
export function bootLicenseState(opts: VerifyOptions = {}): LicenseState {
  const store = recoverLicenseStore(opts.now ?? new Date());
  const graceUntil = store.lastContact === undefined
    ? undefined
    : store.lastContact + (store.offlineHours ?? DEFAULT_OFFLINE_HOURS) * 3600;
  const state = readLicense(undefined, { device: deviceId(), graceUntil, ...opts });
  if (state.status === 'valid' && state.expiresAt && Date.parse(state.expiresAt) < (opts.now ?? new Date()).getTime() && store.lastContact !== undefined) {
    return { ...state, offlineSince: new Date(store.lastContact * 1000).toISOString() };
  }
  return state;
}

/**
 * A hard reset can leave `license.state.json` empty or cut short, and reading
 * it as absent lost `lastContact`: a token that expired during the outage then
 * looked never renewed, so the boot read it `expired` and a beta build locked
 * itself (`beta_ended`) until a renewal got through (TIM-0147). The token file
 * is rewritten by every activation and renewal, so its date is the last server
 * contact that survived; the tolerance counts from it, as it would have.
 *
 * Only with an activation key: without one, the token was installed by hand,
 * nothing renews it, and its date says nothing about the server.
 *
 * The clock anchors went with the file too. The token's own `srv` is the
 * server clock of the last token this install accepted, so it restores
 * `maxSrv` (an older token replayed after the reset is refused again) and,
 * with the file date, `lastSeen`. Never later than now: a forged `srv` could
 * only push the anchors into the future, which locks its own author out.
 */
function recoverLicenseStore(now: Date): LicenseStore {
  const store = readLicenseStore();
  if (!licenseStoreDamaged() || !readLicenseKey()) return store;
  let tokenWritten: number;
  try { tokenWritten = statSync(LICENSE_FILE).mtimeMs; } catch { return store; }
  const nowSeconds = Math.floor(now.getTime() / 1000);
  const lastContact = Math.min(Math.floor(tokenWritten / 1000), nowSeconds);
  const srv = tokenServerClock();
  const patch: LicenseStore = {
    lastContact,
    lastSeen: lastContact,
    ...(srv !== null ? { maxSrv: Math.min(srv, nowSeconds) } : {}),
  };
  console.warn(`[license] license.state.json is unreadable; offline tolerance counted from the licence file date (${new Date(lastContact * 1000).toISOString()})`);
  try { return writeLicenseStore(patch); }
  catch (err) {
    console.warn('[license] could not rewrite license.state.json:', (err as Error).message);
    return { ...store, ...patch };
  }
}

/** The `srv` claim of the installed token, unverified: only ever used to restore an anchor. */
function tokenServerClock(): number | null {
  try {
    const claims = readFileSync(LICENSE_FILE, 'utf8').trim().split('.')[1];
    if (!claims) return null;
    const srv = (JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as { srv?: unknown }).srv;
    return typeof srv === 'number' && Number.isInteger(srv) && srv >= 0 ? srv : null;
  } catch { return null; }
}

// ── The loop ────────────────────────────────────────────────────────────────

export type RefreshDeps = {
  app: Pick<Application, 'get'> | null;
  client?: ClientOptions;
  verify?: VerifyOptions;
  now?: () => number;
  /** `applyLicensedSurfaces` — injected to keep this module free of the router. */
  recompose?: (app: Pick<Application, 'get'>) => Promise<void>;
  notify?: (n: { title: string; body: string; urgent: boolean; message?: DaemonMessage }) => void;
  /** Tests: no timers, no first tick — the test drives `tick()` / `localTick()`. */
  manual?: boolean;
  /** Tests: whether the machine id can be read right now. */
  fingerprintReadable?: () => boolean;
  /** Tests: shorter delays for the quick retries after the boot. */
  bootRetryMs?: readonly number[];
};

export type LicenseRefresh = {
  /** One network refresh. Exposed for the tests and for `timon license renew`. */
  tick(): Promise<void>;
  /** One local re-evaluation. */
  localTick(): Promise<void>;
  stop(): void;
};

/** Licence alerts point at the licence page, and are recognised by it. */
export const LICENSE_ALERT_ANCHOR = '/license';

/**
 * A licence that is valid again retires the alerts that said otherwise. They
 * stayed in the Notification center, still claiming the licence was off after
 * the key had been entered again (TIM-0024).
 * Never rejects: a caller may leave it floating, a test awaits it.
 */
export function clearLicenseAlerts(): Promise<void> {
  return import('../db.js').then(({ dbApi }) => {
    if (dbApi.dismissNotificationsByAnchor(LICENSE_ALERT_ANCHOR, 'alert') > 0) {
      bus.publish({ kind: 'notifications_changed', ownerUserId: null });
    }
  }).catch(() => { /* notifications unavailable: nothing to retire */ });
}

function publish(state: LicenseState): void {
  bus.publish({ kind: 'license_changed', status: state.status, reason: state.reason, offlineSince: state.offlineSince });
}

/**
 * The cause of a failed renewal, worded for the log and the alert: which side
 * failed is what tells a network not ready yet from a server that answered.
 * Built from the status, the error code and the transport's own error code —
 * never the request, which carries the activation key.
 */
export function describeRenewFailure(err: unknown): string {
  if (err instanceof LicenseServerError) {
    if (err.status === 429) return 'rate limited by the license server (429)';
    if (err.status === 0) return `license server not usable: ${err.code}`;
    return `license server answered ${err.status} ${err.code}`;
  }
  const e = err as { name?: unknown; message?: unknown; cause?: { code?: unknown } } | null;
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'network: license server did not answer in time';
  const code = typeof e?.cause?.code === 'string' ? e.cause.code : null;
  return `network: ${code ?? (typeof e?.message === 'string' ? e.message : 'unreachable')}`;
}

function refusalReason(code: string): 'revoked' | 'expired' | 'deactivated' | null {
  if (code === 'revoked') return 'revoked';
  if (code === 'expired') return 'expired';
  if (code === 'deactivated' || code === 'not_active' || code === 'unknown_key') return 'deactivated';
  return null;
}

export function startLicenseRefresh(deps: RefreshDeps): LicenseRefresh {
  const now = deps.now ?? (() => Date.now());
  const notify = deps.notify ?? defaultNotify;
  let offlineSince: number | null = null;
  let alertedStillOff = false;
  /** The server refused to renew the expired paid licence: no more asking until a restart. */
  let renewalAbandoned = false;

  /** Tells the rest of the daemon what `before` became, once per change. */
  const announce = async (before: LicenseState, after: LicenseState): Promise<void> => {
    const changed = before.status !== after.status || before.reason !== after.reason
      || before.offlineSince !== after.offlineSince || before.edition !== after.edition
      || JSON.stringify(before.modules) !== JSON.stringify(after.modules)
      || JSON.stringify(before.plugins) !== JSON.stringify(after.plugins)
      || JSON.stringify(before.capabilities) !== JSON.stringify(after.capabilities)
      // A token that only adds or withdraws a feature (White Label) must still
      // recompose: the plugin loader reads it to admit a layout.
      || JSON.stringify(before.features ?? []) !== JSON.stringify(after.features ?? [])
      || before.users !== after.users || before.plan !== after.plan || before.planId !== after.planId;
    if (!changed) return;
    if (after.status === 'valid' && before.status !== 'valid') void clearLicenseAlerts();
    publish(after);
    if (after.reason === 'build_expired' && before.reason !== 'build_expired') {
      notify({
        title: 'This Timon beta build has expired', body: 'Install the current beta build to keep working. Your data is preserved.', urgent: true,
        message: daemonMessage('license_build_expired'),
      });
    }
    if (deps.app && deps.recompose) {
      await deps.recompose(deps.app).catch((err: Error) => console.warn('[license] recomposition failed:', err.message));
    }
  };

  // The comparison is against the EFFECTIVE state the runtime stored, not the
  // one handed in: on a beta build the two differ (no Free, no expired build).
  const apply = async (state: LicenseState): Promise<void> => {
    const before = licenseState();
    setLicenseState(state);
    if (licenseState().status === 'valid') alertedStillOff = false;
    await announce(before, licenseState());
  };

  /**
   * A licence that is off while an activation key is there, and a renewal that
   * could not settle it. `goOff` only speaks when a VALID licence goes off: a
   * boot that read the licence as off, then failed to renew it, stayed silent
   * while the dispatcher and the routines were down for an hour (TIM-0147).
   * Once per episode; a licence valid again re-arms it.
   */
  const alertStillOff = (cause: string): void => {
    const state = licenseState();
    // No licence is Free, not a failure: nothing to tell anyone.
    if (state.status === 'valid' || state.localFree === true || state.reason === 'build_expired' || alertedStillOff) return;
    alertedStillOff = true;
    const minutes = Math.round((readLicenseStore().every ?? DEFAULT_EVERY_SECONDS) / 60);
    console.warn(`[license] licence still not valid (${state.reason}) and its renewal failed: ${cause}`);
    // Only a locked beta build gets here: an expired licence that fell back
    // to Free keeps every module, and its renewal is retried without a word.
    notify({
      title: 'Licence not renewed',
      body: `Timon could not renew its licence (${cause}); the modules your licence covers stay off until it goes through. It tries again every ${minutes} min.`,
      urgent: true,
      message: daemonMessage('license_not_renewed', { cause, minutes }),
    });
  };

  /**
   * A paid licence whose token expired while the daemon was off, past the
   * offline tolerance, reads as Free at boot. With its activation key still on
   * disk it is still somebody's licence, and a renewal is what brings its
   * rights back, so it is retried like any other (the maintainer's decision,
   * 18/11/2026). The install stays Free meanwhile, without a word.
   *
   * Only an `expired` reading qualifies: the verifier says so only for a token
   * whose signature checked, so never for a retired Free token (read as
   * `missing`). A refusal the server made is persisted against the token and
   * read back with its own reason, `expired` included: that one is checked
   * here, since asking again would get the same answer.
   */
  const expiredPaidLicence = (): boolean => {
    const state = licenseState();
    return state.localFree === true && state.reason === 'expired' && !renewalAbandoned && !installedTokenRefused();
  };

  /**
   * The expired paid licence will not come back on its own: no more requests.
   * The state was already off, so `apply` saw no change; the refusal is now
   * persisted, which turns the lapse from "paused" into "refused": publish,
   * so the card that said "until Timon reaches the server" is replaced.
   */
  const abandonRenewal = (cause: string): void => {
    renewalAbandoned = true;
    console.warn(`[license] the expired licence was not renewed and will not be retried: ${cause}`);
    publish(licenseState());
  };

  const goOff = async (reason: LicenseReason, detail: string): Promise<void> => {
    const was = licenseState();
    await apply(unlicensed(reason));
    if (was.status === 'valid') {
      console.warn(`[license] licence is now off: ${reason} (${detail})`);
      // Fallen back to Free: the bottom-left card says it, once (`paidRightsLapse`).
      if (licenseState().localFree) return;
      notify({
        title: 'Licence is no longer valid',
        body: `${detail}. This beta has no Free tier: Timon is locked until a valid licence is activated; all data is preserved.`,
        urgent: true,
        message: daemonMessage('license_off', { detail }),
      });
    }
  };

  const tolerance = (): { hours: number; until: number | null } => {
    const store = readLicenseStore();
    const hours = store.offlineHours ?? DEFAULT_OFFLINE_HOURS;
    const since = offlineSince ?? (store.lastContact !== undefined ? store.lastContact * 1000 : null);
    return { hours, until: since === null ? null : since + hours * 3_600_000 };
  };

  const rememberRefusal = (reason: 'revoked' | 'expired' | 'deactivated' | 'invalid:machine'): void => {
    try {
      const digest = createHash('sha256').update(readFileSync(LICENSE_FILE, 'utf8').trim()).digest('hex');
      writeLicenseStore({ refusedToken: { digest, reason } });
    } catch (err) {
      console.warn('[license] Could not persist the refused token:', (err as Error).message);
    }
  };

  /**
   * Whether the last renewal failed for want of a network (unreachable, 5xx,
   * unsigned): the only failure the boot retries quickly. A refusal or a 429
   * is an answer, and asking again sooner would not change it.
   */
  let lastOffline = false;

  const tick = async (): Promise<void> => {
    lastOffline = false;
    // No licence in force means no server to ask, unless what is on disk is a
    // paid licence that only expired: that one is renewed, silently.
    const expired = expiredPaidLicence();
    if (licenseState().localFree && !expired) return;
    // A build past its end date needs no answer from the server.
    if (licenseState().reason === 'build_expired') return;
    const key = readLicenseKey();
    // No key: a token installed by hand (`PUT /api/license`) has nothing to
    // renew. It expires on its own; the local tick will say so.
    if (!key) return;
    const revision = licenseRevision();
    try {
      const response = await renew(key, { ...deps.client, allowRotate: false });
      if (revision !== licenseRevision() || key !== readLicenseKey()) return;
      const candidate = installLicenseToken(response.token, undefined, { ...deps.verify, fresh: true, now: new Date(now()), dryRun: true });
      try { assertLicenseCompatible(candidate); }
      catch (err) {
        if (!(err instanceof LicenseCapabilityError)) throw err;
        notify({ title: 'Licence change refused', body: err.message, urgent: true, message: daemonMessage('license_change_refused', { error: err.message }) });
        return;
      }
      const state = installLicenseToken(response.token, undefined, { ...deps.verify, fresh: true, now: new Date(now()) });
      if (state.status === 'unlicensed') {
        // Signed by the server, refused by this daemon: the token is for
        // another machine or another clock. Not offline — a real refusal.
        await goOff(state.reason, `renewed token refused: ${state.reason}`);
        if (expired) abandonRenewal(`renewed token refused: ${state.reason}`);
        return;
      }
      recordServerContact(response.refresh, now());
      offlineSince = null;
      await apply(state);
    } catch (err) {
      if (revision !== licenseRevision() || key !== readLicenseKey()) return;
      const cause = describeRenewFailure(err);
      if (err instanceof LicenseServerError && err.isRefusal) {
        console.warn(`[license] renew failed: ${cause}`);
        if (err.status === 429) { alertStillOff(cause); return; } // rate limited: not an answer about the licence
        if (err.status === 409 && err.code === 'device_mismatch') {
          rememberRefusal('invalid:machine');
          await goOff('invalid:machine', 'another machine holds this device id (device_mismatch)');
          if (expired) abandonRenewal(cause);
          return;
        }
        const reason = refusalReason(err.code);
        if (reason) {
          rememberRefusal(reason);
          await goOff(reason, cause);
          if (expired) abandonRenewal(cause);
          return;
        }
        // A refusal we do not know how to read (400 invalid_request…): change
        // nothing — the local tick keeps the expiry honest.
        alertStillOff(cause);
        return;
      }
      // Unreachable, 5xx, unsigned: offline. The token stays good until the
      // plan's tolerance runs out; the local tick enforces that.
      lastOffline = true;
      // An expired licence has no tolerance left to count nor to warn about:
      // the boot retries and the interval try again, nobody is told.
      if (expired) {
        console.warn(`[license] renewal of the expired licence failed: ${cause}`);
        return;
      }
      if (offlineSince === null) {
        const store = readLicenseStore();
        offlineSince = store.lastContact !== undefined ? store.lastContact * 1000 : now();
      }
      const current = licenseState();
      if (current.status === 'valid') {
        await apply({ ...current, offlineSince: new Date(offlineSince).toISOString() });
      }
      // A passing outage: the paid rights hold for the tolerance, nobody is
      // told. The log keeps the trace.
      const { until } = tolerance();
      const left = until === null ? null : Math.max(0, Math.round((until - now()) / 3_600_000));
      console.warn(`[license] renew failed: ${cause}; offline since ${new Date(offlineSince).toISOString()}${left === null ? '' : `, about ${left} h of tolerance left`}`);
      alertStillOff(cause);
    }
  };

  const localTick = async (): Promise<void> => {
    // First: a build can end while its licence is perfectly valid.
    const built = licenseState();
    if (reevaluateBuildPolicy(now())) await announce(built, licenseState());
    const current = licenseState();
    if (current.status !== 'valid') return;
    if (!existsSync(LICENSE_FILE)) {
      await goOff('missing', 'license file is missing');
      return;
    }
    let token: string;
    try { token = readFileSync(LICENSE_FILE, 'utf8'); } catch {
      await goOff('invalid:format', 'license file cannot be read');
      return;
    }
    const state = verifyLicenseToken(token, { device: deviceId(), ...deps.verify, now: new Date(now()) });
    if (state.status === 'valid') return;
    if (state.reason === 'expired') {
      const { until } = tolerance();
      if (!fixedComposition(current) && until !== null && now() <= until) return; // within the offline tolerance
      await goOff('expired', until === null ? 'token expired and never renewed' : 'token expired and the offline tolerance ran out');
      return;
    }
    // Unable to READ the machine id is not a verdict on the token: the next
    // tick tries again (TIM-0024). A fingerprint that reads and differs is.
    if (state.reason === 'invalid:fingerprint' && !(deps.fingerprintReadable ?? fingerprintReadable)()) {
      console.warn('[license] machine id unreadable for now; licence left as is');
      return;
    }
    await goOff(state.reason, `token no longer verifies: ${state.reason}`);
  };

  if (deps.manual) return { tick, localTick, stop: () => undefined };
  const store = readLicenseStore();
  const every = (store.every ?? DEFAULT_EVERY_SECONDS) * 1000;
  const network = setInterval(() => { void tick(); }, every);
  const local = setInterval(() => { void localTick(); }, LOCAL_TICK_MS);
  network.unref();
  local.unref();
  // First refresh right away: a daemon that was down for a while must not wait
  // five minutes to learn its licence was revoked — or renewed. At boot the
  // network is often not up yet (a machine just woken, Wi-Fi still joining):
  // a licence read as off then kept its modules off for a whole interval
  // (TIM-0147), so a failure for want of a network is retried a few times
  // sooner before the interval takes over.
  const retries = deps.bootRetryMs ?? BOOT_RETRY_MS;
  let stopped = false;
  let bootRetry: NodeJS.Timeout | null = null;
  const bootTick = async (attempt: number, elapsed: number): Promise<void> => {
    await tick();
    const delay = retries[attempt];
    if (stopped || !lastOffline || delay === undefined || elapsed + delay >= every) return;
    bootRetry = setTimeout(() => { bootRetry = null; void bootTick(attempt + 1, elapsed + delay); }, delay);
    bootRetry.unref();
  };
  void bootTick(0, 0);

  return {
    tick,
    localTick,
    stop() {
      stopped = true;
      clearInterval(network);
      clearInterval(local);
      if (bootRetry) clearTimeout(bootRetry);
      bootRetry = null;
    },
  };
}

/**
 * Paid rights a build that falls back to Free has really lost, as the web app
 * must say it: `offline` when the tolerance ran out without an answer from the
 * server (a renewal brings them back), `refused` when the server refused the
 * licence for good (revoked, expired, deactivated, unknown key) or the token
 * is for another device. `null` for everything else: a licence in force (an
 * outage within the tolerance included), a beta build (its lock screen
 * speaks), and Free — no activation key on disk, whatever happened before.
 *
 * `since` is the last successful contact with the server, the episode's
 * mark: a renewal moves it, so a later lapse is a new card, while a restart
 * keeps the same one (closed stays closed).
 */
export type PaidRightsLapse = { cause: 'offline' | 'refused'; since: string | null };

export function paidRightsLapse(state: LicenseState): PaidRightsLapse | null {
  if (state.status === 'valid' || state.localFree !== true) return null;
  if (readLicenseKey() === null || !existsSync(LICENSE_FILE)) return null;
  const lastContact = readLicenseStore().lastContact;
  const since = lastContact === undefined ? null : new Date(lastContact * 1000).toISOString();
  if (installedTokenRefused()) return { cause: 'refused', since };
  if (state.reason === 'expired') return { cause: 'offline', since };
  if (state.reason === 'invalid:machine' || state.reason === 'invalid:fingerprint') return { cause: 'refused', since };
  return null;
}

/** Whether the server already refused the token on disk (persisted by `rememberRefusal`). */
function installedTokenRefused(): boolean {
  const refused = readLicenseStore().refusedToken;
  if (!refused) return false;
  try { return refused.digest === createHash('sha256').update(readFileSync(LICENSE_FILE, 'utf8').trim()).digest('hex'); }
  catch { return true; } // no token left: nothing to renew
}

function defaultNotify(n: { title: string; body: string; urgent: boolean; message?: DaemonMessage }): void {
  void import('../notifications.js').then(({ createNotification }) => {
    createNotification({
      type: 'alert', urgent: n.urgent, title: n.title, body: n.body, source: 'license', anchor: LICENSE_ALERT_ANCHOR, message: n.message,
    });
  }).catch(() => { /* notifications unavailable: the log already said it */ });
}
