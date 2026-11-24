'use client';

/**
 * The update window (docs/AUTO-UPDATE.md §10) and its host. The product's
 * window is the default occupant of `updates.dialog`; the host — mounted by
 * the update card's source, which owns the update flow — keeps the dialog,
 * names it, and turns the flow's step into what the window paints, so the
 * card and the window always say the same thing.
 */

import { type ReactElement, type ReactNode } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { UPDATE_DIALOG_SLOT } from '@/lib/plugin-host/slots';
import { releaseHighlights } from '@/lib/update-highlights';
import { installerLink } from '@/lib/update-settings';
import type { UpdateDownloadState } from '@/lib/update-download';
import { formatDate } from '@/lib/intl';
import { t } from '@/lib/i18n';
import { UpdateDialogProvider, useUpdateDialog, type UpdateDialogAction, type UpdateDialogValue } from './update-dialog-context';
import type { UpdateFlowView } from './update-flow';
import type { UpdateStatusValue } from './update-status-context';

/** How far the download is, 0 to 1; `null` while there is no file under way or ready. */
export function downloadRatio(state: UpdateDownloadState | null): number | null {
  if (!state) return null;
  if (state.phase === 'downloading') return state.total > 0 ? Math.min(1, state.received / state.total) : 0;
  if (state.phase === 'verifying' || state.phase === 'ready') return 1;
  return null;
}

/**
 * What the window paints for `value` at the flow's `view`. The card's words
 * become the window's where they differ: "Download" before anything started
 * (the card's "Update" opens this window), "Restart and install" once the
 * file is verified, and in a browser one link to the installer of this system
 * (the install page when none fits).
 */
export function updateDialogValue(value: UpdateStatusValue, view: UpdateFlowView, close: () => void): UpdateDialogValue {
  const { offer, download } = value;
  const base = {
    version: offer.version,
    publishedAt: offer.publishedAt,
    installed: value.installed,
    highlights: releaseHighlights(offer.notes),
    notesUrl: offer.notesUrl,
    download: download?.state ?? null,
    close,
  };
  if (!download) {
    const { href, forThisSystem } = installerLink(value.installers);
    const installer: UpdateDialogAction = {
      label: t(forThisSystem ? 'updates.dialog.installer' : 'updates.dialog.allInstallers'),
      marker: 'installer',
      run: () => { window.open(href, '_blank', 'noopener,noreferrer'); },
      href,
    };
    return { ...base, step: 'offer', line: null, command: null, alert: false, actions: [installer] };
  }
  const actions = view.actions.map((action): UpdateDialogAction => {
    if (action.marker === 'update') return { label: t('updates.dialog.download'), marker: 'download', run: download.start, href: null };
    if (action.marker === 'install') return { label: t('updates.dialog.install'), marker: 'install', run: action.run, href: null };
    return { label: action.label, marker: action.marker, run: action.run, href: null };
  });
  const line = view.step === 'ready' && !view.alert ? t('updates.dialog.verified') : view.line;
  return { ...base, step: view.step, line, command: view.command, alert: view.alert, actions };
}

/** The product's window: the default occupant of `updates.dialog`. `null` outside the host. */
export function ProductUpdateDialog(): ReactElement | null {
  const value = useUpdateDialog();
  if (!value) return null;
  const date = formatDate(value.publishedAt, 'long');
  const ratio = downloadRatio(value.download);
  // The main gesture sits at the right, where the eye ends.
  const actions = [...value.actions].reverse();
  return (
    <div className="flex flex-col gap-5" data-update-dialog-body="">
      {/* The host names the dialog for assistive technology; this is what the eye reads. */}
      <div aria-hidden className="flex flex-col gap-1 pr-6">
        <h2 className="m-0 text-xl font-semibold leading-tight">{t('updates.dialog.title', { version: value.version })}</h2>
        {date && <p className="m-0 text-sm text-muted-foreground">{date}</p>}
      </div>
      {value.highlights.length > 0 && (
        <ul className="m-0 flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed" data-update-highlights="">
          {value.highlights.map((item, index) => <li key={index}>{item}</li>)}
        </ul>
      )}
      <a
        href={value.notesUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex w-fit items-center gap-1.5 text-sm text-primary hover:underline"
        data-update-changelog=""
      >
        {t('updates.dialog.changelog')}
        <ExternalLink aria-hidden className="h-3.5 w-3.5" />
      </a>
      <div className="flex flex-col gap-3 rounded-lg bg-muted/40 p-4" data-update-dialog-step={value.step}>
        {ratio !== null && (
          <div
            role="progressbar"
            aria-label={t('updates.dialog.progress')}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(ratio * 100)}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${ratio * 100}%` }} />
          </div>
        )}
        {value.line && (
          <p className={`m-0 text-sm tabular-nums ${value.alert ? 'text-destructive' : 'text-muted-foreground'}`} role={value.alert ? 'alert' : undefined} data-update-line="">
            {value.line}
          </p>
        )}
        {/* code-font: a command to paste in a terminal */}
        {value.command && <code className="select-all rounded bg-background px-2 py-1 font-mono text-xs" data-update-command="">{value.command}</code>}
        {actions.length > 0 && (
          <div className="flex flex-wrap justify-end gap-2">
            {actions.map((action, index) => {
              const main = index === actions.length - 1;
              return action.href ? (
                <Button key={action.marker} asChild size="sm" variant={main ? 'default' : 'ghost'} data-update-dialog-action={action.marker}>
                  <a href={action.href} target="_blank" rel="noopener noreferrer">{action.label}</a>
                </Button>
              ) : (
                <Button key={action.marker} size="sm" variant={main ? 'default' : 'ghost'} onClick={action.run} data-update-dialog-action={action.marker}>
                  {action.label}
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The dialog around the occupant of `updates.dialog` — or the product's
 * window while the slot is empty (a page outside the bundled halves), so
 * "Update" never opens an empty frame. `children` go under the occupant,
 * inside the dialog: a modal leaves nothing outside it clickable.
 */
export function UpdateDialogHost({ open, onOpenChange, value, children }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  value: UpdateDialogValue | null;
  children?: ReactNode;
}): ReactElement {
  const claimed = useSlotEntries(UPDATE_DIALOG_SLOT).length > 0;
  return (
    <Dialog open={open && value !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" aria-describedby={undefined} data-update-dialog={value?.version ?? ''}>
        <DialogTitle className="sr-only">{value ? t('updates.dialog.title', { version: value.version }) : ''}</DialogTitle>
        {value && (
          <UpdateDialogProvider value={value}>
            {claimed ? <SlotSingle name={UPDATE_DIALOG_SLOT} /> : <ProductUpdateDialog />}
          </UpdateDialogProvider>
        )}
        {value && children}
      </DialogContent>
    </Dialog>
  );
}
