/**
 * The widget catalog: what the host can place, wherever it comes from.
 *
 * The host used to read `widget-registry.tsx`, a table of React components
 * compiled into the app. A plugin widget was rendered apart by `<Slot />`,
 * after the rails, hence never movable, never removable, never persisted. Two
 * sources, only one placed: that was the gap of §10.12.
 *
 * The slot registry is now the only source of placement: the cockpit tiles are
 * the registrations of the client halves of `dreams` and `vault`, and
 * the native table no longer exists.
 * The `natives` parameter stays the entry point for entries that would not come
 * from the registry; it is empty in the product.
 *
 * Pure module: no React, no slot registry. The slot entries are passed to it,
 * the components are zipped back by the `.tsx` layer; that is what keeps the
 * model testable under `node --test`.
 */

import type { WidgetOptions } from '@/lib/plugin-host/slots';
import type { WidgetConstraints, ZoneId } from './widget-layout';

/** A widget registration in a slot, as the registry reports it. */
export type WidgetSlotEntry = {
  /**
   * Registration id (`<pluginId>:<n>`). It changes at every reload, hence
   * the stable placement id computed below.
   */
  registrationId: string;
  pluginId: string;
  /** Key given by the plugin when it registers several widgets. */
  key?: string;
  /** Registration slot, necessarily of the `widget` kind. */
  slot: string;
  /** What the registration declares about itself: title, heights, frame, zone. */
  options?: WidgetOptions;
};

export type CatalogEntry = WidgetConstraints & {
  title: string;
  /**
   * Plugin that registers this widget. Absent for a native entry. It is not
   * enough to tell two same-named widgets apart (one module often paints both
   * the cockpit card and the chat card), hence `widgetOrigin` below.
   */
  pluginId?: string;
  /**
   * Declared slots, submitted as is to admission (`slot-compat.ts`). For a
   * plugin widget it is its registration slot: it is `*.widget`, so it opens
   * by nature every host zone; admission unchanged.
   */
  slots: readonly string[];
  /** Registration painted by this entry; `null` for a native widget. */
  registrationId: string | null;
  /** Admitted in a horizontal zone (`WidgetOptions.bar`). */
  bar?: boolean;
  /** One sentence on what the widget does, read in the widget window. */
  description?: string;
  /** Name in the widget window when `title` is the user's. */
  catalogTitle?: string;
  /** Glyph of the card in the widget window (`WidgetOptions.icon`). */
  icon?: string;
  /** Name on its tab in a stack (`WidgetOptions.tabTitle`). */
  tabTitle?: string;
  /** Kept mounted behind its stack's front tab (`WidgetOptions.liveCount`). */
  liveCount?: boolean;
};

/**
 * Heights of a plugin widget. A plugin does not declare them yet (the manifest
 * does not carry them), and leaving them undefined would make
 * `mergeLayout` clamp on `undefined`, hence persist `NaN`s.
 */
export const PLUGIN_DEFAULT_HEIGHT = 260;
export const PLUGIN_MIN_HEIGHT = 120;

/** Prefix of the placement ids of plugin widgets. */
export const PLUGIN_ID_PREFIX = 'plugin:';

/**
 * Id under which a plugin widget's placement is written.
 *
 * It must survive reloads: the registration id carries a session counter, and
 * using it would put every card back at its default place at every F5. The
 * (plugin, key) pair is what the plugin controls and repeats.
 */
export function pluginPlacementId(pluginId: string, key?: string): string {
  return `${PLUGIN_ID_PREFIX}${pluginId}${key ? `:${key}` : ''}`;
}

/** Same-module former keys, then the cross-module ids a bundled widget may carry. */
function formerIdsOf(pluginId: string, options: WidgetOptions | undefined): string[] {
  const ids = (options?.formerKeys ?? []).map((k) => pluginPlacementId(pluginId, k || undefined));
  if (pluginId.startsWith('@timon/')) ids.push(...(options?.formerIds ?? []));
  return ids;
}

/**
 * Merges the native widgets and the slot registrations into a catalog.
 *
 * Natives come first and keep their default ranks; plugin widgets are added
 * after them, in the order the registry reports them.
 *
 * `defaultZoneForSlot` translates a slot into a first-placement zone. It is
 * injected, as `isVisible` is into `widgetsAllowedByConfig`: the only known
 * exception is the cockpit, whose two rails share the `cockpit.widget` slot
 * (see `widget-dnd.ts`), and that knowledge belongs to the cockpit, not to the
 * model. By default the zone carries the slot's name, which is true of
 * `sidebar.left.widget`, `sidebar.right.widget` and any zone a third-party
 * layout would declare.
 */
export function buildWidgetCatalog(
  natives: readonly CatalogEntry[],
  entries: readonly WidgetSlotEntry[],
  defaultZoneForSlot: (slot: string) => ZoneId = (slot) => slot,
): CatalogEntry[] {
  const catalog = [...natives];
  const seen = new Set(catalog.map((e) => e.id));

  for (const entry of entries) {
    const stable = pluginPlacementId(entry.pluginId, entry.key);
    // Two registrations of the same plugin without distinct keys: the second
    // cannot claim the same placement. It falls back on its registration id: it
    // shows and moves, but goes back to its default place on reload. A key in
    // the plugin manifest fixes that.
    const id = seen.has(stable) ? entry.registrationId : stable;
    if (seen.has(id)) continue;
    seen.add(id);
    const options = entry.options;
    catalog.push({
      id,
      title: options?.title ?? entry.key ?? entry.pluginId,
      pluginId: entry.pluginId,
      slots: [entry.slot],
      registrationId: entry.registrationId,
      defaultHeight: options?.height ?? PLUGIN_DEFAULT_HEIGHT,
      minHeight: options?.minHeight ?? PLUGIN_MIN_HEIGHT,
      ...(options?.heightMode ? { heightMode: options.heightMode } : {}),
      ...(options?.bar ? { bar: true } : {}),
      ...(options?.description ? { description: options.description } : {}),
      ...(options?.catalogTitle ? { catalogTitle: options.catalogTitle } : {}),
      ...(options?.icon ? { icon: options.icon } : {}),
      ...(options?.tabTitle ? { tabTitle: options.tabTitle } : {}),
      ...(options?.liveCount ? { liveCount: true } : {}),
      ...(options?.placedByDefault ? { placedByDefault: true } : {}),
      ...(formerIdsOf(entry.pluginId, options).length ? { formerIds: formerIdsOf(entry.pluginId, options) } : {}),
      // The declared zone is only a first-placement preference: the slot alone
      // cannot give it when two zones share it (the cockpit rails). Nothing checks
      // it here: the model does not know which zones are mounted, and a missing
      // zone simply leaves the card waiting for it.
      defaultZone: options?.zone ?? defaultZoneForSlot(entry.slot),
      defaultRank: catalog.length,
    });
  }

  return catalog;
}

/**
 * Current id of a widget named by an id it carried before (`formerIds`).
 *
 * `inheritedPlacement` only migrates the host's layout; an id written elsewhere
 * (an island tab) must find its card too. A current id always wins; when two
 * widgets claim the same former id, the first in the catalog keeps it.
 */
export function currentWidgetId(entries: readonly CatalogEntry[], id: string): string | null {
  if (entries.some((e) => e.id === id)) return id;
  return entries.find((e) => e.formerIds?.includes(id))?.id ?? null;
}

/**
 * Slots whose surface we can name for a human, as i18n keys.
 *
 * The palette shows this surface under the title: two widgets can share
 * `title` AND plugin (the two "Missions" both come from `@timon/missions`),
 * and it is the slot that tells which one paints the cockpit and which one
 * paints the chat rail. An unknown slot (a third-party layout's) is shown as
 * is: a readable id is better than nothing.
 */
/** The middle of the top bar, between the logo and the controls: a line like
 *  `topbar.widget`, where the Working agents widget starts (TODO #479). */
export const TOPBAR_CENTER_ZONE = 'topbar.center.widget';

const SURFACE_KEYS: Record<string, string> = {
  'cockpit.widget': 'widgets.surface.cockpit',
  'chat.left.widget': 'widgets.surface.chatLeft',
  'chat.right.widget': 'widgets.surface.chatRight',
  'sidebar.left.widget': 'widgets.surface.sidebarLeft',
  'sidebar.right.widget': 'widgets.surface.sidebarRight',
  'topbar.widget': 'widgets.surface.topbar',
  [TOPBAR_CENTER_ZONE]: 'widgets.surface.topbar',
};

export type WidgetOrigin = {
  /** i18n key of the surface, `null` when the slot has none. */
  surfaceKey: string | null;
  /** Fallback name, shown when `surfaceKey` is `null`. */
  surface: string;
  /** Short plugin name (`@timon/missions` → `missions`), `null` if native. */
  plugin: string | null;
};

/**
 * Where a widget comes from: the surface it lives in by default, and its plugin.
 *
 * The declared slot wins over `defaultZone`: the latter can carry a zone
 * internal to the cockpit (`gauche`), which only makes sense for the cockpit,
 * whereas the slot names the surface for everyone. Except when `defaultZone`
 * is itself a known surface (`topbar.widget`, a sidebar).
 */
export function widgetOrigin(entry: CatalogEntry): WidgetOrigin {
  // A product zone named as first placement (the top bar, a sidebar) says
  // more than the registration slot every bundled widget shares.
  const slot = SURFACE_KEYS[entry.defaultZone] ? entry.defaultZone : entry.slots[0] ?? entry.defaultZone;
  const plugin = entry.pluginId?.replace(/^@[^/]+\//, '') ?? null;
  return { surfaceKey: SURFACE_KEYS[slot] ?? null, surface: slot, plugin };
}

/** The page a widget belongs to in the widget window: where it is at home, which
 *  is what the user looks for it by. Admission is wider (a `*.widget` slot opens
 *  every host zone), so this reads the first placement, not the admission. */
export type WidgetPage = 'cockpit' | 'chat' | 'agents' | 'sidebars' | 'topbar';
export const WIDGET_PAGES: readonly WidgetPage[] = ['cockpit', 'chat', 'agents', 'sidebars', 'topbar'];

export function widgetPage(entry: CatalogEntry): WidgetPage {
  for (const zone of [entry.defaultZone, entry.slots[0] ?? '']) {
    if (zone.startsWith('chat.')) return 'chat';
    if (zone.startsWith('agents.')) return 'agents';
    if (zone.startsWith('topbar.')) return 'topbar';
    if (zone.startsWith('sidebar.')) return 'sidebars';
  }
  return 'cockpit';
}
