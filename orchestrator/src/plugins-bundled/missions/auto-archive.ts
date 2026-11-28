/**
 * Scheduled archiving of finished conversations (`TIMON_MISSIONS_AUTO_ARCHIVE_DAYS`,
 * off by default). Archiving only flags the row, so the sweep is cheap, safe to
 * repeat and reversible: any user message unarchives the mission.
 */
import { dbApi } from '../../db.js';
import { pendingPermissionSummary } from '../../permissions.js';
import { settingInt } from '../../settings.js';

const DAY = 86_400_000;
/** Missions archived per pass at most; the next hourly pass takes the rest. */
export const AUTO_ARCHIVE_BATCH = 200;
/** Candidates read per query: pending cards are filtered afterwards, so a page can hold fewer usable rows. */
const PAGE = 200;

export type AutoArchiveOptions = { now?: number; days?: number; batch?: number };

/** True when the mission waits on a permission card or a command request the owner has not decided. */
function waitsOnUser(missionId: string): boolean {
  if (pendingPermissionSummary(missionId)) return true;
  const owner = dbApi.getMission(missionId)?.owner_user_id;
  if (!owner) return false;
  return dbApi.listCommandRequests({ ownerUserId: owner, missionId, status: 'pending' }).length > 0;
}

/** One pass. Returns how many missions were archived. */
export function autoArchiveOnce(opts: AutoArchiveOptions = {}): number {
  const { now = Date.now(), batch = AUTO_ARCHIVE_BATCH } = opts;
  const days = opts.days ?? settingInt('TIMON_MISSIONS_AUTO_ARCHIVE_DAYS');
  if (days <= 0) return 0;
  const cutoff = now - days * DAY;
  let archived = 0;
  let after = 0;
  while (archived < batch) {
    const page = dbApi.listAutoArchiveCandidates(cutoff, after, PAGE);
    if (!page.length) break;
    for (const mission of page) {
      after = mission.rowid;
      if (archived >= batch) break;
      if (waitsOnUser(mission.id)) continue;
      if (dbApi.archiveMission(mission.id, 'auto') === 'archived') archived += 1;
    }
  }
  return archived;
}

/** Hourly-sweep entry point: never throws, logs counts only. */
export function runAutoArchive(): void {
  try {
    const archived = autoArchiveOnce();
    if (archived > 0) console.log(`[missions] ${archived} finished conversation(s) auto-archived`);
  } catch (err) {
    console.warn(`[missions] auto-archive failed: ${(err as Error).message}`);
  }
}
