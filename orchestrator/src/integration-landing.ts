/**
 * The landing of an integration branch (`docs/KANBAN-PR-PIPELINE.md` §2.6, §2.7).
 *
 * While a job's branch (`feat/<topic>`) is only integrated, its closures hold
 * back (`chain-landing.ts`): TO DO ideas wait in `partial`, no doc task is
 * created, the GC keeps the worktrees. When the branch is merged into the
 * target, whoever learnt it (the forge poller, a `mark-merged` by hand) calls
 * `landIntegration`, which marks the row 'merged' and replays on every DONE
 * task of the job the two closures that waited, by the very functions the task
 * closure runs: `applyTodoClosure`, then `maybeCreateDocTask`. The GC needs no
 * call: it reads the state on its next pass.
 *
 * Exactly once per integration (`landed_at`, claimed before the replay and
 * released if it fails), and both closures are idempotent on their own. The
 * tasks' return markers (`tasks.return_notified`) are not touched: each task
 * already reported once, at its own closure; the doc tasks created here report
 * like any other task.
 */
import { dbApi, type IntegrationRow, type TaskRow } from './db.js';
import { maybeCreateDocTask } from './doc-task.js';
import { applyTodoClosure, type TodoClosure } from './todo-closure.js';
import { integrationOfTask } from './chain-landing.js';
import { integrationTargetLabel, usesIntegrationBranch } from './git-integration.js';

export type LandingOutcome = {
  /** False when the landing had already been replayed (or is being). */
  replayed: boolean;
  /** DONE tasks of the job the closures were replayed on. */
  tasks: number;
  /** What the TO DO notebook moved to. */
  closures: TodoClosure[];
  /** Doc tasks created. */
  docs: number;
};

/** The DONE tasks merged into `row`'s branch: its job. */
function tasksOfIntegration(row: IntegrationRow): TaskRow[] {
  return dbApi.listTasksByBaseBranch(row.branch).filter((t) =>
    t.status === 'DONE'
    && usesIntegrationBranch(t.integration_mode)
    && integrationOfTask(t)?.id === row.id);
}

/** Replays the closures of a merged integration. Exported for the reconciliation. */
export async function replayLanding(row: IntegrationRow): Promise<LandingOutcome> {
  const none: LandingOutcome = { replayed: false, tasks: 0, closures: [], docs: 0 };
  if (!dbApi.claimIntegrationLanding(row.id)) return none;
  try {
    const tasks = tasksOfIntegration(row);
    const closures: TodoClosure[] = [];
    // Every closure first, then the docs: a doc task joining the job mid-way
    // must not be taken for one of its own tasks.
    for (const task of tasks) closures.push(...applyTodoClosure(task));
    const before = new Set(dbApi.listTasksByBaseBranch(row.branch).filter((t) => t.type === 'doc').map((t) => t.id));
    for (const task of tasks) await maybeCreateDocTask(task);
    const docs = dbApi.listTasksByBaseBranch(row.branch).filter((t) => t.type === 'doc' && !before.has(t.id)).length;
    console.log(
      `[landing] ${row.branch} landed in ${integrationTargetLabel(row)}: ${tasks.length} task(s), ` +
      `${closures.length} TO DO move(s), ${docs} doc task(s)`,
    );
    return { replayed: true, tasks: tasks.length, closures, docs };
  } catch (err) {
    // Handed back: the reconciliation replays it, and both closures skip what
    // they already did.
    dbApi.releaseIntegrationLanding(row.id);
    throw err;
  }
}

/**
 * The integration branch `id` was merged into its target (`mergeSha`: the
 * merge commit there, when known). Marks it 'merged' and replays its landing.
 * Idempotent: a second call finds the landing already replayed.
 */
export async function landIntegration(id: string, mergeSha: string | null = null): Promise<LandingOutcome> {
  const row = dbApi.getIntegrationById(id);
  if (!row) throw new Error(`integration ${id} does not exist`);
  dbApi.markIntegrationMerged(id, mergeSha);
  return replayLanding(dbApi.getIntegrationById(id) ?? row);
}

/**
 * Reconciliation: an integration 'merged' whose landing was never replayed
 * (daemon stopped between the two writes, a replay that failed) is replayed.
 * Silent when there is nothing to do.
 */
export async function reconcileLandedIntegrations(): Promise<void> {
  for (const row of dbApi.listUnlandedIntegrations()) {
    try {
      await replayLanding(row);
    } catch (err) {
      console.error(`[landing] replay of ${row.branch} failed: ${(err as Error).message}`);
    }
  }
}
