/**
 * `~/.timon/license.state.json` — everything the daemon must remember about
 * its licence besides the token itself (SECU-LICENCES L-1, L-5, L-7):
 *
 *   - `every` / `offlineHours`: the refresh schedule the SERVER announced on
 *     activation (`refresh` of §5.1). Never hard-coded: the server may tighten
 *     or loosen it per plan without shipping a daemon.
 *   - `lastContact`: last successful `activate` / `renew`, Unix seconds. The
 *     offline tolerance counts from here, and survives a restart with it.
 *   - `maxSrv`: highest server clock ever accepted. A token whose `srv` is
 *     below it was issued BEFORE one we already trusted: either a replay or a
 *     local clock wound back to resurrect an old token (L-5).
 *   - `lastSeen`: highest local clock ever observed. A boot whose clock is a
 *     day behind it is a wound-back clock, not a drift.
 *   - `clockHigh`: highest local clock a BETA build ever judged its own end
 *     date against (`build-policy.ts`), written on every evaluation rather
 *     than on token acceptance like `lastSeen`. A build that has seen its
 *     `expiresAt` stays expired when the clock is wound back afterwards.
 *   - `machineName` / `machineNameLocked`: the name this install gave itself
 *     (§5.10). Remembered HERE because nowhere else carries it: the name is
 *     not a token claim, and `409 name_locked` sends no name back. So the
 *     daemon knows the name only from its own accepted write, and knows
 *     "already named, by someone else" only from that 409 — two states worth
 *     telling apart, since the second must not offer a field that would fail.
 *   - `machineNameLicense`: the `lic` the name was recorded under. Kept next
 *     to the name rather than read from the live state, because the live state
 *     is `expired` exactly when someone hand-installs a fresher token — the
 *     moment we most need to answer "same licence, or another one?".
 *
 * Written atomically and durably (`writeFileDurably`) like the token; `0600`;
 * zone `secrets`.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { LICENSE_STATE_FILE } from '../paths.js';

const Schema = z.object({
  refusedToken: z.object({ digest: z.string(), reason: z.enum(['revoked', 'expired', 'deactivated', 'invalid:machine']) }).optional(),
  every: z.number().int().positive().optional(),
  offlineHours: z.number().nonnegative().optional(),
  lastContact: z.number().int().nonnegative().optional(),
  maxSrv: z.number().int().nonnegative().optional(),
  lastSeen: z.number().int().nonnegative().optional(),
  clockHigh: z.number().int().nonnegative().optional(),
  machineName: z.string().nullable().optional(),
  machineNameLocked: z.boolean().optional(),
  machineNameLicense: z.string().nullable().optional(),
});
export type LicenseStore = z.infer<typeof Schema>;

/**
 * `tmp` + `rename` alone is atomic for the processes reading the file, not for
 * a power cut: the rename can reach the disk before the data it points to, and
 * a hard reset then leaves an EMPTY file where the old one was (TIM-0147). The
 * data is flushed before the rename, the directory entry after it.
 */
export function writeFileDurably(file: string, content: string, mode = 0o600): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = openSync(tmp, 'w', mode);
  try {
    writeFileSync(fd, content);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, file);
  syncDirectory(dirname(file));
}

/** Best effort: Windows cannot open a directory, and NTFS journals the rename itself. */
function syncDirectory(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, 'r');
    fsyncSync(fd);
  } catch { /* not supported on this system: the file data is already on disk */ }
  finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* already closed */ }
    }
  }
}

/**
 * True when the file exists but cannot be read back: empty, cut short, not the
 * expected shape. `readLicenseStore` hides that case on purpose (the boot must
 * go on); the boot asks here to know its anchors were lost rather than never set.
 */
export function licenseStoreDamaged(file = LICENSE_STATE_FILE): boolean {
  if (!existsSync(file)) return false;
  try {
    Schema.parse(JSON.parse(readFileSync(file, 'utf8')) as unknown);
    return false;
  } catch {
    return true;
  }
}

export function readLicenseStore(file = LICENSE_STATE_FILE): LicenseStore {
  if (!existsSync(file)) return {};
  try { return Schema.parse(JSON.parse(readFileSync(file, 'utf8')) as unknown); }
  // A corrupt file must not brick the boot: the anchors restart from zero,
  // which is exactly what a fresh install has.
  catch { return {}; }
}

export function writeLicenseStore(patch: LicenseStore, file = LICENSE_STATE_FILE): LicenseStore {
  const next = { ...readLicenseStore(file), ...patch };
  writeFileDurably(file, JSON.stringify(next) + '\n');
  return next;
}

/**
 * Drops what this install knew about its machine name. Called when the licence
 * it belonged to leaves (a release, a replacement): the name lives on the
 * ACTIVATION of one licence, so keeping it would label a machine with the name
 * of a licence it no longer holds.
 */
export function forgetMachineName(file = LICENSE_STATE_FILE): void {
  writeLicenseStore({ machineName: null, machineNameLocked: false, machineNameLicense: null }, file);
}

/**
 * The two clock anchors as one object, so `verifyLicenseToken` can be handed
 * a fake one in tests and the production one everywhere else.
 */
export type ClockAnchor = {
  /** `null` when the token is acceptable, a reason otherwise. */
  check(srv: number, now: number): 'rollback' | null;
  /** Records a token we accepted. Monotonic on both axes. */
  commit(srv: number, now: number): void;
};

/** A wound-back clock is one behind the last instant seen by more than this.
 *  Generous on purpose: a real drift is seconds, a `faketime` is months. */
const LOCAL_ROLLBACK_SECONDS = 24 * 3600;
/** Same 60 s the token guards use: two servers a minute apart are one clock. */
const SRV_SKEW_SECONDS = 60;

export function fileClockAnchor(file = LICENSE_STATE_FILE): ClockAnchor {
  return {
    check(srv, now) {
      const store = readLicenseStore(file);
      if (store.maxSrv !== undefined && srv < store.maxSrv - SRV_SKEW_SECONDS) return 'rollback';
      if (store.lastSeen !== undefined && now < store.lastSeen - LOCAL_ROLLBACK_SECONDS) return 'rollback';
      return null;
    },
    commit(srv, now) {
      const store = readLicenseStore(file);
      const patch: LicenseStore = {};
      if (store.maxSrv === undefined || srv > store.maxSrv) patch.maxSrv = srv;
      if (store.lastSeen === undefined || now > store.lastSeen) patch.lastSeen = now;
      if (Object.keys(patch).length) writeLicenseStore(patch, file);
    },
  };
}
