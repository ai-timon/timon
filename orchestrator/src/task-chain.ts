/**
 * Post-closing chaining: when a task goes DONE, everything it must
 * trigger leaves IMMEDIATELY.
 *
 * ## Why this module exists
 *
 * `verification-loop.ts` (review / merge / next iteration) and `doc-task.ts`
 * both listened to `mission_complete`. That event is NOT emitted when
 * the agent closes its task: it is when its PROCESS dies, so at the idle reap —
 * `TIMON_REAP_IDLE_MS` is 600,000 ms (settings.ts). Measured on 2026-08-21:
 * review `98e28f1a` closed at 09:47:28 with `changes_requested`, mission already
 * without a living process, code task iter:2 created at **09:58** — 11 minutes of
 * empty Kanban, during which the user believed the job was finished. That delay was
 * systematic on every code → review → merge → doc chain.
 *
 * The trigger is now `task_done`, published BY the write that sets
 * status=DONE (`dbApi.updateTaskStatus` / `setTaskStatusOnly`). Two properties
 * follow for free:
 *   - the status is in the database by construction when our handlers run, so
 *     the constraint "register after `startDispatcher()`" disappears;
 *   - `mission_complete` no longer chains anything. It keeps its only remaining
 *     use: the mission dead WITHOUT closing its task (crash, kill, agent that
 *     never closed) — the dispatcher's `watchMissionComplete` path, intact.
 *
 * ## Why a dedicated module, and not two listeners
 *
 * The order between the two steps is load-bearing: the verification-loop yields
 * on an `await` (git diff) before creating the review, whereas doc-task
 * decided synchronously. On the same event, doc-task therefore always
 * won the race and saw the `code` task as terminal: on
 * 2026-08-21 the code task of the `wake` job received ITS doc at 08:00, then a
 * second one through its merge at 08:07. Here the steps are AWAITED one after
 * the other — terminality and group completion are evaluated on a
 * Kanban where what follows already exists.
 *
 * ## Why `setImmediate`
 *
 * `task_done` is published INSIDE the DB write that caused it
 * (`bus.emit` is synchronous). A synchronous handler would therefore write to the database in
 * the middle of that write, and nothing guarantees no caller has
 * wrapped it in a `db.transaction`. One event tick is enough to leave
 * that context — that is ~0 ms, to compare with the 600,000 ms of the reap.
 *
 * That tick is NO LONGER a budget. It used to be: the wake-loop enqueued the work
 * return as soon as `task_done` but only evaluated the urgency at the flush, 1 s later
 * (`DEBOUNCE_MS`), through `hasFollowUpTask` — so the chain had to have created its
 * follow-up task by then. It was a bet on git's latency: `handleCodeDone`
 * starts with a `git diff --stat` in a subprocess (5 s timeout), which goes past the
 * second on a cold worktree. That bet is replaced by an explicit signal
 * (`chain-barrier.ts`): the barrier is opened SYNCHRONOUSLY on receiving
 * `task_done`, and the wake-loop's flush waits for it before deciding. A slow
 * `await` at the head of `runTaskChain` therefore no longer wakes anyone wrongly.
 */
import { bus, type BusEvent } from './bus.js';
import { dbApi, CHAIN_DONE, CHAIN_FAILED, CHAIN_NEVER, CHAIN_RUNNING, CHAIN_STALE_MS } from './db.js';
import { openChainBarrier } from './chain-barrier.js';
import { runVerificationChain } from './verification-loop.js';
import { maybeCreateDocTask } from './doc-task.js';
import { evaluateGroupCompleteForTask } from './wake.js';
import { notifyUser } from './notify.js';
import { daemonMessage } from './daemon-message.js';
import { applyTodoClosure } from './todo-closure.js';
import { isMirrorTask } from './task-mirror.js';

// The landing replay of an integration branch is the second half of a chain's
// closure; re-exported so `reconcile.ts` keeps its three imports.
export { reconcileLandedIntegrations } from './integration-landing.js';

/**
 * Chaining attempts before explicitly giving up.
 *
 * The replay was bounded by NOTHING: a JS exception set the task back to
 * `CHAIN_NEVER`, hence eligible for immediate replay, every 120 s (the
 * reconcile cadence) for the 6 h of the catch-up window — that is ~180 silent
 * attempts. Acceptable for a transient failure; absurd for a DETERMINISTIC
 * failure (worktree already cleaned by `stale-worktrees`, reviewer role not
 * resolvable, exception in doc-task) where the 180th attempt will fail exactly
 * like the first.
 *
 * 3, as everywhere else in the system (MAX_ITERATIONS, MAX_REPAIRS,
 * system requeue cap, MAX_INVALID_ASK_USER): two failures can be a
 * hazard, the third says the cause is structural and a human must
 * see it. Giving up is then EXPLICIT (CHAIN_FAILED + notification), never a
 * silence — that is precisely the failure mode this whole work
 * seeks to eliminate.
 */
export const MAX_CHAIN_ATTEMPTS = 3;

/**
 * Chains in progress in THIS process. A purely in-memory lock: it is the only
 * thing the persistent flag had to cover by being set before the first
 * await (two `task_done` of the same tick for the same task). The DB flag
 * is now only set "in progress" to let the reconcile spot the
 * chains that died in flight — two distinct roles, two mechanisms.
 */
const inFlight = new Set<string>();

/**
 * Runs the follow-up chain of a closed task: review/merge/iteration, then doc,
 * then end-of-batch recap. Exported for the tests (and for any caller
 * that would want to replay a missed chain).
 *
 * Idempotent, on two levels:
 *   - `inFlight` (memory) closes the intra-process double entry;
 *   - `chain_ran` (DB) bounds the run to ONCE per task run, and
 *     only reaches `CHAIN_DONE` once the chain is really finished. An
 *     interrupted chain — JS exception caught here, but also SIGTERM, OOM
 *     or restart, which this `catch` will NEVER see — therefore stays in
 *     `CHAIN_RUNNING`, a state `reconcileUnchainedTasks` replays past
 *     `CHAIN_STALE_MS`. That is the whole point of the three states.
 * The flag is reset to `CHAIN_NEVER` on (re-)dispatch (`assignTaskMission`):
 * a task sent back to the coder must re-chain at its new closing.
 */
export async function runTaskChain(taskId: string): Promise<void> {
  if (inFlight.has(taskId)) return;
  const task = dbApi.getTask(taskId);
  if (!task || task.status !== 'DONE') return;
  if (task.chain_ran === CHAIN_DONE) return;
  // The image of an external ticket has nothing to review, merge or document.
  // Settled as chained so the reconcile sweep does not come back to it.
  if (isMirrorTask(task)) {
    dbApi.setTaskChainState(taskId, CHAIN_DONE);
    return;
  }
  // Cap BEFORE retrying: beyond it, the cause is structural and one more
  // replay would only repeat the same failure every 120 s.
  if (task.chain_attempts >= MAX_CHAIN_ATTEMPTS) {
    dbApi.setTaskChainState(taskId, CHAIN_FAILED);
    console.error(
      `[task-chain] task ${taskId} (${task.type}): chain abandoned after ` +
      `${task.chain_attempts} attempts — escalated to the user`,
    );
    notifyUser(
      `Chain abandoned: ${task.title}`,
      `The follow-up chain of task ${taskId} (${task.type}, "${task.title}") failed ` +
      `${task.chain_attempts} times in a row: its review / merge / doc were not created ` +
      `and will no longer be created automatically.\n\n` +
      `A failure that repeats this often is structural (worktree cleaned up, project role that ` +
      `cannot be resolved, error in a step of the chain) — the \`[task-chain]\` logs of this task ` +
      `carry the cause.\n\n` +
      `To replay: dispatching the task again resets the counter.`,
      {
        taskId,
        message: daemonMessage('chain_abandoned', {
          title: task.title, taskId, type: task.type, attempts: task.chain_attempts,
        }),
      },
    );
    return;
  }
  inFlight.add(taskId);
  dbApi.setTaskChainState(taskId, CHAIN_RUNNING);
  try {
    await runVerificationChain(task);
    await maybeCreateDocTask(task);
    // Last task of the batch? The consolidated recap leaves now, not at the reap of
    // the last mission. Evaluated AFTER the chaining: the group is only "finished"
    // if the chain created nothing new.
    evaluateGroupCompleteForTask(taskId);
    // Its own catch: a failure here must not send the chain back to
    // CHAIN_NEVER and replay a review or a merge already created above.
    try {
      applyTodoClosure(task);
    } catch (err) {
      console.error(`[task-chain] TO DO closure failed for ${taskId}: ${(err as Error).message}`);
    }
    dbApi.setTaskChainState(taskId, CHAIN_DONE);
  } catch (err) {
    // The chain did not succeed: set back to `CHAIN_NEVER` so that a replay
    // leaves right away, without waiting for the staleness threshold reserved for
    // silent deaths.
    dbApi.setTaskChainState(taskId, CHAIN_NEVER);
    throw err;
  } finally {
    inFlight.delete(taskId);
  }
}

export function startTaskChain(): () => void {
  const onBusEvent = (ev: BusEvent) => {
    if (ev.kind !== 'task_done') return;
    const { taskId } = ev;
    // Barrier opened SYNCHRONOUSLY, before the tick: from here on the
    // wake-loop knows a chain is on its way for this task and waits for it
    // instead of betting on a one-second window (see chain-barrier.ts).
    const settle = openChainBarrier(taskId);
    setImmediate(() => {
      runTaskChain(taskId)
        .catch((err) => {
          console.error(`[task-chain] chaining of ${taskId} failed: ${(err as Error).message}`);
        })
        .finally(settle);
    });
  };
  bus.on('event', onBusEvent);
  console.log('[task-chain] post-close chaining armed (task_done)');
  return () => void bus.off('event', onBusEvent);
}

/**
 * Catch-up window, aligned on `verification-loop.reconcileMissingMerges`.
 * Bounded for two reasons: a really broken chain is detected within minutes,
 * and every task closed BEFORE `chain_ran` was introduced has the flag at 0
 * — without a bound, the first boot after deployment would try to re-chain the whole
 * history.
 */
const RECONCILE_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * Safety net: replays the lost chains.
 *
 * `task_done` is a single shot, in memory. It gets lost if the task goes DONE
 * while no listener is listening — typically an orchestrator restart
 * mid-flight, which is nothing hypothetical here (chronic OOM, V8 heap cap
 * at 4 GB). Before the switch to `task_done`, that case was caught by the
 * boot's zombie sweep, which republishes `mission_complete`; that is no longer true,
 * since the dispatcher exits early on a task already DONE and so emits no
 * `task_done`.
 *
 * Two states are picked up, and that is the heart of the net:
 *   - `CHAIN_NEVER`: the chain never left (the event got lost);
 *   - `CHAIN_RUNNING` for more than `CHAIN_STALE_MS`: the chain left and
 *     never finished. That case was INVISIBLE as long as the flag was a
 *     boolean set before the first await: a SIGTERM, an OOM or a restart
 *     between the setting and the end left the task marked "chained" without it
 *     having produced anything, and nothing caught it any more — ever. The net was
 *     blind to the very scenario that gave birth to it.
 *
 * `runTaskChain` is idempotent and its steps each have their own second-curtain
 * guard (`hasChildTask`, `hasDocTask`, `isGroupNotified`), so a replay on
 * an already done chain creates nothing.
 *
 * Scheduled by `reconcile.ts`, which carries all the system's invariants.
 */
export async function reconcileUnchainedTasks(): Promise<void> {
  const cutoff = Date.now() - RECONCILE_MAX_AGE_MS;
  // Filter in SQL, not in JS: see `listTasksNeedingChainStmt` (db.ts) — 1290
  // DONE tasks materialised every 120 s to keep none of them.
  for (const task of dbApi.listTasksNeedingChain(cutoff, Date.now() - CHAIN_STALE_MS)) {
    const cause = task.chain_ran === CHAIN_RUNNING
      ? `chain started at ${new Date(task.chain_started_at ?? 0).toISOString()} and never finished`
      : 'chain never started';
    console.warn(`[task-chain] reconcile: task ${task.id} (${task.type}) — ${cause} → rejeu`);
    try {
      await runTaskChain(task.id);
    } catch (err) {
      console.error(`[task-chain] reconcile: failed on ${task.id}: ${(err as Error).message}`);
    }
  }
}
