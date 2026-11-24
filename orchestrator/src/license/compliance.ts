import { existsSync, readFileSync } from 'node:fs';
import { CONFIG_FILE } from '../config/load.js';
import { canonicalizeIds, isRetiredModuleId } from '../kernel/legacy-ids.js';
import { dbApi } from '../db.js';
import { installedPackages } from '../plugins/loader.js';
import { fixedComposition, singleSuperadmin, compositionWritePending, LicenseCapabilityError } from './capabilities.js';
import type { LicenseState } from './license.js';

/** A refused downgrade leaves accounts, plugin data and the old token intact. */
export function assertLicenseCompatible(next: LicenseState): void {
  if (next.status !== 'valid') return;
  const problems: string[] = [];
  if (singleSuperadmin(next)) {
    const users = dbApi.listUsers().filter((u) => u.status !== 'disabled');
    if (users.length > 1 || users.some((u) => !u.is_superadmin || u.status !== 'active')) {
      problems.push('Keep exactly one active superadmin; disable the other accounts before switching (their data will be preserved).');
    }
  }
  if (fixedComposition(next)) {
    if (compositionWritePending()) problems.push('Wait for the ongoing plugin operation to finish before switching.');
    if (installedPackages().length) problems.push('Remove external plugins before switching; keep their data directories.');
    if (existsSync(CONFIG_FILE)) {
      const cfg = JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { modules?: Record<string, unknown> };
      for (const [id, setting] of Object.entries(canonicalizeIds(cfg.modules ?? {}))) {
        // A module the product no longer ships cannot run either way: its key is not an override to reset.
        if (isRetiredModuleId(id)) continue;
        const wanted = typeof setting === 'object' && setting !== null ? (setting as { enabled?: unknown }).enabled : setting;
        const included = next.modules !== '*' && next.modules.includes(id);
        if ((wanted === true && !included) || (wanted === false && included)) {
          problems.push(`Reset the explicit activation override for ${id} before switching.`);
        }
      }
    }
  }
  if (problems.length) throw new LicenseCapabilityError('free_incompatible', problems.join(' '));
}
