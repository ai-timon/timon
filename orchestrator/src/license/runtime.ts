import { applyBuildPolicy } from './build-policy.js';
import { forgetVerifiedLicenses, isVerifiedLicense, readLicense, unlicensed, type LicenseState } from './license.js';
import { underTestRunner } from './test-runner.js';

let revision = 0;
export const licenseRevision = (): number => revision;

/** What the licence says, before the build's channel has its word. */
let raw: LicenseState = unlicensed('missing');
let current: LicenseState = raw;
let initialized = false;

const copy = (state: LicenseState): LicenseState => ({
  ...state,
  ...(state.capabilities ? { capabilities: { ...state.capabilities } } : {}),
  modules: state.modules === '*' ? '*' : [...state.modules],
  plugins: state.plugins === '*' ? '*' : [...state.plugins],
  ...(state.features ? { features: [...state.features] } : {}),
});

/**
 * What `setLicenseState` must refuse: a state that grants paid rights the
 * verifier did not issue against the pinned keyring. Taking rights away is
 * never refused — `unlicensed(...)` is how the daemon turns a licence off.
 * Under the test runner anything goes: tests install paid states by hand
 * (`tests/helpers/paid-license.ts`).
 */
export function unverifiedGrant(state: LicenseState, underTest: boolean = underTestRunner()): boolean {
  if (underTest) return false;
  if (state.status !== 'valid' || state.planId === 'free') return false;
  return !isVerifiedLicense(state);
}

/**
 * The single setter of the licence in force. Exported because the boot, the
 * licence routes and the refresh loop all call it — which also puts it within
 * reach of a plugin importing the build, hence the refusal above. `nowMs` is
 * the clock the build's end is judged against; tests move it.
 */
export function setLicenseState(state: LicenseState, nowMs: number = Date.now()): void {
  if (unverifiedGrant(state)) {
    throw new Error('setLicenseState refuses a licence the pinned keyring did not verify: outside the test runner, only a state issued by verifyLicenseToken can grant rights.');
  }
  revision++;
  initialized = true;
  if (state.status !== 'valid' || state.planId === 'free') state = unlicensed(state.planId === 'free' && state.status === 'valid' ? 'missing' : state.reason);
  if (state.status === 'valid') state = { ...state, localFree: false };
  else forgetVerifiedLicenses();
  raw = copy(state);
  current = copy(applyBuildPolicy(raw, { nowMs }));
}

/**
 * Judges the stored licence against the build again. The build's end date can
 * pass while the daemon runs with a perfectly valid licence: nothing calls
 * `setLicenseState` then, so the local tick (and the HTTP guard) call this.
 * `true` when the effective state changed.
 */
export function reevaluateBuildPolicy(nowMs: number = Date.now()): boolean {
  const next = applyBuildPolicy(raw, { nowMs });
  if (next.status === current.status && next.reason === current.reason && next.localFree === current.localFree) return false;
  current = copy(next);
  return true;
}

export function licenseState(): LicenseState { return copy(current); }

/** Local CLI processes have no boot; the installed signed receipt still applies. */
export function mutationLicenseState(): LicenseState {
  return initialized ? licenseState() : applyBuildPolicy(readLicense());
}
