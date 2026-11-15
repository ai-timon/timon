/**
 * "Animate mascots" (Settings → Appearance), on by default. Off, a mascot
 * still shows its state by its eyes, without moving — as under
 * `prefers-reduced-motion`. Stored per account in the daemon's layout scopes
 * (`/api/ui/layout?scope=mascot.animation`), read once per page.
 */
import { useSyncExternalStore } from 'react';
import type { LayoutIo } from '@/lib/ui-layout-store';
import { createMascotLayoutPref, type MascotLayoutPref } from './mascot-layout-pref';

export const MASCOT_ANIMATION_SCOPE = 'mascot.animation';

/** What the scope holds; anything but an explicit `false` animates. */
export function readMascotAnimation(raw: unknown): boolean {
  return !(raw && typeof raw === 'object' && (raw as { animate?: unknown }).animate === false);
}

export type MascotAnimationPref = MascotLayoutPref<boolean>;

export function createMascotAnimationPref(io: Pick<LayoutIo, 'fetchImpl'> = {}): MascotAnimationPref {
  return createMascotLayoutPref({ scope: MASCOT_ANIMATION_SCOPE, initial: true, read: readMascotAnimation, write: (animate) => ({ animate }) }, io);
}

let shared: MascotAnimationPref | null = null;

export function mascotAnimationPref(): MascotAnimationPref {
  shared ??= createMascotAnimationPref();
  return shared;
}

const serverValue = (): boolean => true;

/** `true` while the user lets the mascots move. */
export function useMascotAnimation(pref: MascotAnimationPref = mascotAnimationPref()): boolean {
  return useSyncExternalStore(pref.subscribe, pref.get, serverValue);
}
