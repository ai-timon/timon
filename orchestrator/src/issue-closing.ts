/**
 * The issues a job's pull request closes or mentions (`docs/FORGE-FLOW-PLAN.md`
 * §2 (a) step 5, decision n° 4): computed by the daemon from OUR links, never
 * from the text of an issue nor from what an agent wrote.
 *
 * An idea of the job tied to a GitHub issue (`github`, `owner/repo#n`) gives:
 * - `Fixes owner/repo#n` when the idea is carried by this job alone, or when
 *   the person who launched the job ticked "resolves its issue entirely" in
 *   the planner (`series_landing`); GitHub then closes the issue at the merge;
 * - `Refs owner/repo#n` otherwise: one job among several does not close it.
 * An issue tied to several ideas of the job is fixed only if every one of them
 * is: closing an issue by mistake costs more than leaving it open.
 *
 * The agent's own closing keywords (`Fixes #12`, `closes https://…/issues/12`)
 * are turned into `Refs`: an agent that read an issue must not be able to
 * close another one through the pull request.
 */
import { dbApi, type IntegrationRow } from './db.js';
import { GITHUB_ISSUE_PROVIDER, parseGithubIssueRef } from './forge-links.js';

/** Most issue lines a pull request gets. */
export const ISSUE_LINE_LIMIT = 20;

export type IssueClosing = {
  repo: string;
  number: number;
  /** The ideas of the job tied to this issue. */
  todoIds: number[];
  keyword: 'Fixes' | 'Refs';
};

const issueKey = (repo: string, number: number): string => `${repo}#${number}`.toLowerCase();

/** The ideas a job carries, through its tasks, whoever owns them. */
export function jobTodoIds(row: Pick<IntegrationRow, 'id'>): number[] {
  const ids: number[] = [];
  for (const link of dbApi.listIntegrationTaskLinks([row.id])) {
    if (link.todo_id !== null && !ids.includes(link.todo_id)) ids.push(link.todo_id);
  }
  return ids;
}

/** The issues of the job's ideas, each with the keyword its pull request uses. */
export function jobIssueClosings(row: Pick<IntegrationRow, 'id' | 'series_id'>): IssueClosing[] {
  const todoIds = jobTodoIds(row);
  if (todoIds.length === 0) return [];
  const wholeJob = row.series_id ? dbApi.seriesResolvesIssues(row.series_id) : false;
  const jobsOf = new Map<number, Set<string>>();
  for (const r of dbApi.listTodoIntegrations(todoIds)) {
    const set = jobsOf.get(r.todo_id) ?? new Set<string>();
    set.add(r.id);
    jobsOf.set(r.todo_id, set);
  }
  const issues = new Map<string, IssueClosing>();
  for (const ref of dbApi.listTodoExternalRefs(todoIds)) {
    if (ref.provider !== GITHUB_ISSUE_PROVIDER) continue;
    const parsed = parseGithubIssueRef(ref.ref);
    if (!parsed) continue;
    const whole = wholeJob || (jobsOf.get(ref.todo_id)?.size ?? 0) <= 1;
    const key = issueKey(parsed.repo, parsed.number);
    const prior = issues.get(key);
    if (prior) {
      if (!prior.todoIds.includes(ref.todo_id)) prior.todoIds.push(ref.todo_id);
      if (!whole) prior.keyword = 'Refs';
    } else {
      issues.set(key, { repo: parsed.repo, number: parsed.number, todoIds: [ref.todo_id], keyword: whole ? 'Fixes' : 'Refs' });
    }
  }
  return [...issues.values()]
    .sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number)
    .slice(0, ISSUE_LINE_LIMIT);
}

/** `Fixes owner/repo#n` / `Refs owner/repo#n`, one per issue. */
export function issueLines(closings: readonly IssueClosing[]): string[] {
  return closings.map((c) => `${c.keyword} ${c.repo}#${c.number}`);
}

const ISSUE_TARGET = String.raw`(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#\d+|https?:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/issues\/\d+`;
const CLOSING_KEYWORD = new RegExp(String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(\s*:?\s+)(${ISSUE_TARGET})`, 'gi');

/** The text with every closing keyword before an issue turned into `Refs`. */
export function withoutClosingKeywords(text: string): string {
  return text.replace(CLOSING_KEYWORD, (_m, gap: string, target: string) => `Refs${gap}${target}`);
}

/** The description the forge receives: the agent's, defused, then our lines. */
export function pullRequestBody(body: string, lines: readonly string[]): string {
  const defused = withoutClosingKeywords(body).trimEnd();
  if (lines.length === 0) return defused;
  return defused ? `${defused}\n\n${lines.join('\n')}` : lines.join('\n');
}
