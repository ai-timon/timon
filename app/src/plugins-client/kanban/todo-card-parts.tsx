'use client';

/**
 * The zones of a TO DO idea's tile, shared by its two densities (TODO #837):
 * the board column's card and the TO DO widgets' row. Each is a node handed to
 * `BoardCard`, which owns the layout.
 */

import type { ReactElement } from 'react';
import { CircleCheck, Link2, Paperclip, RotateCcw, Send, Trash2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/lib/i18n';
import { formatDate, formatDateTime } from '@/lib/intl';
import { useSlotEntries } from '@/lib/plugin-host/render';
import { effectiveProgress } from '@/lib/project-todo-tags';
import { cn } from '@/lib/utils';
import { ProgressBadge, UrgencyBadge, todoAuthorLabel } from './project-todo-tag-chips';
import { safeHref } from './project-todo-links';
import { TODO_BADGE_SLOT, TodoBadgeSlot } from './todo-badge-slot';
import { TodoLandingSlot, useTodoLandingReplaced } from './todo-landing-slot';
import { linkIssue, todoHasOrigin, TodoOriginChips } from './todo-issue-chips';
import { TodoProposalChip, useTodoProposals } from './todo-proposal-chip';
import type { KanbanTodoCardValue } from './kanban-card-context';
import type { ProjectTodo } from './project-todo-types';

// Same shape as the task card's icon buttons, kept here: that file belongs to the task tile.
export const TODO_ICON_BUTTON = 'grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * The author a tile names, or `null`. When a connector the idea is linked to
 * is its author (`discord` + a `discord` link), that connector's badge
 * already names it: the tile does not say it twice.
 */
export function todoAuthor(item: ProjectTodo): string | null {
  if (!item.author || item.links?.some((link) => link.provider === item.author)) return null;
  return todoAuthorLabel(item.author);
}

/**
 * Whether the idea has a badge to show: `BoardCard` draws a zone for any node
 * it is handed, so an idea without one must hand none.
 */
export function useTodoHasBadges(item: ProjectTodo): boolean {
  const plugins = useSlotEntries(TODO_BADGE_SLOT).length > 0;
  const landing = useTodoLandingReplaced() || !!item.landing;
  const waiting = useTodoProposals(item).length > 0;
  return !!item.urgency || effectiveProgress(item.progress) !== 'todo' || plugins || landing || todoHasOrigin(item) || waiting;
}

/** Urgency, progress (when it moved), its issues and whether its text came
 *  from outside, a publication on GitHub waiting for the person, where its
 *  branch stands, and the plugins' badges. */
export function TodoBadges({ item }: { item: ProjectTodo }): ReactElement {
  const progress = effectiveProgress(item.progress);
  const proposals = useTodoProposals(item);
  return (
    <>
      {item.urgency && <UrgencyBadge value={item.urgency} />}
      {progress !== 'todo' && <ProgressBadge value={progress} />}
      <TodoOriginChips item={item} />
      <TodoProposalChip proposals={proposals} />
      <TodoLandingSlot item={item} />
      <TodoBadgeSlot item={item} />
    </>
  );
}

/** The idea's 📎 and its number of files, as on a task's tile; nothing without a file. */
export function TodoAttachmentCount({ item }: { item: ProjectTodo }): ReactElement | null {
  const count = item.attachment_count ?? 0;
  if (count <= 0) return null;
  const label = t('kanbanPage.card.attachments', { count });
  return (
    <span data-todo-attachments={count} className="inline-flex items-center gap-1 tabular-nums" title={label} aria-label={label}>
      <Paperclip className="size-3.5" aria-hidden />
      {count}
    </span>
  );
}

/**
 * The quiet line of the card: when the idea last moved, its files, and where it lives
 * outside Timon (its issues apart, which are badges). A link is an `href` only when it is http(s), the rule of the
 * popup's rail.
 */
export function TodoMeta({ item }: { item: ProjectTodo }): ReactElement {
  // An issue is already a chip among the badges.
  const links = (item.links ?? []).filter((link) => !linkIssue(link));
  const moved = item.status === 'done' && item.done_at ? item.done_at : item.updated_at;
  return (
    <>
      <span title={formatDateTime(moved, { dateStyle: 'medium', timeStyle: 'short' })}>
        {formatDate(moved, { day: 'numeric', month: 'short' })}
      </span>
      <TodoAttachmentCount item={item} />
      {links.map((link) => {
        const href = safeHref(link.url);
        const text = link.label || link.provider;
        const title = `${link.provider} · ${link.ref}`;
        return href ? (
          <a
            key={`${link.provider}:${link.ref}`}
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            title={title}
            className="inline-flex min-w-0 max-w-[10rem] items-center gap-1 text-primary underline-offset-2 hover:underline"
          >
            <Link2 className="size-3.5 flex-none" aria-hidden />
            <span className="truncate">{text}</span>
          </a>
        ) : (
          <span key={`${link.provider}:${link.ref}`} title={title} className="inline-flex min-w-0 max-w-[10rem] items-center gap-1">
            <Link2 className="size-3.5 flex-none" aria-hidden />
            <span className="truncate">{text}</span>
          </span>
        );
      })}
    </>
  );
}

export function todoHasActions(card: KanbanTodoCardValue, toggle = true): boolean {
  return !!((toggle && card.toggleDone) || card.handoff || card.remove);
}

const TODO_TIP = 'rounded-md bg-popover px-2 py-1 text-[11.5px] font-medium text-popover-foreground shadow-elev-2';

/** An icon button named by a real tooltip, not the browser's `title`. */
function TodoIconButton({ label, onClick, className, children }: {
  label: string;
  onClick: () => void;
  className?: string;
  children: ReactElement;
}): ReactElement {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" onClick={onClick} aria-label={label} className={cn(TODO_ICON_BUTTON, className)}>
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4} className={TODO_TIP}>{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The idea's gestures, as icon buttons; a gesture the host withholds (`null`)
 * is not drawn. `toggle: false` leaves the tick out.
 */
export function TodoActions({ card, toggle = true, className }: {
  card: KanbanTodoCardValue;
  toggle?: boolean;
  className?: string;
}): ReactElement | null {
  const done = card.item.status === 'done';
  const tick = toggle ? card.toggleDone : null;
  if (!todoHasActions(card, toggle)) return null;
  return (
    <TooltipProvider delayDuration={300} skipDelayDuration={300}>
      {tick && (
        <TodoIconButton
          label={done ? t('projectTodo.reopen') : t('projectTodo.markDone')}
          onClick={tick}
          className={cn(!done && 'hover:bg-primary/10 hover:text-primary', className)}
        >
          {done ? <RotateCcw className="size-3.5" aria-hidden /> : <CircleCheck className="size-3.5" aria-hidden />}
        </TodoIconButton>
      )}
      {card.handoff && (
        <TodoIconButton label={t('projectTodo.detail.handoff')} onClick={card.handoff} className={className}>
          <Send className="size-3.5" aria-hidden />
        </TodoIconButton>
      )}
      {card.remove && (
        <TodoIconButton
          label={t('projectTodo.delete')}
          onClick={card.remove}
          className={cn('hover:bg-destructive/10 hover:text-destructive', className)}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </TodoIconButton>
      )}
    </TooltipProvider>
  );
}
