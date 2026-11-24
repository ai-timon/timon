'use client';

import { t } from '@/lib/i18n';
import { HudClock } from '@/components/cockpit/hud-clock';
import { Tile } from '@/components/tile';
import type { WidgetProps } from '@/components/widget-host/widget-props';
import { registerWidget } from './widget';
import { LayoutDashboard } from 'lucide-react';
import { NavDivider } from '@/components/nav-link';
import { NAV_SEPARATOR } from '@/lib/nav-order';
import { NAV_SECONDARY_ORDER, registerNavItem } from './nav';
import type { BundledClientPlugin } from './types';
import { widgetPicto } from './widget-pictos';
import { registerIslandArrangements } from './island-arrangements';
import { AddWidgetCard } from '@/components/widget-host/add-widget-card';
import { ADD_WIDGET_KEYS } from '@/components/widget-host/add-widget';

export const UI_LAYOUT_MODULE = '@timon/ui-layout';

/** The chrome owns the home entry: the cockpit is the layout's own page. */
export const uiLayoutClient: BundledClientPlugin = {
  module: UI_LAYOUT_MODULE,
  apply(ctx) {
    registerWidget(ctx, { key: 'clock', widget: { title: t('widgetCatalog.clock.title'), icon: widgetPicto('clock'), description: t('widgetCatalog.clock.description'), height: 140, minHeight: 110, frame: 'none' }, Component: ClockWidget });
    // "Your widget here", placed by the fresh-install arrangements (`widget-defaults.ts`).
    for (const key of ADD_WIDGET_KEYS) {
      registerWidget(ctx, { key, widget: { title: t('widgets.placeholder.title'), description: t('widgets.placeholder.description'), height: 160, minHeight: 120, frame: 'none' }, Component: AddWidgetCard });
    }
    registerNavItem(ctx, { href: '/', labelKey: 'nav.cockpit', icon: LayoutDashboard, order: 10 });
    // The gap between the main group and the secondary one is a nav entry
    // like any other: it is the chrome's, and it sits at the rank where the
    // two groups meet. Its key makes it a separator of the person's menu,
    // which they may move or remove like the ones they add (TODO #456).
    ctx.register({ slot: 'nav.item', key: NAV_SEPARATOR, order: NAV_SECONDARY_ORDER - 1 }, NavDivider);
    // Named island arrangements: their page and their menu entries. The
    // chrome owns them, as it owns the presets they sit beside.
    registerIslandArrangements(ctx);
  },
};

function ClockWidget({ handle, className }: WidgetProps) {
  return <Tile title={t('widgetCatalog.clock.title')} actions={handle} className={className} bodyClassName="justify-center"><HudClock /></Tile>;
}
