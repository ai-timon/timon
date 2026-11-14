/**
 * Plugin categories on the /settings sidebar: occupants of
 * `settings.section` plus active plugins that declare `timon.settings` or
 * `timon.webhooks` (whose secrets are managed there), deduped. Occupant wins — custom client half vs auto form.
 *
 * Empty (no occupant, no settings) → no item. A disable (`plugins_changed`)
 * drops the item because the loader disposes the slot entry and the catalog
 * row is no longer `active`.
 */
import { APPEARANCE_PLUGIN_ID } from './appearance-options';
import { MACHINES_MODULE } from './machines/fleet';
import { TELEMETRY_MODULE } from './telemetry-preference';
import { t } from './i18n';
import { pluginGalleryLabel } from './plugin-gallery';

export type PluginCatalogRow = {
  id: string;
  label: string | null;
  state: string;
  source?: 'bundled' | 'third-party';
  builtin?: boolean;
  settings?: readonly unknown[];
  webhooks?: readonly string[];
};

export type SettingsPluginOrigin = 'occupant' | 'manifest';

export type SettingsNavItem = {
  slug: string;
  label?: string;
  /** Native API group label, or `null` for Notifications / a plugin category. */
  group: string | null;
  /** Present only for a plugin's own category (not a native group). */
  plugin?: {
    id: string;
    origin: SettingsPluginOrigin;
    label: string;
  };
};

export type SettingsSectionOccupant = {
  pluginId: string;
  order: number;
  seq: number;
};

function pluginLabel(row: PluginCatalogRow | undefined, fallbackId: string): string {
  // Own category of `@timon/ui-theme` is "Appearance", not the gallery "Theme":
  // the pane lists layouts too.
  if (fallbackId === APPEARANCE_PLUGIN_ID) {
    const titled = t('appearance.title');
    if (titled !== 'appearance.title') return titled;
  }
  // Read from the local daemon whatever machine is active: the remote's
  // catalogue may not even know the module.
  if (fallbackId === MACHINES_MODULE) return t('machines.title');
  if (fallbackId === TELEMETRY_MODULE) return t('telemetrySettings.tab');
  if (row) return pluginGalleryLabel(row);
  return fallbackId;
}

export function pluginCategoryItems(
  occupants: readonly SettingsSectionOccupant[],
  catalog: readonly PluginCatalogRow[],
): SettingsNavItem[] {
  const byId = new Map(catalog.map((row) => [row.id, row]));
  const seen = new Set<string>();
  const items: SettingsNavItem[] = [];

  const sortedOccupants = [...occupants].sort((a, b) => (
    a.order === b.order ? a.seq - b.seq : a.order - b.order
  ));
  for (const occ of sortedOccupants) {
    if (seen.has(occ.pluginId)) continue;
    const row = byId.get(occ.pluginId);
    // The catalogue is the active machine's. A half anchored on this computer
    // (Machines) is registered only when it runs here: the remote's state for
    // that id says nothing about it.
    if (row && row.state !== 'active' && occ.pluginId !== MACHINES_MODULE) continue;
    seen.add(occ.pluginId);
    items.push({
      slug: occ.pluginId,
      group: null,
      plugin: {
        id: occ.pluginId,
        origin: 'occupant',
        label: pluginLabel(row, occ.pluginId),
      },
    });
  }

  const manifestOnly = catalog
    .filter((row) => (
      row.state === 'active'
      && ((row.settings?.length ?? 0) > 0 || (row.webhooks?.length ?? 0) > 0)
      && !seen.has(row.id)
    ))
    .sort((a, b) => a.id.localeCompare(b.id));
  for (const row of manifestOnly) {
    seen.add(row.id);
    items.push({
      slug: row.id,
      group: null,
      plugin: {
        id: row.id,
        origin: 'manifest',
        label: pluginLabel(row, row.id),
      },
    });
  }

  return items;
}
