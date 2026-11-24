/**
 * Cold archive of the events — disabled by default.
 *
 * The `events` table carries most of the weight of `timon.db` (1.8 GB on the maintainer's install
 * for 12 MB for everything else), which makes the installation impossible to
 * move and the export endless. Past `TIMON_EVENTS_HOT_DAYS` days, the
 * rows migrate to `~/.timon/archive/events.db`, attached to the connection:
 * they stay readable (`dbApi.listEvents` reads both tables), but no longer
 * weigh on the hot database or on the backups.
 *
 * Default `0` = inert function. Nobody loses history without having
 * asked for it; it is an operations setting, not a default behaviour.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TIMON_HOME } from './paths.js';
import { db, dbApi, attachEventsArchive } from './db.js';
import { settingInt } from './settings.js';
import { runDataRetention } from './data-retention.js';

export const EVENTS_ARCHIVE_PATH = join(TIMON_HOME, 'archive', 'events.db');

/** Size of a batch. Big enough for the move of millions of rows
 *  to finish, small enough for no transaction to block the writes of the
 *  missions in flight for more than an instant. */
const BATCH = 5_000;

/** Attaches the archive if it already exists. Called at boot: without it, the
 *  events of an archived mission could not be found until the job's first
 *  pass. */
export function attachEventsArchiveIfPresent(): boolean {
  if (!existsSync(EVENTS_ARCHIVE_PATH)) return false;
  attachEventsArchive(EVENTS_ARCHIVE_PATH);
  return true;
}

/** Moves the events older than `TIMON_EVENTS_HOT_DAYS` to the archive.
 *  Returns the number of rows moved (0 if the setting is 0). */
export function archiveOldEvents(now = Date.now()): number {
  const hotDays = settingInt('TIMON_EVENTS_HOT_DAYS');
  if (hotDays <= 0) return 0;

  mkdirSync(dirname(EVENTS_ARCHIVE_PATH), { recursive: true });
  attachEventsArchive(EVENTS_ARCHIVE_PATH);

  const cutoff = now - hotDays * 86_400_000;
  const pick = db.prepare(`SELECT id FROM events WHERE timestamp < ? ORDER BY id LIMIT ?`);
  // One transaction PER BATCH, and not a single one for everything: on a database of
  // several million events, a single transaction would hold the write
  // lock long enough to make the running missions fail.
  const moveBatch = db.transaction((ids: number[]) => {
    const list = ids.join(','); // integers coming from the database: nothing to escape
    db.exec(
      `INSERT OR REPLACE INTO archive.events (id, mission_id, type, timestamp, payload)
       SELECT id, mission_id, type, timestamp, payload FROM events WHERE id IN (${list})`,
    );
    db.exec(`DELETE FROM events WHERE id IN (${list})`);
  });

  let moved = 0;
  for (;;) {
    const ids = (pick.all(cutoff, BATCH) as { id: number }[]).map((r) => r.id);
    if (!ids.length) break;
    moveBatch(ids);
    moved += ids.length;
    if (ids.length < BATCH) break;
  }
  if (moved) console.log(`[events-archive] ${moved} event(s) moved to ${EVENTS_ARCHIVE_PATH}`);
  return moved;
}

/** Retention of the secrets access log (SECRETS-VAULT.md §8), aligned on
 *  that of the events: same setting, same daily pass, and so `0` (the
 *  default) = never purge — the right default for an audit trail.
 *  The rows are deleted, not archived: they contain no
 *  value, and they are not what makes `timon.db` heavy. */
export function pruneSecretAccessJournal(now = Date.now()): number {
  const hotDays = settingInt('TIMON_EVENTS_HOT_DAYS');
  if (hotDays <= 0) return 0;
  const dropped = dbApi.pruneSecretAccess(now - hotDays * 86_400_000);
  if (dropped) console.log(`[events-archive] ${dropped} access log line(s) purged`);
  return dropped;
}

/** Retention of the spans (PRD workflows §13.1): their own horizon, 90 days by
 *  default, `0` = never purge. Unlike events, a default is possible: once
 *  deleted they can be rebuilt from the events, whereas an archived event
 *  leaves the export and the default backup. */
export function pruneOldTraceSpans(now = Date.now(), maxRows = Number.POSITIVE_INFINITY): number {
  const days = settingInt('TIMON_TRACE_SPANS_RETENTION_DAYS');
  if (days <= 0) return 0;
  return dbApi.pruneTraceSpans(now - days * 86_400_000, Math.min(1_000, maxRows), maxRows);
}

/** Same purge, handing the event loop back between two slices. An
 *  installation discovering the retention has hundreds of thousands of rows
 *  to remove, and better-sqlite3 holds the whole daemon while it writes. */
export async function drainOldTraceSpans(opts: { now?: number; sliceRows?: number; pauseMs?: number; stopped?: () => boolean } = {}): Promise<number> {
  const { now = Date.now(), sliceRows = 5_000, pauseMs = 200, stopped = () => false } = opts;
  let dropped = 0;
  while (!stopped()) {
    const slice = pruneOldTraceSpans(now, sliceRows);
    dropped += slice;
    if (slice < sliceRows) break;
    await new Promise((resolve) => setTimeout(resolve, pauseMs));
  }
  if (dropped) console.log(`[events-archive] ${dropped} trace span(s) removed`);
  return dropped;
}

/** Daily pass at 04:30 local time. Returns what stops it (contract of the
 *  modular kernel's `start*`). */
export function startEventsArchive(): () => void {
  let lastRunDay = '';
  let lastSpansDay = '';
  let stopped = false;
  const tick = () => {
    const d = new Date();
    const day = `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    // Caught up later in the day, unlike the rest: a laptop switched off at
    // 04:30 would never purge its spans, while this setting is on by default.
    if (day !== lastSpansDay && (d.getHours() > 4 || (d.getHours() === 4 && d.getMinutes() >= 30))) {
      lastSpansDay = day;
      void drainOldTraceSpans({ stopped: () => stopped }).catch((e: unknown) => {
        console.error(`[events-archive] trace span cleanup failed: ${(e as Error).message}`);
      });
      // Same catch-up: the history retention is on by default too, and must
      // not wait for a computer left on at 04:30.
      void runDataRetention({ stopped: () => stopped }).catch((e: unknown) => {
        console.error(`[retention] cleanup failed: ${(e as Error).message}`);
      });
    }
    if (d.getHours() !== 4 || d.getMinutes() < 30) return;
    if (day === lastRunDay) return;
    lastRunDay = day;
    try {
      archiveOldEvents();
      pruneSecretAccessJournal();
    } catch (e) {
      console.error(`[events-archive] archiving failed: ${(e as Error).message}`);
    }
  };
  const timer = setInterval(tick, 60_000);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}
