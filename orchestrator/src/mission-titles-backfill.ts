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
import { randomUUID } from 'node:crypto';
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
  /** Set when the run stopped early: the title model ran out of quota, generation is off, or the caller cancelled. */
  stopped: 'quota' | 'off' | 'cancelled' | null;
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
  /** Called after each mission with the counters so far (processed = missions handled). */
  onProgress?: (done: BackfillResult, processed: number) => void;
  /** Checked between two missions: true ends the run cleanly (`cancelled`). */
  shouldCancel?: () => boolean;
};

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

async function runLoop(list: MissionRow[], base: BackfillResult, opts: BackfillOptions): Promise<BackfillResult> {
  const delayMs = opts.delayMs ?? settingNum('TIMON_MISSION_TITLE_BACKFILL_DELAY_MS');
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let processed = 0;
  for (const m of list) {
    if (opts.shouldCancel?.()) { base.stopped = 'cancelled'; break; }
    if (processed > 0 && delayMs > 0) await sleep(delayMs);
    // The pause can be long: a cancel asked during it must not cost one more call.
    if (opts.shouldCancel?.()) { base.stopped = 'cancelled'; break; }
    const out = await regenerateMissionTitle(m.id, {}, opts.deps);
    processed++;
    if (!out) base.failed++;
    else if (out.status === 'written') base.written++;
    else if (out.status === 'failed') {
      base.failed++;
      if (out.reason === 'quota') base.stopped = 'quota';
    } else if (out.status === 'off') base.stopped = 'off';
    else base.kept++;
    opts.onProgress?.(base, processed);
    if (base.stopped) break;
  }
  return base;
}

function freshResult(list: MissionRow[], ceiling: number, limit: number, dryRun: boolean): BackfillResult {
  return { dryRun, targeted: list.length, calls: list.length, ceiling, limit, written: 0, kept: 0, failed: 0, stopped: null };
}

/**
 * Runs the catch-up to its end, in the caller's task. `dryRun` defaults to
 * true: a caller that does not say `dryRun: false` never writes. The HTTP
 * route does not wait for this: it goes through `startTitleBackfillJob`.
 */
export async function runTitleBackfill(opts: BackfillOptions = {}): Promise<BackfillResult> {
  const ceiling = backfillCeiling();
  const limit = effectiveLimit(opts.limit, ceiling);
  const list = candidates(opts, limit);
  const base = freshResult(list, ceiling, limit, opts.dryRun !== false);
  if (base.dryRun) return base;
  return runLoop(list, base, opts);
}

export type BackfillJobStatus = 'running' | 'done' | 'stopped_quota' | 'stopped_off' | 'cancelled' | 'failed';

/** What a client sees of a job: counters and a fixed-vocabulary error, never a raw message. */
export type BackfillJobView = {
  jobId: string;
  status: BackfillJobStatus;
  targeted: number;
  processed: number;
  written: number;
  skipped: number;
  errored: number;
  limit: number;
  ceiling: number;
  startedAt: number;
  finishedAt: number | null;
  cancelRequested: boolean;
  /** Short fixed text (no model or provider message, so nothing secret can leak). */
  lastError: string | null;
};

type Job = BackfillJobView & { ownerId: string };

/**
 * Jobs live in memory: a daemon restart forgets them (a title already written
 * stays written, and a new run simply targets what is still untitled), so no
 * table. Finished jobs are kept briefly so a page that returns can read the
 * outcome, then dropped.
 */
const jobs = new Map<string, Job>();
const FINISHED_JOB_TTL_MS = 60 * 60 * 1000;

function ownerKey(viewer: DbViewer | null | undefined): string { return viewer?.id ?? ''; }

function pruneJobs(now: number): void {
  for (const [id, j] of jobs) if (j.finishedAt !== null && now - j.finishedAt > FINISHED_JOB_TTL_MS) jobs.delete(id);
}

function viewOf(j: Job): BackfillJobView {
  const { ownerId: _owner, ...view } = j;
  return view;
}

/** The job of this account that is still running, if any. */
export function activeTitleBackfillJob(viewer: DbViewer | null | undefined): BackfillJobView | null {
  const key = ownerKey(viewer);
  for (const j of jobs.values()) if (j.ownerId === key && j.status === 'running') return viewOf(j);
  return null;
}

/** A job by id, only for its owner: another account's id reads as absent. */
export function getTitleBackfillJob(jobId: string, viewer: DbViewer | null | undefined): BackfillJobView | null {
  const j = jobs.get(jobId);
  return j && j.ownerId === ownerKey(viewer) ? viewOf(j) : null;
}

/** Asks a running job to stop between two missions. `null`: unknown or not yours. */
export function cancelTitleBackfillJob(jobId: string, viewer: DbViewer | null | undefined): BackfillJobView | null {
  const j = jobs.get(jobId);
  if (!j || j.ownerId !== ownerKey(viewer)) return null;
  if (j.status === 'running') j.cancelRequested = true;
  return viewOf(j);
}

/**
 * Starts a real run in the background and returns at once. One running job per
 * account: `null` when this account already has one. Same guards as the
 * synchronous run (ceiling, pause, quota stop, never manual/preset/native).
 */
export function startTitleBackfillJob(opts: BackfillOptions = {}): BackfillJobView | null {
  const key = ownerKey(opts.viewer);
  const now = Date.now();
  pruneJobs(now);
  if (activeTitleBackfillJob(opts.viewer)) return null;
  const ceiling = backfillCeiling();
  const limit = effectiveLimit(opts.limit, ceiling);
  const list = candidates(opts, limit);
  const job: Job = {
    jobId: randomUUID(), ownerId: key, status: 'running', targeted: list.length, processed: 0, written: 0, skipped: 0,
    errored: 0, limit, ceiling, startedAt: now, finishedAt: null, cancelRequested: false, lastError: null,
  };
  jobs.set(job.jobId, job);
  const base = freshResult(list, ceiling, limit, false);
  const sync = (r: BackfillResult, processed: number): void => {
    job.processed = processed; job.written = r.written; job.skipped = r.kept; job.errored = r.failed;
    if (r.failed > 0 && r.stopped !== 'quota') job.lastError = 'some titles could not be generated';
    opts.onProgress?.(r, processed);
  };
  void runLoop(list, base, { ...opts, onProgress: sync, shouldCancel: () => job.cancelRequested })
    .then((r) => {
      sync(r, job.processed);
      if (r.stopped === 'quota') { job.status = 'stopped_quota'; job.lastError = 'the title model is out of quota'; }
      else if (r.stopped === 'off') { job.status = 'stopped_off'; job.lastError = 'automatic titles are turned off'; }
      else if (r.stopped === 'cancelled') job.status = 'cancelled';
      else job.status = 'done';
    })
    .catch(() => { job.status = 'failed'; job.lastError = 'the catch-up stopped on an unexpected error'; })
    .finally(() => { job.finishedAt = Date.now(); });
  return viewOf(job);
}

/** Test seam: forget every job. */
export function resetTitleBackfillJobs(): void { jobs.clear(); }
