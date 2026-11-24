'use client';

/**
 * `kanban.todo.badge`: badges a plugin adds to a TO DO idea, wherever the
 * idea's badges show — the lines of the TO DO widgets, the Kanban TO DO
 * column, the idea's detail.
 *
 * The occupant reads the idea from context, never from props: an entry is
 * registered once and rendered on every line (same contract as
 * `kanban.todo.detail`). A badge is read-only: it sits beside the tile's
 * title, and a click on it opens the idea like the rest of the tile.
 */

import React, { createContext, useContext } from 'react';
import { renderSlotEntries, useSlotEntries } from '@/lib/plugin-host/render';
import type { ProjectTodo } from './project-todo-types';

export const TODO_BADGE_SLOT = 'kanban.todo.badge';

const TodoItemContext = createContext<ProjectTodo | null>(null);

/** The idea a `kanban.todo.badge` or `kanban.todo.landing` occupant is rendered for. */
export function useTodoItem(): ProjectTodo | null {
  return useContext(TodoItemContext);
}

/** Puts `item` where `useTodoItem()` reads it. */
export function TodoItemProvider({ item, children }: { item: ProjectTodo; children: React.ReactNode }): React.ReactElement {
  return <TodoItemContext.Provider value={item}>{children}</TodoItemContext.Provider>;
}

/** Paints nothing at all while no plugin holds a badge: a stock line keeps its
 *  exact markup. */
export function TodoBadgeSlot({ item }: { item: ProjectTodo }): React.ReactElement | null {
  const entries = useSlotEntries(TODO_BADGE_SLOT);
  if (entries.length === 0) return null;
  return <TodoItemContext.Provider value={item}>{renderSlotEntries(entries)}</TodoItemContext.Provider>;
}
