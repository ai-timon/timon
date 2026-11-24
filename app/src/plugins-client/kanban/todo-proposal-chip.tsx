'use client';

/**
 * "To approve" on a TO DO idea: a publication on GitHub waits for a person on
 * one of the idea's issues, or on the pull request of one of its jobs (the
 * comment its landing proposed, a branch update). A click opens it in
 * "Publish on GitHub" over the page; the row itself is not opened.
 */

import { useMemo, type ReactElement } from 'react';
import { isPending, type ForgeProposal } from './forge-proposals-api';
import { openForgeProposal } from './forge-proposal-link';
import { ProposalChip } from './proposal-chip';
import { todoIssues } from './todo-issue-chips';
import { useForgeProposals } from './use-forge-proposals';
import type { ProjectTodo } from './project-todo-types';

const PR_URL = /^https:\/\/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)$/;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The pull requests of the idea's jobs, as `owner/repo` and number. */
function todoPulls(item: ProjectTodo): Array<{ repo: string; number: number }> {
  const jobs = item.landing ? [item.landing, ...item.landing.jobs] : [];
  return jobs.flatMap((job) => {
    const m = job.prUrl ? PR_URL.exec(job.prUrl) : null;
    return m && job.prNumber !== null && Number(m[2]) === job.prNumber ? [{ repo: m[1]!, number: job.prNumber }] : [];
  });
}

/** The proposals of `pending` waiting on the idea: on its issues, or on its jobs' pull requests. */
export function proposalsForTodo(pending: readonly ForgeProposal[], item: ProjectTodo): ForgeProposal[] {
  if (!item.project) return [];
  const issues = todoIssues(item);
  const pulls = todoPulls(item);
  return pending.filter((p) => isPending(p) && p.project === item.project && (
    p.target.type === 'issue'
      ? issues.some((i) => i.number === p.target.number && same(i.repo, p.repo))
      : pulls.some((pr) => pr.number === p.target.number && same(pr.repo, p.repo))
  ));
}

/** Whether a publication could wait on the idea at all: none is read for one without issue nor pull request. */
function mayWait(item: ProjectTodo): boolean {
  return !!item.project && (todoIssues(item).length > 0 || todoPulls(item).length > 0);
}

/** The proposals waiting on the idea, read once per project for the whole page. */
export function useTodoProposals(item: ProjectTodo): ForgeProposal[] {
  const projects = useMemo(() => (mayWait(item) && item.project ? [item.project] : []), [item]);
  const { pending } = useForgeProposals(projects);
  return useMemo(() => proposalsForTodo(pending, item), [pending, item]);
}

export function TodoProposalChip({ proposals }: { proposals: readonly ForgeProposal[] }): ReactElement | null {
  return <ProposalChip proposals={proposals} onOpen={(p) => openForgeProposal(p.project, p.id)} />;
}
