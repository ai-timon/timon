import { z } from 'zod';
import type { LicenseState } from './license.js';

/** Optional signed extension to v4. Absence preserves existing paid grants. */
export const CommercialCapabilitiesSchema = z.object({
  version: z.literal(1),
  plugins: z.enum(['fixed', 'extensible']),
  accounts: z.enum(['single-superadmin', 'standard']),
}).strict();
export type CommercialCapabilities = z.infer<typeof CommercialCapabilitiesSchema>;

export function fixedComposition(state: LicenseState): boolean {
  return state.capabilities?.plugins === 'fixed';
}
/** The exact `features` entry that unlocks replacing the whole interface. */
export const WHITE_LABEL_FEATURE = 'whitelabel';

/**
 * May a plugin replace the whole interface (slot `root`)? Only a valid paid
 * licence whose signed `features` names the right exactly. Free never has it,
 * even when a Free token carried the string: the schema accepts any
 * `features` on Free, so the refusal has to live here. Nor does a beta-locked
 * install (`features: []`). No plan id grants it by name: the server decides,
 * through the claim, which plans include it.
 */
export function whiteLabelAllowed(state: LicenseState): boolean {
  return state.status === 'valid' && state.localFree !== true && state.planId !== 'free'
    && state.features?.includes(WHITE_LABEL_FEATURE) === true;
}

export function singleSuperadmin(state: LicenseState): boolean {
  return state.capabilities?.accounts === 'single-superadmin';
}

export class LicenseCapabilityError extends Error {
  constructor(readonly code: 'plugin_composition_fixed' | 'single_superadmin_required' | 'user_limit' | 'free_incompatible' | 'free_account_restricted' | 'license_required', message: string) {
    super(message);
    this.name = 'LicenseCapabilityError';
  }
}

export function assertCompositionMutable(state: LicenseState): void {
  if (fixedComposition(state)) throw new LicenseCapabilityError('plugin_composition_fixed',
    'This licence includes a fixed plugin composition. Configure the included plugins or upgrade your plan to change it.');
}

/** Called inside the same database transaction as the resulting row write. */
export function assertAccountWrite(state: LicenseState, input: { isSuperadmin: boolean; status: string }, count: number, adding: boolean): void {
  if (singleSuperadmin(state) && (adding || input.status !== 'disabled') && !input.isSuperadmin) {
    throw new LicenseCapabilityError('single_superadmin_required', 'This licence requires a single superadmin account.');
  }
  const limit = singleSuperadmin(state) ? 1 : state.users;
  if (adding && (singleSuperadmin(state) || input.status !== 'disabled') && limit !== null && count >= limit) {
    throw new LicenseCapabilityError('user_limit', `This licence allows ${limit} user profile(s) on this machine (${count} in use).`);
  }
}

export function licenseCurrentlyValid(state: LicenseState, now = Date.now()): boolean {
  return state.localFree === true || state.status === 'valid' && (!fixedComposition(state) ||
    (state.expiresAt !== null && now <= Date.parse(state.expiresAt) + 60_000));
}
export function assertLicensedExecution(state: LicenseState): void {
  if (fixedComposition(state) && !licenseCurrentlyValid(state)) {
    throw new LicenseCapabilityError('license_required', 'Activate or renew your licence before starting another agent turn.');
  }
}

let compositionWrites = 0;
export const compositionWritePending = (): boolean => compositionWrites > 0;
export async function withCompositionWrite<T>(state: LicenseState, operation: () => Promise<T>): Promise<T> {
  assertCompositionMutable(state);
  compositionWrites++;
  try { return await operation(); }
  finally { compositionWrites--; }
}
