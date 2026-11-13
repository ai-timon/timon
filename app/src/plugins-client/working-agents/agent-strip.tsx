'use client';

import { ChatLink } from '@/components/chat/chat-link';
import { useCallback, useState, type DragEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Columns2, Pin, PinOff, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import {
  STATE_VISUALS,
  type ActiveAgent,
} from '@/lib/agent-state';
import { ActiveAgentAvatar, AgentAvatar, type AgentIdentity } from '@/components/agent-avatar';
import { useIslandBus } from '@/lib/island-bus';
import { canDragToIsland, chatSplitActions, startChatIslandDrag } from '@/lib/chat-island-drag';
import { chatHref } from '@/lib/chat-island-params';
import { FileContextMenu, type FileMenuItem } from '@/components/chat/file-context-menu';

/**
 * The tabs of the Working agents widget: one agent per tab, in three shapes.
 *
 * - `chip`, the top bar's tab: the avatar, the name, the state and its timer,
 *   close on top and pin at the bottom of a column on its right edge;
 * - `row`, the same at the full width of a card (cockpit, chat column, island);
 * - `avatar`, the face alone, for a narrow column (the nav rail): pin, close
 *   and the move entries live in its right-click menu.
 *
 * Elapsed times tick with the `now` the widget hands down, so every tab moves
 * on the same second.
 */
function fmtElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + (s % 60 ? (s % 60) + 's' : '');
  return Math.floor(m / 60) + 'h' + (m % 60) + 'm';
}

/** The strip's avatar: the shared active face, at the tab's size. */
export function ChipAvatar({ identity, state }: { identity: AgentIdentity; state: ActiveAgent['state'] }) {
  return (
    <ActiveAgentAvatar
      identity={identity}
      state={state}
      size="sm"
      className="size-5 [&>div]:size-5 [&>div]:text-[9px] md:size-6 md:[&>div]:size-6 md:[&>div]:text-[10px]"
    />
  );
}

export type TabShape = 'chip' | 'row' | 'avatar';

/** A tab's drag, given by the widget: along the strip it reorders, out of it it opens an island. */
export type TabDrag = {
  onDragStart: (e: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
};

/** How a pinned tab moves from its menu, the keyboard and touch form of the drag. */
export type PinMove = {
  /** Steps offered in the menu; `null` at that end of the list. */
  earlier: (() => void) | null;
  later: (() => void) | null;
  /** The tabs run down a column: the menu says up and down, not left and right. */
  vertical: boolean;
};

export function AgentChip({
  agent,
  identity,
  highlighted,
  now,
  pinned,
  onTogglePin,
  onDismiss,
  shape = 'chip',
  pinMove = null,
  drag = null,
}: {
  agent: ActiveAgent;
  identity: AgentIdentity;
  highlighted: boolean;
  now: number;
  /** Tab pinned by the user: stays shown even when idle. */
  pinned: boolean;
  /** null = no pin on this tab: grouped by project, the pin holds the project. */
  onTogglePin: (() => void) | null;
  /** null = a chip that cannot be hidden (agent of the open conversation, or pinned):
   *  no cross. */
  onDismiss: (() => void) | null;
  shape?: TabShape;
  /** A pinned tab of a widget that can reorder them. */
  pinMove?: PinMove | null;
  /** The widget's drag; without it the tab only opens an island when dragged. */
  drag?: TabDrag | null;
}) {
  const vis = STATE_VISUALS[agent.state];
  // An idle chip is synthetic (current or pinned agent with no mission
  // running): its `at` measures nothing, so no counter.
  const elapsed = agent.state === 'idle' ? null : fmtElapsed(now - agent.at);
  const href = chatHref(agent.name, agent.mission_id);
  // Revealed on hover from `sm` up; always visible on touch (no hover there).
  const reveal = 'sm:opacity-0 sm:group-hover:opacity-100 sm:focus-visible:opacity-100';
  // The agent's chat, next to the page on screen (ISLAND-WORKSPACE.md §6, §11).
  // Without a workspace the link keeps the browser's own drag and menu, unless
  // the tab is pinned: its drag then reorders the pinned tabs.
  const bus = useIslandBus();
  const missionId = agent.mission_id || null;
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  // Stable: the chip re-renders every second (its timer), the menu's listeners need not.
  const closeMenu = useCallback(() => setMenu(null), []);
  const toIsland = canDragToIsland(bus);
  const menuItems: FileMenuItem[] = [
    ...chatSplitActions(bus, agent.name, missionId).map((a) => ({ ...a, icon: <Columns2 className="size-3.5" /> })),
    ...tabMenuItems({ agent, pinned, onTogglePin, onDismiss, shape, pinMove }),
  ];
  const title = `${agent.name} — ${vis.label}${agent.pending_count ? ` (${agent.pending_count} pending)` : ''}`;
  const link = (children: ReactNode, className: string) => (
    <ChatLink
      href={href}
      {...(drag ? {
        draggable: true,
        onDragStart: drag.onDragStart,
        onDragEnd: drag.onDragEnd,
      } : toIsland ? {
        draggable: true,
        onDragStart: (e: React.DragEvent<HTMLAnchorElement>) => startChatIslandDrag(e, agent.name, missionId),
      } : {})}
      {...(menuItems.length > 0 ? {
        onContextMenu: (e: React.MouseEvent<HTMLAnchorElement>) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }); },
      } : {})}
      className={className}
      title={title}
    >
      {children}
    </ChatLink>
  );
  const contextMenu = menu && menuItems.length > 0 && (
    <FileContextMenu x={menu.x} y={menu.y} label={t('workingAgents.tabMenu', { name: agent.name })} items={menuItems} onClose={closeMenu} />
  );

  if (shape === 'avatar') {
    return (
      <span
        data-agent-tab={agent.name}
        data-strip-slot={agent.name}
        data-pinned={pinned || undefined}
        className={cn('inline-grid shrink-0 place-items-center rounded-md p-1 transition-colors hover:bg-muted', highlighted && 'bg-muted')}
      >
        {link(<ChipAvatar identity={identity} state={agent.state} />, 'inline-grid place-items-center no-underline')}
        {contextMenu}
      </span>
    );
  }

  return (
    // The border lives on the container (no longer on the Link) so the
    // buttons are true siblings of the link: a <button> nested in an <a>
    // is invalid and catches taps badly on mobile.
    <span
      data-agent-tab={agent.name}
      data-strip-slot={agent.name}
      data-pinned={pinned || undefined}
      className={cn(
        // `overflow-hidden`: the avatar's pulse scales to 2x; left unclipped it
        // grows the scroll range of whatever scrolls around the chip (the
        // project list, the strip) and a scrollbar blinks in at every beat.
        'group items-stretch overflow-hidden rounded-md border text-[10.5px] transition-colors md:text-[11.5px]',
        shape === 'row' ? 'flex w-full min-w-0' : 'inline-flex shrink-0',
        // Raised by its surface, like the rest of the chrome: a rim around
        // every chip in the top bar read as a row of form fields.
        highlighted
          ? 'border-transparent bg-foreground/[0.1]'
          : 'border-transparent bg-foreground/[0.05] hover:bg-foreground/[0.08]',
      )}
    >
      {link(<>
        <ChipAvatar identity={identity} state={agent.state} />
        {/* A text block on two lines: the name alone on top, the state and the
            timer below. On a single line the chip grew very wide and the
            strip only held three agents. */}
        <span className="flex min-w-0 flex-col items-start gap-px leading-tight">
          <span className="flex min-w-0 items-center gap-1">
            <span
              className="truncate text-foreground"
              style={agent.color ? { color: agent.color } : undefined}
            >
              {agent.name}
            </span>
            {agent.pending_count > 0 && (
              <span
                className="shrink-0 rounded px-0.5 text-[8.5px] font-semibold md:px-1 md:text-[9.5px]"
                style={{ background: vis.colorVar, color: '#0c0c0c' }}
              >
                {agent.pending_count}
              </span>
            )}
          </span>
          <span className="flex items-center gap-1">
            <span className={cn('text-[9.5px] md:text-[10.5px]', vis.textClass)}>{vis.label}</span>
            {elapsed && (
              <span className="text-[9.5px] tabular-nums text-muted-foreground/70 md:text-[10.5px]">
                {elapsed}
              </span>
            )}
          </span>
        </span>
      </>, cn('inline-flex items-center gap-1.5 py-1 pl-1.5 pr-0.5 no-underline md:gap-2', shape === 'row' && 'min-w-0 flex-1'))}
      {/* Close on top, pin at the bottom: a column on the right edge of the tab. */}
      {(onDismiss || onTogglePin) && <span className="flex flex-col items-center justify-between py-px pr-px" data-chip-actions>
        {onDismiss ? (
          <button
            type="button"
            data-chip-close
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); onDismiss(); }}
            className={cn('grid size-4 place-items-center rounded text-muted-foreground/60 transition-colors hover:text-destructive', reveal)}
            title={t('strip.dismiss', { name: agent.name })}
            aria-label={t('strip.dismiss', { name: agent.name })}
          >
            <X className="size-2.5 md:size-3" />
          </button>
        ) : (
          <span aria-hidden className="size-4" />
        )}
        {onTogglePin && <button
          type="button"
          data-chip-pin
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); onTogglePin(); }}
          aria-pressed={pinned}
          // Revealed on hover like the cross, pinned or not (the maintainer, 28/10/2026):
          // a pinned tab says so by the pin's colour once shown, and by its place.
          className={cn(
            'grid size-4 place-items-center rounded transition-colors',
            pinned ? 'text-primary hover:text-muted-foreground' : 'text-muted-foreground/60 hover:text-foreground',
            reveal,
          )}
          title={pinned ? t('strip.unpin', { name: agent.name }) : t('strip.pin', { name: agent.name })}
          aria-label={pinned ? t('strip.unpin', { name: agent.name }) : t('strip.pin', { name: agent.name })}
        >
          {pinned ? <PinOff className="size-2.5 md:size-3" /> : <Pin className="size-2.5 md:size-3" />}
        </button>}
      </span>}
      {contextMenu}
    </span>
  );
}

/**
 * The tab's own entries of its right-click menu: the moves of a pinned tab
 * (the drag's keyboard and touch form), and — on the bare avatar, which has no
 * buttons — pin and close.
 */
function tabMenuItems({ agent, pinned, onTogglePin, onDismiss, shape, pinMove }: {
  agent: ActiveAgent;
  pinned: boolean;
  onTogglePin: (() => void) | null;
  onDismiss: (() => void) | null;
  shape: TabShape;
  pinMove: PinMove | null;
}): FileMenuItem[] {
  const name = agent.name;
  const items: FileMenuItem[] = [];
  if (pinMove?.earlier) {
    items.push({ key: 'move-earlier', label: t(pinMove.vertical ? 'workingAgents.moveUp' : 'workingAgents.moveLeft', { name }), icon: pinMove.vertical ? <ArrowUp className="size-3.5" /> : <ArrowLeft className="size-3.5" />, onSelect: pinMove.earlier });
  }
  if (pinMove?.later) {
    items.push({ key: 'move-later', label: t(pinMove.vertical ? 'workingAgents.moveDown' : 'workingAgents.moveRight', { name }), icon: pinMove.vertical ? <ArrowDown className="size-3.5" /> : <ArrowRight className="size-3.5" />, onSelect: pinMove.later });
  }
  if (shape === 'avatar') {
    if (onTogglePin) items.push({ key: 'pin', label: pinned ? t('strip.unpin', { name }) : t('strip.pin', { name }), icon: pinned ? <PinOff className="size-3.5" /> : <Pin className="size-3.5" />, onSelect: onTogglePin });
    if (onDismiss) items.push({ key: 'dismiss', label: t('strip.dismiss', { name }), icon: <X className="size-3.5" />, onSelect: onDismiss, danger: true });
  }
  return items;
}
