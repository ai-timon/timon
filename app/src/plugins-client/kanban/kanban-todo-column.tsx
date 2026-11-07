'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ClientRealtime } from '@/lib/plugin-host/realtime';
import { subscribeProjectTodoChanges } from '@/lib/project-todo-realtime';
import { KanbanCardHost } from './kanban-card-slot';
import { TodoFormModal } from './todo-form-modal';
import { handOffIdea } from './todo-handoff';
import { filterTodoItems } from '@/lib/kanban-filters';
import { useKanbanFilters } from '@/lib/kanban-filters-context';
import { t } from '@/lib/i18n';
import { formatNumber } from '@/lib/intl';
import { KanbanColumnEmpty, KanbanColumnHeader } from './kanban-column-header';
import type { ProjectTodo } from './project-todo-types';

/**
 * The Kanban "TO DO" column: the ideas in bulk, before they are tasks.
 *
 * It is the board's first column, always there, but not a queue the
 * orchestrator takes work from — that is what sets it apart from PENDING, and
 * nothing drops a task in it.
 *
 * It is not a task status either. An idea has no agent, type or pipeline: a
 * draggable card would pass it off as a task, and the first drop would ask the
 * daemon for a "TO DO" status that does not exist. So an idea is never
 * dragged; its tile carries the idea's own gestures (tick it done, hand it to
 * the orchestrator, delete it, TODO #837), and the only way to a task is the
 * hand-off (`POST /api/project-todo/:id/handoff`): the project's orchestrator
 * discusses it with the user and files the task if it holds. The Kanban's
 * data model is not touched.
 *
 * It paints its own frame: `kanban.column` is not a widget host zone, the host
 * only lays out the column's geometry.
 */
export function KanbanTodoColumn({ realtime }: { realtime: ClientRealtime }) {
  // The board's project filter narrows the ideas too.
  const filters = useKanbanFilters();
  const [all, setItems] = useState<ProjectTodo[]>([]);
  const items = useMemo(
    () => filterTodoItems(all, filters),
    [all, filters],
  );
  const [chargement, setChargement] = useState(true);
  const [detailId, setDetailId] = useState<number | null>(null);
  // Read again on every render: after a save the form shows the reloaded idea.
  const detail = detailId === null ? null : items.find((i) => i.id === detailId) ?? null;

  const load = useCallback(async () => {
    try {
      const r = await fetch('/api/ui/project-todo?status=open', { cache: 'no-store' });
      const j = (await r.json()) as { items?: ProjectTodo[] };
      setItems(j.items ?? []);
    } catch {
      // Silent: a broken API must not break the task board.
    } finally {
      setChargement(false);
    }
  }, []);

  const patch = async (id: number, fields: Partial<Pick<ProjectTodo, 'status'>>) => {
    await fetch(`/api/ui/project-todo/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(fields),
    });
    await load();
  };

  const supprimer = async (id: number) => {
    await fetch(`/api/ui/project-todo/${id}`, { method: 'DELETE' });
    await load();
  };

  useEffect(() => {
    const unsubscribe = subscribeProjectTodoChanges(realtime, () => { void load(); });
    void load();
    return unsubscribe;
  }, [load, realtime]);

  return (
    <section aria-label={t('kanbanPage.columns.todo')} className="timon-island flex min-h-0 flex-1 flex-col">
      <KanbanColumnHeader
        label={t('kanbanPage.columns.todo')}
        count={chargement ? '…' : formatNumber(items.length)}
        dotClass="bg-muted-foreground/60"
      />

      {/* Same foot fade as the board's other columns: the last card fades out
          instead of being sliced, and the bottom padding lets it scroll clear. */}
      <div className="flex flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden p-2 pb-6 [mask-image:linear-gradient(to_bottom,#000_calc(100%-28px),transparent)]">
        {items.length === 0 ? (
          <KanbanColumnEmpty>
            {chargement ? t('kanbanPage.columns.todoLoading') : t('kanbanPage.columns.todoEmpty')}
          </KanbanColumnEmpty>
        ) : (
          items.map((it) => (
            <KanbanCardHost
              key={it.id}
              value={{
                kind: 'todo', density: 'card', item: it, show: { id: true, author: true, project: true },
                open: () => setDetailId(it.id),
                // An idea ticked done leaves the column, which lists the open ones.
                toggleDone: () => void patch(it.id, { status: it.status === 'done' ? 'open' : 'done' }),
                handoff: it.project ? () => void handOffIdea(it.id) : null,
                remove: () => void supprimer(it.id),
              }}
            />
          ))
        )}
      </div>

      {/* The popup carries the edition and the hand-off, like the tile. */}
      {detail && <TodoFormModal item={detail} onSaved={load} onClose={() => setDetailId(null)} />}
    </section>
  );
}
