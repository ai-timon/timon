/**
 * The ghost pointer's window: transparent, over every window, crossed by the clicks, on the primary
 * display. It exists only while an agent drives the computer and is closed at Stop.
 */
import { BrowserWindow, type Display } from 'electron';
import { GHOST_POINTER_PAGE, ghostPointerCall } from './computer-use-overlay-page.js';
import type { PointerEvent } from './computer-use-pointer.js';

/**
 * How long a hidden window takes to leave the screen before a capture. Content protection already
 * keeps it out of captures on Windows and macOS, but not on Linux, and not with every macOS capture
 * path: hiding it is what works everywhere.
 */
const HIDE_BEFORE_CAPTURE_MS = 80;

export class GhostPointer {
  private window: BrowserWindow | null = null;
  private ready = false;
  private pending: string[] = [];
  private capturing = false;

  /** `onShow` lets the stop bar come back on top: the sheet covers the whole display. */
  constructor(private readonly display: () => Display, private readonly onShow?: () => void) {}

  /** The open window, for the smoke test; null outside a session. */
  get current(): BrowserWindow | null { return this.window && !this.window.isDestroyed() ? this.window : null; }

  draw(event: PointerEvent, agent: string | undefined): void {
    const call = ghostPointerCall(event, agent);
    const window = this.current ?? this.open();
    if (!this.ready) { this.pending.push(call); return; }
    void window.webContents.executeJavaScript(call).catch(() => { /* a closing window: nothing to draw on */ });
  }

  hide(): void {
    this.current?.close();
    this.window = null;
    this.ready = false;
    this.pending = [];
  }

  /** Runs a capture with the sheet off the screen, so the model never reads the pointer as part of the task. */
  async withoutGhost<T>(capture: () => Promise<T>): Promise<T> {
    const window = this.current;
    if (!window || !window.isVisible()) return capture();
    this.capturing = true;
    window.hide();
    try {
      await new Promise((resolve) => setTimeout(resolve, HIDE_BEFORE_CAPTURE_MS));
      return await capture();
    } finally {
      this.capturing = false;
      if (this.current === window) window.showInactive();
    }
  }

  private open(): BrowserWindow {
    const { bounds } = this.display();
    const window = new BrowserWindow({
      ...bounds, title: '', frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
      resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      skipTaskbar: true, focusable: false, show: false, alwaysOnTop: true, enableLargerThanScreen: true,
      // Scripted: the page animates the pointer. Sandboxed, no preload, no Node, its only input is `timonPointer`.
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, spellcheck: false },
    });
    window.setIgnoreMouseEvents(true);
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setContentProtection(true);
    // No title: the window lists of the agent (list_windows) skip untitled windows.
    window.on('page-title-updated', (event) => event.preventDefault());
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.once('did-finish-load', () => {
      if (this.window !== window) return;
      this.ready = true;
      for (const call of this.pending.splice(0)) void window.webContents.executeJavaScript(call).catch(() => {});
      if (!this.capturing) window.showInactive();
      this.onShow?.();
    });
    window.once('closed', () => { if (this.window === window) { this.window = null; this.ready = false; } });
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(GHOST_POINTER_PAGE)}`);
    this.window = window;
    return window;
  }
}
