/**
 * The frame of the desktop window this page is shown in. Without a title bar
 * of the system, the top bar is the title bar: a drag area, and on Windows and
 * Linux the minimize, maximize and close buttons the page draws itself. On
 * macOS the traffic lights stay the system's, over the left end of the bar.
 *
 * Nothing on the web, in the PWA, with an older desktop or with a window that
 * kept the system's title bar: `readWindowFrame` then resolves to null and the
 * page draws nothing more.
 */

export type WindowControls = 'drawn' | 'native';
export type WindowFrameAction = 'minimize' | 'toggle-maximize' | 'close';

export type WindowFrameState = {
  controls: WindowControls;
  maximized: boolean;
  fullScreen: boolean;
  /** The machine the window drives, as the system title names it. */
  machineName: string | null;
  /**
   * This page is the one the window shows. The shell keeps pages of other
   * machines alive under it, and Electron still applies a hidden page's drag
   * areas, above the page on screen: only this one may have any.
   */
  active: boolean;
};

type FrameBridge = NonNullable<NonNullable<Window['timonDesktop']>['windowFrame']>;

function bridge(): FrameBridge | null {
  if (typeof window === 'undefined') return null;
  const frame = window.timonDesktop?.windowFrame;
  return frame && typeof frame.get === 'function' && typeof frame.act === 'function' && typeof frame.onChange === 'function' ? frame : null;
}

/** What the shell sent, checked: a window with its system title bar is no frame to draw. */
export function parseWindowFrameState(input: unknown): WindowFrameState | null {
  if (!input || typeof input !== 'object') return null;
  const state = input as Record<string, unknown>;
  if (state.frameless !== true) return null;
  if (state.controls !== 'drawn' && state.controls !== 'native') return null;
  const name = typeof state.machineName === 'string' ? state.machineName.trim().slice(0, 120) : '';
  return {
    controls: state.controls,
    maximized: state.maximized === true,
    fullScreen: state.fullScreen === true,
    machineName: name || null,
    // An older shell says nothing: its window holds one page.
    active: state.active !== false,
  };
}

/** The window's frame, or null when the page draws none. */
export async function readWindowFrame(): Promise<WindowFrameState | null> {
  const frame = bridge();
  if (!frame) return null;
  try {
    return parseWindowFrameState(await frame.get());
  } catch {
    // An older shell without the channel, or a page the shell does not trust.
    return null;
  }
}

/** Hears every change of the window: maximized, restored, full screen, another machine. */
export function subscribeWindowFrame(listener: (state: WindowFrameState) => void): () => void {
  const frame = bridge();
  if (!frame) return () => {};
  return frame.onChange((input) => {
    const state = parseWindowFrameState(input);
    if (state) listener(state);
  });
}

/** `true` once the shell took the gesture; the window's own events then tell the new state. */
export async function windowFrameAction(action: WindowFrameAction): Promise<boolean> {
  const frame = bridge();
  if (!frame) return false;
  try {
    await frame.act(action);
    return true;
  } catch {
    return false;
  }
}

/**
 * The room the top bar keeps for the window's buttons: three of them, the one
 * way out of full screen, or the traffic lights at the other end. macOS hides
 * its lights in full screen, and the bar then needs no room at all.
 */
export type FrameRoom = 'drawn' | 'drawn-full-screen' | 'native';

/**
 * What `<html>` carries for the stylesheet: `data-timon-frame` reserves the
 * room in the top bar, `data-timon-drag` turns the drag areas on, for the
 * page on screen only (`active`, and the page's own visibility as a second
 * guard).
 */
export function frameAttributes(state: WindowFrameState | null, visible: boolean): { frame: FrameRoom | null; drag: boolean } {
  if (!state) return { frame: null, drag: false };
  const frame: FrameRoom | null = state.controls === 'native'
    ? (state.fullScreen ? null : 'native')
    : (state.fullScreen ? 'drawn-full-screen' : 'drawn');
  return { frame, drag: state.active && visible };
}
