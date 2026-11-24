'use client';

/**
 * Any widget of the catalog as a content of the island workspace
 * (`@timon/ui-layout:widget-card`): a page made of one card, no code.
 *
 * It paints the very card the `WidgetHost` would — same component, same
 * plugin boundary — in the island's body, without its drag handle (the island
 * has its own). A widget that needs the context of a zone it is not in (the
 * chat columns' mission) paints what it paints there; nothing is faked.
 */

import { useEffect, type ReactElement } from 'react';
import { useIslandContent } from '@/components/islands/island-content';
import { useWidgetCatalog } from '@/components/widget-host/use-widget-catalog';
import { t } from '@/lib/i18n';
import type { IslandParams } from '@/lib/island-tree';
import { slotEntries, slotNames } from '@/lib/plugin-host/slots';
import { pluginPlacementId } from '@/components/widget-host/widget-catalog';

export const WIDGET_CARD_KEY = 'widget-card';

/** Placement ids are `plugin:<module>:<key>`; the bound is the params' room, not a guess. */
const WIDGET_ID = /^[A-Za-z0-9@:._/-]{1,200}$/;

/** `{ widget }`: the placement id from `widgets_get`. The catalog says whether it exists. */
export function parseWidgetCardParams(raw: unknown): IslandParams | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const { widget } = raw as Record<string, unknown>;
  if (typeof widget !== 'string' || !WIDGET_ID.test(widget)) return null;
  return { widget };
}

/**
 * Whether the card `params.widget` names takes its island whole on `route`
 * (`WidgetOptions.bareIslandOn`). Read from the registry at each call: a
 * plugin registered late is honoured from its first paint.
 */
export function widgetCardBare(params: IslandParams, view: { route: string }): boolean {
  const id = params.widget;
  if (typeof id !== 'string') return false;
  for (const name of slotNames()) {
    for (const entry of slotEntries(name)) {
      if (!entry.widget?.bareIslandOn || pluginPlacementId(entry.pluginId, entry.key) !== id) continue;
      return entry.widget.bareIslandOn.includes(view.route);
    }
  }
  return false;
}

export function WidgetCardIsland(): ReactElement {
  const { params, setParams, setTitle } = useIslandContent();
  const id = typeof params.widget === 'string' ? params.widget : '';
  // A tab saved before its widget changed id (moved to another module,
  // renamed key) finds the card under its new id.
  const entry = useWidgetCatalog().lookup(id);

  useEffect(() => { if (entry) setTitle(entry.title); }, [entry, setTitle]);
  // Store the current id: `singletonBy: ['widget']` then focuses this tab
  // instead of opening a second one for the same card.
  useEffect(() => { if (entry && entry.id !== id) setParams({ widget: entry.id }); }, [entry, id, setParams]);

  if (!entry) {
    return <p className="p-4 text-[12.5px] text-muted-foreground">{t('islands.widgetCard.missing', { widget: id })}</p>;
  }
  return (
    <div className="flex h-full min-h-0 flex-col overflow-auto">
      {entry.render({ handle: null, className: 'h-full min-h-0' })}
    </div>
  );
}
