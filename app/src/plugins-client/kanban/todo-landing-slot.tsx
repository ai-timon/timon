'use client';

/**
 * `kanban.todo.landing`: the landing badge of a TO DO idea, wherever its
 * badges show — the lines of the TO DO widgets, the Kanban TO DO column, the
 * idea's detail. A single slot: a plugin that takes it (an issue tracker that
 * paints the state its own way) replaces the badge everywhere at once.
 *
 * The occupant reads the idea from `useTodoItem()`, never from props. The
 * product's badge is painted directly while no plugin claims the slot, as
 * `KanbanCardHost` does: a line never waits for a chunk to show its state.
 */

import type { ReactElement } from 'react';
import { SlotSingle, useSlotEntries } from '@/lib/plugin-host/render';
import { TODO_LANDING_SLOT } from '@/lib/plugin-host/slots';
import { ProductTodoLanding } from './product-todo-landing';
import { TodoItemProvider } from './todo-badge-slot';
import type { ProjectTodo } from './project-todo-types';

/** A plugin holds the slot: its badge may show what the product's would not. */
export function useTodoLandingReplaced(): boolean {
  const occupant = useSlotEntries(TODO_LANDING_SLOT)[0];
  return !!occupant && !occupant.fallback;
}

export function TodoLandingSlot({ item }: { item: ProjectTodo }): ReactElement | null {
  const replaced = useTodoLandingReplaced();
  if (!replaced && !item.landing) return null;
  return (
    <TodoItemProvider item={item}>
      {replaced ? <SlotSingle name={TODO_LANDING_SLOT} /> : <ProductTodoLanding />}
    </TodoItemProvider>
  );
}
