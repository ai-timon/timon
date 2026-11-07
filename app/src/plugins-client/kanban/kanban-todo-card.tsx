'use client';

/**
 * The product's tile of a TO DO idea (TODO #837), in both densities: the card
 * of the board's TO DO column and the row of the TO DO widgets. Laid out on
 * `BoardCard` like a task's tile — the identity is the author and the project,
 * the corner the idea's number, then the title, the badges, the meta line and
 * the gestures.
 */

import type { ReactElement } from 'react';
import { BoardCard } from '@/components/board-card';
import type { KanbanTodoCardValue } from './kanban-card-context';
import { TodoRow } from './project-todo-row';
import { TodoActions, TodoBadges, TodoMeta, todoAuthor, todoHasActions, useTodoHasBadges } from './todo-card-parts';

export function KanbanTodoCard({ card }: { card: KanbanTodoCardValue }): ReactElement {
  const hasBadges = useTodoHasBadges(card.item);
  if (card.density === 'row') return <TodoRow card={card} />;
  const { item, show } = card;
  const author = show.author ? todoAuthor(item) : null;
  const project = show.project ? item.project : null;
  // The first line names who wrote the idea, the second where it belongs;
  // without an author the project takes the first line.
  const [lead, sub] = author ? [author, project] : [project, null];
  return (
    <BoardCard
      data-todo-card={item.id}
      identity={lead && (
        // One quiet line ("You · acme-web"): on two lines the metadata made
        // every card open with a header taller than its title.
        <span className="flex min-w-0 items-baseline gap-1.5 text-[12px] text-muted-foreground">
          <span className="truncate font-medium">{lead}</span>
          {sub && <><span aria-hidden>·</span><span className="truncate">{sub}</span></>}
        </span>
      )}
      // The id is how agents and the orchestrator name an idea ("#209"):
      // without it on the card, a report citing one cannot be matched.
      corner={show.id ? `#${item.id}` : undefined}
      title={item.text}
      badges={hasBadges ? <TodoBadges item={item} /> : undefined}
      meta={<TodoMeta item={item} />}
      // Revealed under the pointer or the keyboard, dimmed on touch: three icons
      // on every card of a column competed with the titles.
      actions={todoHasActions(card) ? <TodoActions card={card} className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 [@media(hover:none)]:opacity-60" /> : undefined}
      muted={item.status === 'done'}
      onOpen={card.open}
    />
  );
}
