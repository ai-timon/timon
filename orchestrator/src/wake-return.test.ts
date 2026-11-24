/**
 * The work return leaves at the CLOSING of the task, only once.
 *
 * What these tests protect (incident of 2026-08-21): the `task_done` event
 * (without it, the return waits for the death of the process: 11 min of delay measured
 * on review `693469fa`), the `return_notified` flag that prevents the
 * late `mission_complete` from producing a SECOND wake, and its reset
 * on re-dispatch (otherwise a restarted task would never report again).
 *
 * `node --test --import tsx src/wake-return.test.ts` (or `npm test`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-wake-return-test-'));
const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');

function task(type: 'code' | 'review' | 'merge' | 'doc' = 'code', deps: string[] = []): string {
  const id = randomUUID();
  dbApi.createTask(id, `${type} — un volet`, 'p.coder', { type, deps });
  return id;
}

/** Counts the `task_done` emitted during the call: that event triggers
 *  the return to the pilot. */
function countTaskDone(fn: () => void): number {
  let n = 0;
  const listener = (ev: { kind: string }): void => { if (ev.kind === 'task_done') n++; };
  bus.on('event', listener);
  try { fn(); } finally { bus.off('event', listener); }
  return n;
}

test('setting a task DONE emits task_done, only once', () => {
  const id = task();
  assert.equal(countTaskDone(() => dbApi.updateTaskStatus(id, 'DONE', { doneComment: 'fait' })), 1);
  // Closing a task already DONE again re-emits nothing (no second wake).
  assert.equal(countTaskDone(() => dbApi.updateTaskStatus(id, 'DONE', { doneComment: 'fait' })), 0);
});

test('setTaskStatusOnly emits task_done too (closing by a guard)', () => {
  const id = task();
  assert.equal(countTaskDone(() => dbApi.setTaskStatusOnly(id, 'DONE')), 1);
});

test('a block does not emit task_done', () => {
  const id = task();
  assert.equal(countTaskDone(() => dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'conflit' })), 0);
});

test('return_notified: set explicitly, reset on (re-)dispatch', () => {
  const id = task();
  assert.equal(dbApi.isTaskReturnNotified(id), false);
  dbApi.markTaskReturnNotified(id);
  assert.equal(dbApi.isTaskReturnNotified(id), true);

  // Re-dispatch: a new run, hence a new reporting cycle. Without
  // this reset, a task requeued then closed again would stay mute.
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'p.coder', 'exec', { channel: 'dispatcher' });
  dbApi.assignTaskMission(id, missionId);
  assert.equal(dbApi.isTaskReturnNotified(id), false);
});

test('hasFollowUpTask: a task another one depends on already has a follow-up', () => {
  const code = task('code');
  assert.equal(dbApi.hasFollowUpTask(code), false);
  const review = task('review', [code]);
  assert.equal(dbApi.hasFollowUpTask(code), true);
  // A `doc` task chains nothing: its presence does not prove the chain
  // goes on, so it does not count as a follow-up.
  const merge = task('merge', [review]);
  task('doc', [merge]);
  assert.equal(dbApi.hasFollowUpTask(merge), false);
});
