'use client';

import { Clock, GitMerge, Network, Paperclip, ShieldAlert, Square, SquareArrowOutUpRight } from 'lucide-react';
import { BoardCard } from '@/components/board-card';
import { ChatLink } from '@/components/chat/chat-link';
import { RoleBadge } from '@/components/role-badge';
import { StatusLabel } from '@/components/task-form/task-form-parts';
import { ActiveAgentAvatar, AgentAvatar, type AgentIdentity } from '@/components/agent-avatar';
import { daemonMessageText } from '@/lib/api-error';
import { chatHref } from '@/lib/chat-island-params';
import { t as i18n } from '@/lib/i18n';
import { INTERRUPTION_LABEL_KEYS } from '@/lib/interruption-labels';
import {
  formatRunningFor,
  formatScheduled,
  parseDeps,
  pendingPermissionLine,
  priorityTone,
  unblocksCount,
  waitingOnCount,
  type PriorityTone,
} from '@/lib/kanban-card';
import { canMarkMerged } from '@/lib/mark-merged';
import { effectiveProgress } from '@/lib/project-todo-tags';
import { hasSeriesGraph } from '@/lib/series-graph';
import { taskRunAgent } from '@/lib/task-runner';
import { cn } from '@/lib/utils';
import type { CatalogTarget } from '@/components/model-picker';
import { MergeRequestChip } from './merge-request-chip';
import { MetaBadge, ProgressBadge, UrgencyBadge } from './project-todo-tag-chips';
import type { ProjectTodo } from './project-todo-types';
import { TaskLinksBadge } from './task-links-badge';
import { TaskParamsBadge } from './task-params-badge';
import { TaskRunnerBadge } from './task-runner-badge';
import type { Task } from './kanban-task';

const PRIORITY_CLASS: Record<PriorityTone, string> = {
  low: 'text-muted-foreground/70',
  normal: 'text-muted-foreground',
  high: 'rounded bg-warning/10 px-1.5 font-semibold text-warning',
  urgent: 'rounded bg-destructive/10 px-1.5 font-semibold text-destructive',
};

const ICON_BUTTON = 'grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** The system death cause, as a sentence for the reader who doesn't know the
 *  nomenclature; the badge beside it keeps the raw, grepable value. */
function interruptionLabel(reason: string): string {
  const key = (INTERRUPTION_LABEL_KEYS as Record<string, string | undefined>)[reason];
  return key ? i18n(key) : i18n('kanbanPage.interruptionDefault');
}

/**
 * One task of the board, laid out on `BoardCard` like an idea of the TO DO
 * column (TODO #837): the agent as identity, `P<n>` in the corner, the type,
 * the status, the runner and the linked idea as badges, what asks for attention as context, dates and
 * counts as meta. The page owns the data and the actions; the card lays them out.
 */
export function KanbanTaskCard({
  task: t, byId, now, agent, agentRole, todo, needsAction, dragging, modelTarget,
  onOpen, onStop, onMarkMerged, onOpenGraph, onSaved, onDragStart, onDragEnd,
}: {
  task: Task;
  /** The whole board, unfiltered: a filter must not change what a task waits on. */
  byId: ReadonlyMap<string, Task>;
  now: number;
  agent: AgentIdentity;
  /** The role written on the agent's sheet, as its label; null when it has none. */
  agentRole: string | null;
  todo: ProjectTodo | null;
  needsAction: boolean;
  dragging: boolean;
  modelTarget: CatalogTarget;
  onOpen: () => void;
  /** Stops the running mission; the board asks before it does. */
  onStop: () => void;
  onMarkMerged: () => void;
  onOpenGraph: (focusId: string | null) => void;
  onSaved: () => Promise<void> | void;
  onDragStart: () => void;
  onDragEnd: () => void;
}) {
  const running = t.status === 'IN_PROGRESS';
  const deps = parseDeps(t.deps);
  const waits = waitingOnCount(deps, byId);
  const dependents = t.dependents ?? [];
  const unblocks = unblocksCount(dependents, byId);
  const chain = dependents.filter((l) => l.kind === 'chain').length;
  const attachments = t.attachment_count ?? 0;
  const tone = priorityTone(t.priority);
  const subtitle = [
    agentRole,
    running && t.started_at ? formatRunningFor(t.started_at, now) : null,
  ].filter(Boolean).join(' · ');
  const scheduled = t.scheduled_at ? formatScheduled(t.scheduled_at) : null;
  // The mission is reached from its button; a click anywhere else opens the task.
  const showsMission = !!t.mission_id && (running || t.status === 'DONE');

  // The daemon's summary says what the mission waits on and for how long; the
  // agent state alone only knows that it waits.
  const waiting = running && t.pending_permission ? pendingPermissionLine(t.pending_permission, now) : null;

  const identity = (
    <>
      {running ? (
        <ActiveAgentAvatar
          identity={agent}
          state={needsAction || waiting ? 'needs_action' : 'thinking'}
          label={i18n('kanbanPage.card.running')}
        />
      ) : (
        <AgentAvatar identity={agent} />
      )}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[13px] font-semibold">{taskRunAgent(t)}</span>
        {subtitle && <span className="truncate text-[12px] tabular-nums text-muted-foreground">{subtitle}</span>}
      </span>
      <TaskParamsBadge task={t} onSaved={onSaved} target={modelTarget} />
    </>
  );

  // The status repeats the column on purpose: the tile reads the same once a
  // plugin or a filter shows it elsewhere.
  const badges = (
    <>
      {t.type && <RoleBadge role={t.type} size="sm" uppercase={false} />}
      <span data-task-status={t.status} className="text-[11px] text-muted-foreground">
        <StatusLabel status={t.status} />
      </span>
      {t.run_by && <TaskRunnerBadge named={t.agent_name} runBy={t.run_by} />}
      <MergeRequestChip task={t} />
      {todo && (
        <>
          <MetaBadge title={i18n('kanbanPage.card.todoLink')}>#{todo.id}</MetaBadge>
          {todo.urgency && <UrgencyBadge value={todo.urgency} />}
          {effectiveProgress(todo.progress) !== 'todo' && <ProgressBadge value={effectiveProgress(todo.progress)} />}
        </>
      )}
    </>
  );

  const validation = running && needsAction && !waiting;
  const context = (waiting || validation || t.interrupted_reason || t.blocked_reason) ? (
    <>
      {waiting && (
        <div
          data-pending-permission={t.pending_permission?.tool_name}
          title={waiting.title}
          className="flex min-w-0 items-start gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] text-warning"
        >
          <ShieldAlert className="mt-px size-3.5 flex-none animate-pulse" aria-hidden />
          {/* Wraps rather than truncates: in a narrow column the tool name is the point. */}
          <span className="min-w-0 tabular-nums">
            <span className="font-semibold">{waiting.label}</span>
            {waiting.deadline && <span className="whitespace-nowrap text-muted-foreground"> · {waiting.deadline}</span>}
          </span>
        </div>
      )}
      {validation && (
        <div className="flex animate-pulse items-center gap-1 rounded-md bg-warning/10 px-1.5 py-0.5 text-[11px] font-semibold text-warning">
          <span aria-hidden>⚠</span>
          <span>{i18n('kanbanPage.validationRequired')}</span>
        </div>
      )}
      {t.interrupted_reason && (
        <div className="flex items-center gap-1.5 text-[11px] text-warning">
          <span className="rounded bg-warning/15 px-1.5 py-0.5 text-[10px] uppercase tabular-nums">{t.interrupted_reason}</span>
          <span className="text-muted-foreground">
            {interruptionLabel(t.interrupted_reason)}
          </span>
        </div>
      )}
      {t.blocked_reason && (
        <div className="rounded bg-destructive/10 px-2 py-1 text-[11.5px] text-destructive">{daemonMessageText(t.blocked_reason_code, t.blocked_reason)}</div>
      )}
    </>
  ) : null;

  const meta = (scheduled || waits > 0 || unblocks > 0 || attachments > 0) ? (
    <>
      {scheduled && (
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <Clock className="size-3.5 flex-none text-primary" aria-hidden />
          <span>{i18n('kanbanPage.card.scheduled')}</span>
          <span className="font-medium text-foreground">{scheduled.date} · {scheduled.time}</span>
        </span>
      )}
      {waits > 0 && (
        <TaskLinksBadge
          tone="plain"
          label={i18n('kanbanPage.card.waits', { count: waits })}
          header={i18n('kanbanPage.depsTitle')}
          links={deps.map((id) => ({ id }))}
          byId={byId}
        />
      )}
      {unblocks > 0 && (
        <TaskLinksBadge
          tone={chain > 0 ? 'chain' : 'plain'}
          label={i18n('kanbanPage.card.unblocks', { count: unblocks })}
          header={i18n('kanbanPage.dependentsTitle')}
          links={dependents}
          byId={byId}
        />
      )}
      {attachments > 0 && (
        <span
          className="inline-flex items-center gap-1"
          title={i18n('kanbanPage.card.attachments', { count: attachments })}
          aria-label={i18n('kanbanPage.card.attachments', { count: attachments })}
        >
          <Paperclip className="size-3.5" aria-hidden />
          {attachments}
        </span>
      )}
    </>
  ) : null;

  // No graph on an isolated task: there is nothing to show.
  const graph = !!t.series_id && hasSeriesGraph(t);
  const merge = t.status === 'DONE' && canMarkMerged(t);
  const stoppable = running && !!t.mission_id;
  const actions = (graph || merge || showsMission || stoppable) ? (
    <>
      {graph && (
        <button
          type="button"
          title={i18n('seriesGraph.openGraph')}
          aria-label={i18n('seriesGraph.openGraph')}
          onClick={() => onOpenGraph(t.id)}
          className={ICON_BUTTON}
        >
          <Network className="size-3.5" aria-hidden />
        </button>
      )}
      {merge && (
        <button
          type="button"
          title={i18n('taskForm.markMerged.title')}
          aria-label={i18n('taskForm.markMerged.cardAction')}
          onClick={onMarkMerged}
          className={ICON_BUTTON}
        >
          <GitMerge className="size-3.5" aria-hidden />
        </button>
      )}
      {showsMission && t.mission_id && (
        <ChatLink
          href={chatHref(taskRunAgent(t), t.mission_id)}
          title={i18n('kanbanPage.card.openMission')}
          aria-label={i18n('kanbanPage.card.openMission')}
          className={ICON_BUTTON}
        >
          <SquareArrowOutUpRight className="size-3.5" aria-hidden />
        </ChatLink>
      )}
      {stoppable && (
        <button
          type="button"
          title={i18n('kanbanPage.card.stop')}
          aria-label={i18n('kanbanPage.card.stop')}
          onClick={onStop}
          className={cn(ICON_BUTTON, 'text-destructive hover:bg-destructive/10 hover:text-destructive')}
        >
          <Square className="size-3 fill-current" aria-hidden />
        </button>
      )}
    </>
  ) : null;

  return (
    <BoardCard
      data-task-card={t.id}
      draggable={!running}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onOpen={onOpen}
      tone={running ? 'running' : t.status === 'BLOCKED' ? 'blocked' : 'default'}
      dragging={dragging}
      className={cn((t.status === 'PENDING' || t.status === 'BLOCKED') && 'active:cursor-grabbing')}
      identity={identity}
      corner={(
        <span
          className={cn('text-[11.5px] tabular-nums', PRIORITY_CLASS[tone])}
          title={i18n('kanbanPage.card.priority', { priority: t.priority })}
        >
          P{t.priority}
        </span>
      )}
      title={<span data-card-title="">{t.title}</span>}
      badges={badges}
      context={context}
      meta={meta}
      actions={actions}
    />
  );
}
