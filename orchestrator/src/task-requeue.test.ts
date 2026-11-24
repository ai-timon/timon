/**
 * A SYSTEM block survives neither the kill/reap nor the requalification.
 *
 * What these tests protect is what cost the night of 2026-08-15: doc
 * tasks killed by the idle mission reap, left BLOCKED, and relaunched by
 * hand the next day, while no human decision was needed. And
 * task `bceeb4cd`, requalified as `chore`, left dead on the board with the
 * reason of a guard that no longer applied to its new type.
 *
 * The database is opened in a temporary TIMON_HOME: the imports are therefore
 * dynamic, AFTER the environment is set.
 *
 * `node --test --import tsx src/task-requeue.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// french-ok-file: French sample reasons the test feeds in

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-requeue-test-'));

const { dbApi, MAX_SYSTEM_REQUEUES } = await import('./db.js');
const { bus } = await import('./bus.js');

/** An IN_PROGRESS task with a live mission: the exact state of a task whose
 *  process gets killed mid-flight. */
function runningTask(type: 'code' | 'doc' | 'chore' = 'doc'): string {
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, `task ${taskId.slice(0, 8)}`, 'tester', { type });
  dbApi.createMission(missionId, 'tester', 'peu importe');
  dbApi.assignTaskMission(taskId, missionId);
  return taskId;
}

/** Counts the `task_blocked` emitted during the call: that event wakes
 *  the orchestrator and starts the recovery loop. An automatic restart
 *  must emit none. */
function countBlockedEvents(fn: () => void): number {
  let n = 0;
  const listener = (ev: { kind: string }) => {
    if (ev.kind === 'task_blocked') n++;
  };
  bus.on('event', listener);
  try {
    fn();
  } finally {
    bus.off('event', listener);
  }
  return n;
}

test('a task killed by the reap goes back to PENDING without waking anybody', () => {
  const id = runningTask();
  let outcome = '';
  const blocked = countBlockedEvents(() => {
    outcome = dbApi.setTaskInterrupted(id, 'killed', 'process tué');
  });
  assert.equal(outcome, 'requeued');
  assert.equal(blocked, 0, 'an automatic restart must not emit task_blocked');

  const after = dbApi.getTask(id);
  assert.equal(after?.status, 'PENDING');
  assert.equal(after?.mission_id, null, 'the dead mission must no longer be attached');
  assert.equal(after?.interrupted_reason, null);
  assert.equal(after?.blocked_reason, null);
  assert.equal(after?.requeue_count, 1);
});

test('the restart counter is DEDICATED: `iteration` is never consumed', () => {
  // The trap: reusing `iteration` (as merge-integrity does, which is not
  // in the verification loop) would burn the review budget of a
  // `code` task for a cause that has nothing to do with its content.
  const id = runningTask('code');
  dbApi.setTaskVerificationMeta(id, 1, id);
  dbApi.setTaskInterrupted(id, 'timeout', 'tour bloqué');
  const after = dbApi.getTask(id);
  assert.equal(after?.requeue_count, 1);
  assert.equal(after?.iteration, 1, 'iteration belongs to the verification loop');
});

test('at the cap, the task stays BLOCKED and the caller is asked to escalate', () => {
  const id = runningTask();
  for (let i = 1; i <= MAX_SYSTEM_REQUEUES; i++) {
    assert.equal(dbApi.setTaskInterrupted(id, 'killed', 'process tué'), 'requeued');
    assert.equal(dbApi.getTask(id)?.requeue_count, i);
    // Re-dispatch: the task leaves again on a new mission.
    const missionId = randomUUID();
    dbApi.createMission(missionId, 'tester', 'retry');
    dbApi.assignTaskMission(id, missionId);
  }
  let outcome = '';
  const blocked = countBlockedEvents(() => {
    outcome = dbApi.setTaskInterrupted(id, 'killed', 'process tué une fois de trop');
  });
  assert.equal(outcome, 'escalated');
  assert.equal(blocked, 1, 'at the cap, the block must indeed go up');
  const after = dbApi.getTask(id);
  assert.equal(after?.status, 'BLOCKED');
  assert.equal(after?.interrupted_reason, 'killed');
  // The death too many counts too: without it, a loop relaunched by the pilot
  // would stay frozen at the cap (TIM-0065, crash-loop.test.ts).
  assert.equal(after?.requeue_count, MAX_SYSTEM_REQUEUES + 1);
  // TIM-0149: the death sentence alone says "not a business block", which next
  // to BLOCKED read as a replay still to come. The reason has to say it is over.
  assert.match(after?.blocked_reason ?? '', /process tué une fois de trop/);
  assert.match(after?.blocked_reason ?? '', /Automatic retries are exhausted \(4 system deaths/);
  assert.ok(
    after?.blocked_reason?.includes(`timon task update ${id} --status PENDING`),
    'the reason gives the gesture that restarts the task',
  );
});

test('a cause never replayed keeps its reason without the exhausted-retries sentence', () => {
  const id = runningTask();
  assert.equal(dbApi.setTaskInterrupted(id, 'permission_denied', 'refused tool'), 'blocked');
  assert.equal(dbApi.getTask(id)?.blocked_reason, 'refused tool');
});

test('a BUSINESS block is never restarted', () => {
  // Set by the agent through `timon task block --reason`: interrupted_reason stays
  // NULL, and the task waits for a decision.
  const id = runningTask();
  dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'la spec est ambiguë' });
  assert.equal(dbApi.getTask(id)?.interrupted_reason, null);

  assert.equal(dbApi.setTaskInterrupted(id, 'killed', 'process tué'), 'noop');
  const after = dbApi.getTask(id);
  assert.equal(after?.status, 'BLOCKED');
  assert.equal(after?.blocked_reason, 'la spec est ambiguë');
  assert.equal(after?.requeue_count, 0);
});

test('the residue of a previous block does not prevent the restart', () => {
  // `blocked_reason` is NOT reset to NULL on re-dispatch: a task already
  // blocked then restarted drags the reason along. Reading it as a fresh
  // business verdict would forbid any restart for those tasks. Only the STATUS prevails.
  const id = runningTask();
  dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'motif d\'un tour précédent' });
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'tester', 'retry');
  dbApi.assignTaskMission(id, missionId);
  assert.equal(dbApi.getTask(id)?.blocked_reason, 'motif d\'un tour précédent');

  assert.equal(dbApi.setTaskInterrupted(id, 'crash', 'arrêt inattendu'), 'requeued');
  const after = dbApi.getTask(id);
  assert.equal(after?.status, 'PENDING');
  assert.equal(after?.blocked_reason, null, 'the residue goes with the restart');
});

test('a usage limit is not restarted here: it waits for the backend switch', () => {
  const id = runningTask();
  const outcome = dbApi.setTaskInterrupted(id, 'rate_limit', 'quota épuisé');
  assert.equal(outcome, 'blocked');
  assert.equal(dbApi.getTask(id)?.status, 'BLOCKED');
  assert.equal(dbApi.getTask(id)?.requeue_count, 0);
});

test("requalifying the type of a BLOCKED task clears the stale reason", () => {
  const id = runningTask('code');
  dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'garde merge : sha manquant' });
  dbApi.updateTask(id, { type: 'chore' });
  const after = dbApi.getTask(id);
  assert.equal(after?.type, 'chore');
  assert.equal(after?.status, 'BLOCKED', 'the reason is cleared, nothing is unblocked instead');
  assert.equal(after?.blocked_reason, null);
  assert.equal(after?.interrupted_reason, null);
});

test('an update without a type change leaves the reason intact', () => {
  const id = runningTask('code');
  dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'garde merge : sha manquant' });
  dbApi.updateTask(id, { priority: 5, type: 'code' });
  const after = dbApi.getTask(id);
  assert.equal(after?.priority, 5);
  assert.equal(after?.blocked_reason, 'garde merge : sha manquant');
});
