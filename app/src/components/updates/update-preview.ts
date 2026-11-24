'use client';

/**
 * The update window's preview, to judge its design without a version on
 * offer: `/?update-preview=1` opens it at once, and the "Update" button of
 * the demonstration card in `/?notices-preview=1` opens it too.
 *
 * Nothing here talks to the daemon or the desktop shell. The simulator is an
 * `UpdateDownloadControl` made of timers — a download of 0.2.0 that fills in
 * a few seconds, its verification, two running missions at the first
 * install — handed to the real update flow (`useUpdateFlow`,
 * `updateDialogValue`), so the window it paints is the product's, step for
 * step, in the same `updates.dialog` slot. The flow itself carries no preview
 * branch. This module imports no hook that reaches the shell (`useUpdateDownload`)
 * and makes no request: `update-preview.test.ts` reads its source to keep it so.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { UpdateOffer } from '@/lib/updates';
import { clientOs } from '@/lib/updates';
import type { UpdateDownloadControl, UpdateDownloadFormat, UpdateDownloadState, UpdateInstallOutcome } from '@/lib/update-download';
import { CHANGELOG_URL } from '@/lib/update-settings';
import { t } from '@/lib/i18n';
import type { UpdateStatusValue } from './update-status-context';

export const UPDATE_PREVIEW_PARAM = 'update-preview';
export const UPDATE_PREVIEW_VERSION = '0.2.0';
/** How long the simulated download takes; tests shorten it. */
export const UPDATE_PREVIEW_DOWNLOAD_MS = 7_000;
/** The simulated installer's size, about what a real one weighs. */
export const UPDATE_PREVIEW_TOTAL = 148_897_792;
/** Running missions the simulated install finds the first time. */
export const UPDATE_PREVIEW_MISSIONS = 2;
const TICK_MS = 100;

/** The states the preview's selector jumps to. */
export const UPDATE_PREVIEW_STATES = ['downloading', 'verified', 'missions', 'network', 'cancelled'] as const;
export type UpdatePreviewState = typeof UPDATE_PREVIEW_STATES[number];

/** Whether this address asks for the window's preview: `?update-preview=1`. */
export function updatePreviewRequested(search: string): boolean {
  return new URLSearchParams(search).get(UPDATE_PREVIEW_PARAM) === '1';
}

let opener: (() => void) | null = null;

/** Registers the preview's window; returns its removal. Only `UpdatePreviewHost` calls it. */
export function provideUpdatePreview(open: () => void): () => void {
  opener = open;
  return () => { if (opener === open) opener = null; };
}

/** Opens the preview's window; `false` when no preview host is mounted. */
export function openUpdatePreview(): boolean {
  if (!opener) return false;
  opener();
  return true;
}

/** The installer a release would carry for this browser's system. */
function previewInstaller(userAgent: string): { name: string; format: UpdateDownloadFormat } {
  const os = clientOs(userAgent);
  if (os === 'mac') return { name: `Timon-${UPDATE_PREVIEW_VERSION}.pkg`, format: 'pkg' };
  if (os === 'win') return { name: `Timon-Setup-${UPDATE_PREVIEW_VERSION}.exe`, format: 'nsis' };
  return { name: `Timon-${UPDATE_PREVIEW_VERSION}.AppImage`, format: 'appimage' };
}

/** A release published today, with highlights written as the maintainer writes them. */
export function previewOffer(now: number = Date.now()): UpdateOffer {
  const highlights = [
    t('notices.preview.update.highlight1'),
    t('notices.preview.update.highlight2'),
    t('notices.preview.update.highlight3'),
    t('notices.preview.update.highlight4'),
  ].map((line) => `- ${line}`);
  return {
    version: UPDATE_PREVIEW_VERSION,
    publishedAt: new Date(now).toISOString(),
    notes: ['### Highlights', ...highlights].join('\n'),
    notesUrl: CHANGELOG_URL,
    artifacts: [],
  };
}

/** What the real flow runs for, with the simulated control as its download. */
export function previewStatusValue(control: UpdateDownloadControl, offer: UpdateOffer): UpdateStatusValue {
  return {
    installed: '0.1.9',
    channel: 'beta',
    offer,
    installers: [],
    buildExpiresAt: null,
    later: () => undefined,
    download: control,
  };
}

export type UpdatePreviewDriver = {
  control: UpdateDownloadControl;
  /** Puts the simulation at `state`; `true` when the install must be clicked to get there (missions, password cancelled). */
  jump: (state: UpdatePreviewState) => boolean;
};

/**
 * The simulated shell: `start` fills the download over `downloadMs`, then
 * verifies it; `install` finds two missions the first time, then "installs"
 * by calling `onInstall` — nothing is installed, the host closes the window.
 */
export function usePreviewDriver({ downloadMs = UPDATE_PREVIEW_DOWNLOAD_MS, delayMs = 700, onInstall }: {
  downloadMs?: number;
  delayMs?: number;
  onInstall: () => void;
}): UpdatePreviewDriver {
  const installer = useMemo(() => previewInstaller(typeof navigator === 'undefined' ? '' : navigator.userAgent), []);
  const [state, setState] = useState<UpdateDownloadState>({ phase: 'idle' });
  const received = useRef(0);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const missionsAsked = useRef(false);
  const nextInstall = useRef<'install' | 'cancelled'>('install');
  const installRef = useRef(onInstall);
  useEffect(() => { installRef.current = onInstall; }, [onInstall]);

  const stop = useCallback(() => {
    for (const timer of timers.current) { clearTimeout(timer); clearInterval(timer); }
    timers.current = [];
  }, []);
  useEffect(() => stop, [stop]);

  const file = useMemo(() => ({ version: UPDATE_PREVIEW_VERSION, name: installer.name, format: installer.format }), [installer]);
  const ready = useCallback(() => {
    stop();
    received.current = UPDATE_PREVIEW_TOTAL;
    setState({ phase: 'ready', ...file, total: UPDATE_PREVIEW_TOTAL });
  }, [file, stop]);

  const start = useCallback(() => {
    stop();
    if (received.current >= UPDATE_PREVIEW_TOTAL) received.current = 0;
    const step = UPDATE_PREVIEW_TOTAL / Math.max(1, downloadMs / TICK_MS);
    setState({ phase: 'downloading', ...file, received: received.current, total: UPDATE_PREVIEW_TOTAL });
    const interval = setInterval(() => {
      received.current = Math.min(UPDATE_PREVIEW_TOTAL, received.current + step);
      if (received.current < UPDATE_PREVIEW_TOTAL) {
        setState({ phase: 'downloading', ...file, received: Math.round(received.current), total: UPDATE_PREVIEW_TOTAL });
        return;
      }
      stop();
      setState({ phase: 'verifying', ...file, total: UPDATE_PREVIEW_TOTAL });
      timers.current.push(setTimeout(ready, delayMs));
    }, TICK_MS);
    timers.current.push(interval);
  }, [delayMs, downloadMs, file, ready, stop]);

  const control = useMemo((): UpdateDownloadControl => ({
    state,
    start,
    cancel: () => { stop(); received.current = 0; setState({ phase: 'idle' }); },
    openFolder: async () => ({ status: 'opened' }),
    openInstaller: async () => ({ status: 'opened' }),
    install: (confirmed = false) => new Promise<UpdateInstallOutcome>((resolve) => {
      timers.current.push(setTimeout(() => {
        if (nextInstall.current === 'cancelled') {
          nextInstall.current = 'install';
          resolve({ status: 'cancelled' });
          return;
        }
        if (!confirmed && !missionsAsked.current) {
          missionsAsked.current = true;
          resolve({ status: 'missions', count: UPDATE_PREVIEW_MISSIONS });
          return;
        }
        // Back to "ready" in the flow: the window closes on this anyway.
        resolve({ status: 'cancelled' });
        installRef.current();
      }, delayMs));
    }),
  }), [delayMs, start, state, stop]);

  const jump = useCallback((target: UpdatePreviewState): boolean => {
    stop();
    missionsAsked.current = false;
    nextInstall.current = 'install';
    switch (target) {
      case 'downloading':
        received.current = 0;
        start();
        return false;
      case 'network':
        received.current = Math.round(UPDATE_PREVIEW_TOTAL * 0.42);
        setState({ phase: 'failed', version: file.version, name: file.name, code: 'network', resumable: true });
        return false;
      case 'cancelled':
        nextInstall.current = 'cancelled';
        ready();
        return true;
      case 'missions':
        ready();
        return true;
      default:
        ready();
        return false;
    }
  }, [file, ready, start, stop]);

  return { control, jump };
}
