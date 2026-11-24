/**
 * "Integrated" is not "landed" (`docs/KANBAN-PR-PIPELINE.md` §2.1, §2.7).
 *
 * A local chain lands the moment its merge reaches its base: the base IS the
 * branch the work was meant for. A chain whose base is an integration branch
 * (`integration_mode` 'branch' or 'pr') is only integrated at that moment: its
 * work sits in `feat/<topic>`, and lands when that branch is merged into the
 * remote's target (the pull request merged, or an embargo landed by hand).
 * Closing the TO DO idea, creating the doc task, releasing the worktree and
 * freeing a dependent of another base all wait for the landing.
 *
 * The landing state is the `integrations` row of the branch, never a column of
 * the task: every chain of the job lands together, by one write.
 *
 * Read-only, and fail-closed: a chain on an integration branch whose row cannot
 * be found has not landed. Nothing closes on a guess; the landing replay
 * (`integration-landing.ts`) catches up once the row says 'merged'.
 */
import { loadConfig } from './agent-config.js';
import { dbApi, type IntegrationRow, type TaskRow } from './db.js';
import { usesIntegrationBranch } from './git-integration.js';

/**
 * - `local`: the chain lands in its base; integration is landing.
 * - `integrated`: in its integration branch, not in the target yet.
 * - `landed`: the integration branch was merged into the target.
 * - `closed`: its pull request was closed without a merge; nothing landed.
 */
export type ChainLanding = 'local' | 'integrated' | 'landed' | 'closed';

export type LandingTask = Pick<TaskRow, 'agent_name' | 'base_branch' | 'project'> &
  Partial<Pick<TaskRow, 'integration_mode'>>;

function agentRepo(agentName: string): string | null {
  try {
    return loadConfig(agentName).cwd ?? null;
  } catch {
    return null;
  }
}

/**
 * The integration row the task's chain merges into. Keyed by the agent's
 * repository like the dispatcher records it; when that cannot be read (agent
 * renamed or gone), the branch alone decides if it is unambiguous within the
 * task's project.
 */
export function integrationOfTask(task: LandingTask, repo?: string | null): IntegrationRow | undefined {
  if (!usesIntegrationBranch(task.integration_mode) || !task.base_branch) return undefined;
  const where = repo ?? agentRepo(task.agent_name);
  if (where) {
    const exact = dbApi.getIntegration(where, task.base_branch);
    if (exact) return exact;
  }
  const rows = dbApi.listIntegrationsByBranch(task.base_branch)
    .filter((r) => !task.project || !r.project || r.project === task.project);
  return rows.length === 1 ? rows[0] : undefined;
}

export function landingOfIntegration(row: IntegrationRow | undefined): ChainLanding {
  if (row?.state === 'merged') return 'landed';
  if (row?.state === 'closed') return 'closed';
  return 'integrated';
}

/** Where the chain of `task` stands. */
export function chainLanding(task: LandingTask, repo?: string | null): ChainLanding {
  if (!usesIntegrationBranch(task.integration_mode)) return 'local';
  return landingOfIntegration(integrationOfTask(task, repo));
}

/** True when the chain's work is where it was meant to end up. */
export function hasLanded(task: LandingTask, repo?: string | null): boolean {
  const landing = chainLanding(task, repo);
  return landing === 'local' || landing === 'landed';
}

/** The integration branch the first of `tasks` still waits in, or null when
 *  all of them landed. */
export function pendingLanding(...tasks: LandingTask[]): string | null {
  for (const t of tasks) {
    if (!hasLanded(t)) return t.base_branch ?? 'the integration branch';
  }
  return null;
}
