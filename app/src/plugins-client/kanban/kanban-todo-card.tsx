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
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-[12px] font-medium text-muted-foreground">{lead}</span>
          {sub && <span className="truncate text-[12px] text-muted-foreground/80">{sub}</span>}
        </span>
      )}
      // The id is how agents and the orchestrator name an idea ("#209"):
      // without it on the card, a report citing one cannot be matched.
      corner={show.id ? `#${item.id}` : undefined}
      title={item.text}
      badges={hasBadges ? <TodoBadges item={item} /> : undefined}
      meta={<TodoMeta item={item} />}
      actions={todoHasActions(card) ? <TodoActions card={card} /> : undefined}
      muted={item.status === 'done'}
      onOpen={card.open}
    />
  );
}
