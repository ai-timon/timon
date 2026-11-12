import { fixedComposition, licenseCurrentlyValid } from '../license/capabilities.js';
import type { LicenseState } from '../license/license.js';
import { mutationLicenseState } from '../license/runtime.js';
import { pemFromJwkX } from '../license/pubkey.js';

/** Third-party plugin admission keys. The private key never lives here. */
export type PluginPublicKey = {
  keyId: string;
  publicKey: string;
  /** ISO-8601 date: the key is no longer accepted from this instant on. */
  expiresAt?: string;
};

/**
 * Rotation registry, separate from the licence keyring: a leaked plugin key
 * must not mint licences, nor the reverse. The literal is the raw JWK `x`
 * (base64url) so a diff shows exactly which key changed, and it must stay
 * identical to the one the site publishes in the static JWKS at
 * `https://timon-ai.com/.well-known/timon-plugin-keys.json` (same model as
 * the licence keys in `license/pubkey.ts`). Rotation adds a new
 * entry and sets `expiresAt` on the old one — never an edit in place, which
 * would orphan every package already signed (`docs/PLUGINS.md`, signing key
 * section).
 */
export const PLUGIN_PUBLIC_KEYS: readonly PluginPublicKey[] = [
  {
    keyId: 'timon-plugins-2026-11',
    publicKey: pemFromJwkX('PgAMt3tfQQkCaqDvx4oLdQ5ulPnepeg1XJR4C_NZ-UQ'),
  },
];

/**
 * Is unsigned third-party code admitted?
 *
 * **Only when the owner switched developer mode on, on an install whose rights
 * are in force, and never under a fixed composition.** Rights in force means a
 * valid paid licence OR the local Free tier (`licenseCurrentlyValid`): Free is
 * `unlicensed` + `localFree`, never `valid`, so a `status === 'valid'` test
 * shut every Free user out of the plugins they write themselves, against the
 * promise that Free includes every feature (decision of the maintainer,
 * 10/11/2026, amending the one of 04/09/2026, step 5.9.3; plan §10 carries
 * both, dated).
 *
 * Why this does not reopen what 04/09/2026 closed: on the first real launch
 * `PLUGIN_PUBLIC_KEYS` was empty, so an unset setting resolved to `true` and an
 * install nobody had activated loaded arbitrary unsigned code — a developer
 * mode that opened itself. Since the first production key (2026-11-02) an
 * unset setting resolves closed, so the mode now opens only when the owner
 * writes `developer.unsignedPlugins: true` themselves; `false` closes it.
 *
 * Still refused, whatever the setting: a fixed composition, which a paid offer
 * may carry and the locked beta state (`betaLocked`) always does. A tampered
 * package (a SIGNATURE that does not verify) is refused by the loader before
 * this question is asked.
 *
 * With no key in the registry an unset setting resolves open: a strict default
 * would then mean "no third-party plugin ever loads", a dead feature rather
 * than a security posture.
 *
 * ONE state answers both questions: `mutationLicenseState()`, which is the
 * daemon's state once booted and the installed receipt under the build policy
 * in a CLI process that never booted (`timon plugin add`).
 */
export function unsignedPluginsAllowed(
  setting: boolean | undefined,
  opts: { keys?: readonly PluginPublicKey[]; state?: LicenseState } = {},
): boolean {
  const { keys = PLUGIN_PUBLIC_KEYS, state = mutationLicenseState() } = opts;
  if (!licenseCurrentlyValid(state) || fixedComposition(state)) return false;
  return setting ?? keys.length === 0;
}
