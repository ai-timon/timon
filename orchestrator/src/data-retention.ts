/**
 * Retention of what agents leave behind on the computer.
 *
 * Two settings, `0` keeping everything:
 *  - `TIMON_EVENTS_RETENTION_DAYS`, 180 days by default: the history of the
 *    missions idle for longer (`events`, the cold archive included, and the
 *    text the history search copied from it);
 *  - `TIMON_LEARNINGS_RETENTION_DAYS`, off by default: the raw facts
 *    (`learnings` table, and the `learnings.jsonl` / `learnings.archive.jsonl`
 *    files of each agent), which feed the memory curation.
 *
 * Unlike `TIMON_EVENTS_HOT_DAYS`, which moves events and loses nothing, this
 * deletes. A running mission, or one an open task or workflow run still
 * needs, is never touched. The provider sessions (Codex rollouts) have their
 * own retention, `TIMON_PROVIDER_SESSION_TTL_MS`.
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dbApi } from './db.js';
import { AGENTS_DIR, agentMemoryFile } from './paths.js';
import { settingInt } from './settings.js';

const DAY = 86_400_000;
const LEARNING_FILES = ['learnings.jsonl', 'learnings.archive.jsonl'] as const;

export type RetentionOutcome = { events: number; learnings: number; learningLines: number };

/** Date of a learnings line, `null` when it carries none (agents write `{kind,text}` by hand). */
function lineDate(line: string): number | null {
  try {
    const ts = (JSON.parse(line) as { ts?: unknown }).ts;
    if (typeof ts === 'number' && Number.isFinite(ts)) return ts;
    if (typeof ts === 'string') {
      const parsed = Date.parse(ts);
      return Number.isFinite(parsed) ? parsed : null;
    }
  } catch { /* an unreadable line is dated like an undated one */ }
  return null;
}

/**
 * Drops the lines of one learnings file older than `cutoff`. An undated line is
 * known to be older than the file's last write: it goes when that write is
 * itself past the cutoff. Returns the lines removed.
 */
function pruneLearningsFile(path: string, cutoff: number): number {
  let before: ReturnType<typeof statSync>;
  let content: string;
  try {
    before = statSync(path);
    content = readFileSync(path, 'utf8');
  } catch { return 0; }
  const lines = content.split('\n').filter((l) => l.trim());
  const keep = lines.filter((line) => (lineDate(line) ?? before.mtimeMs) >= cutoff);
  const removed = lines.length - keep.length;
  if (removed === 0) return 0;
  const tmp = `${path}.retention-tmp`;
  writeFileSync(tmp, keep.length ? keep.join('\n') + '\n' : '');
  // An agent appending meanwhile would lose its line to the rename: leave the
  // file for the next pass instead.
  const now = statSync(path);
  if (now.size !== before.size || now.mtimeMs !== before.mtimeMs) {
    rmSync(tmp, { force: true });
    return 0;
  }
  try {
    renameSync(tmp, path);
  } catch (e) {
    // Windows refuses to replace a file another process holds open: the
    // agent's own append. The next pass tries again; no copy is left behind.
    rmSync(tmp, { force: true });
    throw e;
  }
  return removed;
}

/** Raw facts older than the retention, in the database and in the agents' files. */
export function pruneOldLearnings(now = Date.now()): { rows: number; lines: number } {
  const days = settingInt('TIMON_LEARNINGS_RETENTION_DAYS');
  if (days <= 0) return { rows: 0, lines: 0 };
  const cutoff = now - days * DAY;
  const rows = dbApi.pruneLearnings(cutoff);
  let lines = 0;
  if (existsSync(AGENTS_DIR)) {
    for (const agent of readdirSync(AGENTS_DIR)) {
      for (const file of LEARNING_FILES) {
        let path: string;
        try { path = agentMemoryFile(agent, file); } catch { continue; }
        if (!existsSync(path)) continue;
        try { lines += pruneLearningsFile(path, cutoff); } catch (e) {
          console.warn(`[retention] could not prune ${path}: ${(e as Error).message}`);
        }
      }
    }
  }
  if (rows || lines) console.log(`[retention] ${rows} raw fact(s) and ${lines} learnings line(s) past retention deleted`);
  return { rows, lines };
}

/** Missions listed per query: each costs a few index probes. */
const MISSION_PAGE = 200;

export type EventsPruneOptions = { now?: number; sliceRows?: number; pauseMs?: number; stopped?: () => boolean };

/**
 * The history of the missions idle past the retention, whole conversations at
 * a time (`historyExpiredSql` in `db.ts` says which). Events go in slices,
 * handing the event loop back between two: the first pass on a large home
 * deletes millions of rows, and better-sqlite3 holds the whole daemon while it
 * writes.
 */
export async function pruneOldEvents(opts: EventsPruneOptions = {}): Promise<number> {
  const { now = Date.now(), sliceRows = 5_000, pauseMs = 200, stopped = () => false } = opts;
  const days = settingInt('TIMON_EVENTS_RETENTION_DAYS');
  if (days <= 0) return 0;
  const cutoff = now - days * DAY;
  const archive = dbApi.eventsArchiveAttached();
  const tables = archive ? (['events', 'archive.events'] as const) : (['events'] as const);
  const pause = () => new Promise((resolve) => setTimeout(resolve, pauseMs));
  let after = 0;
  let dropped = 0;
  // Rows deleted since the last pause: many small missions add up to a slice too.
  let sinceYield = 0;
  while (!stopped()) {
    const page = dbApi.expiredHistoryMissions(cutoff, archive, after, MISSION_PAGE);
    if (!page.length) break;
    for (const mission of page) {
      if (stopped()) break;
      after = mission.rowid;
      for (const table of tables) {
        for (;;) {
          if (stopped()) break;
          if (sinceYield >= sliceRows) { await pause(); sinceYield = 0; }
          const room = sliceRows - sinceYield;
          const slice = dbApi.pruneMissionEventsBatch(table, mission.id, cutoff, archive, room, days);
          dropped += slice;
          sinceYield += slice;
          if (slice < room) break; // nothing left of this mission in this table
        }
      }
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  return dropped;
}

/** The daily pass. */
export async function runDataRetention(opts: EventsPruneOptions = {}): Promise<RetentionOutcome> {
  const learnings = pruneOldLearnings(opts.now);
  const events = await pruneOldEvents(opts);
  if (events) console.log(`[retention] ${events} mission event(s) past retention deleted`);
  return { events, learnings: learnings.rows, learningLines: learnings.lines };
}
