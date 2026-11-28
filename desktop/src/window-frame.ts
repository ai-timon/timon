/**
 * The main window has no title bar of the operating system: Timon's own top
 * bar takes its place, as a drag area (`app-region: drag` in the page), and
 * carries the window's buttons. Windows and Linux get buttons drawn by the
 * page; macOS keeps its traffic lights, laid over the left end of the bar.
 *
 * The secondary windows (about, update, release check) keep the system frame.
 */

/** Who draws the minimize, maximize and close buttons of a frameless window. */
export type WindowControls = 'drawn' | 'native';

export const WINDOW_FRAME_CHANNELS = {
  get: 'timon:window-frame-get',
  action: 'timon:window-frame-action',
  /** Main to page: the window was maximized, restored, or entered or left full screen. */
  changed: 'timon:window-frame-changed',
} as const;

export const WINDOW_FRAME_ACTIONS = ['minimize', 'toggle-maximize', 'close'] as const;
export type WindowFrameAction = (typeof WINDOW_FRAME_ACTIONS)[number];

/** What a page learns about its window: enough to draw the bar, nothing about the system. */
export type WindowFrameState = {
  frameless: boolean;
  controls: WindowControls;
  maximized: boolean;
  fullScreen: boolean;
  /** The machine the window drives, as its system title names it; null while unknown. */
  machineName: string | null;
  /**
   * This page is the one on screen. The pages of other machines the window
   * keeps alive under it must drop their drag areas: Electron still applies
   * a hidden view's drag areas, above the page on screen.
   */
  active: boolean;
};

/**
 * Set to `1`, the main window keeps the title bar of the system: a window
 * manager that draws its own decorations (a tiling one on Linux), or a person
 * who prefers them.
 */
export const SYSTEM_TITLE_BAR_ENV = 'TIMON_SYSTEM_TITLE_BAR';

/**
 * Where the traffic lights sit, from the window's top-left corner: centred on
 * the top bar's first row (3rem at 100 %), aligned with the logo's margin.
 */
const TRAFFIC_LIGHTS = { x: 16, y: 18 } as const;

export function windowFrameless(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[SYSTEM_TITLE_BAR_ENV] !== '1';
}

export function windowControls(platform: NodeJS.Platform): WindowControls {
  return platform === 'darwin' ? 'native' : 'drawn';
}

/**
 * The options of the main window's `BrowserWindow` that remove the system
 * title bar. Windows keeps its thick frame (the default): resizing by the
 * edges, the shadow and Aero Snap stay the system's.
 */
export function framelessWindowOptions(platform: NodeJS.Platform, frameless: boolean):
  { frame?: false; titleBarStyle?: 'hiddenInset'; trafficLightPosition?: { x: number; y: number } } {
  if (!frameless) return {};
  if (platform === 'darwin') return { titleBarStyle: 'hiddenInset', trafficLightPosition: { ...TRAFFIC_LIGHTS } };
  return { frame: false };
}

export function windowFrameState(
  platform: NodeJS.Platform,
  frameless: boolean,
  window: { maximized: boolean; fullScreen: boolean; machineName: string | null; active: boolean },
): WindowFrameState {
  return {
    frameless,
    controls: windowControls(platform),
    maximized: window.maximized,
    fullScreen: window.fullScreen,
    machineName: window.machineName,
    active: window.active,
  };
}

/** A page's request, checked: one of the three gestures, nothing else. */
export function parseWindowFrameAction(input: unknown): WindowFrameAction | null {
  if (!input || typeof input !== 'object') return null;
  const { action } = input as { action?: unknown };
  return typeof action === 'string' && (WINDOW_FRAME_ACTIONS as readonly string[]).includes(action) ? action as WindowFrameAction : null;
}

/** The part of a `BrowserWindow` a gesture needs: `close` asks, it never destroys. */
export type FramedWindow = {
  minimize(): void;
  maximize(): void;
  unmaximize(): void;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  setFullScreen(flag: boolean): void;
  close(): void;
};

/**
 * Runs a gesture of the drawn buttons. Maximize in full screen leaves full
 * screen first: the button then reads "restore", and a restore that left the
 * window full screen would look like a dead button. `close` goes through the
 * window's `close` event, where every page is asked about unsaved changes.
 */
export function runWindowFrameAction(window: FramedWindow, action: WindowFrameAction): void {
  if (action === 'minimize') window.minimize();
  else if (action === 'close') window.close();
  else if (window.isFullScreen()) window.setFullScreen(false);
  else if (window.isMaximized()) window.unmaximize();
  else window.maximize();
}
