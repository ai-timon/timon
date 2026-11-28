'use client';

/**
 * Fullscreen view of a task series as a graph.
 *
 * The layout is entirely deterministic (see `@/lib/series-graph`): one column
 * per topological rank, so a column reads as a wave of parallelism. No force
 * simulation — a graph that moves between two renders cannot be compared with
 * the one you looked at five seconds ago, which is the whole point here.
 *
 * The dialog receives the task list from the Kanban page and derives
 * everything from it: it opens no connection and starts no polling of its own,
 * so it refreshes exactly when the page underneath does.
 */

import { useMemo, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Dialog, DialogOverlay, DialogPortal, DialogTitle } from '@/components/ui/dialog';
import { RoleBadge } from '@/components/role-badge';
import { BrandMark } from '@/components/brand-mark';
import { useBackendCatalog, type BackendCatalog } from '@/lib/backends';
import { taskRunView } from '@/lib/task-runner';
import { cn } from '@/lib/utils';
import { t } from '@/lib/i18n';
import {
  buildSeriesGraph,
  formatElapsed,
  type SeriesGraphNode,
  type SeriesTask,
  type SeriesTaskStatus,
} from '@/lib/series-graph';
import { NativeViewCover } from '@/lib/native-view-cover';

// Fixed geometry: node boxes never resize, so edges drawn from these numbers
// always land on the box they point at. Satellites open in an overlay rather
// than growing the node, precisely to keep that true.
const NODE_W = 208;
const NODE_H = 96;
const GAP_X = 72;
const GAP_Y = 22;
const PAD = 28;

const STATUS_TONE: Record<SeriesTaskStatus, string> = {
  PENDING: 'border-border bg-secondary/50',
  IN_PROGRESS: 'border-primary/50 bg-primary/[0.07]',
  DONE: 'border-[hsl(var(--success)/0.45)] bg-[hsl(var(--success)/0.06)]',
  BLOCKED: 'border-destructive/60 bg-destructive/[0.08]',
};

const STATUS_DOT: Record<SeriesTaskStatus, string> = {
  PENDING: 'bg-muted-foreground/60',
  IN_PROGRESS: 'bg-primary',
  DONE: 'bg-[hsl(var(--success))]',
  BLOCKED: 'bg-destructive',
};

/** Edge colour: an edge leaving a blocked node is the thing holding the rest,
 *  so it is drawn in the blocking colour rather than the neutral one. */
function edgeStroke(blocked: boolean): string {
  return blocked ? 'hsl(var(--destructive) / 0.55)' : 'hsl(var(--muted-foreground) / 0.35)';
}

function nodeX(rank: number): number {
  return PAD + rank * (NODE_W + GAP_X);
}

function nodeY(order: number): number {
  return PAD + order * (NODE_H + GAP_Y);
}

/** One folded chain task, shown as a pastille under its host. */
function SatellitePill({
  task,
  highlighted,
  onOpen,
}: {
  task: SeriesTask;
  highlighted: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      title={`${task.type ?? 'task'} · ${task.status} · ${task.title}`}
      onClick={(e) => { e.stopPropagation(); onOpen(); }}
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 tabular-nums text-[9.5px] text-muted-foreground transition-colors hover:text-foreground',
        STATUS_TONE[task.status],
        highlighted && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
      )}
    >
      <span className={cn('size-1.5 rounded-full', STATUS_DOT[task.status])} />
      {task.type ?? 'task'}
    </button>
  );
}

function GraphNodeBox<T extends SeriesTask>({
  node,
  now,
  catalog,
  onOpen,
}: {
  node: SeriesGraphNode<T>;
  now: number;
  catalog: BackendCatalog;
  onOpen: (task: T) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const task = node.task;
  const iteration = task.iteration ?? 1;
  const elapsed =
    task.status === 'IN_PROGRESS' && typeof task.updated_at === 'number'
      ? formatElapsed(task.updated_at, now)
      : null;
  const run = taskRunView(catalog, task);
  return (
    <div
      className="absolute"
      style={{ left: nodeX(node.rank), top: nodeY(node.order), width: NODE_W }}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={() => onOpen(task)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpen(task); }}
        title={`${task.id.slice(0, 8)} · ${run.title}`}
        className={cn(
          'flex cursor-pointer flex-col gap-1.5 rounded-lg border px-2.5 py-2 transition-colors hover:border-muted-foreground/50',
          STATUS_TONE[task.status],
          // Held downstream of a blocked task: attenuated, because it is not
          // late by its own doing and reading it as a problem is a mistake.
          node.blockedUpstream && 'opacity-45',
          node.inCycle && 'border-amber-500/70',
          node.focused && 'ring-2 ring-primary ring-offset-2 ring-offset-background',
        )}
        style={{ height: NODE_H }}
      >
        <div className="flex items-center gap-1.5">
          <span className={cn('size-2 flex-none rounded-sm', STATUS_DOT[task.status])} />
          {task.type && <RoleBadge role={task.type} size="xs" uppercase={false} />}
          {iteration > 1 && (
            <span className="rounded border border-amber-500/40 bg-amber-500/10 px-1 tabular-nums text-[9.5px] text-amber-500">
              {t('seriesGraph.iteration', { n: iteration })}
            </span>
          )}
          {node.focused && (
            <span className="ml-auto text-[9px] uppercase tracking-wide text-primary">
              {t('seriesGraph.origin')}
            </span>
          )}
        </div>
        <div className="line-clamp-2 text-[11.5px] font-medium leading-snug">{task.title}</div>
        {/* Who runs the task and on what, as the card says it (#1203): the
          * agent the roles hand it to, not always the one it names. Faded
          * unless it is running; the id moved to the tooltip. */}
        <div
          data-task-runner={run.agent}
          className={cn(
            'mt-auto flex min-w-0 items-center gap-1.5 tabular-nums text-[9.5px]',
            task.status === 'IN_PROGRESS' ? 'text-muted-foreground/80' : 'text-muted-foreground/55',
          )}
        >
          <span className="min-w-0 truncate">{run.agent}</span>
          {run.model && (
            <span className="inline-flex min-w-0 shrink items-center gap-1" data-task-model={run.model}>
              {!run.mark.empty && (
                <BrandMark
                  icon={run.mark.icon}
                  brand={run.mark.brand}
                  slug={run.mark.slug}
                  fallbackIcon={run.mark.fallbackIcon}
                  fallbackBrand={run.mark.fallbackBrand}
                  className="size-2.5 flex-none"
                />
              )}
              <span className="truncate">{run.model}</span>
            </span>
          )}
          {elapsed && <span className="ml-auto flex-none text-primary">{elapsed}</span>}
        </div>
      </div>

      {node.satellites.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {(expanded ? node.satellites : node.satellites.slice(0, 3)).map((s) => (
            <SatellitePill
              key={s.id}
              task={s}
              highlighted={node.focusedSatelliteId === s.id}
              onOpen={() => onOpen(s as T)}
            />
          ))}
          {!expanded && node.satellites.length > 3 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              className="rounded-full border border-border px-1.5 py-0.5 tabular-nums text-[9.5px] text-muted-foreground hover:text-foreground"
            >
              +{node.satellites.length - 3}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export function SeriesGraphDialog<T extends SeriesTask>({
  open,
  onOpenChange,
  tasks,
  seriesId,
  focusId,
  onOpenTask,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** FULL task list of the page — never the filtered or paginated one: a
   *  series graph missing the tasks hidden by an agent filter would silently
   *  shift every rank. Filtering by series happens inside the builder. */
  tasks: readonly T[];
  seriesId: string;
  /** Task the graph was opened from, highlighted. Null when opened from the
   *  series identifier. */
  focusId?: string | null;
  onOpenTask: (task: T) => void;
}) {
  // Read at render time, so the elapsed times advance exactly when the Kanban
  // page refreshes its task list. No clock of its own: a second timer would
  // redraw the graph between two identical states, for nothing.
  const now = Date.now();
  const catalog = useBackendCatalog();
  const graph = useMemo(
    () => buildSeriesGraph(tasks, { seriesId, focusId }),
    [tasks, seriesId, focusId],
  );

  const nodeById = useMemo(
    () => new Map(graph.nodes.map((n) => [n.id, n])),
    [graph],
  );
  const width = PAD * 2 + Math.max(1, graph.ranks.length) * (NODE_W + GAP_X) - GAP_X;
  const rows = graph.ranks.reduce((m, col) => Math.max(m, col.length), 1);
  const height = PAD * 2 + rows * (NODE_H + GAP_Y) + 24;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className="timon-below-window-band fixed inset-0 left-0 top-0 z-50 flex h-screen w-screen max-w-none translate-x-0 translate-y-0 flex-col gap-0 border-0 bg-background p-0 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
          aria-describedby={undefined}
        >
          <NativeViewCover />
          <header className="flex flex-wrap items-center gap-2 px-4 py-2.5">
            <DialogTitle className="m-0 text-[14px] font-semibold">
              {t('seriesGraph.title')}
            </DialogTitle>
            <span className="rounded border border-border bg-muted/40 px-1.5 text-[11px] text-muted-foreground">
              {seriesId.slice(0, 8)}
            </span>
            <span className="tabular-nums text-[11px] text-muted-foreground/70">
              {t('seriesGraph.summary', {
                tasks: graph.nodes.length,
                waves: graph.ranks.length,
              })}
            </span>
            <div className="flex-1" />
            <DialogPrimitive.Close
              className="rounded-md border border-border p-1 text-muted-foreground transition-colors hover:text-foreground"
              aria-label={t('seriesGraph.close')}
            >
              <X className="size-4" />
            </DialogPrimitive.Close>
          </header>

          {(graph.hasCycle || graph.ignoredDeps > 0) && (
            <div className="flex flex-wrap gap-3 bg-amber-500/10 px-4 py-1.5 text-[11.5px] text-amber-500">
              {graph.hasCycle && (
                <span>{t('seriesGraph.cycleWarning', { count: graph.cycleIds.length })}</span>
              )}
              {graph.ignoredDeps > 0 && (
                <span>{t('seriesGraph.ignoredDeps', { count: graph.ignoredDeps })}</span>
              )}
            </div>
          )}

          <div className="min-h-0 flex-1 overflow-auto">
            {graph.nodes.length === 0 ? (
              <div className="p-8 text-center text-[12.5px] text-muted-foreground">
                {t('seriesGraph.empty')}
              </div>
            ) : (
              <div className="relative" style={{ width, height }}>
                <svg width={width} height={height} className="absolute inset-0">
                  {graph.edges.map((e) => {
                    const from = nodeById.get(e.from);
                    const to = nodeById.get(e.to);
                    if (!from || !to) return null;
                    const x1 = nodeX(from.rank) + NODE_W;
                    const y1 = nodeY(from.order) + NODE_H / 2;
                    const x2 = nodeX(to.rank);
                    const y2 = nodeY(to.order) + NODE_H / 2;
                    const mid = (x1 + x2) / 2;
                    const blocked = from.task.status === 'BLOCKED';
                    return (
                      <path
                        key={`${e.from}->${e.to}`}
                        d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
                        fill="none"
                        stroke={edgeStroke(blocked)}
                        strokeWidth={blocked ? 1.75 : 1.25}
                        // An edge going backwards can only come from a cycle;
                        // dashing it says so without a second legend.
                        strokeDasharray={to.rank <= from.rank ? '4 3' : undefined}
                      />
                    );
                  })}
                </svg>
                {graph.nodes.map((n) => (
                  <GraphNodeBox key={n.id} node={n} now={now} catalog={catalog} onOpen={onOpenTask} />
                ))}
              </div>
            )}
          </div>

          <footer className="flex flex-wrap items-center gap-3 bg-muted/30 px-4 py-1.5 text-[10.5px] text-muted-foreground/80">
            {(['PENDING', 'IN_PROGRESS', 'DONE', 'BLOCKED'] as SeriesTaskStatus[]).map((s) => (
              <span key={s} className="inline-flex items-center gap-1.5">
                <span className={cn('size-2 rounded-sm', STATUS_DOT[s])} />
                {s}
              </span>
            ))}
            <span className="inline-flex items-center gap-1.5 opacity-45">
              <span className="size-2 rounded-sm bg-muted-foreground/60" />
              {t('seriesGraph.legendHeld')}
            </span>
            <span className="ml-auto">{t('seriesGraph.legendColumns')}</span>
          </footer>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
