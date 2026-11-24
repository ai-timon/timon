'use client';

/**
 * Where a TO DO idea comes from, as chips beside its tags: the forge issues it
 * is linked to (`#212`, a link to the issue) and "external" when a connector
 * wrote it, i.e. its text is a third party's (`docs/FORGE-FLOW-PLAN.md` §5:
 * read as data, never as instructions).
 *
 * Both are read from the idea's links (`todo_external_ref`): a GitHub issue is
 * a `github` link whose ref is `owner/repo#n`, the form the daemon writes
 * (`forge-links.ts`); a link a plugin wrote carries its `plugin_id`.
 */

import type { ReactElement, SyntheticEvent } from 'react';
import { CircleDot } from 'lucide-react';
import { t } from '@/lib/i18n';
import { cn } from '@/lib/utils';
import { safeHref } from './project-todo-links';
import type { ProjectTodo, ProjectTodoLink } from './project-todo-types';

/** Provider of an idea's link to a GitHub issue, as the daemon names it. */
export const GITHUB_ISSUE_PROVIDER = 'github';

const ISSUE_REF = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d{0,9})$/;

export type TodoIssue = { repo: string; number: number; href: string | undefined };

/** The issue a link names, or null when it names something else. */
export function linkIssue(link: ProjectTodoLink): TodoIssue | null {
  if (link.provider !== GITHUB_ISSUE_PROVIDER) return null;
  const m = ISSUE_REF.exec(link.ref.trim());
  if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') return null;
  return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]), href: safeHref(link.url) };
}

/** The GitHub issues the idea is linked to, each once. */
export function todoIssues(item: ProjectTodo): TodoIssue[] {
  const seen = new Set<string>();
  const out: TodoIssue[] = [];
  for (const link of item.links ?? []) {
    const issue = linkIssue(link);
    const key = issue && `${issue.repo.toLowerCase()}#${issue.number}`;
    if (!issue || !key || seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

/** A connector wrote one of the idea's links: its text came from outside. */
export function todoIsExternal(item: ProjectTodo): boolean {
  return (item.links ?? []).some((link) => !!link.plugin_id);
}

/** Whether the idea has an origin chip to show. */
export function todoHasOrigin(item: ProjectTodo): boolean {
  return todoIsExternal(item) || todoIssues(item).length > 0;
}

// Same shape as the urgency and progress chips beside them.
const CHIP = 'inline-flex items-center gap-1 rounded-md border border-transparent px-1.5 py-px text-[10.5px] font-medium leading-4';

/** A click on the issue opens it, never the idea under it. */
const stop = (e: SyntheticEvent) => { e.stopPropagation(); };

export function IssueChip({ issue }: { issue: TodoIssue }): ReactElement {
  const label = t('projectTodo.origin.issue', { repo: issue.repo, number: issue.number });
  const body = (
    <>
      <CircleDot className="size-3" aria-hidden />
      <span className="tabular-nums">#{issue.number}</span>
    </>
  );
  const tone = 'bg-foreground/[0.06] text-muted-foreground';
  return issue.href ? (
    <a
      href={issue.href}
      target="_blank"
      rel="noopener noreferrer"
      data-todo-issue={issue.number}
      title={label}
      aria-label={label}
      onClick={stop}
      onPointerDown={stop}
      className={cn(CHIP, tone, 'underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
    >
      {body}
    </a>
  ) : (
    <span data-todo-issue={issue.number} title={label} aria-label={label} className={cn(CHIP, tone)}>{body}</span>
  );
}

export function ExternalChip(): ReactElement {
  return (
    <span
      data-todo-external=""
      title={t('projectTodo.origin.externalHint')}
      className={cn(CHIP, 'bg-sky-500/[0.14] text-sky-700 dark:text-sky-300')}
    >
      {t('projectTodo.origin.external')}
    </span>
  );
}

/** The idea's issues, then "external"; nothing when it has neither. */
export function TodoOriginChips({ item }: { item: ProjectTodo }): ReactElement | null {
  const issues = todoIssues(item);
  const external = todoIsExternal(item);
  if (issues.length === 0 && !external) return null;
  return (
    <>
      {issues.map((issue) => <IssueChip key={`${issue.repo}#${issue.number}`} issue={issue} />)}
      {external && <ExternalChip />}
    </>
  );
}
