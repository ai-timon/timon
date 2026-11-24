/**
 * The landing of a job of a project that merges locally (`landing = 'local'`).
 *
 * The Kanban planner can give such a job a branch of its own (`branch`
 * integration mode, cut from the project's local target): its chains merge
 * into the branch, its ideas wait in `partial`, and its last task, a `merge`
 * task with `landing = 'local'`, merges the branch into the target on this
 * machine. The merge guard (`localLandingCloseRefusal`, `code-gate.ts`) proves
 * with git that the sha it closes with is in the target and carries the
 * branch; once that task is DONE, the branch lands through the same gate as a
 * pull request merged on the forge (`concludeMerged`): its integration row
 * goes 'merged', the job's ideas close, its doc task is created, its pilot is
 * told.
 *
 * Read on `task_done`, and again by a sweep for a notice lost to a restart.
 * Idempotent: a landed row is skipped, and the landing replays once.
 */
import { bus, type BusEvent } from './bus.js';
import { integrationOfTask } from './chain-landing.js';
import { dbApi, type TaskRow } from './db.js';
import { concludeMerged, type Notify } from './integration-poller.js';

function landsLocally(task: TaskRow | undefined): task is TaskRow & { merged_commit_sha: string } {
  return !!task && task.type === 'merge' && task.landing === 'local' && task.status === 'DONE'
    && typeof task.merged_commit_sha === 'string' && task.merged_commit_sha !== '';
}

/**
 * Lands the branch `taskId` merged into its target, when that task is a DONE
 * `--landing local` merge whose integration has not landed yet. True when it
 * concluded the landing.
 */
export async function landLocalLanding(taskId: string, notify?: Notify): Promise<boolean> {
  const task = dbApi.getTask(taskId);
  if (!landsLocally(task)) return false;
  const row = integrationOfTask(task);
  // A remote target lands through a pull request, never by this task.
  if (!row || row.remote !== '' || row.state === 'merged') return false;
  await concludeMerged(row.id, task.merged_commit_sha, notify);
  return true;
}

/** The local landings a missed `task_done` left behind. */
export async function landPendingLocalLandings(notify?: Notify): Promise<number> {
  let landed = 0;
  for (const row of dbApi.listLocalIntegrationsToLand()) {
    const done = dbApi.listTasksByBaseBranch(row.branch)
      .find((t) => landsLocally(t) && integrationOfTask(t)?.id === row.id);
    if (!done) continue;
    try {
      if (await landLocalLanding(done.id, notify)) landed++;
    } catch (err) {
      console.error(`[local-landing] ${row.branch}: ${(err as Error).message}`);
    }
  }
  return landed;
}

/** Lands a job as soon as its `--landing local` task is DONE; returns its stop. */
export function watchLocalLandings(): () => void {
  const onEvent = (ev: BusEvent): void => {
    if (ev.kind !== 'task_done') return;
    landLocalLanding(ev.taskId)
      .catch((err) => console.error(`[local-landing] task ${ev.taskId}: ${(err as Error).message}`));
  };
  bus.on('event', onEvent);
  landPendingLocalLandings()
    .catch((err) => console.error(`[local-landing] sweep failed: ${(err as Error).message}`));
  return () => { bus.off('event', onEvent); };
}
