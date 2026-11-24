'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useDraggable, useDroppable } from '@dnd-kit/core';
import { GripHorizontal, GripVertical } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useMobile } from '@/hooks/use-mobile';
import { t } from '@/lib/i18n';
import { useWidgetHost } from './widget-host';
import { insertionSide, type WidgetLayout } from './widget-layout';
import { CONTROL, WidgetContextMenu, WidgetGear, wantsNativeMenu } from './widget-menu';
import { effectiveWidgetStyle, useWidgetStyleDefaults } from './use-widget-style';
import { WidgetSelfProvider, type WidgetMenuItem } from './widget-self';
import type { WidgetOrientation } from './widget-dnd';

/** Side where the insertion cursor is drawn on `targetId`. A widget coming
 *  from another stack has no rank here: it lands BEFORE the hovered tab,
 *  which the drop applies literally. */
function cursorSide(members: WidgetLayout[], dragging: string | null, targetId: string): 'avant' | 'apres' | null {
  if (!dragging || dragging === targetId) return null;
  if (!members.some((m) => m.id === dragging)) return 'avant';
  return insertionSide(members, dragging, targetId);
}

/** A tab is a drag source AND a drop target, at any time: a stack is reordered
 *  between its tabs, not in the card's body, which belongs to docking. */
function WidgetTab({ entry, selected, onSelect, panelId, side, count, attention }: { entry: WidgetLayout; selected: boolean; onSelect: () => void; panelId: string; side: 'avant' | 'apres' | null; count: number | null; attention: string | null }) {
  const host = useWidgetHost();
  const widget = host.widget(entry.id);
  // A short name on the tab, the full one in the tooltip and for a screen reader.
  const short = widget?.tabTitle && widget.tabTitle !== widget.title ? widget.tabTitle : null;
  const { listeners, setNodeRef, isDragging } = useDraggable({ id: entry.id });
  const { setNodeRef: setDropRef, isOver } = useDroppable({ id: `tab:${entry.id}`, disabled: !host.editing || host.dragging === entry.id });
  const cursor = isOver && side !== null && host.dragging !== entry.id ? side : null;
  // Only the pointer lifts a tab: dnd-kit's attributes and keyboard listener
  // would turn Enter and Space on a tab into a drag. A tab keeps its tab
  // semantics; the stack's grip carries the keyboard drag.
  return <button ref={(node) => { setNodeRef(node); setDropRef(node); }} type="button"
    onPointerDown={listeners?.onPointerDown as React.PointerEventHandler<HTMLButtonElement> | undefined}
    role="tab" id={`tab-${entry.id}`} aria-controls={panelId} aria-selected={selected}
    tabIndex={selected ? 0 : -1} onClick={onSelect}
    // The full name and what waits in it, for the tooltip and a screen reader;
    // a plain tab keeps its own text as its name.
    title={short || attention ? [short ? widget?.title : null, attention].filter(Boolean).join(' · ') : undefined}
    aria-label={(short || attention) && widget ? [[widget.title, count || null].filter(Boolean).join(' '), attention].filter(Boolean).join(' · ') : undefined}
    // Five French tabs fit a 300 px rail. Past that (a count of two digits, a
    // wider system font), the strip goes tight (`fitTabs`), then the tabs
    // shrink and truncate their title, keeping the count, before it scrolls.
    className={cn('widget-tab relative flex h-7 min-w-10 shrink items-center justify-center gap-1 rounded-md px-[5px] text-[11.5px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring', selected ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground', isDragging && 'opacity-40')}>
    {/* A line BETWEEN two tabs, not a highlighted tab: highlighting the
        target shows what is hovered, which still leaves you guessing on which
        side the tab will fall. The side is the one `insertionSide` will decide
        on drop; same function, so the line cannot lie. */}
    {cursor && <span aria-hidden data-cursor={cursor} className={cn('pointer-events-none absolute inset-y-0.5 z-10 w-[3px] rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]', cursor === 'avant' ? '-left-[2px]' : '-right-[2px]')} />}
    <span data-tab-title="" className="min-w-0 max-w-40 truncate">{short ?? widget?.title}</span>
    {!!count && <span data-tab-count="" className="shrink-0 tabular-nums text-muted-foreground">{count}</span>}
    {attention && <span aria-hidden data-tab-attention="" className="size-1.5 shrink-0 rounded-full bg-amber-500" />}
  </button>;
}

/** The free space after the tab group: the target that puts a widget at the
 *  END of the stack. A tab only orders around itself, and a widget from
 *  elsewhere lands before it; without this target, the last place was out of
 *  reach. Outside the tablist, `min-w-6` keeps it visible even when the tabs
 *  overflow. */
function WidgetTabEnd({ entry, members }: { entry: WidgetLayout; members: WidgetLayout[] }) {
  const host = useWidgetHost();
  const { setNodeRef, isOver } = useDroppable({ id: `tab-end:${entry.id}`, disabled: !host.editing });
  // Already last: the drop changes nothing, the line must promise nothing.
  const cursor = isOver && !!host.dragging && members[members.length - 1]?.id !== host.dragging;
  return <div ref={setNodeRef} aria-hidden className="relative h-8 min-w-1 flex-1 self-center">
    {cursor && <span className="pointer-events-none absolute inset-y-0.5 left-0 z-10 w-[3px] rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]" />}
  </div>;
}

/**
 * Tightens a stack's tab strip (`data-tight`, smaller padding and type) only
 * when a title would otherwise be cut: measured, since what fits depends on
 * the language, the counts and the system's font. Reset first so a strip that
 * grew wider goes back to its roomy form.
 */
export function fitTabs(list: HTMLElement): void {
  delete list.dataset.tight;
  const cut = Array.from(list.querySelectorAll<HTMLElement>('[data-tab-title]')).some((title) => title.scrollWidth > title.clientWidth);
  if (cut) list.dataset.tight = '';
}

/** What a press may never lift the card from: the controls inside the title
 *  bar keep their own click, and a tab lifts itself. */
const INTERACTIVE = 'button, a[href], input, textarea, select, label, summary, [role="button"], [role="tab"], [role="menuitem"], [role="slider"], [contenteditable=""], [contenteditable="true"], [data-no-drag]';

/** Height of the strip a card without a header row is lifted by. */
const HEADERLESS_STRIP = 28;

/** How long the pointer rests on a title before the drag hint shows. */
export const DRAG_HINT_DELAY = 2000;

/** The widget's own title bar: the header of the section it paints, if any. */
function headerOf(frame: HTMLElement): HTMLElement | null {
  return frame.querySelector<HTMLElement>(':scope > .widget-content > section > header');
}

/**
 * Whether a press at `target` lifts the card: its title bar, a stack's tab
 * strip (between the tabs), the whole of a bare form — never a control. A card
 * that paints no header is lifted by its top strip.
 */
export function isOnTitleHandle(
  frame: HTMLElement, target: Element, clientY: number, shape: { bare: boolean; tabbed: boolean }, includeTabs = false,
): boolean {
  if (!frame.contains(target)) return false;
  // A stack's tabs ARE its titles: they arm the hint and take the right
  // click. They are left out of the press only, since each lifts itself.
  const tab = shape.tabbed && includeTabs ? target.closest('.widget-tabbar [role="tab"]') : null;
  if (tab && frame.contains(tab)) return true;
  const control = target.closest(INTERACTIVE);
  if (control && frame.contains(control)) return false;
  if (shape.bare) return true;
  if (shape.tabbed) return !!target.closest('.widget-tabbar');
  const header = headerOf(frame);
  if (header) return header.contains(target);
  return clientY - frame.getBoundingClientRect().top <= HEADERLESS_STRIP;
}

/** A stack has a tab strip and a single visible body. Tabs themselves remain
 * drag sources so they can be detached, reordered or docked into another stack.
 *
 * There is no layout mode: a card is lifted by its title at any time. Resting
 * the pointer on the title for `DRAG_HINT_DELAY` shows the hint — the grab
 * cursor, and a small pill with the grip and the gear at the top of the card
 * (`data-drag-ready`). The gear's menu also opens by a right click on the
 * title. Heights are the zone's business (`WidgetZone`): a card only receives
 * its share of the column, `part`.
 *
 * On a horizontal zone (the top bar) a card has no frame of its own: no height,
 * no style menu, no docking — a stack of tabs has no room on a 36px line. Only
 * the grip and the gear remain, next to the widget's flat form, once hinted.
 *
 * A compact column (a sidebar) does the same for a widget that has a compact
 * form (`bar: true`) and stands alone: it takes its natural height, its icons
 * stacked. Any other widget keeps its card there, and a stack keeps its tabs. */
export function WidgetCard({ entry, members = [entry], part, orientation = 'vertical', compact = false }: {
  entry: WidgetLayout;
  members?: WidgetLayout[];
  /** Share of the column's height (a flex weight); absent = natural height. */
  part?: number;
  orientation?: WidgetOrientation;
  /** The zone is a narrow column: a widget with a compact form paints it. */
  compact?: boolean;
}) {
  const host = useWidgetHost();
  const siteStyle = useWidgetStyleDefaults();
  const style = effectiveWidgetStyle(entry, siteStyle);
  const widget = host.widget(entry.id);
  const horizontal = orientation === 'horizontal';
  const grouped = members.length > 1 && !horizontal;
  // The frame-less form: always on a line, and in a compact column for a lone
  // widget that knows how to paint it.
  const bare = horizontal || (compact && !grouped && widget?.bar === true);
  // Only a stack has tabs: a lone widget shows its title in its own header,
  // and an untitled one drops even that — a stack ignores the flag, it needs
  // its tabs.
  const untitled = !grouped && !!entry.untitled;
  const tabbed = grouped;
  const { attributes, listeners, setNodeRef, setActivatorNodeRef, isDragging } = useDraggable({ id: tabbed ? `frame:${entry.id}` : entry.id });
  const [menuAt, setMenuAt] = useState<{ x: number; y: number } | null>(null);
  const { setNodeRef: setDockRef, isOver } = useDroppable({ id: `dock:${entry.id}`, disabled: bare || !host.editing || host.dragging === entry.id });
  const mobile = useMobile();
  const tablist = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement | null>(null);
  const memberKey = members.map((m) => m.id).join('|');
  // Counts published by the stack's widgets (`useWidgetCount`), shown on their tabs.
  const [counts, setCounts] = useState<Record<string, number | null>>({});
  const publishCount = useCallback((id: string, count: number | null) => {
    setCounts((current) => (current[id] ?? null) === count ? current : { ...current, [id]: count });
  }, []);
  // What waits for the person in a stacked widget (`useWidgetAttention`): a dot on its tab.
  const [attentions, setAttentions] = useState<Record<string, string | null>>({});
  const publishAttention = useCallback((id: string, label: string | null) => {
    setAttentions((current) => (current[id] ?? null) === label ? current : { ...current, [id]: label });
  }, []);
  // Header actions a stacked widget hands to its menu (`useWidgetMenu`).
  const [menus, setMenus] = useState<Record<string, readonly WidgetMenuItem[] | null>>({});
  const publishMenu = useCallback((id: string, items: readonly WidgetMenuItem[] | null) => {
    setMenus((current) => (current[id] ?? null) === items ? current : { ...current, [id]: items });
  }, []);
  // The drag hint: armed while the pointer rests on the title, shown after
  // the delay, kept until the pointer leaves the card — the pill it shows
  // sits below the title, and must stay while the pointer goes to it.
  const [hintShown, setHintShown] = useState(false);
  const hintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const disarm = useCallback(() => {
    if (hintTimer.current !== null) { clearTimeout(hintTimer.current); hintTimer.current = null; }
  }, []);
  useEffect(() => disarm, [disarm]);
  useEffect(() => { if (host.dragging) { disarm(); setHintShown(false); } }, [host.dragging, disarm]);
  // The scrollbar is hidden, so a mouse without a horizontal wheel needs its
  // vertical wheel translated. Non-passive listener (React's onWheel is passive,
  // it cannot preventDefault), and only while the strip can still move that
  // way: at either end the page keeps its scroll.
  useEffect(() => {
    const el = tablist.current;
    if (!tabbed || !el) return;
    const onWheel = (e: WheelEvent) => {
      if (el.scrollWidth <= el.clientWidth + 1 || Math.abs(e.deltaX) >= Math.abs(e.deltaY)) return;
      const delta = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientWidth : 1);
      const max = el.scrollWidth - el.clientWidth;
      if ((delta < 0 && el.scrollLeft <= 0) || (delta > 0 && el.scrollLeft >= max - 1)) return;
      e.preventDefault();
      el.scrollLeft = Math.min(max, Math.max(0, el.scrollLeft + delta));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => { el.removeEventListener('wheel', onWheel); };
  }, [tabbed, memberKey]);
  // The strip's width follows the card's, not its own content: observing the
  // tab bar cannot loop on the change `fitTabs` makes.
  const badgesKey = members.map(({ id }) => `${counts[id] ?? ''}:${attentions[id] ? 'dot' : ''}`).join('|');
  useLayoutEffect(() => {
    const el = tablist.current;
    const bar = el?.parentElement;
    if (!tabbed || !el || !bar) return;
    fitTabs(el);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => fitTabs(el));
    observer.observe(bar);
    return () => observer.disconnect();
  }, [tabbed, memberKey, badgesKey]);
  // Brings the selected tab back into view, keyboard included. Done by hand on
  // the strip: `scrollIntoView` would also scroll the page to a card below the
  // fold when it mounts.
  useEffect(() => {
    const el = tablist.current;
    const tab = el?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
    if (!el || !tab) return;
    const box = el.getBoundingClientRect();
    const rect = tab.getBoundingClientRect();
    const left = rect.left - box.left + el.scrollLeft;
    const right = left + rect.width;
    if (left < el.scrollLeft) el.scrollLeft = left;
    else if (right > el.scrollLeft + el.clientWidth) el.scrollLeft = right - el.clientWidth;
  }, [entry.id, memberKey]);
  if (!widget) return null;
  const minimum = Math.max(...members.map((member) => host.widget(member.id)?.minHeight ?? 0)) + (tabbed ? 46 : 0);
  const shape = { bare, tabbed };
  const onTitle = (e: { target: EventTarget | null; clientY: number }, includeTabs = false) =>
    !!frame.current && e.target instanceof Element && isOnTitleHandle(frame.current, e.target, e.clientY, shape, includeTabs);
  // Keyboard drag goes through the grip (a real button), shown in the pill.
  const grip = <button type="button" ref={setActivatorNodeRef} aria-label={t('cockpit.board.move', { title: widget.title })} className={cn(CONTROL, 'cursor-grab touch-none active:cursor-grabbing')} {...attributes} {...listeners}>{bare ? <GripVertical className="size-3.5" /> : <GripHorizontal className="size-3.5" />}</button>;
  const extra = menus[entry.id] ?? undefined;
  const gear = <WidgetGear entry={entry} grouped={grouped} bare={bare} extra={extra} />;
  // A bare form has no title bar to float a pill over: the grip leads, the
  // gear follows it, in a box as tall as the line — once hinted.
  const showTools = hintShown || host.paletteOpen;
  const inline = bare && showTools ? <span className="flex shrink-0 items-center self-center">{gear}</span> : null;
  const leadingGrip = bare && showTools ? <span className="flex shrink-0 items-center self-center">{grip}</span> : null;
  const openMenu = (e: React.MouseEvent) => { e.preventDefault(); setMenuAt({ x: e.clientX, y: e.clientY }); };
  return <div ref={(node) => { setNodeRef(node); frame.current = node; }}
    onPointerDown={(e) => {
      if (e.button !== 0 || !onTitle(e)) return;
      (listeners?.onPointerDown as React.PointerEventHandler<HTMLDivElement> | undefined)?.(e);
    }}
    onPointerMove={(e) => {
      if (e.pointerType !== 'mouse' || host.dragging || hintShown) return;
      if (!onTitle(e, true)) { disarm(); return; }
      if (hintTimer.current === null) hintTimer.current = setTimeout(() => { hintTimer.current = null; setHintShown(true); }, DRAG_HINT_DELAY);
    }}
    onPointerLeave={() => { disarm(); setHintShown(false); }}
    // The title bar's right click is the gear's menu; a stack's strip brings
    // the tab under the pointer forward first, the menu is about it.
    onContextMenu={(e) => {
      if (wantsNativeMenu(e.target) || !onTitle(e, true)) return;
      if (tabbed) {
        const tab = (e.target as Element).closest<HTMLElement>('[role="tab"]');
        const id = tab?.id.startsWith('tab-') ? tab.id.slice(4) : null;
        if (id && id !== entry.id) host.onSelectTab(id);
      }
      openMenu(e);
    }}
    data-widget-id={entry.id} data-borderless={style.borderless || undefined} data-transparent={style.transparent || undefined} data-tabbed={tabbed || undefined} data-untitled={untitled || undefined}
    // A phone stacks cards at their natural height; only the cockpit's centre
    // still stretches its `fill` cards there (cockpit-board.tsx).
    data-height-mode={(mobile ? entry.heightMode === 'fill' : part !== undefined) ? 'fill' : 'fixed'}
    data-drag-ready={hintShown || undefined}
    // Flex basis at ZERO, and the share as the grow factor: the distributed space
    // is then the whole free height, so three cards at 33 % are equal.
    // `minHeight` stays the floor: a share too small cannot crush a widget below
    // its useful size.
    // `0px` is the same basis as `0`; jsdom drops the whole shorthand without the unit.
    data-orientation={orientation}
    data-compact={bare || undefined}
    style={mobile || bare || part === undefined ? undefined : { flex: `${part / 100} 0 0px`, minHeight: minimum }}
    className={cn('widget-frame group/widget relative flex shrink-0', horizontal ? 'h-full items-center' : 'min-w-0 flex-col', tabbed && 'widget-stack overflow-hidden rounded-xl border border-border bg-card', isDragging && 'opacity-40')}>
    {/* Stack: the whole card carries the frame, and the tab group lives
        INSIDE it, at the top, with no line separating it from the content. */}
    {tabbed && <div className="widget-tabbar relative z-[1] mb-1.5 flex h-10 shrink-0 items-center px-1 pt-1.5"><div ref={tablist} role="tablist" aria-label={t('widgets.tabs')} className="widget-tablist flex min-w-0 items-center overflow-x-auto rounded-lg bg-muted p-[3px]"
      onKeyDown={(e) => {
        if (host.dragging) return;
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault();
        const index = members.findIndex((w) => w.id === entry.id);
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? members.length - 1 : (index + (e.key === 'ArrowRight' ? 1 : -1) + members.length) % members.length;
        host.onSelectTab(members[next]!.id);
        document.getElementById(`tab-${members[next]!.id}`)?.focus();
      }}>
      {members.map((member) => <WidgetTab key={member.id} entry={member} selected={member.id === entry.id} onSelect={() => host.onSelectTab(member.id)} panelId={`panel-${member.id}`} side={cursorSide(members, host.dragging, member.id)} count={counts[member.id] ?? null} attention={attentions[member.id] ?? null} />)}
    </div><WidgetTabEnd entry={entry} members={members} /></div>}
    {/* The hint: a pill at the top of the card, over the middle of its title
        bar, with the grip (the keyboard's way to move it) and the gear. It
        stays reachable from the keyboard: focusing it shows it. */}
    {!bare && <div data-widget-hint className={cn('widget-chrome absolute left-1/2 top-1.5 z-30 flex -translate-x-1/2 items-center gap-0.5 rounded-lg bg-popover/95 p-0.5 shadow-elev-2 ring-1 ring-border transition-opacity duration-150',
      showTools ? 'opacity-100' : 'pointer-events-none opacity-0 focus-within:pointer-events-auto focus-within:opacity-100')}>{grip}{gear}</div>}
    {leadingGrip}
    {/* One panel per member, keyed, so a widget that publishes a count
        (`liveCount`) stays mounted behind the front tab and keeps it true;
        any other member is painted only in front. */}
    {(grouped ? members : [entry]).map((member) => {
      const front = member.id === entry.id;
      const painted = front ? widget : member.id !== entry.id && host.widget(member.id)?.liveCount ? host.widget(member.id) : undefined;
      const self = { id: member.id, tabbed, selected: front, publishCount, publishMenu, publishAttention };
      return <div key={member.id} id={`panel-${member.id}`} role={tabbed ? 'tabpanel' : undefined} aria-labelledby={tabbed ? `tab-${member.id}` : undefined}
        // `hidden` the class, not only the attribute: the attribute loses to `flex`.
        hidden={!front || undefined}
        className={front ? cn('widget-content flex', horizontal ? 'h-full items-center gap-0.5' : bare ? 'min-w-0 flex-col items-start' : 'min-h-0 min-w-0 flex-1 flex-col', tabbed && 'overflow-hidden', host.dragging && !bare && '[&_*]:!pointer-events-none pointer-events-none') : 'hidden'}>
        {painted && <WidgetSelfProvider value={self}>
          {painted.render({ editing: front && (host.editing || hintShown), className: mobile || bare ? undefined : 'h-full', handle: front ? inline ?? undefined : undefined, onReplace: (id) => host.onReplace(member.id, id), orientation, compact: bare })}
        </WidgetSelfProvider>}
      </div>;
    })}
    {/* The docking target covers the whole card (the surface the hand
        aims at), but the veil is drawn on the TAB BAR, at the top: that is
        where the dropped widget will appear. */}
    {!bare && <div ref={setDockRef} className="pointer-events-none absolute inset-0 z-20">
      {isOver && host.dragging && (
        <div className="absolute inset-x-0 top-0 flex h-9 items-center justify-center gap-2 rounded-t-xl border-2 border-primary bg-primary/25 px-3">
          <span className="truncate text-xs font-medium text-foreground">{t('widgets.dockHint')}</span>
        </div>
      )}
    </div>}
    <WidgetContextMenu entry={entry} grouped={grouped} bare={bare} extra={extra} at={menuAt} onClose={() => setMenuAt(null)} />
  </div>;
}
