'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { toast } from 'sonner';
import { Plus, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { TaskFormModal } from '@/components/task-form-modal';
import { agentIdentity, pseudoIdentity, type AgentIdentity } from '@/components/agent-avatar';
import { useProjectMeta } from '@/hooks/use-project-meta';
import { t as i18n } from '@/lib/i18n';
import { formatNumber } from '@/lib/intl';
import { resolveRole } from '@/lib/roles';
import { SeriesGraphDialog } from '@/components/series-graph-dialog';
import { useSlotEntries } from '@/lib/plugin-host/render';
import { PluginBoundary } from '@/lib/plugin-host/plugin-boundary';
import { kanbanGridClass } from '@/lib/kanban-grid';
import { deleteKanbanTask } from '@/lib/kanban-delete';
import { groupByColumn } from '@/lib/kanban-columns';
import {
  ALL_FILTER,
  DEFAULT_KANBAN_FILTERS,
  agentOptions,
  boardTaskQuery,
  filterBoardTasks,
  isFiltered,
  projectOptions,
  readKanbanFilters,
  withProject,
  writeKanbanFilters,
  type KanbanFilters,
} from '@/lib/kanban-filters';
import { KanbanFiltersContext } from '@/lib/kanban-filters-context';
import { MarkMergedDialog } from './mark-merged-dialog';
import { machineLocalStorage } from '@/lib/machines/machine-storage';
import { KanbanColumnEmpty, KanbanColumnHeader } from './kanban-column-header';
import { KanbanCardHost } from './kanban-card-slot';
import type { Agent, Task, TaskStatus } from './kanban-task';
import type { ProjectTodo } from './project-todo-types';
import { confirmAction } from '@/components/confirm-dialog/confirm-dialog-context';

/** `tint`: the theme token (an HSL triple) the column's corner wash is drawn with. */
type ColumnDef = { key: TaskStatus; labelKey: string; emptyKey: string; dot: string; tint: string };

// Column dots are theme tokens: the four statuses read the same in light and dark.
const COLUMNS: ColumnDef[] = [
  { key: 'PENDING', labelKey: 'kanbanPage.columns.pending', emptyKey: 'kanbanPage.columns.pendingEmpty', dot: 'bg-warning', tint: '--warning' },
  { key: 'IN_PROGRESS', labelKey: 'kanbanPage.columns.inProgress', emptyKey: 'kanbanPage.columns.inProgressEmpty', dot: 'bg-info', tint: '--info' },
  { key: 'DONE', labelKey: 'kanbanPage.columns.done', emptyKey: 'kanbanPage.columns.doneEmpty', dot: 'bg-success', tint: '--success' },
  { key: 'BLOCKED', labelKey: 'kanbanPage.columns.blocked', emptyKey: 'kanbanPage.columns.blockedEmpty', dot: 'bg-destructive', tint: '--destructive' },
];

/** A faint wash of the column's colour from its top-left corner, laid over the island's own fill. */
function columnWash(token: string): CSSProperties {
  return { backgroundImage: `radial-gradient(120% 70% at 0% 0%, hsl(var(${token}) / 0.13), transparent 70%)` };
}

// ── Main kanban ────────────────────────────────────────────────────────────────

const DONE_PAGE_SIZE = 20;

function storage(): Storage | null {
  try { return machineLocalStorage(); } catch { return null; }
}

export function KanbanClient({ defaultAgent }: { defaultAgent?: string }) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [filters, setFilters] = useState<KanbanFilters>(DEFAULT_KANBAN_FILTERS);
  // The stored choice is read after mount (no `localStorage` on the server
  // render); the board waits for it rather than painting everything first.
  const [filtersReady, setFiltersReady] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [editTask, setEditTask] = useState<Task | null>(null);
  const [mergeTask, setMergeTask] = useState<Task | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [doneLimit, setDoneLimit] = useState(DONE_PAGE_SIZE);
  // DONE tasks the server holds for the current filter; the list itself only
  // carries the window the column shows (plus the series those cards belong to).
  const [doneTotal, setDoneTotal] = useState<number | null>(null);
  // Series graph popup: the series to lay out, and the task it was opened
  // from (null when opened from the series identifier).
  const [graphView, setGraphView] = useState<{ seriesId: string; focusId: string | null } | null>(null);
  const dragOver = useRef<TaskStatus | null>(null);
  // What plugins add to the board. Empty on an install where the notebook
  // is off: the Kanban then gets back exactly its four status columns, with
  // no gutter or ghost frame.
  const colonnesPlugins = useSlotEntries('kanban.column');
  // mission_id → agent live state ('thinking' | 'needs_action' | ...)
  const [agentStateByMission, setAgentStateByMission] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    setFilters(readKanbanFilters(storage()));
    setFiltersReady(true);
  }, []);

  // The keyword is typed into a draft and committed after a pause: each commit
  // re-queries the DONE window (`done_q`), which a keystroke must not do.
  const [qDraft, setQDraft] = useState('');
  useEffect(() => { setQDraft(filters.q); }, [filters.q]);
  useEffect(() => {
    if (qDraft === filters.q) return;
    const timer = setTimeout(() => changeFilters({ ...filters, q: qDraft }), 250);
    return () => clearTimeout(timer);
    // changeFilters only wraps setFilters + storage.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qDraft, filters]);

  function changeFilters(next: KanbanFilters) {
    setFilters(next);
    writeKanbanFilters(storage(), next);
  }

  const taskQuery = boardTaskQuery(doneLimit, filters);
  // A reply to an older window or filter must not overwrite the current one.
  const currentQuery = useRef(taskQuery);
  currentQuery.current = taskQuery;

  const fetchData = useCallback(async () => {
    try {
      const [tr, ar, actR] = await Promise.all([
        fetch(`/api/ui/tasks?${taskQuery}`, { cache: 'no-store' }).then((r) =>
          r.ok ? r.json() : { tasks: [] },
        ),
        fetch('/api/ui/agents', { cache: 'no-store' }).then((r) =>
          r.ok ? r.json() : { agents: [] },
        ),
        fetch('/api/ui/agents/active', { cache: 'no-store' }).then((r) =>
          r.ok ? r.json() : { agents: [] },
        ),
      ]);
      if (currentQuery.current !== taskQuery) return;
      setTasks(tr.tasks || []);
      setDoneTotal(typeof tr.done_total === 'number' ? tr.done_total : null);
      setAgents(ar.agents || []);
      const stateMap = new Map<string, string>();
      for (const a of (actR.agents ?? []) as Array<{ name: string; state: string; mission_id: string }>) {
        if (a.mission_id) stateMap.set(a.mission_id, a.state);
      }
      setAgentStateByMission(stateMap);
    } catch {
      /* keep last state */
    }
  }, [taskQuery]);

  useEffect(() => {
    if (!filtersReady) return;
    fetchData();
    const id = setInterval(fetchData, 5000);
    return () => clearInterval(id);
  }, [fetchData, filtersReady]);

  // Tags of the TO DO ideas the board's tasks carry out. Read again only when
  // that set of ideas changes, not at every poll: a tag rarely moves, and the
  // notebook can hold far more ideas than the board holds tasks.
  const todoKey = useMemo(
    () => Array.from(new Set(tasks.map((t) => t.todo_id).filter((id): id is number => typeof id === 'number'))).sort((x, y) => x - y).join(','),
    [tasks],
  );
  const [todos, setTodos] = useState<Map<number, ProjectTodo>>(new Map());
  useEffect(() => {
    if (!todoKey) return;
    let off = false;
    fetch('/api/ui/project-todo?status=all', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((j: { items?: ProjectTodo[] }) => {
        if (!off) setTodos(new Map((j.items ?? []).map((item) => [item.id, item])));
      })
      .catch(() => { /* a card without its tags is still a card */ });
    return () => { off = true; };
  }, [todoKey]);

  // A task's project is its own when set at creation, else its agent's
  // (`taskProject`, the daemon's rule for `done_project`). We resolve the slug,
  // then slug → the actual color/logo.
  const projectMeta = useProjectMeta();
  const projectByAgent = new Map(agents.map((a) => [a.name, a.project ?? null]));
  const taskById = new Map(tasks.map((t) => [t.id, t]));
  const identities = useMemo(() => {
    const byName = new Map<string, { identity: AgentIdentity; role: string | null }>();
    for (const a of agents) {
      byName.set(a.name, {
        identity: agentIdentity(a, a.project ? projectMeta.get(a.project) ?? null : null),
        role: a.role ? resolveRole(a.role)?.label ?? a.role : null,
      });
    }
    return byName;
  }, [agents, projectMeta]);
  const now = Date.now();

  const filtered = filterBoardTasks(tasks, filters, projectByAgent);

  const byCol = groupByColumn(filtered);
  // Chronological sort by trigger time: scheduled_at ASC (nulls last),
  // then priority DESC, then created_at ASC. The dispatcher remains free to
  // use its own SQL-side order — this is display only.
  for (const k of Object.keys(byCol) as TaskStatus[]) {
    if (k === 'DONE') {
      // DONE: most recent first (updated_at DESC)
      byCol[k].sort((a, b) => b.updated_at - a.updated_at);
    } else {
      byCol[k].sort((a, b) => {
        const sa = a.scheduled_at ?? Number.POSITIVE_INFINITY;
        const sb = b.scheduled_at ?? Number.POSITIVE_INFINITY;
        if (sa !== sb) return sa - sb;
        if (a.priority !== b.priority) return b.priority - a.priority;
        return a.created_at - b.created_at;
      });
    }
  }

  // Single interaction for opening a task, shared by the card and the graph
  // node: its popup, whatever its status. The mission has its own button.
  function openTask(task: Task) {
    void openEditor(task.id);
  }

  // The board's rows carry trimmed texts: the form edits the stored task,
  // never a preview it would save back over the full description.
  async function openEditor(id: string) {
    const r = await fetch(`/api/ui/tasks/${encodeURIComponent(id)}`, { cache: 'no-store' }).catch(() => null);
    const body = r?.ok ? await r.json().catch(() => null) as { task?: Task } | null : null;
    if (body?.task) setEditTask(body.task);
    else toast.error(i18n('kanbanPage.openFailed'));
  }

  async function stopMission(missionId: string) {
    if (!(await confirmAction({ title: i18n('kanbanPage.card.stopConfirm'), confirmLabel: i18n('confirmDialog.stop'), destructive: true }))) return;
    const r = await fetch(`/api/ui/missions/${encodeURIComponent(missionId)}`, { method: 'DELETE' }).catch(() => null);
    if (r?.ok) fetchData();
    else toast.error(i18n('kanbanPage.card.stopFailed', { status: r?.status ?? 0 }));
  }

  /** True once the task is gone, so the popup that asked can close. */
  async function deleteTask(id: string): Promise<boolean> {
    if (!(await confirmAction({ title: i18n('kanbanDelete.confirm'), confirmLabel: i18n('confirmDialog.delete'), destructive: true }))) return false;
    let result = await deleteKanbanTask(id);
    // A chain root is refused alone: the count comes from the daemon, so the
    // user confirms exactly what the chain deletion removes.
    if (!result.ok && result.chainSize) {
      if (!(await confirmAction({ title: i18n('kanbanDelete.chainConfirm', { count: result.chainSize }), confirmLabel: i18n('confirmDialog.delete'), destructive: true }))) return false;
      result = await deleteKanbanTask(id, { chain: true });
    }
    if (result.ok) { toast.success(result.message); fetchData(); }
    else toast.error(result.message, { duration: 10000 });
    return result.ok;
  }

  async function moveTask(id: string, newStatus: TaskStatus) {
    const r = await fetch(`/api/ui/tasks/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: newStatus }),
    });
    if (r.ok) fetchData();
    else toast.error(i18n('kanbanPage.moveFailed', { status: r.status }));
  }

  function onDragStart(id: string) { setDragId(id); }
  function onDragEnd() { setDragId(null); dragOver.current = null; }
  function onDragOverCol(status: TaskStatus) { dragOver.current = status; }

  async function onDropCol(status: TaskStatus) {
    if (dragId && status !== 'IN_PROGRESS') {
      await moveTask(dragId, status);
    } else if (dragId && status === 'IN_PROGRESS') {
      toast(i18n('kanbanPage.inProgressManaged'));
    }
    setDragId(null);
    dragOver.current = null;
  }

  // A tint of the text colour, like the Missions filters: half of `muted`
  // vanished into the light island, which is nearly the same beige.
  const controlClass = 'flex h-9 items-center gap-2 rounded-lg bg-foreground/[0.06] px-2.5';
  const triggerClass = 'h-8 border-0 bg-transparent px-1 text-[13px] shadow-none focus:ring-0 focus:ring-offset-0';

  return (
    <>
      {showNew && (
        <TaskFormModal
          agents={agents}
          defaultAgent={defaultAgent}
          onSaved={fetchData}
          onClose={() => setShowNew(false)}
        />
      )}

      {mergeTask && (
        <MarkMergedDialog task={mergeTask} onClose={() => setMergeTask(null)} onMerged={() => { void fetchData(); }} />
      )}

      {graphView && (
        <SeriesGraphDialog
          open
          onOpenChange={(o) => { if (!o) setGraphView(null); }}
          /* The FULL list, never `filtered` or the DONE page: a graph missing
           * the tasks a filter hides would silently shift every rank. */
          tasks={tasks}
          seriesId={graphView.seriesId}
          focusId={graphView.focusId}
          onOpenTask={(task) => { setGraphView(null); openTask(task); }}
        />
      )}

      {editTask && (
        <TaskFormModal
          agents={agents}
          task={editTask}
          onSaved={fetchData}
          onDelete={() => deleteTask(editTask.id)}
          onClose={() => setEditTask(null)}
        />
      )}

      <header className="flex flex-wrap items-center gap-3 pb-3">
        <h1 className="m-0 mr-1 text-[22px] font-semibold -tracking-[0.01em]">{i18n('kanbanPage.title')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <label className={controlClass}>
            <span className="text-[12px] text-muted-foreground">{i18n('kanbanPage.filterProject')}</span>
            <Select
              value={filters.project}
              onValueChange={(project) => changeFilters(withProject(filters, project, agents))}
            >
              <SelectTrigger aria-label={i18n('kanbanPage.filterProject')} className={triggerClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_FILTER}>{i18n('kanbanPage.filterAll')}</SelectItem>
                {projectOptions(agents, tasks, filters).map((slug) => (
                  <SelectItem key={slug} value={slug}>
                    {projectMeta.get(slug)?.name || slug}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className={controlClass}>
            <span className="text-[12px] text-muted-foreground">{i18n('kanbanPage.filterAgent')}</span>
            <Select value={filters.agent} onValueChange={(agent) => changeFilters({ ...filters, agent })}>
              <SelectTrigger aria-label={i18n('kanbanPage.filterAgent')} className={triggerClass}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_FILTER}>{i18n('kanbanPage.filterAll')}</SelectItem>
                {agentOptions(agents, filters).map((name) => (
                  <SelectItem key={name} value={name}>
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className={controlClass}>
            <Search className="size-3.5 flex-none text-muted-foreground" aria-hidden />
            <input
              type="search"
              value={qDraft}
              onChange={(e) => setQDraft(e.target.value)}
              placeholder={i18n('kanbanPage.filterSearchPlaceholder')}
              aria-label={i18n('kanbanPage.filterSearch')}
              className="h-8 w-48 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70"
            />
          </label>
          {isFiltered(filters) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => changeFilters(DEFAULT_KANBAN_FILTERS)}
              className="h-9 px-2.5 text-[12.5px] text-muted-foreground"
            >
              {i18n('kanbanPage.resetFilters')}
            </Button>
          )}
        </div>
        <div className="ml-auto flex items-center gap-3">
          <Button size="sm" onClick={() => setShowNew(true)} className="h-9 gap-1.5 px-4 text-[13px] font-semibold">
            <Plus className="size-4" aria-hidden />
            {i18n('kanbanPage.newTask')}
          </Button>
        </div>
      </header>

      {/* Columns are islands on the chrome fill: the gutter between them is
          the only line, no border draws it. */}
      <div
        className={cn(
          'timon-island-backdrop flex min-h-0 flex-1 gap-[var(--timon-island-gap)] overflow-x-auto overflow-y-hidden rounded-[var(--timon-island-radius)] p-[var(--timon-island-gap)] [-webkit-overflow-scrolling:touch] md:grid md:overflow-hidden',
          kanbanGridClass(colonnesPlugins.length),
        )}
      >
        {/* Plugin columns come BEFORE the statuses: that is the place the
            slot promises (§10.12), and the only one that makes sense for a
            pool of ideas — what is not a task yet comes before what is. The
            host only sets the column's geometry; the plugin paints its frame,
            its header and its body, like a `frame: 'none'` widget. No
            `onDragOver` here: a task dragged onto it finds no target and goes
            back to its column, because a plugin column is not a task
            status. */}
        <KanbanFiltersContext.Provider value={filters}>
          {colonnesPlugins.map(({ id, pluginId, Component }) => (
            <div key={id} className="flex w-[82vw] flex-none flex-col overflow-hidden md:w-auto">
              <PluginBoundary pluginId={pluginId}><Component /></PluginBoundary>
            </div>
          ))}
        </KanbanFiltersContext.Provider>
        {COLUMNS.map((col) => {
          const allCards = byCol[col.key];
          const cards = col.key === 'DONE' ? allCards.slice(0, doneLimit) : allCards;
          // Without a filter the window is global, so doneTotal counts the
          // column; with one, the server windowed the matching DONE only.
          const doneCount = doneTotal ?? allCards.length;
          const doneHasMore = col.key === 'DONE' && doneCount > doneLimit;
          const label = i18n(col.labelKey);
          return (
            <section
              key={col.key}
              aria-label={label}
              className={cn(
                'timon-island flex w-[82vw] flex-none flex-col transition-shadow md:w-auto',
                dragId && col.key !== 'IN_PROGRESS' && 'ring-2 ring-inset ring-primary/40',
              )}
              style={columnWash(col.tint)}
              onDragOver={(e) => { e.preventDefault(); onDragOverCol(col.key); }}
              onDrop={() => onDropCol(col.key)}
            >
              <KanbanColumnHeader
                label={label}
                count={formatNumber(col.key === 'DONE' ? doneCount : cards.length)}
                dotClass={col.dot}
                pulse={col.key === 'IN_PROGRESS' && cards.length > 0}
              />
              <div className="flex flex-1 flex-col gap-2 overflow-y-auto overflow-x-hidden p-2">
                {allCards.length === 0 ? (
                  <KanbanColumnEmpty>{i18n(col.emptyKey)}</KanbanColumnEmpty>
                ) : (
                  cards.map((t) => {
                    const known = identities.get(t.agent_name);
                    return (
                      <KanbanCardHost
                        key={t.id}
                        value={{
                          kind: 'task',
                          density: 'card',
                          task: t,
                          board: taskById,
                          now,
                          agent: known?.identity ?? pseudoIdentity(t.agent_name),
                          agentRole: known?.role ?? null,
                          todo: typeof t.todo_id === 'number' ? todos.get(t.todo_id) ?? null : null,
                          needsAction: !!t.mission_id && agentStateByMission.get(t.mission_id) === 'needs_action',
                          dragging: dragId === t.id,
                          // What the vault sees at spawn: the agent's project, not `task.project`.
                          modelTarget: { agent: t.agent_name, project: projectByAgent.get(t.agent_name) },
                          // A running task stays in its column: the product card makes the same call.
                          drag: { draggable: t.status !== 'IN_PROGRESS', onDragStart: () => onDragStart(t.id), onDragEnd },
                          open: () => openTask(t),
                          stop: () => { if (t.mission_id) void stopMission(t.mission_id); },
                          markMerged: () => setMergeTask(t),
                          openGraph: (focusId) => { if (t.series_id) setGraphView({ seriesId: t.series_id, focusId }); },
                          refresh: fetchData,
                        }}
                      />
                    );
                  })
                )}
                {doneHasMore && (
                  <button
                    type="button"
                    onClick={() => setDoneLimit((l) => l + DONE_PAGE_SIZE)}
                    className="w-full rounded-lg px-2 py-2 text-left text-[12.5px] tabular-nums text-primary transition-colors hover:bg-muted/50"
                  >
                    {i18n('kanbanPage.moreTasks', { count: formatNumber(doneCount - doneLimit) })}
                  </button>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </>
  );
}
