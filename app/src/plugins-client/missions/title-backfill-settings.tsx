'use client';

/**
 * Settings › Missions: catch up the titles of old conversations (TODO #358,
 * step 6). A preview first (a dry run: how many conversations, how many model
 * calls), then a button that runs it and says the same number. Never
 * automatic: every title costs a call on the title model's quota, so only a
 * click starts one. The daemon holds the rules (never a title you typed or a
 * launcher gave, the ceiling per run, the stop at the first quota signal).
 */

import { useState, type ReactElement } from 'react';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { apiErrorMessage } from '@/lib/api-error';

export type BackfillView = {
  dryRun: boolean;
  targeted: number;
  calls: number;
  limit: number;
  ceiling: number;
  written?: number;
  kept?: number;
  failed?: number;
  stopped?: 'quota' | 'off' | null;
};

/** The toast of a finished run: what was written, and why it stopped early if it did. */
export function backfillSummary(r: BackfillView): string {
  const done = t('missionTitleBackfill.done', { written: r.written ?? 0, targeted: r.targeted });
  if (r.stopped === 'quota') return `${done} ${t('missionTitleBackfill.stoppedQuota')}`;
  if (r.stopped === 'off') return `${done} ${t('missionTitleBackfill.stoppedOff')}`;
  return done;
}

async function post(dryRun: boolean): Promise<{ ok: true; view: BackfillView } | { ok: false; message: string }> {
  try {
    const res = await fetch('/api/ui/mission-titles/backfill', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ dryRun }),
    });
    const json = await res.json().catch(() => ({})) as BackfillView & { error?: string };
    if (!res.ok) return { ok: false, message: apiErrorMessage(json, t('missionTitleBackfill.error')) };
    return { ok: true, view: json };
  } catch {
    return { ok: false, message: t('missionTitleBackfill.error') };
  }
}

export function MissionTitleBackfillSettings(): ReactElement {
  const [preview, setPreview] = useState<BackfillView | null>(null);
  const [busy, setBusy] = useState<'preview' | 'run' | null>(null);

  const onPreview = async () => {
    setBusy('preview');
    const out = await post(true);
    setBusy(null);
    if (out.ok) setPreview(out.view); else toast.error(out.message);
  };

  const onRun = async () => {
    setBusy('run');
    const out = await post(false);
    setBusy(null);
    // The numbers announced are spent: a new preview is needed to run again.
    setPreview(null);
    if (!out.ok) { toast.error(out.message); return; }
    toast.success(backfillSummary(out.view));
  };

  return (
    <section className="space-y-2 py-4" aria-label={t('missionTitleBackfill.title')} aria-busy={busy !== null}>
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
            disabled={busy !== null}
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
                  disabled={busy !== null}
                  onClick={() => { void onRun(); }}
                >
                  {busy === 'run' ? t('missionTitleBackfill.running') : t('missionTitleBackfill.run', { calls: preview.calls })}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
