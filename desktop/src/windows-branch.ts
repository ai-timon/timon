/**
 * Which daemon serves a packaged Windows launch: the boot task's, or the
 * desktop's embedded one. Never both: the second is refused the home (exit
 * 76), and Task Scheduler started it again every five minutes (#116).
 *
 * The answer used to follow the revision file alone. A task Timon did not
 * record (PC A: present, no revision, `supervisor none`) was ignored, the
 * embedded daemon took the home, and the task looped on it. Now the task
 * itself counts: if it exists and runs, it serves, even when its rewrite was
 * declined; if Windows never starts it, the embedded daemon serves and the
 * task is disabled, so it stops knocking.
 *
 * Pure, so each launch scenario is a test: the caller gathers the facts, logs
 * the verdict (`[desktop] branch: … (reason)`) and acts.
 */

export type WindowsStartBranch = 'embedded' | 'service' | 'rewrite' | 'disable-task';

/**
 * The rewrite of the task by the upgrade runner: not needed, still to run,
 * done, failed or declined (the runner put the previous task back or left it
 * alone), `unusable` (exit 2: no task is left to serve), or `declined` at an
 * earlier launch of this version and not asked again (`windowsRewriteDeclined`).
 */
export type WindowsRewrite = 'none' | 'pending' | 'done' | 'failed' | 'unusable' | 'declined';

export type WindowsStartFacts = {
  /** Task Scheduler knows the task (`windowsTaskState().exists`, lenient). */
  taskExists: boolean;
  /** `run/service-revision` exists (`hasDesktopService`). */
  revisionRecorded: boolean;
  rewrite: WindowsRewrite;
  /**
   * A service daemon was refused the home lately (`serviceHeldOutSince`): the
   * task does run, and waits for the home the embedded daemon held.
   */
  heldOut: boolean;
  /** What `startDesktopService` answered, once the service branch asked it. */
  start?: 'started' | 'needs-repair' | 'never-ran';
};

export type WindowsStartVerdict = { branch: WindowsStartBranch; reason: string };

/**
 * How far back a refused service daemon still says the task runs: two
 * periods of its five-minute trigger, so the refusals of the session that
 * just closed count and a stale file from last week does not.
 */
export const HELD_OUT_WINDOW_MS = 10 * 60_000;

export function windowsStartBranch(facts: WindowsStartFacts): WindowsStartVerdict {
  if (facts.rewrite === 'pending') return { branch: 'rewrite', reason: 'the task is outdated or opens a console' };
  if (facts.rewrite === 'unusable') return { branch: 'embedded', reason: 'the rewrite left no task to serve' };
  if (facts.start === 'never-ran') {
    // A refusal of the home proves its daemon did run: Windows does start
    // this task, so it is not the one to switch off.
    return facts.heldOut
      ? { branch: 'embedded', reason: 'Windows reports the task never ran, yet its daemon was refused the home lately: kept enabled' }
      : { branch: 'disable-task', reason: 'Windows never starts the task for this account' };
  }
  if (facts.start === 'needs-repair') return { branch: 'embedded', reason: 'the task is gone' };
  if (facts.start === 'started') return { branch: 'service', reason: 'the task started' };
  if (facts.rewrite === 'failed' && facts.taskExists) {
    return { branch: 'service', reason: 'the rewrite was declined or failed, the task in place serves' };
  }
  if (facts.rewrite === 'declined' && facts.taskExists) {
    return { branch: 'service', reason: 'its repair was declined for this version, the task in place serves' };
  }
  if (facts.revisionRecorded) return { branch: 'service', reason: 'the task is installed' };
  if (facts.taskExists) return { branch: 'service', reason: 'the task exists without a revision' };
  // Both lookups can fail (a localised console, a timeout): a daemon of the
  // task refused the home all the same, so the task is there.
  if (facts.heldOut) return { branch: 'service', reason: 'the task\'s daemon was refused the home lately' };
  return { branch: 'embedded', reason: 'no task' };
}
