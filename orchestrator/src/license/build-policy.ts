import { buildInfo, type BuildInfo } from '../build-info.js';
import { setupPolicy } from '../users/setup-policy.js';
import type { LicenseReason, LicenseState } from './license.js';
import { readLicenseStore, writeLicenseStore } from './store.js';

/**
 * What a build's CHANNEL does to the licence state (beta build separation,
 * decision of 30/09/2026). Applied by `runtime.ts` to every state the daemon
 * stores, so no path — boot, renewal, route, deactivation — can skip it.
 *
 * Only a `beta` build is touched. `stable` and `dev` (the repository, the
 * sandbox, the tests) keep `unlicensed()` exactly as it is: local Free.
 *
 * Under the `free` setup policy (the product since 04/11/2026), a beta build
 * keeps Free too: the first account is created without a key, so locking the
 * install until one is entered would lock everybody out. Only the build's own
 * `expiresAt` still stops it — that is the build's lifetime, not a licence.
 *
 * Under the `beta` setup policy, Free does not exist on a beta build, not even
 * when the licence ends:
 *   - the build's own `expiresAt` passed → `build_expired`, whatever the
 *     licence says, and whether or not the server can be reached;
 *   - any other state that is not `valid` → locked, never Free. A licence that
 *     expired, was revoked or deactivated reads `beta_ended`; the rest keeps
 *     its own reason (`missing`, `invalid:machine`…) because that is what the
 *     person has to fix. Without this, deleting `license.json` would bring
 *     Free back.
 */
const ENDED: readonly LicenseReason[] = ['expired', 'revoked', 'deactivated'];

/**
 * The locked state reuses the fixed-composition machinery Free already goes
 * through, with no module and no plugin: non-core modules switch off, their
 * routes answer 403, and `assertLicensedExecution` refuses every agent turn —
 * including the ones the daemon starts on its own (routines, dispatcher).
 * `localFree` is false: this is not a lesser licence, it is none.
 */
export function betaLocked(reason: LicenseReason): LicenseState {
  return {
    status: 'unlicensed', reason, edition: 'lite', plan: null, lifetime: false,
    localFree: false, modules: [], plugins: [], features: [], users: 0,
    capabilities: { version: 1, plugins: 'fixed', accounts: 'single-superadmin' },
    expiresAt: null, subscriptionExpiresAt: null, paymentStatus: 'active', offlineSince: null,
  };
}

export type BuildClock = { info?: BuildInfo; nowMs?: number };

/** The high-water mark is rewritten at most this often: boot and every local tick. */
const CLOCK_WRITE_STEP_SECONDS = 60;

/**
 * The instant the build's end is judged against: never earlier than anything
 * this install has already seen, so winding the clock back does not bring an
 * expired build back.
 *   - the persisted high-water mark of the local clock (`clockHigh`), which is
 *     advanced here;
 *   - the licence server's time (`maxSrv`, the `srv` of the last token it
 *     signed) — the one clock the user does not control — and `lastSeen`;
 *   - the build's own `builtAt`: a clock before the build was made is wrong.
 * Deleting `license.state.json` resets the first two; `builtAt` still bounds
 * the damage, and the file is part of the secrets zone.
 */
export function effectiveNowMs(info: BuildInfo, nowMs: number): number {
  const store = readLicenseStore();
  const nowSeconds = Math.floor(nowMs / 1000);
  if (nowSeconds >= (store.clockHigh ?? 0) + CLOCK_WRITE_STEP_SECONDS) {
    try { writeLicenseStore({ clockHigh: nowSeconds }); }
    catch (err) { console.warn('[license] could not persist the clock high-water mark:', (err as Error).message); }
  }
  const seen = Math.max(store.clockHigh ?? 0, store.maxSrv ?? 0, store.lastSeen ?? 0) * 1000;
  return Math.max(nowMs, seen, info.builtAtMs ?? 0);
}

export function buildExpired(info: BuildInfo, nowMs: number): boolean {
  return info.expiresAtMs !== null && effectiveNowMs(info, nowMs) >= info.expiresAtMs;
}

export function applyBuildPolicy(state: LicenseState, clock: BuildClock = {}): LicenseState {
  const info = clock.info ?? buildInfo();
  if (info.channel !== 'beta') return state;
  if (buildExpired(info, clock.nowMs ?? Date.now())) return betaLocked('build_expired');
  if (state.status === 'valid' || setupPolicy() === 'free') return state;
  return betaLocked(state.reason !== null && ENDED.includes(state.reason) ? 'beta_ended' : state.reason);
}

/** Whether the build on this machine is a beta one. */
export const isBetaBuild = (info: BuildInfo = buildInfo()): boolean => info.channel === 'beta';
