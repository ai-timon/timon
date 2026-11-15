/**
 * "Mascot style" (Settings → Appearance): the 3D plush head by default, the
 * flat 2D drawing on request. Stored per account in the daemon's layout
 * scopes (`/api/ui/layout?scope=mascot.style`), read once per page. Without
 * WebGL2 the 3D choice draws in 2D: the browser cannot render it.
 *
 * The welcome screen offers it before any account exists: the choice then
 * waits in this browser (`MASCOT_STYLE_LOCAL_KEY`) and goes to the account
 * once a session can take it (`mascot-layout-pref.ts`).
 */
import { useSyncExternalStore } from 'react';
import { createMascotLayoutPref, type MascotLayoutPref, type MascotLayoutPrefIo } from './mascot-layout-pref';
import { hasWebGL2 } from './three/tile';

export type MascotStyle = '3d' | '2d';

export const MASCOT_STYLES: readonly MascotStyle[] = ['3d', '2d'];

export const MASCOT_STYLE_SCOPE = 'mascot.style';

/** Browser key of a choice made before the account exists. */
export const MASCOT_STYLE_LOCAL_KEY = 'timon.mascot.style';

/** What the scope holds; anything but an explicit `2d` is the 3D default. */
export function readMascotStyle(raw: unknown): MascotStyle {
  return raw && typeof raw === 'object' && (raw as { style?: unknown }).style === '2d' ? '2d' : '3d';
}

export type MascotStylePref = MascotLayoutPref<MascotStyle>;

export function createMascotStylePref(io: MascotLayoutPrefIo = {}): MascotStylePref {
  return createMascotLayoutPref<MascotStyle>({
    scope: MASCOT_STYLE_SCOPE, initial: '3d', read: readMascotStyle, write: (style) => ({ style }), localKey: MASCOT_STYLE_LOCAL_KEY,
  }, io);
}

let shared: MascotStylePref | null = null;

/** Forgets the page's shared preference, so the next read starts from storage again. */
export function resetMascotStylePrefForTests(): void {
  shared = null;
}

export function mascotStylePref(): MascotStylePref {
  shared ??= createMascotStylePref();
  return shared;
}

const serverStyle = (): MascotStyle => '3d';

/** The style the user picked, whatever the browser can draw. */
export function useMascotStyle(pref: MascotStylePref = mascotStylePref()): MascotStyle {
  return useSyncExternalStore(pref.subscribe, pref.get, serverStyle);
}

const noSubscribe = (): (() => void) => () => {};
/** The server cannot know: it paints 2D, and hydration switches to 3D where the browser can draw it. */
const serverWebGL2 = (): boolean => false;

/** Whether this browser can draw the 3D mascot. */
export function useWebGL2(): boolean {
  return useSyncExternalStore(noSubscribe, hasWebGL2, serverWebGL2);
}

/** `true` when mascots are drawn in 3D: the user's style allows it and the browser can. */
export function useMascot3D(pref: MascotStylePref = mascotStylePref()): boolean {
  const style = useMascotStyle(pref);
  const webgl2 = useWebGL2();
  return style === '3d' && webgl2;
}
