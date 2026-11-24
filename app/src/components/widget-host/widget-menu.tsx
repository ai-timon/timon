'use client';

import { useEffect, useState } from 'react';
import { Settings, Trash2, Ungroup } from 'lucide-react';
import * as Dropdown from '@radix-ui/react-dropdown-menu';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { useWidgetHost } from './widget-host';
import { effectiveWidgetStyle, useWidgetStyleDefaults } from './use-widget-style';
import type { WidgetLayout } from './widget-layout';
import type { WidgetMenuItem } from './widget-self';
import { NativeViewCover } from '@/lib/native-view-cover';

export const CONTROL = 'grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

const ITEM = 'flex cursor-pointer items-center gap-2 rounded-md px-2 py-2 outline-none focus:bg-muted';

/** What a right click must leave to the browser: text to copy, a link to open,
 *  a field to paste into. */
const NATIVE = 'input, textarea, select, a[href], [contenteditable=""], [contenteditable="true"]';
export const wantsNativeMenu = (target: EventTarget | null): boolean => target instanceof Element && target.closest(NATIVE) !== null;

/**
 * The widget's settings, shared by the gear and the right-click menu. A bare
 * widget (the top bar's line, a column of icons) has no frame to style, so it
 * only offers to be deleted. Delete comes last and red; it is set apart by
 * spacing and colour, never by a rule.
 */
export function WidgetMenuContent({ entry, grouped, bare, extra, onClose }: { entry: WidgetLayout; grouped: boolean; bare: boolean; extra?: readonly WidgetMenuItem[]; onClose?: () => void }) {
  const host = useWidgetHost();
  const site = useWidgetStyleDefaults();
  const widget = host.widget(entry.id);
  const { borderless, transparent, own: ownStyle } = effectiveWidgetStyle(entry, site);
  return <Dropdown.Portal><Dropdown.Content sideOffset={6} align="end" onCloseAutoFocus={(e) => { if (onClose) e.preventDefault(); }}
    // The content is portalled but React events still bubble through the card:
    // without this a press in the menu would start a drag of the widget.
    onPointerDown={(e) => e.stopPropagation()}
    className="z-50 min-w-48 rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-elev-2">
    <NativeViewCover />
    {/* The widget's own header actions, handed over while it is a tab. */}
    {extra?.map((item) => <Dropdown.Item key={item.key} onSelect={item.onSelect} className={ITEM}>{item.icon ?? <span className="w-3" />}{item.label}</Dropdown.Item>)}
    {!bare && <>
      <Dropdown.Label className={cn('px-2 py-1.5 font-medium', !!extra?.length && 'mt-2')}>{t('widgets.style')}</Dropdown.Label>
      <Dropdown.CheckboxItem checked={borderless} onCheckedChange={(v) => host.onStyle(entry.id, { borderless: v === true })} className={ITEM}><span className="w-3">{borderless ? '✓' : ''}</span>{t('widgets.borderless')}</Dropdown.CheckboxItem>
      <Dropdown.CheckboxItem checked={transparent} onCheckedChange={(v) => host.onStyle(entry.id, { transparent: v === true })} className={ITEM}><span className="w-3">{transparent ? '✓' : ''}</span>{t('widgets.transparent')}</Dropdown.CheckboxItem>
      {!grouped && <Dropdown.CheckboxItem checked={!!entry.untitled} onCheckedChange={(v) => host.onStyle(entry.id, { untitled: v === true })} className={ITEM}><span className="w-3">{entry.untitled ? '✓' : ''}</span>{t('widgets.untitled')}</Dropdown.CheckboxItem>}
      {/* A widget that made its own choice says so, and can go back to following the site's. */}
      {ownStyle && <Dropdown.Item onSelect={() => host.onStyle(entry.id, { borderless: undefined, transparent: undefined })} className={ITEM}><span className="w-3" />{t('widgets.followSiteStyle')}</Dropdown.Item>}
      {grouped && <Dropdown.Item onSelect={() => host.onDetach(entry.id)} className={ITEM}><Ungroup className="size-3" />{t('widgets.detach')}</Dropdown.Item>}
    </>}
    <Dropdown.Item onSelect={() => host.onRemove(entry.id)} aria-label={t('widgets.remove', { title: widget?.title ?? '' })}
      className={cn(ITEM, 'text-destructive focus:bg-destructive/10 focus:text-destructive', !bare && 'mt-2')}>
      <Trash2 className="size-3.5" />{t('widgets.delete')}
    </Dropdown.Item>
  </Dropdown.Content></Dropdown.Portal>;
}

/** The gear: the widget's settings, at the right of its header or tab strip. */
export function WidgetGear({ entry, grouped, bare, extra }: { entry: WidgetLayout; grouped: boolean; bare: boolean; extra?: readonly WidgetMenuItem[] }) {
  const host = useWidgetHost();
  const title = host.widget(entry.id)?.title ?? '';
  return <Dropdown.Root>
    <Dropdown.Trigger asChild><button type="button" aria-label={t('widgets.settingsFor', { title })} title={t('widgets.settings')} className={CONTROL}><Settings className="size-3.5" /></button></Dropdown.Trigger>
    <WidgetMenuContent entry={entry} grouped={grouped} bare={bare} extra={extra} />
  </Dropdown.Root>;
}

/**
 * The same menu opened by a right click. There is no context-menu primitive in
 * the product's dependencies, so a controlled dropdown is anchored on a
 * zero-size element placed under the pointer.
 */
export function WidgetContextMenu({ entry, grouped, bare, extra, at, onClose }: { entry: WidgetLayout; grouped: boolean; bare: boolean; extra?: readonly WidgetMenuItem[]; at: { x: number; y: number } | null; onClose: () => void }) {
  const [anchor, setAnchor] = useState(at);
  useEffect(() => { if (at) setAnchor(at); }, [at]);
  if (!anchor) return null;
  return <Dropdown.Root open={at !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
    <Dropdown.Trigger asChild><span aria-hidden style={{ position: 'fixed', left: anchor.x, top: anchor.y, width: 0, height: 0 }} /></Dropdown.Trigger>
    <WidgetMenuContent entry={entry} grouped={grouped} bare={bare} extra={extra} onClose={onClose} />
  </Dropdown.Root>;
}
