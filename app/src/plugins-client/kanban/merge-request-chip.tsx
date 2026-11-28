'use client';

/**
 * The pull (GitHub) or merge (GitLab) request a task opened: "MR !7" /
 * "PR #12", coloured by its state. A click opens it in a new tab and never the
 * card it sits on.
 */

import type { ReactElement } from 'react';
import { GitMerge, GitPullRequest, GitPullRequestClosed } from 'lucide-react';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import type { Task } from './kanban-task';

export type MergeRequestRef = {
  url: string;
  forge: 'github' | 'gitlab';
  number: number;
  state: 'open' | 'merged' | 'closed';
  pipeline: string | null;
};

const STATES = ['open', 'merged', 'closed'] as const;

/** The reference a task row carries, or null; an unknown state reads as open. */
export function mergeRequestOf(task: Pick<Task, 'mr_url' | 'mr_forge' | 'mr_number' | 'mr_state' | 'mr_pipeline'>): MergeRequestRef | null {
  const { mr_url: url, mr_forge: forge, mr_number: number } = task;
  if (!url || !number || (forge !== 'github' && forge !== 'gitlab')) return null;
  // Only a web link is ever put in an href.
  if (!/^https?:\/\//i.test(url)) return null;
  const state = STATES.find((s) => s === task.mr_state) ?? 'open';
  return { url, forge, number, state, pipeline: task.mr_pipeline ?? null };
}

/** `MR !7` on GitLab, `PR #12` on GitHub. */
export function mergeRequestLabel(mr: Pick<MergeRequestRef, 'forge' | 'number'>): string {
  return mr.forge === 'gitlab' ? `MR !${mr.number}` : `PR #${mr.number}`;
}

const TONE: Record<MergeRequestRef['state'], string> = {
  open: 'bg-success/15 text-success hover:bg-success/25',
  merged: 'bg-primary/15 text-primary hover:bg-primary/25',
  closed: 'bg-destructive/15 text-destructive hover:bg-destructive/25',
};
const ICON = { open: GitPullRequest, merged: GitMerge, closed: GitPullRequestClosed } as const;

export function MergeRequestChip({ task, className }: {
  task: Parameters<typeof mergeRequestOf>[0];
  className?: string;
}): ReactElement | null {
  const mr = mergeRequestOf(task);
  if (!mr) return null;
  const Icon = ICON[mr.state];
  const label = mergeRequestLabel(mr);
  const state = t(`kanbanPage.mergeRequest.state.${mr.state}`);
  const title = [t('kanbanPage.mergeRequest.open', { label }), state, mr.pipeline ? t('kanbanPage.mergeRequest.pipeline', { status: mr.pipeline }) : null]
    .filter(Boolean).join(' · ');
  return (
    <a
      href={mr.url}
      target="_blank"
      rel="noopener noreferrer"
      data-merge-request-chip={mr.state}
      onClick={(e) => e.stopPropagation()}
      // A draggable card would otherwise start dragging the link.
      draggable={false}
      title={title}
      aria-label={`${label} · ${state}`}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10.5px] font-medium tabular-nums focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        TONE[mr.state],
        className,
      )}
    >
      <Icon className="size-3" aria-hidden />{label}
    </a>
  );
}
