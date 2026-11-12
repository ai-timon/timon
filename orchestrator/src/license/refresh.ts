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
 * the bundled reconciler and the plugin loader follow without a restart; the
 * superadmin is notified once per offline episode at half the tolerance, and
 * once when the licence goes off.
 *
 * Logs carry the `status` and the reason, NEVER the token nor the key.
 */
import { fingerprintReadable } from './fingerprint.js';
import { assertLicenseCompatible } from './compliance.js';
import { LicenseCapabilityError } from './capabilities.js';
import { fixedComposition } from './capabilities.js';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Application } from 'express';
import { bus } from '../bus.js';
import { LICENSE_FILE, LICENSE_KEY_FILE } from '../paths.js';
import { deviceId } from './device.js';
import { LicenseServerError, renew, type ClientOptions } from './client.js';
import { installLicenseToken, readLicense, unlicensed, verifyLicenseToken, type LicenseReason, type LicenseState, type VerifyOptions } from './license.js';
import { licenseRevision, licenseState, reevaluateBuildPolicy, setLicenseState } from './runtime.js';
import { readLicenseStore, writeLicenseStore } from './store.js';

/** §5.1 defaults, used only until the server has announced its own. */
const DEFAULT_EVERY_SECONDS = 300;
const DEFAULT_OFFLINE_HOURS = 24;
const LOCAL_TICK_MS = 60_000;

// ── Persistence of the activation key ───────────────────────────────────────

export function readLicenseKey(file = LICENSE_KEY_FILE): string | null {
  try {
    const key = readFileSync(file, 'utf8').trim();
    return key === '' ? null : key;
  } catch { return null; }
}

export function writeLicenseKey(key: string, file = LICENSE_KEY_FILE): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, key.trim() + '\n', { mode: 0o600 });
  renameSync(tmp, file);
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
  const store = readLicenseStore();
  const graceUntil = store.lastContact === undefined
    ? undefined
    : store.lastContact + (store.offlineHours ?? DEFAULT_OFFLINE_HOURS) * 3600;
  const state = readLicense(undefined, { device: deviceId(), graceUntil, ...opts });
  if (state.status === 'valid' && state.expiresAt && Date.parse(state.expiresAt) < (opts.now ?? new Date()).getTime() && store.lastContact !== undefined) {
    return { ...state, offlineSince: new Date(store.lastContact * 1000).toISOString() };
  }
  return state;
}

// ── The loop ────────────────────────────────────────────────────────────────

export type RefreshDeps = {
  app: Pick<Application, 'get'> | null;
  client?: ClientOptions;
  verify?: VerifyOptions;
  now?: () => number;
  /** `applyLicensedSurfaces` — injected to keep this module free of the router. */
  recompose?: (app: Pick<Application, 'get'>) => Promise<void>;
  notify?: (n: { title: string; body: string; urgent: boolean }) => void;
  /** Tests: no timers, no first tick — the test drives `tick()` / `localTick()`. */
  manual?: boolean;
  /** Tests: whether the machine id can be read right now. */
  fingerprintReadable?: () => boolean;
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
  let warnedOffline = false;

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
      notify({ title: 'This Timon beta build has expired', body: 'Install the current beta build to keep working. Your data is preserved.', urgent: true });
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
    await announce(before, licenseState());
  };

  const goOff = async (reason: LicenseReason, detail: string): Promise<void> => {
    const was = licenseState();
    await apply(unlicensed(reason));
    if (was.status === 'valid') {
      console.warn(`[license] licence is now off: ${reason} (${detail})`);
      const body = licenseState().localFree
        ? `${detail}. Timon now uses local Free rights. Extra modules and plugins are suspended; all data is preserved.`
        : `${detail}. This beta has no Free tier: Timon is locked until a valid licence is activated; all data is preserved.`;
      notify({ title: 'Licence is no longer valid', body, urgent: true });
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

  const tick = async (): Promise<void> => {
    // Free never contacts the issuer, including installations retaining an old key.
    if (licenseState().localFree || licenseState().planId === 'free') return;
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
        notify({ title: 'Licence change refused', body: err.message, urgent: true });
        return;
      }
      const state = installLicenseToken(response.token, undefined, { ...deps.verify, fresh: true, now: new Date(now()) });
      if (state.status === 'unlicensed') {
        // Signed by the server, refused by this daemon: the token is for
        // another machine or another clock. Not offline — a real refusal.
        await goOff(state.reason, `renewed token refused: ${state.reason}`);
        return;
      }
      recordServerContact(response.refresh, now());
      offlineSince = null;
      warnedOffline = false;
      await apply(state);
    } catch (err) {
      if (revision !== licenseRevision() || key !== readLicenseKey()) return;
      if (err instanceof LicenseServerError && err.isRefusal) {
        if (err.status === 429) return; // rate limited: not an answer about the licence
        if (err.status === 409 && err.code === 'device_mismatch') {
          rememberRefusal('invalid:machine');
          await goOff('invalid:machine', 'another machine holds this device id (device_mismatch)');
          return;
        }
        const reason = refusalReason(err.code);
        if (reason) { rememberRefusal(reason); await goOff(reason, `license server answered ${err.status} ${err.code}`); return; }
        // A refusal we do not know how to read (400 invalid_request…): log,
        // change nothing — the local tick keeps the expiry honest.
        console.warn(`[license] renew refused: ${err.status} ${err.code}`);
        return;
      }
      // Unreachable, 5xx, unsigned: offline. The token stays good until the
      // plan's tolerance runs out; the local tick enforces that.
      if (offlineSince === null) {
        const store = readLicenseStore();
        offlineSince = store.lastContact !== undefined ? store.lastContact * 1000 : now();
      }
      const current = licenseState();
      if (current.status === 'valid') {
        await apply({ ...current, offlineSince: new Date(offlineSince).toISOString() });
      }
      const { hours, until } = tolerance();
      if (!warnedOffline && until !== null && now() >= offlineSince + (hours * 3_600_000) / 2) {
        warnedOffline = true;
        const left = Math.max(0, Math.round((until - now()) / 3_600_000));
        notify({ title: 'Licence server unreachable', body: `No contact since ${new Date(offlineSince).toISOString()}. The licence stays valid for about ${left} h more.`, urgent: false });
      }
      console.warn(`[license] renew failed (${(err as Error).message}); offline since ${new Date(offlineSince).toISOString()}`);
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
  // five minutes to learn its licence was revoked — or renewed.
  void tick();

  return {
    tick,
    localTick,
    stop() { clearInterval(network); clearInterval(local); },
  };
}

function defaultNotify(n: { title: string; body: string; urgent: boolean }): void {
  void import('../notifications.js').then(({ createNotification }) => {
    createNotification({ type: 'alert', urgent: n.urgent, title: n.title, body: n.body, source: 'license', anchor: LICENSE_ALERT_ANCHOR });
  }).catch(() => { /* notifications unavailable: the log already said it */ });
}
