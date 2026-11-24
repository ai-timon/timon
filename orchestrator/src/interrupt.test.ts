/**
 * STOP button: cutting the turn must neither kill the conversation nor make
 * the task restart on its own.
 *
 * What these tests protect:
 *   - `stopped` (human gesture) and `killed` (system death) stay TWO distinct
 *     causes. Mixing them up would requeue the task automatically,
 *     hence relaunch exactly the work that was just stopped by hand.
 *   - `interruptAgent` always says what it did AND whether resuming is
 *     possible: that answer decides what the UI says ("I
 *     resume in a second" vs "it is final").
 *
 * `node --test --import tsx src/interrupt.test.ts`
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const { dbApi } = await import('./db.js');
await import('../tests/helpers/claude-provider.js');

const { bus } = await import('./bus.js');
const {
  describeInterruption, isRequeueableInterruption, isInterruptionReason,
} = await import('./interruption.js');
const { interruptAgent } = await import('./agent.js');

test("'stopped' is a known cause, distinct from 'killed'", () => {
  assert.ok(isInterruptionReason('stopped'));
  assert.notEqual(describeInterruption('stopped'), describeInterruption('killed'));
  // A fragment SPECIFIC to the `stopped` label: matching the "Mission
  // interrupted (...)" prefix would match every cause and assert nothing.
  assert.match(describeInterruption('stopped'), /resumable/);
});

test('a turn interrupted by hand does NOT replay on its own', () => {
  assert.equal(isRequeueableInterruption('stopped'), false);
  // Explicit contrast: the reap stays replayable; that is the
  // difference the human gesture introduces.
  assert.equal(isRequeueableInterruption('killed'), true);
});

test("the interrupted mission's task goes BLOCKED with the right reason", () => {
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, 'task interrompue', 'tester', { type: 'code' });
  dbApi.createMission(missionId, 'tester', 'peu importe');
  dbApi.assignTaskMission(taskId, missionId);

  let blocked = 0;
  const listener = (ev: { kind: string }) => { if (ev.kind === 'task_blocked') blocked++; };
  bus.on('event', listener);
  const outcome = dbApi.setTaskInterrupted(
    taskId, 'stopped', describeInterruption('stopped'),
  );
  bus.off('event', listener);

  assert.equal(outcome, 'blocked');
  const t = dbApi.getTask(taskId);
  assert.equal(t?.status, 'BLOCKED');
  assert.equal(t?.interrupted_reason, 'stopped');
  assert.match(t?.blocked_reason ?? '', /stopped by hand from the chat/);
  // The block must wake the pilot: it is the one that will decide what comes next.
  assert.equal(blocked, 1);
});

test('interruptAgent: unknown mission → not_found, without breaking anything', () => {
  const out = interruptAgent(randomUUID());
  assert.equal(out.status, 'not_found');
  assert.equal(out.resumable, false);
});

test('interruptAgent: mission without a process → not_running, resume announced', () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'tester', 'peu importe');
  // Without a session anchor, nothing to resume: it is not promised.
  assert.deepEqual(
    { ...interruptAgent(missionId), backend: null },
    { status: 'not_running', resumable: false, backend: null, turnActive: false },
  );
  // With a session on a backend whose store outlives the process, yes.
  dbApi.setMissionSession(missionId, 'sess-42');
  assert.equal(interruptAgent(missionId).resumable, true);
});
