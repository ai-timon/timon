/**
 * Work return of a mission to its pilot — a single producer, one return per turn.
 *
 * Two moments send this return, and they must send exactly the same thing:
 *  - END OF TURN (`turn_complete` → `wake.ts handleMissionTurnComplete`): the
 *    nominal path for an autonomous mission WITHOUT a task. It is instant.
 *  - DEATH OF THE PROCESS (`agent.ts notifyParentOnComplete`): the fallback for
 *    a mission that never finished a turn — crash, SIGTERM mid-turn, kill.
 *
 * Before this module the second path was the ONLY one. With a persistent backend
 * (claude) the process does not die at the end of the turn: it waits for the idle
 * reap, `TIMON_REAP_IDLE_MS` (600 000 ms). Measured 11/09/2026 on two
 * `mission_spawn` delegations: turn done at 12:34 → return at 12:48, turn done at
 * 13:08 → return at 13:20. The pilot got its return ten minutes late, in the
 * middle of another conversation.
 *
 * The guard is `missions.return_notified`, the exact counterpart of
 * `tasks.return_notified`: set when the return goes out, cleared at the start of
 * every turn. A mission whose turn ended properly has already been reported; the
 * death that follows teaches nobody anything and must send NOTHING.
 *
 * The `mission_complete` BUS event is NOT touched here: `verification-loop.ts`,
 * `doc-task.ts`, `dispatcher.ts` and `librarian.ts` listen to it to create
 * follow-up work. Only the trigger of the MESSAGE enqueue moves.
 */
import { randomUUID } from 'node:crypto';
import { dbApi } from './db.js';
import { decodeDaemonMessage } from './daemon-message.js';
import { truncateFinalReport } from './wake-digest.js';

export type MissionReturnStatus = 'completed' | 'failed' | 'terminated';

/**
 * Enqueue the return of `missionId` into its pilot's inbox, unless it has
 * already been delivered for this turn.
 *
 * Nothing is sent when:
 *  - there is no `parent_agent` lineage, or the pilot is the mission's own agent
 *    (self-notification is useless);
 *  - THIS mission's task already reported at closure (`tasks.return_notified`,
 *    posted by `wake.ts handleTaskDone` / `handleTaskBlocked`);
 *  - the mission already reported for this turn (`missions.return_notified`).
 *
 * Returns true when a message was actually enqueued.
 */
export function enqueueMissionReturn(
  missionId: string,
  status: MissionReturnStatus,
): boolean {
  const m = dbApi.getMission(missionId);
  if (!m || !m.parent_agent) return false;
  if (m.parent_agent === m.agent_name) return false;
  const task = m.task_id ? dbApi.getTask(m.task_id) : null;
  if (task && dbApi.isTaskReturnNotified(task.id)) return false;
  if (dbApi.isMissionReturnNotified(missionId)) return false;

  const finalText = task ? null : dbApi.getMissionFinalText(missionId);
  dbApi.enqueueMessage({
    id: randomUUID(),
    fromMission: missionId,
    fromAgent: m.agent_name,
    toAgent: m.parent_agent,
    toMission: m.parent_mission_id ?? null,
    kind: 'notification',
    payload: JSON.stringify({
      kind: 'mission_complete',
      mission_id: missionId,
      agent: m.agent_name,
      status,
      task_id: m.task_id ?? null,
      task_title: task?.title ?? null,
      task_status: task?.status ?? null,
      // type + pipeline: the wake digest uses them to make the return legible
      // AND to decide whether it justifies a wake-up on its own (a `doc` task,
      // no; a `changes_requested` review, always). cf. wake-digest.
      task_type: task?.type ?? null,
      pipeline: task?.pipeline ?? null,
      merged_commit_sha: task?.merged_commit_sha ?? null,
      done_comment: task?.done_comment ?? null,
      summary: task?.done_summary ?? null,
      blocked_reason: task?.blocked_reason ?? null,
      blocked_reason_code: decodeDaemonMessage(task?.blocked_reason_code),
      // group_id: identifies the batch of tasks this one belongs to, so the
      // orchestrator knows which batch this recap comes from on wake-up.
      group_id: task?.group_id ?? null,
      // Final report of a mission WITHOUT a task (`mission_spawn` delegation):
      // nothing else in this payload carries what the agent actually wrote, so
      // the parent used to get a bare "mission terminated" line. A task closes
      // with `done_comment`, which already says it — duplicating it here would
      // only inflate the wake digest. Its own ceiling, wider than a comment's:
      // this text IS the deliverable, no task holds it in full, and the pointer
      // has to name a command that actually opens it.
      final_text: finalText ? truncateFinalReport(finalText, missionId) : null,
    }),
  });
  // Idempotence on both levels: a re-emitted `mission_complete` (retry, boot
  // reconcile) and the death that follows a reported turn must both stay silent.
  if (task) dbApi.markTaskReturnNotified(task.id);
  dbApi.markMissionReturnNotified(missionId);
  return true;
}
