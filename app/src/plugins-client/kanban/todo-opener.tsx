'use client';

/**
 * Opens a TO DO idea by its number from a screen that does not list it: a
 * job's links, a pull request's menu. The idea is read again from the daemon
 * (`/api/ui/project-todo?ids=`), which answers only what the reader may see,
 * then shown in the same form as the TO DO widgets' (`TodoFormModal`).
 *
 * The caller paints `todoModal` where it stays mounted: a job's dialog closes
 * before the idea opens (two modals never stack), so the form cannot live in it.
 */

import { useCallback, useState, type ReactElement, type SyntheticEvent } from 'react';
import { toast } from 'sonner';
import { t } from '@/lib/i18n';
import { TodoFormModal } from './todo-form-modal';
import type { ProjectTodo, ProjectTodoListResponse } from './project-todo-types';

/** The idea `id`, or null when the reader cannot see it (or it is gone). */
export async function fetchTodo(id: number, fetchImpl: typeof fetch = fetch): Promise<ProjectTodo | null> {
  try {
    const query = new URLSearchParams({ status: 'all', ids: String(id), limit: '1' });
    const res = await fetchImpl(`/api/ui/project-todo?${query}`, { cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json().catch(() => null) as ProjectTodoListResponse | null;
    return body?.items?.find((item) => item.id === id) ?? null;
  } catch {
    return null;
  }
}

/** React events bubble from a portal to the tree that holds it: the form's
 *  clicks must not reach the line or the card the opener sits in. */
const stop = (e: SyntheticEvent) => { e.stopPropagation(); };

export function useTodoOpener(): { openTodo: (id: number) => void; todoModal: ReactElement | null } {
  const [item, setItem] = useState<ProjectTodo | null>(null);

  const openTodo = useCallback((id: number) => {
    void fetchTodo(id).then((found) => {
      if (found) setItem(found);
      else toast.error(t('landings.links.todoGone', { id }));
    });
  }, []);

  const reload = useCallback(async () => {
    if (!item) return;
    const fresh = await fetchTodo(item.id);
    if (fresh) setItem(fresh);
  }, [item]);

  const todoModal = item ? (
    <span className="contents" onClick={stop} onPointerDown={stop} onMouseDown={stop} onKeyDown={stop}>
      <TodoFormModal item={item} onSaved={reload} onClose={() => setItem(null)} />
    </span>
  ) : null;
  return { openTodo, todoModal };
}
