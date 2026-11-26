/**
 * Capped catch-up of old mission titles (TODO #358, step 6). Missions that
 * predate automatic titles, or whose generated title came out empty or cut,
 * get one through the same pipeline as an explicit re-title
 * (`regenerateMissionTitle`).
 *
 * Quota is the constraint, so the shape is conservative: a dry run by default
 * (it announces how many missions and calls, writes nothing), a ceiling per
 * run, one light model call per mission, one after the other with a pause, a
 * clean stop at the first quota signal, and never a trigger of its own: only
 * a person asking starts a run.
 *
 * Targets: no title, or a `generated` one that is empty or cut. Never
 * `manual`, `preset` or `native` (the query excludes them, and
 * `regenerateMissionTitle` is called without `force` as a second guard).
 */
import { dbApi, type MissionRow } from './db.js';
import { settingNum } from './settings.js';
import type { DbViewer } from './users/identity.js';
import { regenerateMissionTitle, type MissionTitleDeps } from './mission-titles.js';

export const BACKFILL_DEFAULT_LIMIT = 50;

export type BackfillPlan = {
  dryRun: boolean;
  /** Missions the run targets (already capped). */
  targeted: number;
  /** Model calls the run will make: one per targeted mission. */
  calls: number;
  /** The ceiling in force, so a client can say why a request was lowered. */
  ceiling: number;
  limit: number;
};

export type BackfillResult = BackfillPlan & {
  written: number;
  kept: number;
  failed: number;
  /** Set when the run stopped early: the title model ran out of quota or generation is off. */
  stopped: 'quota' | 'off' | null;
};

export type BackfillOptions = {
  viewer?: DbViewer | null;
  /** Unix ms: only missions started at or after it. */
  since?: number | null;
  limit?: number;
  dryRun?: boolean;
  /** Test seam: pause between two calls, in ms. */
  delayMs?: number;
  deps?: MissionTitleDeps;
  sleep?: (ms: number) => Promise<void>;
};

let running = false;

/** Whether a catch-up is in flight in this daemon. */
export function backfillRunning(): boolean { return running; }

export function backfillCeiling(): number { return settingNum('TIMON_MISSION_TITLE_BACKFILL_MAX'); }

function effectiveLimit(requested: number | undefined, ceiling: number): number {
  const wanted = requested === undefined ? BACKFILL_DEFAULT_LIMIT : Math.max(1, Math.floor(requested));
  return Math.min(wanted, ceiling);
}

function candidates(opts: BackfillOptions, limit: number): MissionRow[] {
  return dbApi.listTitleBackfillCandidates(opts.viewer, opts.since ?? null, limit);
}

/** What a run would do, without a model call and without a write. */
export function planTitleBackfill(opts: BackfillOptions = {}): BackfillPlan {
  const ceiling = backfillCeiling();
  const limit = effectiveLimit(opts.limit, ceiling);
  const n = candidates(opts, limit).length;
  return { dryRun: true, targeted: n, calls: n, ceiling, limit };
}

/**
 * Runs the catch-up. `dryRun` defaults to true: a caller that does not say
 * `dryRun: false` never writes. Returns `null` when a run is already going.
 */
export async function runTitleBackfill(opts: BackfillOptions = {}): Promise<BackfillResult | null> {
  const ceiling = backfillCeiling();
  const limit = effectiveLimit(opts.limit, ceiling);
  const list = candidates(opts, limit);
  const base: BackfillResult = {
    dryRun: opts.dryRun !== false, targeted: list.length, calls: list.length, ceiling, limit,
    written: 0, kept: 0, failed: 0, stopped: null,
  };
  if (base.dryRun) return base;
  if (running) return null;
  running = true;
  try {
    const delayMs = opts.delayMs ?? settingNum('TIMON_MISSION_TITLE_BACKFILL_DELAY_MS');
    const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let first = true;
    for (const m of list) {
      if (!first && delayMs > 0) await sleep(delayMs);
      first = false;
      const out = await regenerateMissionTitle(m.id, {}, opts.deps);
      if (!out) { base.failed++; continue; }
      if (out.status === 'written') base.written++;
      else if (out.status === 'failed') {
        base.failed++;
        if (out.reason === 'quota') { base.stopped = 'quota'; break; }
      } else if (out.status === 'off') { base.stopped = 'off'; break; }
      else base.kept++;
    }
    return base;
  } finally {
    running = false;
  }
}
