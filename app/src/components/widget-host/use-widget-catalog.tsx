'use client';

import { useMemo, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { Tile } from '@/components/tile';
import { defaultZoneForSlot } from '@/components/cockpit/cockpit-zones';
import type { WidgetProps } from './widget-props';
import { PluginBoundary } from '@/lib/plugin-host/plugin-boundary';
import { slotNature } from '@/lib/plugin-host/slot-compat';
import { slotEntries, slotNames, slotVersion, subscribeSlots } from '@/lib/plugin-host/slots';
import type { SlotEntry } from '@/lib/plugin-host/slots';
import { buildWidgetCatalog, currentWidgetId, type CatalogEntry, type WidgetSlotEntry } from './widget-catalog';

/**
 * The catalog as React sees it: the pure model (`widget-catalog.ts`), plus
 * the component each entry paints.
 *
 * A single source now: the slot registry. The native table
 * (`widget-registry.tsx`) disappeared with the last tile that filled it; the
 * cockpit cards are the registrations of the client halves of `dreams`
 * and `vault`. The host no longer knows any "product" widget: it
 * places what registered, wherever it comes from.
 */

export type RenderableEntry = CatalogEntry & {
  /** Paints the card: framed by the host, or bare if it took its own frame. */
  render: (props: WidgetProps) => ReactNode;
};

export type WidgetCatalog = {
  /** The constraints, in order: what the layout model consumes. */
  entries: CatalogEntry[];
  byId: ReadonlyMap<string, RenderableEntry>;
  /** Like `byId`, but a former id (`formerIds`) leads to its card too. */
  lookup: (id: string) => RenderableEntry | undefined;
};

/**
 * A plugin's body, inside a tile's frame.
 *
 * The ordinary case: a plugin registers a component without props
 * (`ctx.slots.register`); it knows neither the drag handle nor the cross, and
 * does not have to: the host owns these gestures.
 *
 * The other case is `frame: 'none'`: the widget paints its own frame and
 * receives the handle to place it itself in its header. That is what the
 * product tiles do, whose header carries a live subtitle, and whose body (3D
 * canvas, scrolling lists, input fields) would not bear a handle laid on hover
 * (see `widget-props.ts`). Hence two renders, a single placement.
 */
function PluginCard({
  title,
  pluginId,
  Component,
  handle,
  className,
  compact,
}: WidgetProps & { title: string; pluginId: string; Component: React.ComponentType }) {
  // A tile on a 36px line, or around two icons in a narrow sidebar, would be a
  // title bar and little else: a framed widget with a compact form
  // (`bar: true`) is painted bare there.
  if (compact) {
    return (
      <>
        <PluginBoundary pluginId={pluginId}>
          <Component />
        </PluginBoundary>
        {handle}
      </>
    );
  }
  return (
    <Tile title={title} actions={handle} className={cn(className)} bodyClassName="p-0">
      <PluginBoundary pluginId={pluginId}>
        <Component />
      </PluginBoundary>
    </Tile>
  );
}

/** Widget registrations, across all host zones. */
function widgetRegistrations(): Array<{ entry: WidgetSlotEntry; component: SlotEntry }> {
  const out: Array<{ entry: WidgetSlotEntry; component: SlotEntry }> = [];
  for (const slot of slotNames()) {
    if (slotNature(slot) !== 'widget') continue;
    for (const slotEntry of slotEntries(slot)) {
      out.push({
        entry: {
          registrationId: slotEntry.id,
          pluginId: slotEntry.pluginId,
          key: slotEntry.key,
          slot,
          options: slotEntry.widget,
        },
        component: slotEntry,
      });
    }
  }
  return out;
}

export function useWidgetCatalog(): WidgetCatalog {
  // The registry is an external store: without a subscription, a plugin that
  // registers after the first render would only appear at the next render
  // caused by something else. The version also serves as the memo key:
  // recomputing the catalog at every render would change the identity of the
  // constraints, hence of the layout, hence of everything the host publishes,
  // and every widget would re-render continuously (3D canvas included).
  const version = useSyncExternalStore(subscribeSlots, slotVersion, slotVersion);

  return useMemo(() => {
    void version;
    const registrations = widgetRegistrations();
    const entries = buildWidgetCatalog(
      [],
      registrations.map((i) => i.entry),
      defaultZoneForSlot,
    );
    const components = new Map(registrations.map((i) => [i.component.id, i.component]));

    const byId = new Map<string, RenderableEntry>();
    for (const entry of entries) {
      const registration = entry.registrationId ? components.get(entry.registrationId) : null;
      // An entry whose registration has just disappeared: the catalog is live,
      // and a plugin can withdraw between two renders.
      if (!registration) continue;
      // `frame: 'none'`: the widget paints its own frame, like the product tiles
      // whose header carries a live subtitle and the handle. It then receives the
      // same props as a native one; framing it as well would give two borders and
      // two titles.
      // The controls go under `handle`, the SDK's name since API 17, and under
      // `poignee` too, the name a widget written for an earlier API reads.
      const Component = registration.Component as ComponentType<WidgetProps & { poignee: ReactNode }>;
      const bare = registration.widget?.frame === 'none';
      byId.set(entry.id, {
        ...entry,
        render: (props) =>
          bare ? (
            <PluginBoundary pluginId={registration.pluginId}>
              <Component {...props} poignee={props.handle} />
            </PluginBoundary>
          ) : (
            <PluginCard
              {...props}
              title={entry.title}
              pluginId={registration.pluginId}
              Component={registration.Component}
            />
          ),
      });
    }

    const lookup = (id: string) => {
      const current = currentWidgetId(entries, id);
      return current === null ? undefined : byId.get(current);
    };
    return { entries, byId, lookup };
  }, [version]);
}
