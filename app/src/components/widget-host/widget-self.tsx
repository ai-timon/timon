'use client';

import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';

/**
 * What the host tells a widget about the card that paints it, and the three
 * things a widget may hand back: a count, a reason for attention, and the
 * actions of its header. Open to every plugin (client API 19), not only the
 * product's own widgets.
 *
 * In a stack, a widget's own title is hidden (its tab names it), so a count
 * painted next to that title stood alone at the top of the body and meant
 * nothing; and a header left with a single button kept a whole line for it.
 * The count goes to the tab ("PR 3"), the button to the widget's menu (the
 * gear, or a right click on the tabs): at 300 px the tab strip has no room
 * left for it.
 */
export type WidgetMenuItem = {
  key: string;
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
};

export type WidgetSelf = {
  id: string;
  /** The widget is one tab of a stack. */
  tabbed: boolean;
  /** Its tab is the one in front (a `liveCount` widget stays mounted behind). */
  selected: boolean;
  publishCount: (id: string, count: number | null) => void;
  publishMenu: (id: string, items: readonly WidgetMenuItem[] | null) => void;
  publishAttention: (id: string, label: string | null) => void;
};

const WidgetSelfContext = createContext<WidgetSelf | null>(null);

export const WidgetSelfProvider = WidgetSelfContext.Provider;

/**
 * Publishes the number the widget's tab shows next to its title (nothing for
 * `null` or 0). Returns whether the host shows it: when it does not (a card
 * alone, or outside the widget host), the widget paints it next to its own
 * title. The count leaves with the widget, so a tab never shows a number its
 * widget no longer stands behind.
 */
export function useWidgetCount(count: number | null | undefined): boolean {
  const self = useContext(WidgetSelfContext);
  const publish = self?.publishCount;
  const id = self?.id;
  const value = count ?? null;
  useEffect(() => {
    if (!publish || !id) return;
    publish(id, value);
    return () => { publish(id, null); };
  }, [publish, id, value]);
  return !!self?.tabbed;
}

/**
 * Asks for a dot on the widget's tab while something in it waits for the
 * person ("2 to approve"): `label` names it for the tooltip and a screen
 * reader; `null` or an empty text clears it. Returns whether the host shows
 * it: a card alone has no tab, and the widget's rows already say it.
 */
export function useWidgetAttention(label: string | null | undefined): boolean {
  const self = useContext(WidgetSelfContext);
  const publish = self?.publishAttention;
  const id = self?.id;
  const value = label ? label : null;
  useEffect(() => {
    if (!publish || !id) return;
    publish(id, value);
    return () => { publish(id, null); };
  }, [publish, id, value]);
  return !!self?.tabbed;
}

/**
 * Hands header actions to the widget's menu while it is a tab of a stack.
 * Returns whether it did: when it did not (a card alone), the widget keeps
 * them in its header. Items are republished when their keys or labels change;
 * a click always runs the latest `onSelect`.
 */
export function useWidgetMenu(items: readonly WidgetMenuItem[]): boolean {
  const self = useContext(WidgetSelfContext);
  const publish = self?.publishMenu;
  const id = self?.id;
  const tabbed = !!self?.tabbed;
  const latest = useRef(items);
  latest.current = items;
  const signature = items.map((item) => `${item.key}\u0000${item.label}`).join('\u0001');
  useEffect(() => {
    if (!publish || !id || !tabbed) return;
    publish(id, latest.current.map((item) => ({
      ...item,
      onSelect: () => { latest.current.find((current) => current.key === item.key)?.onSelect(); },
    })));
    return () => { publish(id, null); };
  }, [publish, id, tabbed, signature]);
  return tabbed;
}

/**
 * Whether the widget is in view: always for a card alone, only while its tab
 * is in front for a stacked one kept mounted behind (`liveCount`).
 */
export function useWidgetInFront(): boolean {
  const self = useContext(WidgetSelfContext);
  return !self?.tabbed || self.selected;
}
