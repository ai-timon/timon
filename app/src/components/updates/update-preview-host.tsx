'use client';

/**
 * The host of the update window's preview (`update-preview.ts`): mounted
 * once in the root layout, it paints nothing unless the address asks for
 * `?update-preview=1` (the window opens at once) or `?notices-preview=1` (the
 * demonstration card's "Update" opens it). Like the demonstration cards,
 * nothing without a session: it waits for the account's closed notices to be
 * read, which the notices host does anyway.
 *
 * Each opening replays the journey from the download; a discreet row of
 * states under the window jumps to any of them. "Restart and install" closes
 * the window with a toast: nothing was installed.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement } from 'react';
import { toast } from 'sonner';
import { dismissedNoticesLoaded, subscribeNotices } from '@/lib/notices';
import { t } from '@/lib/i18n';
import { noticesPreviewRequested } from '@/components/notices/notice-preview';
import { UpdateDialogHost, updateDialogValue } from './update-dialog';
import type { UpdateDialogValue } from './update-dialog-context';
import { useUpdateFlow } from './update-flow';
import {
  UPDATE_PREVIEW_STATES, previewOffer, previewStatusValue, provideUpdatePreview, updatePreviewRequested, usePreviewDriver,
  type UpdatePreviewState,
} from './update-preview';

const STATE_LABEL: Record<UpdatePreviewState, string> = {
  downloading: 'notices.preview.update.state.downloading',
  verified: 'notices.preview.update.state.verified',
  missions: 'notices.preview.update.state.missions',
  network: 'notices.preview.update.state.network',
  cancelled: 'notices.preview.update.state.cancelled',
};

/** The selector's state for where the flow stands; `null` for a step no button names. */
function stateOf(step: string | undefined, last: UpdatePreviewState): UpdatePreviewState | null {
  if (step === 'downloading' || step === 'verifying') return 'downloading';
  if (step === 'download-failed') return 'network';
  if (step === 'missions') return 'missions';
  if (step === 'ready' || step === 'installing') return last === 'cancelled' ? 'cancelled' : 'verified';
  return null;
}

type Timing = { downloadMs?: number; delayMs?: number };

/** One run of the simulation, from `start`: reports the window's value, paints nothing. */
function PreviewRun({ start, timing, onValue, onClose, onInstall }: {
  start: UpdatePreviewState;
  timing: Timing;
  onValue: (value: UpdateDialogValue | null) => void;
  onClose: () => void;
  onInstall: () => void;
}): null {
  const driver = usePreviewDriver({ ...timing, onInstall });
  const offer = useMemo(() => previewOffer(), []);
  const status = useMemo(() => previewStatusValue(driver.control, offer), [driver.control, offer]);
  const { view } = useUpdateFlow(status);
  const value = useMemo(() => (view ? updateDialogValue(status, view, onClose) : null), [onClose, status, view]);

  // Missions and a cancelled password are answers to "Restart and install": click it, as a person would.
  const clickInstall = useRef(false);
  const jump = useRef(driver.jump);
  useEffect(() => { clickInstall.current = jump.current(start); }, [start]);
  useEffect(() => {
    if (!clickInstall.current || value?.step !== 'ready') return;
    clickInstall.current = false;
    value.actions.find((action) => action.marker === 'install')?.run();
  }, [value]);
  useEffect(() => { onValue(value); }, [onValue, value]);
  return null;
}

function PreviewStates({ current, onPick }: { current: UpdatePreviewState | null; onPick: (state: UpdatePreviewState) => void }): ReactElement {
  return (
    <div role="group" aria-label={t('notices.preview.update.states')} className="flex flex-wrap justify-center gap-1" data-update-preview-states="">
      {UPDATE_PREVIEW_STATES.map((state) => (
        <button
          key={state}
          type="button"
          aria-pressed={current === state}
          className={`rounded-md px-2 py-0.5 text-xs transition-colors ${current === state ? 'bg-muted text-foreground' : 'text-muted-foreground/70 hover:bg-muted/60 hover:text-foreground'}`}
          data-update-preview-state={state}
          onClick={() => onPick(state)}
        >
          {t(STATE_LABEL[state])}
        </button>
      ))}
    </div>
  );
}

function UpdatePreview({ openAtStart, timing }: { openAtStart: boolean; timing: Timing }): ReactElement {
  const [open, setOpen] = useState(false);
  const [run, setRun] = useState(0);
  const [start, setStart] = useState<UpdatePreviewState>('downloading');
  const [value, setValue] = useState<UpdateDialogValue | null>(null);

  // A fresh opening forgets the last run's window; a jump keeps it painted while the next run starts.
  const begin = useCallback((state: UpdatePreviewState, fresh = false) => {
    if (fresh) setValue(null);
    setStart(state);
    setRun((n) => n + 1);
    setOpen(true);
  }, []);
  useEffect(() => provideUpdatePreview(() => { begin('downloading', true); }), [begin]);
  useEffect(() => { if (openAtStart) begin('downloading', true); }, [begin, openAtStart]);
  const close = useCallback(() => { setOpen(false); }, []);
  const installed = useCallback(() => {
    setOpen(false);
    toast(t('notices.preview.update.done'));
  }, []);

  return (
    <>
      {open && <PreviewRun key={run} start={start} timing={timing} onValue={setValue} onClose={close} onInstall={installed} />}
      <UpdateDialogHost open={open} onOpenChange={setOpen} value={value}>
        <PreviewStates current={stateOf(value?.step, start)} onPick={(state) => { begin(state); }} />
      </UpdateDialogHost>
    </>
  );
}

/** Mounted once, in the root layout. `downloadMs` and `delayMs` default to the real pace; only tests shorten them. */
export function UpdatePreviewHost({ downloadMs, delayMs }: Timing): ReactElement | null {
  const signedIn = useSyncExternalStore(subscribeNotices, dismissedNoticesLoaded, () => false);
  const [requested, setRequested] = useState<'window' | 'card' | null>(null);
  useEffect(() => {
    const { search } = window.location;
    if (updatePreviewRequested(search)) setRequested('window');
    else if (noticesPreviewRequested(search)) setRequested('card');
  }, []);
  const timing = useMemo(() => ({ downloadMs, delayMs }), [delayMs, downloadMs]);
  if (!requested || !signedIn) return null;
  return <UpdatePreview openAtStart={requested === 'window'} timing={timing} />;
}
