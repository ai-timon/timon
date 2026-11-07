'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Pin, PinOff } from 'lucide-react';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import { formatNumber } from '@/lib/intl';
import { STATE_VISUALS } from '@/lib/agent-state';
import type { AgentIdentity } from '@/components/agent-avatar';
import type { ProjectGroup } from '@/lib/working-agents';
import { FileContextMenu } from '@/components/chat/file-context-menu';
import { ChatLink } from '@/components/chat/chat-link';
import { ChipAvatar, type TabDrag, type TabShape } from './agent-strip';
import { NativeViewCover } from '@/lib/native-view-cover';

/** Long enough to cross the gap between the tab and its list, short enough not to linger. */
const CLOSE_DELAY_MS = 160;

/**
 * The project list on screen, if any. One at a time: the pointer sweeping
 * along the bar enters the next tab before the previous list's close delay
 * runs out, so opening one closes the other at once instead of waiting.
 */
let openList: { hide: () => void } | null = null;

/**
 * One project, in the widget's grouped mode: its face and name, its agents'
 * most pressing state around the face, how many are at work. A click opens
 * the project's orchestrator in the chat (`href`, chosen by the widget).
 *
 * With `hoverList`, hovering or focusing the tab lists the project's agents
 * at work under it (beside it in a column), each one a tab of its own: open
 * its chat, close it. With none at work there is no list: the click already
 * reaches the orchestrator. The list is portalled to the body: the top bar's
 * strip scrolls sideways and would clip it.
 *
 * The pin is the project's: grouped, a tab is a project, and a pinned project
 * stays on the bar with none of its agents at work.
 */
export function ProjectTab({ group, identity, label, href, size, shape, vertical, hoverList, pinned, onTogglePin, drag = null, children }: {
  group: ProjectGroup;
  identity: AgentIdentity;
  label: string;
  /** Where a click goes: the orchestrator's chat. */
  href: string;
  /** How many agents the project has, at work or not. */
  size: number;
  shape: TabShape;
  /** The tabs run down a column: the list opens beside the tab, not under it. */
  vertical: boolean;
  hoverList: boolean;
  pinned: boolean;
  onTogglePin: () => void;
  /** The widget's drag: along the strip it reorders, out of it it opens the orchestrator in an island. */
  drag?: TabDrag | null;
  /** The tabs of the agents at work, shown in the list; none, no list. */
  children: ReactNode[];
}) {
  const vis = STATE_VISUALS[group.state];
  const stateLabel = t(`chatSurface.activeState.${group.state}`);
  const pendingLabel = group.pending > 0 ? t('chatSurface.pendingCount', { count: group.pending }) : '';
  const title = `${label} — ${t('workingAgents.projectCount', { count: String(size) })}`;
  // No agent at work, no list: it would open on nothing, or on finished agents.
  const list = useHoverList(hoverList && children.length > 0, vertical);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  const pinLabel = pinned ? t('strip.unpin', { name: label }) : t('strip.pin', { name: label });

  const face = <ChipAvatar identity={identity} state={group.state} />;
  return (
    <span
      ref={list.anchor}
      data-project-tab={group.project}
      data-strip-slot={`project:${group.project}`}
      data-pinned={pinned || undefined}
      onPointerEnter={list.show}
      onPointerLeave={list.hideSoon}
      onFocus={list.show}
      onBlur={list.blur}
      onKeyDown={(e) => { if (e.key === 'Escape') list.hide(); }}
      className={cn(
        shape === 'avatar'
          ? 'inline-grid shrink-0 place-items-center rounded-md p-1 transition-colors hover:bg-muted'
          : cn('group items-stretch rounded-md border border-border bg-background/60 text-[10.5px] transition-colors hover:border-foreground/20 md:text-[11.5px]', shape === 'row' ? 'flex w-full min-w-0' : 'inline-flex shrink-0'),
      )}
    >
      <ChatLink
        href={href}
        {...(drag ? {
          draggable: true,
          // The list would sit over the strip the tab is dragged along.
          onDragStart: (e: React.DragEvent<HTMLAnchorElement>) => { list.hide(); drag.onDragStart(e); },
          onDragEnd: drag.onDragEnd,
        } : {})}
        title={title}
        aria-haspopup={hoverList ? 'true' : undefined}
        aria-expanded={hoverList ? list.open : undefined}
        onContextMenu={(e) => { e.preventDefault(); list.hide(); setMenu({ x: e.clientX, y: e.clientY }); }}
        className={shape === 'avatar' ? 'inline-grid place-items-center no-underline' : cn('inline-flex items-center gap-1.5 py-1 pl-1.5 pr-0.5 no-underline md:gap-2', shape === 'row' && 'min-w-0 flex-1')}
      >
        {face}
        {shape !== 'avatar' && (
          <span className="flex min-w-0 flex-col items-start gap-px leading-tight">
            <span className="flex min-w-0 items-center gap-1">
              <span className="truncate text-foreground">{label}</span>
              {group.pending > 0 && (
                <span className="shrink-0 rounded px-0.5 text-[8.5px] font-semibold md:px-1 md:text-[9.5px]" style={{ background: vis.colorVar, color: '#0c0c0c' }} title={pendingLabel} aria-label={pendingLabel}>
                  {formatNumber(group.pending)}
                </span>
              )}
            </span>
            {/* Nothing at work, nothing to say: no "idle 0/3" under the name. */}
            {group.working > 0 && (
              <span className="flex items-center gap-1">
                <span className={cn('text-[9.5px] md:text-[10.5px]', vis.textClass)}>{stateLabel}</span>
                <span className="text-[9.5px] tabular-nums text-muted-foreground/70 md:text-[10.5px]">
                  {t('workingAgents.projectWorking', { working: String(group.working), count: String(size) })}
                </span>
              </span>
            )}
          </span>
        )}
      </ChatLink>
      {shape !== 'avatar' && (
        <span className="flex flex-col items-center justify-end py-px pr-px" data-project-actions>
          <button
            type="button"
            data-project-pin
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onTogglePin(); }}
            aria-pressed={pinned}
            // Revealed on hover, pinned or not, like an agent's tab.
            className={cn(
              'grid size-4 place-items-center rounded transition-colors sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100',
              pinned ? 'text-primary hover:text-muted-foreground' : 'text-muted-foreground/60 hover:text-foreground',
            )}
            title={pinLabel}
            aria-label={pinLabel}
          >
            {pinned ? <PinOff className="size-2.5 md:size-3" /> : <Pin className="size-2.5 md:size-3" />}
          </button>
        </span>
      )}
      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          label={label}
          items={[{ key: 'pin', label: pinLabel, icon: pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />, onSelect: onTogglePin }]}
          onClose={closeMenu}
        />
      )}
      {list.open && list.at && createPortal(
        <div
          ref={list.panel}
          role="group"
          data-project-agents={group.project}
          aria-label={t('workingAgents.projectAgents', { project: label })}
          onPointerEnter={list.show}
          onPointerLeave={list.hideSoon}
          onBlur={list.blur}
          onKeyDown={(e) => { if (e.key === 'Escape') list.hide(); }}
          style={{ position: 'fixed', left: list.at.left, top: list.at.top }}
          className="z-50 flex max-h-80 w-64 flex-col gap-1 overflow-y-auto rounded-lg border border-border bg-popover p-1.5 shadow-elev-2"
        >
          <NativeViewCover />
          {children}
        </div>,
        document.body,
      )}
    </span>
  );
}

/** Open on hover or focus, closed a moment after both pointer and focus have left. */
function useHoverList(enabled: boolean, vertical: boolean) {
  const anchor = useRef<HTMLSpanElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [at, setAt] = useState<{ left: number; top: number } | null>(null);
  const cancel = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const self = useRef<{ hide: () => void }>({ hide: () => {} });
  useEffect(() => () => {
    cancel();
    if (openList === self.current) openList = null;
  }, []);
  const show = () => {
    // Reaching a tab closes the list of the one before, even when this one has none.
    if (openList && openList !== self.current) openList.hide();
    if (!enabled) return;
    cancel();
    openList = self.current;
    const box = anchor.current?.getBoundingClientRect();
    if (!box) return;
    // Under the tab on a line, beside it in a column; kept inside the window.
    const width = 256;
    const left = vertical ? box.right + 6 : box.left;
    setAt({ left: Math.max(8, Math.min(left, window.innerWidth - width - 8)), top: vertical ? box.top : box.bottom + 6 });
  };
  const hide = () => {
    cancel();
    setAt(null);
    if (openList === self.current) openList = null;
  };
  self.current.hide = hide;
  const hideSoon = () => { cancel(); timer.current = setTimeout(hide, CLOSE_DELAY_MS); };
  const blur = (e: React.FocusEvent) => {
    const next = e.relatedTarget as Node | null;
    if (next && (anchor.current?.contains(next) || panel.current?.contains(next))) return;
    hideSoon();
  };
  return { anchor, panel, open: at !== null, at, show, hide, hideSoon, blur };
}
