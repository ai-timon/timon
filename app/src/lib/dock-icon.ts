/**
 * The icon macOS shows for Timon in the Dock, kept by the desktop shell of
 * this computer. Nothing on the web, on Windows or Linux, in a window showing
 * another machine, or with an older desktop: the setting is then not offered.
 */
export const DOCK_ICONS = ['classic', 'dark'] as const;
export type DockIcon = (typeof DOCK_ICONS)[number];

export function isDockIcon(value: unknown): value is DockIcon {
  return typeof value === 'string' && (DOCK_ICONS as readonly string[]).includes(value);
}

/** The current choice, or `null` when this window has no Dock to set. */
export async function readDockIcon(): Promise<DockIcon | null> {
  if (typeof window === 'undefined') return null;
  const bridge = window.timonDesktop?.dockIcon;
  if (typeof bridge?.get !== 'function') return null;
  try {
    const state = await bridge.get();
    return state && isDockIcon(state.icon) ? state.icon : null;
  } catch {
    return null;
  }
}

/** `true` once the Dock shows `icon` and the shell kept the choice. */
export async function chooseDockIcon(icon: DockIcon): Promise<boolean> {
  const bridge = typeof window === 'undefined' ? undefined : window.timonDesktop?.dockIcon;
  if (typeof bridge?.set !== 'function') return false;
  try {
    const state = await bridge.set(icon);
    return state?.icon === icon;
  } catch {
    return false;
  }
}
