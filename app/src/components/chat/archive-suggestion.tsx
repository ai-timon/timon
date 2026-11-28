'use client';

/**
 * The agent's proposal to archive a finished conversation: a strip above the
 * composer in the chat, a small chip on a list row. Both only ask: Archive
 * answers with the person's own archive route, Dismiss drops the proposal.
 * The agent never archives by itself.
 */

import React from 'react';
import { Archive, Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { composerTrayClass } from './composer-trays';
import { t } from '@/lib/i18n';

type Props = {
  reason?: string | null;
  onArchive: () => void;
  onDismiss: () => void;
};

export function ArchiveSuggestionBar({ reason, onArchive, onDismiss, compact = false }: Props & { compact?: boolean }) {
  return (
    <div
      data-archive-suggestion
      className={cn(
        composerTrayClass(compact),
        'flex min-w-0 items-center gap-2 border-border/60 px-3 py-1 text-[11px] text-muted-foreground',
      )}
      style={{ backgroundColor: 'hsl(var(--background))' }}
    >
      <Archive className="size-3 flex-none" aria-hidden />
      <span className="flex-none">{t('archiveSuggestion.label')}</span>
      {reason && <span className="min-w-0 flex-1 truncate text-[10.5px] text-muted-foreground/70" title={reason}>{reason}</span>}
      {!reason && <span className="flex-1" />}
      <button type="button" onClick={onArchive} className="flex-none rounded px-1.5 py-0.5 font-medium text-foreground transition-colors hover:bg-muted">
        {t('archiveSuggestion.archive')}
      </button>
      <button type="button" onClick={onDismiss} className="flex-none rounded px-1.5 py-0.5 transition-colors hover:bg-muted hover:text-foreground">
        {t('archiveSuggestion.dismiss')}
      </button>
    </div>
  );
}

/** The same proposal on a list row: a tag with an Archive and a Dismiss button. */
export function ArchiveSuggestionChip({ reason, onArchive, onDismiss }: Props) {
  const stop = (fn: () => void) => (e: React.MouseEvent) => { e.stopPropagation(); fn(); };
  return (
    <span
      data-archive-suggestion
      className="inline-flex shrink-0 items-center gap-0.5 rounded bg-primary/10 px-1 text-[9.5px] text-primary"
      title={reason ? `${t('archiveSuggestion.label')} ${reason}` : t('archiveSuggestion.label')}
    >
      <Archive className="size-2.5" aria-hidden />
      <span>{t('archiveSuggestion.chip')}</span>
      <button type="button" title={t('archiveSuggestion.archive')} aria-label={t('archiveSuggestion.archive')} onClick={stop(onArchive)} className="grid size-3.5 place-items-center rounded hover:bg-primary/20">
        <Check className="size-2.5" aria-hidden />
      </button>
      <button type="button" title={t('archiveSuggestion.dismiss')} aria-label={t('archiveSuggestion.dismiss')} onClick={stop(onDismiss)} className="grid size-3.5 place-items-center rounded hover:bg-primary/20">
        <X className="size-2.5" aria-hidden />
      </button>
    </span>
  );
}
