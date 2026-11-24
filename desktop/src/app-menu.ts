import type { MenuItemConstructorOptions } from 'electron';
import { aboutCopy } from './about.js';
import { shellText } from './shell-i18n.js';
import type { ReloadKeyInput } from './reload-shortcuts.js';
import type { UiZoomDirection } from './ui-zoom.js';

/** "New window" (multi-window V3), in the tray and the macOS File menu. */
export function newWindowCopy(locale: string): { item: string } {
  return { item: shellText(locale)('menu.newWindow') };
}

/**
 * Ctrl+Shift+N (Cmd+Shift+N on macOS) opens a new window. Handled on
 * `before-input-event` like the reload keys: the window hides its menu bar on
 * Windows and Linux, so a menu accelerator alone would not be reliable there.
 */
export function newWindowShortcut(input: ReloadKeyInput, platform: NodeJS.Platform): boolean {
  if (input.type !== 'keyDown' || input.alt || !input.shift) return false;
  const command = platform === 'darwin' ? input.meta : input.control;
  return command && input.key.toLowerCase() === 'n';
}

/**
 * The View menu that sizes the interface itself: Electron's own zoom entries
 * would size the focused page only, and skip the shell's size of every page.
 *
 * The keys are shown, not registered. `registerAccelerator: false` holds on
 * Windows and Linux, which leaves the keys to the page's `before-input-event`
 * handler. On macOS, Cocoa sends the item's key equivalent straight to its
 * `click` before `before-input-event` runs. Either way a key sizes the
 * interface once.
 */
function zoomViewMenu(locale: string, onZoom: (direction: UiZoomDirection) => void): MenuItemConstructorOptions {
  const t = shellText(locale);
  return {
    role: 'viewMenu',
    label: t('menu.view'),
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { label: t('menu.zoomReset'), accelerator: 'CmdOrCtrl+0', registerAccelerator: false, click: () => onZoom('reset') },
      { label: t('menu.zoomIn'), accelerator: 'CmdOrCtrl+Plus', registerAccelerator: false, click: () => onZoom('in') },
      { label: t('menu.zoomOut'), accelerator: 'CmdOrCtrl+-', registerAccelerator: false, click: () => onZoom('out') },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };
}

/**
 * The menu bar.
 *
 * macOS: Electron's default menus, except the "About" entry (TODO #641). The
 * default one opens the native panel, which cannot carry the licences of the
 * speech models; this one opens Timon's window. Edit stays: on macOS Cmd+C
 * and Cmd+V only reach a page through its roles. View keeps its roles but
 * sizes the interface itself.
 *
 * Windows and Linux: Electron's default menus, hidden until Alt is pressed,
 * have no "About", and no application menu is added. With `onZoom`, their
 * View menu is replaced so that View › Zoom In, Zoom Out and Actual Size size
 * the interface like the keys do. Without it, `null`: Electron's menu stays.
 */
export function appMenuTemplate(input: {
  platform: NodeJS.Platform;
  appName: string;
  locale: string;
  onAbout: () => void;
  /** Absent: the File menu stays Electron's own (macOS). */
  onNewWindow?: () => void;
  /** Absent: the View menu stays Electron's own, whose zoom would size one page only. */
  onZoom?: (direction: UiZoomDirection) => void;
}): MenuItemConstructorOptions[] | null {
  if (input.platform !== 'darwin') {
    if (!input.onZoom) return null;
    return [
      { role: 'fileMenu' },
      { role: 'editMenu' },
      zoomViewMenu(input.locale, input.onZoom),
      { role: 'windowMenu' },
    ];
  }
  return [
    {
      label: input.appName,
      submenu: [
        { label: aboutCopy(input.locale).trayItem, click: () => input.onAbout() },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    input.onNewWindow
      ? {
        role: 'fileMenu',
        submenu: [
          // Shown, not registered: the window's own key handler opens it, once.
          { label: newWindowCopy(input.locale).item, accelerator: 'CmdOrCtrl+Shift+N', registerAccelerator: false, click: () => input.onNewWindow?.() },
          { type: 'separator' },
          { role: 'close' },
        ],
      }
      : { role: 'fileMenu' },
    { role: 'editMenu' },
    input.onZoom ? zoomViewMenu(input.locale, input.onZoom) : { role: 'viewMenu' },
    { role: 'windowMenu' },
    { role: 'help', submenu: [] },
  ];
}
