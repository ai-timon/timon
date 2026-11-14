'use client';

/**
 * The card of a Kanban item, whatever its nature: a TO DO idea or a task
 * (TODO #837). Presentation only — the zones arrive as nodes, the caller owns
 * the data and the gestures, so the product's occupant of `kanban.card` and a
 * plugin's replacement lay out the same zones in the same order.
 *
 * Two densities: `card`, the tile of a board column (`rounded-xl` shell on a
 * raised surface), and `row`, the compact line of a widget list. Neither draws
 * a separator or a dashed outline (AGENTS.md rule 16): zones stand apart by
 * spacing, and the shell by its surface.
 */

import type { HTMLAttributes, KeyboardEvent, MouseEvent, ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils';

export type BoardCardDensity = 'card' | 'row';

export type BoardCardProps = Omit<HTMLAttributes<HTMLElement>, 'title' | 'children'> & {
  density?: BoardCardDensity;
  /** Root element: `li` when the row sits in a list. */
  as?: 'article' | 'li' | 'div';
  /** Who carries the item: an agent's avatar and name, an idea's author. */
  identity?: ReactNode;
  /** The short name agents cite (`#209`, `P3`), at the top right corner. */
  corner?: ReactNode;
  /** Before the title in `row` density: a checkbox, a picto. */
  leading?: ReactNode;
  title: ReactNode;
  badges?: ReactNode;
  /** A banner that asks for attention: validation required, block reason. */
  context?: ReactNode;
  /** Dates, counts, links: the quiet line under the title. */
  meta?: ReactNode;
  /** Buttons; a click on them never opens the item. */
  actions?: ReactNode;
  /**
   * Opens the item. The title becomes a real button, named by the title, that
   * the keyboard and screen readers reach (a span with the button role on a
   * `draggable` card, which Firefox would not drag from a button); a click
   * elsewhere on the card opens it too, except on an interactive element of its
   * own. Absent: the card is not interactive.
   */
  onOpen?: () => void;
  /** Done, closed: the title fades and is struck through. */
  muted?: boolean;
  /** `running` and `blocked` ring the card in their colour. */
  tone?: 'default' | 'running' | 'blocked';
  /** Lifted by a drag: the card dims. */
  dragging?: boolean;
};

const stop = (e: MouseEvent) => { e.stopPropagation(); };

// What a click must reach itself rather than open the card: a badge's link,
// a menu, a field laid in the meta line.
const INTERACTIVE = 'a[href],button,input,select,textarea,label,summary,[role="button"],[role="link"],[role="checkbox"],[role="switch"],[role="menuitem"],[contenteditable="true"]';

export function BoardCard({
  density = 'card', as = 'article', identity, corner, leading, title, badges, context, meta, actions,
  onOpen, muted = false, tone = 'default', dragging = false, className, onClick, ...rest
}: BoardCardProps): ReactElement {
  const Root = as;
  const interactive = !!onOpen;
  // One path for the mouse and the keyboard: the open button has no handler of
  // its own, its click (Enter and Space included) bubbles up to here.
  const click = (e: MouseEvent<HTMLElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || !onOpen) return;
    const hit = (e.target as Partial<Element>).closest?.(INTERACTIVE) ?? null;
    if (hit && e.currentTarget.contains(hit) && !hit.hasAttribute('data-board-card-open')) return;
    onOpen();
  };
  // On a card the title is what the eye looks for, so it is the strongest
  // text there; a row keeps the quieter size of a list.
  const titleClass = cn(
    density === 'card' ? 'text-[13.5px] font-medium leading-snug [text-wrap:pretty]' : 'text-[12.5px] leading-tight [text-wrap:pretty]',
    density === 'card' && 'line-clamp-3',
    muted ? 'text-muted-foreground/45 line-through' : 'text-foreground',
  );
  // `line-clamp-3` sets its own `-webkit-box`; Tailwind emits `display`
  // utilities after it, so a `block` here would cancel the clamp.
  const titleSpan = <span data-board-card-title="" className={cn(density === 'card' ? null : 'block', titleClass)}>{title}</span>;
  const openClass = 'block w-full min-w-0 rounded-sm text-left outline-none focus-visible:ring-2 focus-visible:ring-ring';
  // Firefox starts no drag from a `<button>`, even inside a draggable element:
  // on a card that can be dragged, the open control is a focusable span with
  // the button role, which Enter and Space click like a button.
  const draggableRoot = rest.draggable === true || rest.draggable === 'true';
  const openKey = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.currentTarget.click();
  };
  const titleNode = !interactive ? null : draggableRoot ? (
    <span role="button" tabIndex={0} data-board-card-open="" onKeyDown={openKey} className={openClass}>
      {titleSpan}
    </span>
  ) : (
    // A button holds phrasing content only: the title is a span inside it.
    <button type="button" data-board-card-open="" className={openClass}>
      {titleSpan}
    </button>
  );
  const titleZone = titleNode ?? (
    <div data-board-card-title="" className={titleClass}>{title}</div>
  );
  const actionsNode = actions ? (
    <div data-board-card-actions="" className="flex flex-none items-center gap-0.5" onClick={stop}>
      {actions}
    </div>
  ) : null;

  if (density === 'row') {
    return (
      <Root
        {...rest}
        data-board-card=""
        data-density="row"
        onClick={click}
        className={cn(
          'group flex items-start gap-2 rounded-lg px-1.5 pb-0.5 pt-1 transition-colors hover:bg-foreground/[0.05]',
          interactive && 'cursor-pointer',
          dragging && 'opacity-50',
          className,
        )}
      >
        {leading && <div data-board-card-leading="" className="flex flex-none items-center pt-[3px]" onClick={stop}>{leading}</div>}
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {titleZone}
          {/* With tags, the corner and the gestures close the tag line: on a
              line of their own, a lone `#5` made every idea three lines. */}
          {(badges || meta) && (
            <div className="flex flex-wrap items-center gap-1.5 text-[11px] tabular-nums text-muted-foreground">
              {badges}
              {meta}
              {(corner || actionsNode) && (
                // The id closes the line, flush right: the gestures, invisible
                // until hover, still take their width, so they come first.
                <div data-board-card-foot="" className="ml-auto flex min-h-6 items-center gap-1">
                  {actionsNode && <div className="flex">{actionsNode}</div>}
                  {corner && <div data-board-card-corner="" className="text-[11px] tabular-nums text-muted-foreground">{corner}</div>}
                </div>
              )}
            </div>
          )}
          {context}
          {/* Without tags they share a full-width foot line: on their own
              column beside the title they ate half of a narrow widget's
              width. */}
          {!(badges || meta) && (corner || actionsNode) && (
            <div data-board-card-foot="" className="flex min-h-6 items-center gap-1">
              {corner && <div data-board-card-corner="" className="min-w-0 flex-1 text-[11px] tabular-nums text-muted-foreground">{corner}</div>}
              {actionsNode && <div className="ml-auto flex">{actionsNode}</div>}
            </div>
          )}
        </div>
      </Root>
    );
  }

  return (
    <Root
      {...rest}
      data-board-card=""
      data-density="card"
      onClick={click}
      className={cn(
        'group relative flex flex-col gap-2.5 rounded-xl bg-card px-3 py-3 shadow-elev-1 transition-colors hover:bg-surface-2',
        interactive && 'cursor-pointer',
        tone === 'running' && 'ring-1 ring-inset ring-primary/30',
        tone === 'blocked' && 'ring-1 ring-inset ring-destructive/30',
        dragging && 'opacity-50',
        className,
      )}
    >
      {(identity || corner) && (
        <div className="flex items-center gap-2.5">
          <div data-board-card-identity="" className="flex min-w-0 flex-1 items-center gap-2.5">{identity}</div>
          {corner && <div data-board-card-corner="" className="flex-none text-[11.5px] tabular-nums text-muted-foreground">{corner}</div>}
        </div>
      )}
      {titleZone}
      {badges && <div data-board-card-badges="" className="flex flex-wrap items-center gap-1.5">{badges}</div>}
      {context && <div data-board-card-context="" className="flex flex-col gap-1">{context}</div>}
      {(meta || actionsNode) && (
        <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
          <div data-board-card-meta="" className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 tabular-nums">{meta}</div>
          {actionsNode}
        </div>
      )}
    </Root>
  );
}
