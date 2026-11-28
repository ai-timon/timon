/**
 * Electron half of computer use: screen capture, the global stop shortcut, the on-screen indicator
 * and the agent's ghost pointer.
 * What can be decided without Electron lives in `computer-use-service.ts`; this file only wires it.
 */
import { BrowserWindow, desktopCapturer, globalShortcut, screen, shell, systemPreferences } from 'electron';
import { ComputerUseService } from './computer-use-service.js';
import { startComputerServer } from './computer-use-server.js';
import { createSystemExecutor } from './computer-use-exec.js';
import type { DisplayInfo, ImageSize, Region } from './computer-use-geometry.js';
import { readPointerSettings } from './computer-use-pointer.js';
import { GhostPointer } from './computer-use-overlay.js';

export type ShellText = (key: string, vars?: Record<string, string | number>) => string;

/**
 * macOS swallows ⌘⇧Esc before any app sees it (checked on macOS 26), and Windows keeps Ctrl+Shift+Esc
 * for the Task Manager: both stayed silent although registration succeeded. Neither of these is taken.
 */
export const COMPUTER_STOP_SHORTCUT = process.platform === 'darwin' ? 'Control+Alt+Command+Escape' : 'Control+Alt+Shift+Escape';
const COMPUTER_STOP_SHORTCUT_LABEL = process.platform === 'darwin' ? '⌃⌥⌘Esc' : 'Ctrl+Alt+Shift+Esc';

function primaryDisplay(): DisplayInfo {
  const display = screen.getPrimaryDisplay();
  return { width: display.bounds.width, height: display.bounds.height, scaleFactor: display.scaleFactor, originX: display.bounds.x, originY: display.bounds.y };
}

async function capturePrimary(size: ImageSize, region?: Region): Promise<Buffer | null> {
  const display = screen.getPrimaryDisplay();
  // Asked at the physical size, then resized once with the best filter: the thumbnail is the only capture API.
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: Math.round(display.bounds.width * display.scaleFactor), height: Math.round(display.bounds.height * display.scaleFactor) },
  });
  const source = sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0];
  if (!source || source.thumbnail.isEmpty()) return null;
  let shot = source.thumbnail;
  if (region) {
    // A window capture is a crop of the screen in its pixels: the thumbnail's own size gives the
    // scale, in case the system answered smaller than asked.
    const full = shot.getSize();
    const sx = full.width / display.bounds.width;
    const sy = full.height / display.bounds.height;
    const x = Math.min(Math.max(0, Math.round(region.x * sx)), full.width - 1);
    const y = Math.min(Math.max(0, Math.round(region.y * sy)), full.height - 1);
    const rect = { x, y, width: Math.max(1, Math.min(full.width - x, Math.round(region.width * sx))), height: Math.max(1, Math.min(full.height - y, Math.round(region.height * sy))) };
    let cropped = shot.crop(rect);
    // The same lazy macOS bitmap as below: a copy at full size has one to crop from.
    if (cropped.isEmpty()) cropped = shot.resize({ width: full.width, height: full.height }).crop(rect);
    if (cropped.isEmpty()) return null;
    shot = cropped;
  }
  // Always through resize, even at the same size: on macOS a capture's thumbnail has no bitmap of its
  // own yet and its toJPEG came back empty on the CI runner, while the resized copy encodes.
  const image = shot.resize({ width: size.width, height: size.height, quality: 'best' });
  // JPEG: five to ten times lighter than PNG for a screen, so faster to send and to store in the
  // conversation; quality 75 keeps small text readable. PNG remains when an encoder gives nothing.
  const jpeg = image.toJPEG(75);
  return jpeg.length > 0 ? jpeg : image.toPNG();
}

/** Small always-on-top bar with a Stop button. Hidden from captures so the agent never reads it as part of the task. */
class Indicator {
  private window: BrowserWindow | null = null;
  constructor(private readonly t: ShellText, private readonly onStop: () => void) {}

  show(): void {
    if (this.window && !this.window.isDestroyed()) { this.window.showInactive(); return; }
    const area = screen.getPrimaryDisplay().workArea;
    const width = 420;
    const window = new BrowserWindow({
      width, height: 44, x: Math.round(area.x + (area.width - width) / 2), y: area.y + 8,
      frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
      skipTaskbar: true, focusable: false, show: false, hasShadow: true, alwaysOnTop: true,
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false },
    });
    window.setAlwaysOnTop(true, 'screen-saver');
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    window.setContentProtection(true);
    // The button is a link: the navigation is the click, no script and no preload in this page.
    window.webContents.on('will-navigate', (event) => { event.preventDefault(); this.onStop(); });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(this.page())}`);
    window.once('ready-to-show', () => window.showInactive());
    this.window = window;
  }

  hide(): void {
    if (this.window && !this.window.isDestroyed()) this.window.close();
    this.window = null;
  }

  /** Back over the ghost pointer's sheet, which covers the display at the same level. */
  raise(): void {
    if (this.window && !this.window.isDestroyed()) this.window.moveTop();
  }

  private page(): string {
    const escape = (value: string): string => value.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    const hint = this.t('computerUse.shortcutHint', { shortcut: COMPUTER_STOP_SHORTCUT_LABEL });
    return `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<body style="margin:0;font:13px system-ui,sans-serif;color:#fff"><div style="display:flex;align-items:center;gap:12px;height:44px;box-sizing:border-box;padding:0 12px 0 16px;background:#b3261e;border-radius:22px">
<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis" title="${escape(hint)}">${escape(this.t('computerUse.indicator'))}</span>
<a href="timon-computer-stop:" style="background:#fff;color:#b3261e;text-decoration:none;font-weight:600;padding:6px 14px;border-radius:14px">${escape(this.t('computerUse.stop'))}</a></div></body>`;
  }
}

const SETTINGS_PANES = {
  'permission-screen': 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture',
  'permission-accessibility': 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility',
} as const;

/**
 * macOS shows its prompt only for a grant it never asked about; once refused, only the Settings
 * pane can change it, so that pane is opened instead.
 */
/** The Accessibility prompt shows once per launch; a second ask opens the pane instead. */
let accessibilityPrompted = false;

async function requestMacPermission(reason: 'permission-screen' | 'permission-accessibility'): Promise<void> {
  if (process.platform !== 'darwin') return;
  if (reason === 'permission-screen') {
    if (systemPreferences.getMediaAccessStatus('screen') === 'not-determined') {
      // Asking for a capture is what registers the app and shows the Screen Recording prompt.
      await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1, height: 1 } });
      return;
    }
  } else if (!systemPreferences.isTrustedAccessibilityClient(false) && !accessibilityPrompted) {
    // `true` shows the Accessibility prompt, which itself offers to open Settings.
    accessibilityPrompted = true;
    systemPreferences.isTrustedAccessibilityClient(true);
    return;
  }
  await shell.openExternal(SETTINGS_PANES[reason]);
}

export interface ComputerUseDesktop { close: () => Promise<void>; service: ComputerUseService }

export async function startComputerUse(home: string, t: ShellText, restart?: () => void): Promise<ComputerUseDesktop> {
  let indicator: Indicator | null = null;
  const ghost = new GhostPointer(() => screen.getPrimaryDisplay(), () => indicator?.raise());
  const executor = createSystemExecutor();
  const service: ComputerUseService = new ComputerUseService({
    platform: process.platform,
    env: process.env,
    exec: (command) => executor.run(command),
    display: () => { try { return primaryDisplay(); } catch { return null; } },
    cursor: () => screen.getCursorScreenPoint(),
    pointerMotionMs: () => readPointerSettings(home).motionMs,
    capture: (size) => ghost.withoutGhost(() => capturePrimary(size)),
    screenPermission: () => {
      if (process.platform !== 'darwin') return 'granted';
      const status = systemPreferences.getMediaAccessStatus('screen');
      return status === 'granted' || status === 'not-determined' || status === 'unknown' ? status : 'denied';
    },
    requestPermission: requestMacPermission,
    restart,
    onState: ({ active }) => {
      if (active) { indicator?.show(); return; }
      indicator?.hide();
      ghost.hide();
    },
    // Read at each action: turning the ghost off applies to the next one.
    onPointer: (event, agent) => {
      if (!service.isActive) return;
      if (readPointerSettings(home).ghost) ghost.draw(event, agent); else ghost.hide();
    },
  });
  indicator = new Indicator(t, () => service.stop());
  // A person can always stop, even when the agent has focus on another window.
  const registered = globalShortcut.register(COMPUTER_STOP_SHORTCUT, () => service.stop());
  if (!registered) console.warn('[computer-use] The global stop shortcut is taken by another application; the indicator button still stops.');
  const provider = await startComputerServer(home, (actor, command, allowedApps, mode, agent) => service.handle(actor, command, allowedApps, mode, agent));
  return {
    service,
    close: async () => {
      if (registered) globalShortcut.unregister(COMPUTER_STOP_SHORTCUT);
      service.dispose();
      executor.dispose();
      indicator?.hide();
      ghost.hide();
      await provider.close();
    },
  };
}
