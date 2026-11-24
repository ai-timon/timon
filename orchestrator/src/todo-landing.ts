/**
 * Where the work of a TO DO idea stands on its way to the remote's target: a
 * read-only badge derived from the `integrations` rows of its jobs.
 *
 * Two axes, kept apart on purpose: `progress` (`project-todo-tags.ts`) says
 * how far the WORK went, the landing says how far its BRANCH went. Mixing them
 * into one value would multiply the states (`to_test` with a closed pull
 * request?) and copy `integrations.state`, which the forge poller already
 * keeps up to date.
 *
 * Derivation: idea → its tasks (`todo_id`) on an integration branch
 * (`integration_mode` 'branch' or 'pr') → the `integrations` row of their
 * `base_branch`. No such row: no landing. Pure module (no database import):
 * `db.ts` builds its SQL from the same table, so the list filter and the
 * badge cannot disagree.
 */

/**
 * - `branch`: an embargoed job (`sec/…`, mode 'branch'): no pull request is
 *   ever opened, the branch lands by hand.
 * - `pending`: mode 'pr', the pull request is not created yet.
 * - `open`: the pull request is open.
 * - `merged`: it was merged into the target; the work landed.
 * - `closed`: it was closed without a merge; nothing landed.
 */
export const TODO_LANDING_STATES = ['branch', 'pending', 'open', 'merged', 'closed'] as const;
export type TodoLandingState = (typeof TODO_LANDING_STATES)[number];

/** One job (integration branch) of an idea. */
export type TodoLandingJob = {
  /** The job's id: `GET /api/kanban/landings/:id` reads it with its links. */
  jobId: string;
  state: TodoLandingState;
  branch: string;
  prNumber: number | null;
  prUrl: string | null;
};

/**
 * The badge of an idea: its worst job on top, every job in `jobs` (oldest
 * first) so that a reader can still tell them apart.
 */
export type TodoLanding = TodoLandingJob & { jobs: TodoLandingJob[] };

/**
 * When an idea has several jobs, the one furthest from landing wins: the badge
 * must never say "merged" while part of the work is still out. Highest first:
 * - `closed`: nothing landed and nobody is on it anymore; a human decides.
 * - `pending`: the pull request should exist and does not; the job is stuck
 *   before review.
 * - `branch`: not landed either, but no pull request is expected; it waits for
 *   a hand landing that the badge cannot follow.
 * - `open`: in review, the closest to landing of the unfinished states.
 * - `merged`: done.
 */
export const TODO_LANDING_RANK: Readonly<Record<TodoLandingState, number>> = {
  merged: 1,
  open: 2,
  branch: 3,
  pending: 4,
  closed: 5,
};

/** One `integrations` row as the derivation reads it. */
export type TodoIntegrationRow = {
  todo_id: number;
  id: string;
  mode: string;
  state: string;
  branch: string;
  pr_number: number | null;
  pr_url: string | null;
  created_at: number;
};

/** The state of one row. A state this version does not know reads as `pending`
 *  (or `branch` for an embargo): never as landed. */
export function landingStateOf(row: Pick<TodoIntegrationRow, 'mode' | 'state'>): TodoLandingState {
  if (row.state === 'merged') return 'merged';
  if (row.state === 'closed') return 'closed';
  if (row.state === 'open') return 'open';
  return row.mode === 'branch' ? 'branch' : 'pending';
}

/**
 * SQL expression of `TODO_LANDING_RANK` over an `integrations` alias, for the
 * list filter: the same order as `landingStateOf`, written once here.
 */
export function landingRankSql(alias: string): string {
  const r = TODO_LANDING_RANK;
  return `CASE
    WHEN ${alias}.state = 'merged' THEN ${r.merged}
    WHEN ${alias}.state = 'closed' THEN ${r.closed}
    WHEN ${alias}.state = 'open' THEN ${r.open}
    WHEN ${alias}.mode = 'branch' THEN ${r.branch}
    ELSE ${r.pending} END`;
}

function jobOf(row: TodoIntegrationRow): TodoLandingJob {
  const state = landingStateOf(row);
  // The pull request columns only mean something once one was opened.
  const withPr = state === 'open' || state === 'merged' || state === 'closed';
  return {
    jobId: row.id,
    state,
    branch: row.branch,
    prNumber: withPr ? row.pr_number : null,
    prUrl: withPr ? row.pr_url : null,
  };
}

/** The landing of each idea of `rows` (one entry per idea that has a job). */
export function aggregateTodoLandings(rows: readonly TodoIntegrationRow[]): Map<number, TodoLanding> {
  const byTodo = new Map<number, TodoIntegrationRow[]>();
  for (const r of rows) {
    const list = byTodo.get(r.todo_id) ?? [];
    // Several tasks of one job point at the same row: counted once.
    if (!list.some((x) => x.id === r.id)) list.push(r);
    byTodo.set(r.todo_id, list);
  }
  const out = new Map<number, TodoLanding>();
  for (const [todoId, list] of byTodo) {
    const jobs = [...list].sort((a, b) => a.created_at - b.created_at).map(jobOf);
    const worst = jobs.reduce((w, j) => (TODO_LANDING_RANK[j.state] > TODO_LANDING_RANK[w.state] ? j : w));
    out.set(todoId, { ...worst, jobs });
  }
  return out;
}
