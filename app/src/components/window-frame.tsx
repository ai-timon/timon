'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Minimize2, Minus, Square, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import {
  frameAttributes, readWindowFrame, subscribeWindowFrame, windowFrameAction, type WindowFrameAction, type WindowFrameState,
} from '@/lib/window-frame';

/** The window's frame, read once from the shell and kept up to date by its events; null everywhere else. */
export function useWindowFrame(): WindowFrameState | null {
  const [state, setState] = useState<WindowFrameState | null>(null);
  useEffect(() => {
    let live = true;
    const stop = subscribeWindowFrame((next) => { if (live) setState(next); });
    void readWindowFrame().then((first) => { if (live && first) setState((current) => current ?? first); });
    return () => { live = false; stop(); };
  }, []);
  return state;
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const sync = () => setVisible(document.visibilityState === 'visible');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);
  return visible;
}

/**
 * The title bar's part of the page, when the desktop window has none of the
 * system's. Mounted once, at the very top of `<body>`:
 *
 * - `<html>` carries `data-timon-frame` and `data-timon-drag`, which the
 *   stylesheet turns into the room kept for the buttons or the traffic lights
 *   and into the drag areas (the top bar, the strip below);
 * - a strip across the top keeps the window movable on pages without a top
 *   bar (sign-in, setup). It comes first in the document on purpose: the
 *   drag areas add up in document order and every control after it cuts
 *   itself out (`app-region: no-drag`), so it never covers a button;
 * - the buttons, on Windows and Linux, go to the end of `<body>` for the same
 *   reason: after every drag area, nothing can cover them.
 */
export function WindowFrame() {
  const state = useWindowFrame();
  const visible = usePageVisible();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const { frame, drag } = frameAttributes(state, visible);
  useEffect(() => {
    const root = document.documentElement;
    if (frame) root.setAttribute('data-timon-frame', frame);
    else root.removeAttribute('data-timon-frame');
    if (drag) root.setAttribute('data-timon-drag', '');
    else root.removeAttribute('data-timon-drag');
  }, [frame, drag]);
  useEffect(() => () => {
    document.documentElement.removeAttribute('data-timon-frame');
    document.documentElement.removeAttribute('data-timon-drag');
  }, []);

  if (!state) return null;
  return (
    <>
      <div aria-hidden className="timon-window-strip" />
      {mounted && state.controls === 'drawn' && createPortal(<WindowControls state={state} />, document.body)}
    </>
  );
}

const BUTTON = 'flex h-9 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * Minimize, maximize or restore, close: the system's three gestures, drawn in
 * the top bar's own style. In full screen only the way out is left.
 */
export function WindowControls({ state }: { state: WindowFrameState }) {
  const act = (action: WindowFrameAction) => () => { void windowFrameAction(action); };
  return (
    <div role="group" aria-label={t('windowFrame.controls')} className="timon-window-controls fixed right-0 top-0 z-[60] flex h-12 items-center gap-0.5 pr-1.5">
      {state.fullScreen ? (
        <button type="button" className={BUTTON} onClick={act('toggle-maximize')} aria-label={t('windowFrame.exitFullScreen')} title={t('windowFrame.exitFullScreen')}>
          <Minimize2 className="size-4" aria-hidden />
        </button>
      ) : (
        <>
          <button type="button" className={BUTTON} onClick={act('minimize')} aria-label={t('windowFrame.minimize')} title={t('windowFrame.minimize')}>
            <Minus className="size-4" aria-hidden />
          </button>
          <button
            type="button"
            className={BUTTON}
            onClick={act('toggle-maximize')}
            aria-label={state.maximized ? t('windowFrame.restore') : t('windowFrame.maximize')}
            title={state.maximized ? t('windowFrame.restore') : t('windowFrame.maximize')}
          >
            {/* The system's own pair: one square to maximize, two stacked to restore. */}
            {state.maximized ? <Copy className="size-3.5 -scale-x-100" aria-hidden /> : <Square className="size-3.5" aria-hidden />}
          </button>
          <button
            type="button"
            className={cn(BUTTON, 'hover:bg-destructive hover:text-destructive-foreground')}
            onClick={act('close')}
            aria-label={t('windowFrame.close')}
            title={t('windowFrame.close')}
          >
            <X className="size-4" aria-hidden />
          </button>
        </>
      )}
    </div>
  );
}

/**
 * The machine the window drives, which the system's title bar used to show:
 * windows on several machines must still be told apart at a glance.
 */
export function WindowMachineName({ className }: { className?: string }) {
  const state = useWindowFrame();
  if (!state?.machineName) return null;
  return (
    <span className={cn('min-w-0 max-w-[14rem] truncate text-xs text-muted-foreground', className)} title={state.machineName}>
      {state.machineName}
    </span>
  );
}
