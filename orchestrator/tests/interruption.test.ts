/**
 * Qualifying the cause of a mission's death (see src/interruption.ts).
 *
 * Runs on a THROWAWAY database: TIMON_HOME is forced onto a tmpdir BEFORE any
 * import of db.ts (which opens the database when the module loads), hence the
 * dynamic imports below. No interaction with the production database.
 *
 *   npm run test:interruption
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { removeHomeOnExit } from './helpers/test-home.js';

const HOME = mkdtempSync(join(tmpdir(), 'timon-interruption-'));
process.env.TIMON_HOME = HOME;
removeHomeOnExit(HOME);

const { dbApi, db } = await import('../src/db.js');
const { reconcileOrphanedTasks, watchMissionComplete } = await import('../src/dispatcher.js');
const { bus } = await import('../src/bus.js');

// mission_complete watcher wired once and for all (without starting the
// dispatch loop, which would spawn real missions).
watchMissionComplete();

/** Linked task + mission, in the "running" state. */
function seedRunningTask(): { taskId: string; missionId: string } {
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, 'task de test', 'agent-test');
  dbApi.createMission(missionId, 'agent-test', 'mission de test');
  dbApi.assignTaskMission(taskId, missionId);
  return { taskId, missionId };
}

/** Inserts an event and moves it back in time (insertEvent stamps Date.now()). */
function seedEvent(missionId: string, type: string, payload: unknown, agoMs = 0): void {
  const row = dbApi.insertEvent(missionId, type, payload);
  if (agoMs > 0) {
    db.prepare('UPDATE events SET timestamp = ? WHERE id = ?').run(row.timestamp - agoMs, row.id);
  }
}

/** rate_limit_event as Claude emits it (resetsAt in epoch SECONDS). */
function rateLimitRejected(resetsAtMs: number): unknown {
  return {
    type: 'rate_limit_event',
    rate_limit_info: {
      status: 'rejected',
      rateLimitType: 'five_hour',
      resetsAt: Math.floor(resetsAtMs / 1000),
      utilization: 0.9,
      isUsingOverage: false,
    },
  };
}

test('additive migration: the columns exist and older rows stay readable', async () => {
  const taskCols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
  const missionCols = (db.prepare('PRAGMA table_info(missions)').all() as { name: string }[]).map((c) => c.name);
  assert.ok(taskCols.includes('interrupted_reason'));
  assert.ok(missionCols.includes('interrupted_reason'));

  // A task created without ever going through the new code (= any task
  // older than the migration) must read NULL, not crash.
  const id = randomUUID();
  dbApi.createTask(id, 'task legacy', 'agent-test');
  assert.equal(dbApi.getTask(id)?.interrupted_reason, null);
});

test('mission killed externally → requeued, then a qualified BLOCKED in the end', async () => {
  const { taskId, missionId } = seedRunningTask();
  // What the exit handler does when we killed the process ourselves.
  const reason = dbApi.finishMission(missionId, 'terminated', 0, 'killed');
  assert.equal(reason, 'killed');

  await reconcileOrphanedTasks();

  // `killed` is a REPLAYABLE cause: the task restarts on its own rather than
  // waiting for a human to see it (night of 2026-08-15). It is detached from
  // its dead mission, its reasons cleared, and delayed by the backoff.
  const requeued = dbApi.getTask(taskId);
  assert.equal(requeued?.status, 'PENDING');
  assert.equal(requeued?.mission_id, null);
  assert.equal(requeued?.interrupted_reason, null);
  assert.ok((requeued?.scheduled_at ?? 0) > Date.now(), 'the backoff must delay the retry');

  // Cap reached: this is no longer a fluke, the task settles in BLOCKED with
  // a reason a human OR an orchestrator can read, without an SQL query.
  db.prepare('UPDATE tasks SET requeue_count = 99 WHERE id = ?').run(taskId);
  const retry = randomUUID();
  dbApi.createMission(retry, 'agent-test', 'retry');
  dbApi.assignTaskMission(taskId, retry);
  dbApi.finishMission(retry, 'terminated', 0, 'killed');
  await reconcileOrphanedTasks();

  const t = dbApi.getTask(taskId);
  assert.equal(t?.status, 'BLOCKED');
  assert.equal(t?.interrupted_reason, 'killed');
  assert.match(t?.blocked_reason ?? '', /Mission interrupted \(killed\)/);
});

test('business block set by the agent → interrupted_reason stays NULL and the reason is kept', async () => {
  const { taskId, missionId } = seedRunningTask();
  // `timon task block --reason "..."`: the agent closes the task itself.
  dbApi.updateTaskStatus(taskId, 'BLOCKED', { blockedReason: 'dépendance externe indisponible' }); // french-ok: free-text sample data
  // Then its process dies (SIGTERM after closing): the mission ends badly.
  dbApi.finishMission(missionId, 'failed', 1, 'crash');
  await reconcileOrphanedTasks();

  const t = dbApi.getTask(taskId);
  assert.equal(t?.status, 'BLOCKED');
  assert.equal(t?.interrupted_reason, null, 'a business block must never be labelled a system death');
  assert.equal(t?.blocked_reason, 'dépendance externe indisponible'); // french-ok: free-text sample data
});

test('mission ended normally → neither field touched', async () => {
  const { taskId, missionId } = seedRunningTask();
  dbApi.updateTaskStatus(taskId, 'DONE', { doneComment: 'fait' });
  const reason = dbApi.finishMission(missionId, 'completed', 0);
  assert.equal(reason, null);
  await reconcileOrphanedTasks();

  const t = dbApi.getTask(taskId);
  assert.equal(t?.status, 'DONE');
  assert.equal(t?.interrupted_reason, null);
  assert.equal(t?.blocked_reason, null);
  assert.equal(t?.done_comment, 'fait');
});

test('usage limit: the cause seen at exit survives a late finalisation', async () => {
  const { taskId, missionId } = seedRunningTask();
  // Exit on a usage limit: the mission stays `running`, the cause is recorded.
  dbApi.setMissionInterrupted(missionId, 'rate_limit');
  // Much later, the reaper finalises the orphan assuming a crash.
  const reason = dbApi.finishMission(missionId, 'terminated', 0, 'crash');
  assert.equal(reason, 'rate_limit', 'the cause already observed must win over the reaper default');

  await reconcileOrphanedTasks();
  const t = dbApi.getTask(taskId);
  assert.equal(t?.interrupted_reason, 'rate_limit');
  assert.match(t?.blocked_reason ?? '', /account usage limit reached/);
});

test('clean exit on a usage limit: derived from the events, task BLOCKED and not DONE', async () => {
  const { taskId, missionId } = seedRunningTask();
  // Signature measured on 9 of the 11 quota deaths of 2026-07-29/30: the CLI exits
  // with code 0, hence `completed`, indistinguishable from a real success if one
  // only looks at the `missions` table. The last event tells the truth.
  const resetsAt = Date.now() + 3 * 3600_000;
  seedEvent(missionId, 'rate_limit_event', rateLimitRejected(resetsAt));

  const reason = dbApi.finishMission(missionId, 'completed', 0);
  assert.equal(reason, 'rate_limit', 'the events signal must win over an exit 0');
  assert.equal(dbApi.getMission(missionId)?.interrupted_reason, 'rate_limit');

  bus.publish({ kind: 'mission_complete', missionId, status: 'completed', exitCode: 0, reason });

  const t = dbApi.getTask(taskId);
  assert.equal(t?.status, 'BLOCKED', 'a mission killed by the quota must never set the task DONE');
  assert.equal(t?.interrupted_reason, 'rate_limit');
  // The quota reopening time is spelled out: that is what makes the reason
  // actionable (retry at H+X) without an SQL query.
  // `en-GB` like `describeInterruption`: 24-hour clock on both sides.
  const hhmm = new Date(resetsAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  assert.match(t?.blocked_reason ?? '', /five_hour/);
  assert.match(t?.blocked_reason ?? '', new RegExp(`quota reopens at ${hhmm}`));
});

test('old rejected followed by activity → NOT rate_limit (anti false positive)', async () => {
  const { taskId, missionId } = seedRunningTask();
  // Measured case: 3 missions saw a `rejected` and then lived for hours
  // (delta to the last event: 15,002 s / 28,184 s / 79,812 s). A refusal the
  // agent recovered from is not the cause of its death.
  seedEvent(missionId, 'rate_limit_event', rateLimitRejected(Date.now()), 3600_000);
  seedEvent(missionId, 'assistant', { text: "l'agent a continué à travailler" }); // french-ok: free-text sample data

  assert.equal(dbApi.detectMissionDeathSignal(missionId), null);
  const reason = dbApi.finishMission(missionId, 'terminated', 0, 'killed');
  assert.equal(reason, 'killed', "without a contemporary signal, the caller's assumption stays");

  bus.publish({ kind: 'mission_complete', missionId, status: 'terminated', exitCode: 0, reason });
  // `killed` being replayable, the task goes back in the queue, which is precisely
  // the proof that the cause kept is not `rate_limit`, which would have left it
  // BLOCKED while waiting for the series to switch over.
  const t = dbApi.getTask(taskId);
  assert.equal(t?.status, 'PENDING');
  assert.equal(t?.interrupted_reason, null);
});

test('permission refusal: last event result{is_error, stop_reason:tool_use} → permission_denied', async () => {
  const { taskId, missionId } = seedRunningTask();
  // Case of 30/07 13:11: the classifier refuses a tool use, the CLI
  // stops dead, the work is done but the verdict is never written.
  seedEvent(missionId, 'result', { is_error: true, stop_reason: 'tool_use', subtype: 'error' });

  const reason = dbApi.finishMission(missionId, 'completed', 0);
  assert.equal(reason, 'permission_denied');

  bus.publish({ kind: 'mission_complete', missionId, status: 'completed', exitCode: 0, reason });
  const t = dbApi.getTask(taskId);
  assert.equal(t?.status, 'BLOCKED');
  assert.equal(t?.interrupted_reason, 'permission_denied');
  assert.match(t?.blocked_reason ?? '', /permission denied on a tool use/);
});

test('task closed by the agent before the quota death → stays DONE, nothing overwritten', async () => {
  const { taskId, missionId } = seedRunningTask();
  // The agent wrote `timon task done`, THEN the usage limit killed it. The status
  // set by the agent prevails: the mission is qualified, not the task.
  dbApi.updateTaskStatus(taskId, 'DONE', { doneComment: 'travail terminé' }); // french-ok: free-text sample data
  seedEvent(missionId, 'rate_limit_event', rateLimitRejected(Date.now() + 3600_000));
  const reason = dbApi.finishMission(missionId, 'completed', 0);
  assert.equal(reason, 'rate_limit');

  bus.publish({ kind: 'mission_complete', missionId, status: 'completed', exitCode: 0, reason });
  const t = dbApi.getTask(taskId);
  assert.equal(t?.status, 'DONE');
  assert.equal(t?.interrupted_reason, null);
  assert.equal(t?.done_comment, 'travail terminé'); // french-ok: free-text sample data
  assert.equal(t?.blocked_reason, null);
});

test('re-dispatch: the cause of the previous attempt is cleared', async () => {
  const { taskId, missionId } = seedRunningTask();
  dbApi.finishMission(missionId, 'failed', 1, 'crash');
  // Requeue cap already reached: the cause is SET on the task, which is
  // the precondition of this test; without it, `crash` being replayable,
  // the task would go back to PENDING without ever carrying a cause.
  db.prepare('UPDATE tasks SET requeue_count = 99 WHERE id = ?').run(taskId);
  await reconcileOrphanedTasks();
  assert.equal(dbApi.getTask(taskId)?.interrupted_reason, 'crash');

  // The task is requeued then respawned on a new mission.
  const retry = randomUUID();
  dbApi.createMission(retry, 'agent-test', 'retry');
  dbApi.assignTaskMission(taskId, retry);
  assert.equal(dbApi.getTask(taskId)?.interrupted_reason, null);
});
