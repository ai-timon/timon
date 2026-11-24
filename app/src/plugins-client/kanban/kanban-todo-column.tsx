'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClientRealtime } from '@/lib/plugin-host/realtime';
import { subscribeProjectTodoChanges } from '@/lib/project-todo-realtime';
import { movesTodoLanding, useLandingChanges } from './landing-events';
import { KanbanCardHost } from './kanban-card-slot';
import { TodoFormModal } from './todo-form-modal';
import { handOffIdea } from './todo-handoff';
import { ALL_FILTER, filterTodoItems } from '@/lib/kanban-filters';
import { useKanbanFilters } from '@/lib/kanban-filters-context';
import { t } from '@/lib/i18n';
import { formatNumber } from '@/lib/intl';
import { KanbanColumnEmpty, KanbanColumnHeader } from './kanban-column-header';
import { TODO_SURFACE_LIMIT, type ProjectTodo, type ProjectTodoListResponse } from './project-todo-types';

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
  // The daemon's count of the open ideas under the board's project: the rows
  // themselves stop at the page, past which they counted short.
  const [total, setTotal] = useState<number | null>(null);
  const [tronque, setTronque] = useState(false);
  const [chargement, setChargement] = useState(true);
  const [detailId, setDetailId] = useState<number | null>(null);
  // Read again on every render: after a save the form shows the reloaded idea.
  const detail = detailId === null ? null : items.find((i) => i.id === detailId) ?? null;

  const projet = filters.project === ALL_FILTER ? null : filters.project;
  // Only the latest answer lands: a project picked twice in a row must not
  // end on the slower answer to the first pick.
  const derniere = useRef(0);
  const load = useCallback(async () => {
    const tour = ++derniere.current;
    try {
      // The project narrows on the daemon's side, so the page holds that
      // project's ideas, not the newest of every project.
      const query = new URLSearchParams({ status: 'open' });
      if (projet) query.set('project', projet);
      query.set('limit', String(TODO_SURFACE_LIMIT));
      const r = await fetch(`/api/ui/project-todo?${query.toString()}`, { cache: 'no-store' });
      const j = (await r.json()) as ProjectTodoListResponse;
      if (tour !== derniere.current) return;
      setItems(j.items ?? []);
      setTotal(j.counts?.byStatus.open ?? null);
      setTronque(j.truncated === true);
    } catch {
      // Silent: a broken API must not break the task board.
    } finally {
      if (tour === derniere.current) setChargement(false);
    }
  }, [projet]);

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
  // An idea's landing badge moves with its jobs, which the notebook's own
  // signal does not announce. Not narrowed to the project: an idea may be
  // carried out by a job of another one.
  useLandingChanges(() => { void load(); }, movesTodoLanding);

  return (
    <section aria-label={t('kanbanPage.columns.todo')} className="timon-island flex min-h-0 flex-1 flex-col">
      <KanbanColumnHeader
        label={t('kanbanPage.columns.todo')}
        // A keyword filters the loaded rows here, so its count is theirs.
        count={chargement ? '…' : formatNumber(filters.q.trim() || total === null ? items.length : total)}
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
        {tronque && items.length > 0 && total !== null && (
          <p className="px-1 pt-1 text-center text-[11.5px] text-muted-foreground">
            {t('projectTodo.truncated', { shown: all.length, total })}
          </p>
        )}
      </div>

      {/* The popup carries the edition and the hand-off, like the tile. */}
      {detail && <TodoFormModal item={detail} onSaved={load} onClose={() => setDetailId(null)} />}
    </section>
  );
}
