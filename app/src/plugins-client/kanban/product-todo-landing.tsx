'use client';

/**
 * The product's occupant of `kanban.todo.landing`: where the branch of an
 * idea's jobs stands, as one chip. Read-only and derived by the daemon; the
 * work's own progress is the other chip, never this one.
 *
 * A click opens the job's dialog, the one of the jobs widget (diff, commits,
 * pre-checks, and its pull request on the forge), rather than leaving for the
 * browser: the job is the work, the pull request one of its states. It does
 * not open the idea (`BoardCard` leaves buttons to themselves), and nothing
 * from the dialog reaches the line under it. Several jobs: the chip shows the
 * one furthest from landing and opens it, the tooltip lists them all.
 */

import { lazy, Suspense, useState, type ReactElement, type SyntheticEvent } from 'react';
import { toast } from 'sonner';
import { GitBranch, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft, type LucideIcon } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { safeHref } from './project-todo-links';
import { useTodoItem } from './todo-badge-slot';
import { findLanding, getLanding, listLandings, type Landing } from './landing-api';

// Painted on every line of the TO DO: the dialog loads on the first click.
const JobDialog = lazy(() => import('./job-dialog').then((m) => ({ default: m.JobDialog })));

/** React events bubble from a portal to the tree that holds it: the dialog's
 *  clicks and presses must not open the idea or drag its card. */
const stop = (e: SyntheticEvent) => { e.stopPropagation(); };
import type { TodoLanding, TodoLandingJob, TodoLandingState } from './project-todo-types';

// Same shape as the urgency and progress chips beside it.
const CHIP = 'inline-flex items-center gap-1 rounded-md border px-1.5 py-px text-[10.5px] font-medium leading-4';

const LANDING_CLASS: Record<TodoLandingState, string> = {
  branch: 'border-transparent bg-foreground/[0.06] text-muted-foreground',
  pending: 'border-transparent bg-amber-500/[0.14] text-amber-700 dark:text-amber-300',
  open: 'border-transparent bg-emerald-500/[0.12] text-emerald-700 dark:text-emerald-400',
  merged: 'border-transparent bg-violet-500/[0.12] text-violet-700 dark:text-violet-300',
  closed: 'border-transparent bg-rose-500/[0.12] text-rose-700 dark:text-rose-300',
};

const LANDING_ICON: Record<TodoLandingState, LucideIcon> = {
  branch: GitBranch,
  pending: GitPullRequestDraft,
  open: GitPullRequest,
  merged: GitMerge,
  closed: GitPullRequestClosed,
};

/** What a job says in a few words: its pull request when it has one. */
export function landingLabel(job: TodoLandingJob): string {
  const number = job.prNumber;
  switch (job.state) {
    case 'branch': return t('projectTodo.landing.branch');
    case 'pending': return t('projectTodo.landing.pending');
    case 'open': return number === null ? t('projectTodo.landing.openNoNumber') : t('projectTodo.landing.open', { number });
    case 'merged': return number === null ? t('projectTodo.landing.mergedNoNumber') : t('projectTodo.landing.merged', { number });
    case 'closed': return number === null ? t('projectTodo.landing.closedNoNumber') : t('projectTodo.landing.closed', { number });
  }
}

const TIP = 'rounded-md bg-popover px-2 py-1 text-[11.5px] text-popover-foreground shadow-elev-2';

/** The chip of `landing`; a click opens its job's dialog. `project` narrows
 *  the lookup of the job to the idea's project. */
export function TodoLandingBadge({ landing, project = null }: { landing: TodoLanding; project?: string | null }): ReactElement {
  const [opened, setOpened] = useState<Landing | null>(null);
  const [busy, setBusy] = useState(false);
  const Icon = LANDING_ICON[landing.state];
  const label = landingLabel(landing);
  const several = landing.jobs.length > 1;
  const detail = landing.jobs.map((job) => `${job.branch}: ${landingLabel(job)}`);
  const accessible = several ? `${label} · ${detail.join(' · ')}` : `${label} · ${landing.branch}`;

  const open = async () => {
    setBusy(true);
    // The job's own id when the daemon gives it (its links come with it);
    // else the latest job of the branch in the project's list.
    const byId = landing.jobId ? await getLanding(landing.jobId) : null;
    const out = byId?.ok ? null : await listLandings(project);
    setBusy(false);
    if (byId?.ok) { setOpened(byId.value); return; }
    if (!out) return;
    const found = out.ok ? findLanding(out.value, landing.branch) : null;
    if (found) { setOpened(found); return; }
    // The job left the list (its branch removed): its pull request, if any,
    // is still worth reaching.
    const href = safeHref(landing.prUrl);
    if (href) window.open(href, '_blank', 'noopener,noreferrer');
    else toast.error(out.ok ? t('projectTodo.landing.notFound') : out.message);
  };

  const chip = (
    <button
      type="button"
      data-todo-landing={landing.state}
      aria-label={`${accessible} · ${t('projectTodo.landing.openJob')}`}
      aria-busy={busy || undefined}
      onClick={(e) => { e.stopPropagation(); if (!busy) void open(); }}
      className={cn(CHIP, LANDING_CLASS[landing.state], 'cursor-pointer underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
    >
      <Icon className="size-3" aria-hidden />
      <span className="tabular-nums">{label}</span>
      {several && <span className="tabular-nums opacity-70">+{landing.jobs.length - 1}</span>}
    </button>
  );
  return (
    <>
      <TooltipProvider delayDuration={300} skipDelayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>{chip}</TooltipTrigger>
          <TooltipContent side="top" sideOffset={4} className={TIP}>
            {several ? (
              <ul data-todo-landing-jobs={landing.jobs.length} className="flex flex-col gap-0.5">
                {landing.jobs.map((job, i) => <li key={`${job.branch}:${i}`}>{detail[i]}</li>)}
              </ul>
            ) : landing.branch}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      {opened && (
        <span className="contents" onClick={stop} onPointerDown={stop} onMouseDown={stop} onKeyDown={stop}>
          <Suspense fallback={null}>
            <JobDialog landing={opened} onClose={() => setOpened(null)} />
          </Suspense>
        </span>
      )}
    </>
  );
}

/** Reads the idea from `useTodoItem()`, as a plugin's replacement would. */
export function ProductTodoLanding(): ReactElement | null {
  const item = useTodoItem();
  return item?.landing ? <TodoLandingBadge landing={item.landing} project={item.project} /> : null;
}
