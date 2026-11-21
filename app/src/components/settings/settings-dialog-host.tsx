'use client';

import { useEffect, type ReactElement } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import { fetchCapabilities, isPageSurfaceAllowed } from '@/lib/capabilities';
import { SETTINGS_PARAM, useSettingsNavigation } from '@/lib/settings-navigation';
import { isSettingsShortcut } from '@/lib/settings-shortcut';
import { detectTerminalPlatform } from '@/lib/terminal-keys';

/**
 * The dialog and its ~20 panes are fetched the first time `?settings=` shows
 * up, not with the root layout every page loads (docs/BUNDLE-SIZE.md). The
 * dialog itself still decides what an unknown target or a viewer without the
 * surface gets: this gate only checks that a target is asked for at all.
 */
const SettingsDialog = dynamic(
  () => import('./settings-dialog').then((m) => m.SettingsDialog),
  { ssr: false },
);

export function SettingsDialogHost(): ReactElement | null {
  const searchParams = useSearchParams();
  const isOpen = searchParams.get(SETTINGS_PARAM) !== null;
  useSettingsShortcut(isOpen);
  if (!isOpen) return null;
  return <SettingsDialog />;
}

/**
 * Ctrl+, / Cmd+, from any page, a text field included, as in other apps.
 * Capture phase: a menu's search field that stops its keys from bubbling
 * must not swallow an app-wide chord.
 * Pressed again over the open dialog it does nothing: the dialog stays on the
 * tab it shows. The capabilities are read at the press, not at mount, so the
 * sign-in page does not ask for them; a viewer whose gear is hidden gets no
 * dialog from the keyboard either.
 */
function useSettingsShortcut(isOpen: boolean): void {
  const { open } = useSettingsNavigation();
  useEffect(() => {
    if (isOpen) return;
    const platform = detectTerminalPlatform();
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || !isSettingsShortcut(e, platform)) return;
      e.preventDefault();
      void fetchCapabilities().then((caps) => {
        if (caps !== null && isPageSurfaceAllowed(caps, '/settings')) open();
      });
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [isOpen, open]);
}
