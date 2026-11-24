'use client';

/**
 * Cockpit widget `workflow-runs` (PRD §8.1): the latest runs across every
 * workflow, live on the `workflow_run` bus event.
 */
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Workflow as WorkflowIcon } from 'lucide-react';
import { Tile } from '@/components/tile';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { t } from '@/lib/i18n';
import { sseOn } from '@/lib/sse-stream';
import { RunStatusBadge } from './trace-panel';
import { formatDuration, formatRelative, runDuration, sameJson, type WorkflowRun } from './types';

export function WorkflowRunsWidget({ handle, className }: WidgetProps) {
  const [runs, setRuns] = useState<WorkflowRun[] | null>(null);
  const timer = useRef<number | null>(null);
  const load = useCallback(async () => {
    try {
      const response = await fetch('/api/ui/workflows/runs?limit=8', { cache: 'no-store' });
      if (!response.ok) { setRuns([]); return; }
      const value = await response.json() as { runs?: WorkflowRun[] };
      setRuns((previous) => (previous && sameJson(previous, value.runs ?? []) ? previous : value.runs ?? []));
    } catch { setRuns([]); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => sseOn('workflow_run', () => {
    if (typeof document !== 'undefined' && document.hidden) return;
    // Bursts of node events collapse into one refresh.
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => { void load(); }, 400);
  }), [load]);

  return (
    <Tile title={t('workflows.widget.title')} actions={<>
      <Link prefetch={false} href="/workflows" className="text-[10.5px] text-muted-foreground hover:text-foreground">{t('workflows.widget.all')}</Link>
      {handle}
    </>} className={className} bodyClassName="p-2">
      {runs === null && <p className="px-2 py-3 text-[11px] text-muted-foreground">{t('common.loading')}</p>}
      {runs && runs.length === 0 && (
        <div className="flex flex-col items-center gap-1.5 px-2 py-5 text-center text-[11px] text-muted-foreground">
          <WorkflowIcon className="size-4" />{t('workflows.widget.empty')}
        </div>
      )}
      {runs && runs.length > 0 && (
        <ul className="space-y-0.5">
          {runs.map((run) => (
            <li key={run.id}>
              <Link prefetch={false} href={`/workflows/${encodeURIComponent(run.workflow?.slug ?? '')}/runs/${run.id}`} className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted">
                <RunStatusBadge status={run.status} />
                <span className="min-w-0 flex-1 truncate text-[11.5px] font-medium">{run.workflow?.name ?? run.workflow_id}</span>
                <span className="text-[10px] tabular-nums text-muted-foreground">{formatDuration(runDuration(run))}</span>
                <span className="text-[10px] text-muted-foreground">{formatRelative(run.started_at)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Tile>
  );
}
