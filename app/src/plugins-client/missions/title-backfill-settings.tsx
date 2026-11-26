'use client';

/**
 * Settings › Missions: catch up the titles of old conversations (TODO #358,
 * step 6). A preview first (a dry run: how many conversations, how many model
 * calls), then a button that runs it and says the same number. Never
 * automatic: every title costs a call on the title model's quota, so only a
 * click starts one. The daemon holds the rules (never a title you typed or a
 * launcher gave, the ceiling per run, the stop at the first quota signal).
 *
 * The run is a background job in the daemon (a request would outlast any
 * timeout): a progress bar with the counters and a Cancel button follow it,
 * and the section picks a running job up again when the page is reopened. The
 * job is kept in the daemon's memory, so a daemon restart forgets it.
 */

import { useCallback, useEffect, useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { apiErrorMessage } from '@/lib/api-error';

export type BackfillView = {
  dryRun: boolean;
  targeted: number;
  calls: number;
  limit: number;
  ceiling: number;
};

export type BackfillJobStatus = 'running' | 'done' | 'stopped_quota' | 'stopped_off' | 'cancelled' | 'failed';

export type BackfillJob = {
  jobId: string;
  status: BackfillJobStatus;
  targeted: number;
  processed: number;
  written: number;
  skipped: number;
  errored: number;
  cancelRequested: boolean;
  lastError: string | null;
};

const POLL_MS = 2000;

/** Share of the targeted conversations handled so far, 0 to 100. */
export function backfillPercent(j: Pick<BackfillJob, 'targeted' | 'processed'>): number {
  if (j.targeted <= 0) return 100;
  return Math.max(0, Math.min(100, Math.round((j.processed / j.targeted) * 100)));
}

/** The final line of a job: what was written, and why it ended early if it did. */
export function backfillSummary(j: BackfillJob): string {
  const done = t('missionTitleBackfill.done', { written: j.written, targeted: j.targeted });
  switch (j.status) {
    case 'stopped_quota': return `${done} ${t('missionTitleBackfill.stoppedQuota')}`;
    case 'stopped_off': return `${done} ${t('missionTitleBackfill.stoppedOff')}`;
    case 'cancelled': return `${done} ${t('missionTitleBackfill.cancelled')}`;
    case 'failed': return `${done} ${t('missionTitleBackfill.failed')}`;
    default: return done;
  }
}

type Reply<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Reply<T>> {
  try {
    const res = await fetch(path, {
      method,
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    });
    const json = await res.json().catch(() => ({})) as T & { error?: string };
    if (!res.ok) return { ok: false, status: res.status, message: apiErrorMessage(json, t('missionTitleBackfill.error')) };
    return { ok: true, value: json };
  } catch {
    return { ok: false, status: 0, message: t('missionTitleBackfill.error') };
  }
}

const BASE = '/api/ui/mission-titles/backfill';

export function MissionTitleBackfillSettings(): ReactElement {
  const [preview, setPreview] = useState<BackfillView | null>(null);
  const [busy, setBusy] = useState<'preview' | 'start' | 'cancel' | null>(null);
  const [job, setJob] = useState<BackfillJob | null>(null);
  const running = job?.status === 'running';
  const jobId = job?.jobId ?? null;

  // Back on the page: pick up the run in progress (or the latest outcome).
  useEffect(() => {
    let live = true;
    void call<{ job: BackfillJob | null }>('GET', BASE).then((r) => { if (live && r.ok) setJob(r.value.job); });
    return () => { live = false; };
  }, []);

  // While a job runs, follow it.
  useEffect(() => {
    if (!running || !jobId) return;
    let live = true;
    const timer = setInterval(() => {
      void call<BackfillJob>('GET', `${BASE}/${encodeURIComponent(jobId)}`).then((r) => {
        if (!live) return;
        if (r.ok) setJob(r.value);
        else if (r.status === 404) setJob(null); // the daemon restarted: the job is gone
      });
    }, POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [running, jobId]);

  const onPreview = async () => {
    setBusy('preview');
    const out = await call<BackfillView>('POST', BASE, { dryRun: true });
    setBusy(null);
    if (out.ok) setPreview(out.value); else toast.error(out.message);
  };

  const adoptCurrent = useCallback(async () => {
    const cur = await call<{ job: BackfillJob | null }>('GET', BASE);
    if (cur.ok) setJob(cur.value.job);
  }, []);

  const onRun = async () => {
    setBusy('start');
    const out = await call<{ jobId: string }>('POST', BASE, { dryRun: false });
    if (out.ok) {
      // The numbers announced are spent: a new preview is needed to run again.
      setPreview(null);
      await adoptCurrent();
    } else if (out.status === 409) {
      // A run already goes on for this account (another tab): show it.
      await adoptCurrent();
    } else {
      toast.error(out.message);
    }
    setBusy(null);
  };

  const onCancel = async () => {
    if (!job) return;
    setBusy('cancel');
    const out = await call<BackfillJob>('POST', `${BASE}/${encodeURIComponent(job.jobId)}/cancel`, {});
    setBusy(null);
    if (out.ok) setJob(out.value); else toast.error(out.message);
  };

  return (
    <section className="space-y-2 py-4" aria-label={t('missionTitleBackfill.title')} aria-busy={busy !== null || running}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
        <div className="min-w-0 flex-1">
          <span className="text-[13px] font-medium leading-snug">{t('missionTitleBackfill.title')}</span>
          <p className="mt-0.5 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('missionTitleBackfill.description')}</p>
          <p className="mt-1 max-w-[65ch] text-[12px] leading-snug text-muted-foreground">{t('missionTitleBackfill.quotaNote')}</p>
        </div>
        <div className="w-full shrink-0 space-y-2 sm:w-80">
          <button
            type="button"
            className="h-8 rounded-md border border-border bg-background px-3 text-[12.5px] disabled:opacity-50"
            disabled={busy !== null || running}
            onClick={() => { void onPreview(); }}
          >
            {busy === 'preview' ? t('missionTitleBackfill.previewing') : t('missionTitleBackfill.preview')}
          </button>
          {preview && (
            <div role="status" className="space-y-2">
              <p className="text-[12px] leading-snug">
                {preview.targeted === 0
                  ? t('missionTitleBackfill.nothing')
                  : t('missionTitleBackfill.announce', { targeted: preview.targeted, calls: preview.calls })}
              </p>
              {preview.targeted > 0 && (
                <button
                  type="button"
                  className="h-8 rounded-md bg-primary px-3 text-[12.5px] text-primary-foreground disabled:opacity-50"
                  disabled={busy !== null || running}
                  onClick={() => { void onRun(); }}
                >
                  {busy === 'start' ? t('missionTitleBackfill.running') : t('missionTitleBackfill.run', { calls: preview.calls })}
                </button>
              )}
            </div>
          )}
          {job && (
            <div className="space-y-2" role="status">
              <div
                role="progressbar"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={backfillPercent(job)}
                aria-label={t('missionTitleBackfill.progress')}
                className="h-2 w-full overflow-hidden rounded-full bg-muted"
              >
                <div className="h-full bg-primary transition-[width]" style={{ width: `${backfillPercent(job)}%` }} />
              </div>
              <p className="text-[12px] leading-snug">
                {t('missionTitleBackfill.counters', { processed: job.processed, targeted: job.targeted, written: job.written, skipped: job.skipped, errored: job.errored })}
              </p>
              {running ? (
                <button
                  type="button"
                  className="h-8 rounded-md border border-border bg-background px-3 text-[12.5px] disabled:opacity-50"
                  disabled={busy === 'cancel' || job.cancelRequested}
                  onClick={() => { void onCancel(); }}
                >
                  {job.cancelRequested ? t('missionTitleBackfill.cancelling') : t('missionTitleBackfill.cancel')}
                </button>
              ) : (
                <p className="text-[12px] leading-snug font-medium">{backfillSummary(job)}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
