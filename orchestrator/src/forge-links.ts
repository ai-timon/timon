/**
 * The way back between a Kanban job, its TO DO ideas, their forge issues and
 * its pull request (`docs/FORGE-FLOW-PLAN.md` §2 (d)): from a job or a pull
 * request, the ideas it carries, the mission that pilots it and the issues it
 * touches. The other direction, idea → jobs, is the idea's `landing`
 * (`todo-landing.ts`), whose jobs carry the id read here.
 *
 * Computed on every read, never stored: the ideas come from the same join as
 * the badge (`listIntegrationTaskLinks` mirrors `listTodoIntegrations`), the
 * issues from the ideas' own links and from what the forge last said the pull
 * request closes. Everything goes through the caller's scope: an idea, a task
 * or a mission the caller cannot see is left out, never named.
 *
 * Two kinds of issue, kept apart by `closes`: an issue linked to one of our
 * ideas is OUR statement; an issue the pull request's description closes is
 * its author's, which a contributor writes. A reader that closes or comments
 * on an issue trusts only the first.
 */
import { dbApi, type DbViewer, type ProjectTodoRow, type TodoExternalRefRow } from './db.js';
import type { IssueReference } from './host/forge.js';
import { integrationVisibleTo, type IntegrationView } from './integration-preview.js';

/** Provider of an idea's link to a GitHub issue, ref `owner/repo#n`. */
export const GITHUB_ISSUE_PROVIDER = 'github';

/** Characters of an idea's text in a link: enough for a line, never a page. */
export const LINKED_TODO_TEXT_LIMIT = 300;

const ISSUE_REF = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)#([1-9]\d{0,9})$/;
const PR_URL = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/\d+$/;

/** The ref an idea's link to an issue carries. */
export function githubIssueRef(repo: string, number: number): string {
  return `${repo}#${number}`;
}

/** The issue a link's ref names, or null when it names something else. */
export function parseGithubIssueRef(ref: string): { repo: string; number: number } | null {
  const m = ISSUE_REF.exec(ref.trim());
  if (!m || m[1] === '.' || m[1] === '..' || m[2] === '.' || m[2] === '..') return null;
  return { repo: `${m[1]}/${m[2]}`, number: Number(m[3]) };
}

/** `owner/repo` of a GitHub pull request url, or null. */
export function repoOfPullRequestUrl(url: string | null): string | null {
  return url ? PR_URL.exec(url)?.[1] ?? null : null;
}

export type LinkedTodo = {
  id: number;
  text: string;
  /** `open`, `done` or `promoted`. */
  status: string;
  progress: string | null;
  project: string | null;
};

export type LinkedIssue = {
  repo: string;
  number: number;
  url: string | null;
  /** The idea tied to the issue, among those the caller sees. */
  todo_id: number | null;
  /** The pull request's description closes it: the author's claim, not ours. */
  closes: boolean;
};

export type JobLinks = {
  todos: LinkedTodo[];
  issues: LinkedIssue[];
  series_id: string | null;
  /** The mission that pilots the series now, when the caller may open it. */
  pilot_mission_id: string | null;
};

/** What one job or pull request brings to the links. */
type LinkSeed = {
  todoIds: number[];
  seriesId: string | null;
  closing: readonly IssueReference[];
  /** The repository an issue reference without one belongs to. */
  repo: string | null;
};

function issueKey(repo: string, number: number): string {
  return githubIssueRef(repo, number).toLowerCase();
}

function linkedTodo(row: ProjectTodoRow): LinkedTodo {
  const text = row.text.length > LINKED_TODO_TEXT_LIMIT ? `${row.text.slice(0, LINKED_TODO_TEXT_LIMIT - 1)}…` : row.text;
  return { id: row.id, text, status: row.status, progress: row.progress, project: row.project };
}

function pilotOf(seriesId: string, viewer: DbViewer, cache: Map<string, string | null>): string | null {
  const known = cache.get(seriesId);
  if (known !== undefined) return known;
  // The series id is the mission that planned it, until a remap names another.
  const pilot = dbApi.seriesPilotMission(seriesId) ?? seriesId;
  const visible = dbApi.getMission(pilot, viewer) ? pilot : null;
  cache.set(seriesId, visible);
  return visible;
}

/** The links of every seed, in a fixed number of queries plus one per series. */
function resolveLinks<K>(seeds: Map<K, LinkSeed>, viewer: DbViewer | null): Map<K, JobLinks> {
  // No viewer is the unscoped service: a route never reads links without one.
  if (!viewer) {
    return new Map([...seeds.keys()].map((k) => [k, { todos: [], issues: [], series_id: null, pilot_mission_id: null }]));
  }
  // Ideas reached through a closing issue they imported.
  const closingRefs = new Set<string>();
  for (const seed of seeds.values()) {
    for (const c of seed.closing) {
      const repo = c.repo ?? seed.repo;
      if (repo) closingRefs.add(issueKey(repo, c.number));
    }
  }
  const todoOfIssue = new Map<string, number>();
  for (const r of dbApi.findTodoExternalRefs(GITHUB_ISSUE_PROVIDER, [...closingRefs], viewer)) {
    todoOfIssue.set(r.ref.toLowerCase(), r.todo_id);
  }

  const wanted = new Set<number>();
  for (const seed of seeds.values()) for (const id of seed.todoIds) wanted.add(id);
  for (const id of todoOfIssue.values()) wanted.add(id);
  const ids = [...wanted];
  const todos = new Map(
    (ids.length ? dbApi.listProjectTodo({ ids, viewer, limit: ids.length }) : []).map((t) => [t.id, t]),
  );
  const refsOfTodo = new Map<number, TodoExternalRefRow[]>();
  for (const r of dbApi.listTodoExternalRefs([...todos.keys()])) {
    if (r.provider !== GITHUB_ISSUE_PROVIDER) continue;
    const list = refsOfTodo.get(r.todo_id);
    if (list) list.push(r); else refsOfTodo.set(r.todo_id, [r]);
  }

  const pilots = new Map<string, string | null>();
  const out = new Map<K, JobLinks>();
  for (const [key, seed] of seeds) {
    const issues = new Map<string, LinkedIssue>();
    const todoIds: number[] = [];
    const addTodo = (id: number) => { if (todos.has(id) && !todoIds.includes(id)) todoIds.push(id); };
    for (const id of seed.todoIds) addTodo(id);

    for (const c of seed.closing) {
      const repo = c.repo ?? seed.repo;
      if (!repo) continue;
      const k = issueKey(repo, c.number);
      const todoId = todoOfIssue.get(k) ?? null;
      const seen = todoId !== null && todos.has(todoId) ? todoId : null;
      if (seen !== null) addTodo(seen);
      issues.set(k, { repo, number: c.number, url: c.url, todo_id: seen, closes: true });
    }
    for (const id of todoIds) {
      for (const r of refsOfTodo.get(id) ?? []) {
        const parsed = parseGithubIssueRef(r.ref);
        if (!parsed) continue;
        const k = issueKey(parsed.repo, parsed.number);
        const prior = issues.get(k);
        issues.set(k, {
          repo: prior?.repo ?? parsed.repo,
          number: parsed.number,
          url: prior?.url ?? r.url,
          todo_id: prior?.todo_id ?? id,
          closes: prior?.closes ?? false,
        });
      }
    }

    const ordered = todoIds.map((id) => linkedTodo(todos.get(id)!));
    // Our own links first: they are the ones a closure may trust.
    const list = [...issues.values()].sort((a, b) => Number(a.closes) - Number(b.closes));
    out.set(key, {
      todos: ordered,
      issues: list,
      series_id: seed.seriesId,
      pilot_mission_id: seed.seriesId ? pilotOf(seed.seriesId, viewer, pilots) : null,
    });
  }
  return out;
}

/** Ideas and series of the integrations `ids`, through the tasks `viewer` sees. */
function taskLinksOf(ids: readonly string[], viewer: DbViewer | null): Map<string, { todoIds: number[]; seriesIds: string[] }> {
  const out = new Map<string, { todoIds: number[]; seriesIds: string[] }>();
  for (const id of ids) out.set(id, { todoIds: [], seriesIds: [] });
  if (!viewer) return out;
  for (const r of dbApi.listIntegrationTaskLinks(ids, viewer)) {
    const entry = out.get(r.integration_id)!;
    if (r.todo_id !== null && !entry.todoIds.includes(r.todo_id)) entry.todoIds.push(r.todo_id);
    if (r.series_id && !entry.seriesIds.includes(r.series_id)) entry.seriesIds.push(r.series_id);
  }
  return out;
}

export type LinkedIntegrationView = IntegrationView & { links: JobLinks };

/**
 * The views with their links. The views are already the caller's (the routes
 * filter them with `integrationVisibleTo`); the ideas and the pilot still go
 * through `viewer`, since seeing a job does not mean seeing every task on it.
 */
export function withJobLinks(views: readonly IntegrationView[], viewer: DbViewer | null): LinkedIntegrationView[] {
  const tasks = taskLinksOf(views.map((v) => v.id), viewer);
  const seeds = new Map<string, LinkSeed>();
  for (const v of views) {
    const t = tasks.get(v.id)!;
    seeds.set(v.id, {
      todoIds: t.todoIds,
      seriesId: v.series_id ?? t.seriesIds[0] ?? null,
      closing: v.checks?.closing_issues ?? [],
      repo: repoOfPullRequestUrl(v.pr_url),
    });
  }
  const links = resolveLinks(seeds, viewer);
  return views.map((v) => ({ ...v, links: links.get(v.id)! }));
}

export type PullRequestLinks = JobLinks & {
  /** Our job whose pull request this is, when the caller sees it. */
  job_id: string | null;
};

/**
 * The links of a project's open pull requests: the job behind one of ours, and
 * for any of them the ideas that imported an issue it closes.
 */
export function pullRequestLinks(
  project: string,
  repo: string,
  pulls: ReadonlyArray<{ number: number; closingIssues: readonly IssueReference[] }>,
  viewer: DbViewer | null,
): Map<number, PullRequestLinks> {
  const jobOf = new Map<number, { id: string; seriesId: string | null }>();
  for (const p of pulls) {
    const row = dbApi.listIntegrationsByPullRequest(project, p.number).find((r) => {
      const prRepo = repoOfPullRequestUrl(r.pr_url);
      // Another repository's pull request may carry the same number.
      return (prRepo === null || prRepo.toLowerCase() === repo.toLowerCase()) && integrationVisibleTo(viewer, r);
    });
    if (row) jobOf.set(p.number, { id: row.id, seriesId: row.series_id });
  }
  const tasks = taskLinksOf([...jobOf.values()].map((j) => j.id), viewer);
  const seeds = new Map<number, LinkSeed>();
  for (const p of pulls) {
    const job = jobOf.get(p.number);
    const t = job ? tasks.get(job.id)! : null;
    seeds.set(p.number, {
      todoIds: t?.todoIds ?? [],
      seriesId: job ? job.seriesId ?? t?.seriesIds[0] ?? null : null,
      closing: p.closingIssues,
      repo,
    });
  }
  const links = resolveLinks(seeds, viewer);
  const out = new Map<number, PullRequestLinks>();
  for (const p of pulls) out.set(p.number, { ...links.get(p.number)!, job_id: jobOf.get(p.number)?.id ?? null });
  return out;
}
