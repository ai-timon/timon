import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * The picture macOS shows for Timon in the Dock once the app runs. Only the
 * running app's icon can follow a choice: the bundle's own `.icns` (Finder,
 * the Dock before launch) is sealed by the signature and stays the classic one.
 */
export const DOCK_ICONS = ['classic', 'dark'] as const;
export type DockIcon = (typeof DOCK_ICONS)[number];

export const DOCK_ICON_CHANNELS = {
  get: 'timon:dock-icon-get',
  set: 'timon:dock-icon-set',
} as const;

/** A shell preference of this computer, next to `machine-schemes.json`: the daemon has no say in the Dock. */
const DOCK_ICON_FILE = 'dock-icon.json';

/** Next to the classic icon in `app/public`, packaged or not. */
const DOCK_ICON_PICTURES: Record<Exclude<DockIcon, 'classic'>, string> = {
  dark: 'icon-512-dark.png',
};

export function isDockIcon(value: unknown): value is DockIcon {
  return typeof value === 'string' && (DOCK_ICONS as readonly string[]).includes(value);
}

/** The chosen icon; a missing or unreadable file is the classic one. */
export function readDockIcon(home: string): DockIcon {
  try {
    const icon = (JSON.parse(readFileSync(join(home, DOCK_ICON_FILE), 'utf8')) as { icon?: unknown }).icon;
    if (isDockIcon(icon)) return icon;
  } catch { /* never chosen, or a damaged file: the classic icon */ }
  return 'classic';
}

/** Writes the choice; `false` when the file could not be written, and the Dock keeps what it shows. */
export function writeDockIcon(home: string, icon: DockIcon): boolean {
  try {
    writeFileSync(join(home, DOCK_ICON_FILE), `${JSON.stringify({ icon })}\n`, { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/** The picture of `icon`, found beside the classic one. */
export function dockIconPath(classicPath: string, icon: DockIcon): string {
  return icon === 'classic' ? classicPath : join(dirname(classicPath), DOCK_ICON_PICTURES[icon]);
}

/** A page's request, checked: one of the known icons, nothing else. */
export function parseDockIconRequest(input: unknown): DockIcon | null {
  if (!input || typeof input !== 'object') return null;
  const { icon } = input as { icon?: unknown };
  return isDockIcon(icon) ? icon : null;
}
