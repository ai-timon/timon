/**
 * The code beside a stored daemon sentence (TODO #845): written with its
 * sentence, never left behind when another writer changes the sentence, and
 * masked like it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-daemon-message-test-'));

const { db, dbApi } = await import('./db.js');
const { daemonMessage, decodeDaemonMessage, encodeDaemonMessage, withDaemonMessageBody } = await import('./daemon-message.js');
const { setRedactionSource } = await import('./secrets/redact.js');

function pendingTask(type: 'code' | 'doc' | 'merge' = 'doc'): string {
  const id = randomUUID();
  dbApi.createTask(id, `task ${id.slice(0, 8)}`, 'tester', { type });
  return id;
}

function storedCode(id: string): string | null {
  return dbApi.getTask(id)?.blocked_reason_code ?? null;
}

test('a malformed code throws, a param that is no string or finite number is dropped', () => {
  assert.throws(() => daemonMessage('Not-Snake'), TypeError);
  assert.deepEqual(daemonMessage('task_interrupted', { reason: 'crash', n: 2, gone: null, nan: Number.NaN }).params, { reason: 'crash', n: 2 });
});

test('encode then decode gives the message back; a foreign value decodes to null', () => {
  const message = daemonMessage('merge_sha_missing', { guard: 'merge' });
  assert.deepEqual(decodeDaemonMessage(encodeDaemonMessage(message, (s) => s)), message);
  assert.equal(decodeDaemonMessage('not json'), null);
  assert.equal(decodeDaemonMessage(JSON.stringify({ code: 'Bad Code' })), null);
  assert.equal(encodeDaemonMessage(null, (s) => s), null);
});

test('a daemon block stores its code; a block without one clears it', () => {
  const id = pendingTask();
  dbApi.updateTaskStatus(id, 'BLOCKED', {
    blockedReason: 'Review verdict not parsable.',
    blockedReasonCode: daemonMessage('review_verdict_unparsable', { excerpt: '(empty)' }),
  });
  assert.equal(decodeDaemonMessage(storedCode(id))?.code, 'review_verdict_unparsable');

  // An agent's own reason: the code would translate a sentence that is gone.
  dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'I need a decision on the schema.' });
  assert.equal(storedCode(id), null);
  assert.equal(dbApi.getTask(id)?.blocked_reason, 'I need a decision on the schema.');
});

test('a code without a reason is not stored', () => {
  const id = pendingTask();
  dbApi.updateTaskStatus(id, 'PENDING', { blockedReasonCode: daemonMessage('merge_sha_missing', { guard: 'merge' }) });
  assert.equal(storedCode(id), null);
});

test('a writer that changes the reason without naming a code clears the old code', () => {
  const id = pendingTask();
  dbApi.updateTaskStatus(id, 'BLOCKED', {
    blockedReason: 'Review verdict not parsable.',
    blockedReasonCode: daemonMessage('review_verdict_unparsable', { excerpt: '(empty)' }),
  });
  // A statement that predates the column, like the scope stop's.
  db.prepare(`UPDATE tasks SET blocked_reason = ? WHERE id = ?`).run('Stopped from the board.', id);
  assert.equal(storedCode(id), null);
});

test('an interruption keeps the reason already there, and its code with it', () => {
  const id = pendingTask();
  const mission = randomUUID();
  dbApi.createMission(mission, 'tester', 'anything');
  dbApi.assignTaskMission(id, mission);
  // The reason an agent wrote before dying wins, and it has no code.
  db.prepare(`UPDATE tasks SET blocked_reason = ? WHERE id = ?`).run('Agent reason.', id);
  dbApi.setTaskInterrupted(id, 'permission_denied', 'Mission interrupted.', null,
    daemonMessage('task_interrupted', { reason: 'permission_denied' }));
  assert.equal(dbApi.getTask(id)?.blocked_reason, 'Agent reason.');
  assert.equal(storedCode(id), null);

  const fresh = pendingTask();
  const other = randomUUID();
  dbApi.createMission(other, 'tester', 'anything');
  dbApi.assignTaskMission(fresh, other);
  dbApi.setTaskInterrupted(fresh, 'permission_denied', 'Mission interrupted.', null,
    daemonMessage('task_interrupted', { reason: 'permission_denied' }));
  assert.deepEqual(decodeDaemonMessage(storedCode(fresh))?.params, { reason: 'permission_denied' });
});

test('a requeue clears the code with the reason', () => {
  const id = pendingTask();
  dbApi.updateTaskStatus(id, 'BLOCKED', {
    blockedReason: 'Review verdict not parsable.',
    blockedReasonCode: daemonMessage('review_verdict_unparsable', { excerpt: '(empty)' }),
  });
  // Back in flight with its old reason, as a status-only move leaves it.
  const mission = randomUUID();
  dbApi.createMission(mission, 'tester', 'anything');
  dbApi.assignTaskMission(id, mission);
  assert.notEqual(storedCode(id), null);
  assert.equal(dbApi.setTaskInterrupted(id, 'crash', 'Mission interrupted.'), 'requeued');
  assert.equal(dbApi.getTask(id)?.blocked_reason, null);
  assert.equal(storedCode(id), null);
});

test('a notification stores its code, with its string params masked like its text', () => {
  const restore = setRedactionSource(() => ['hunter2-secret-value']);
  try {
    const row = dbApi.createNotification({
      id: randomUUID(),
      type: 'alert',
      title: 'Task keeps failing: x',
      body: 'Last error: hunter2-secret-value',
      message: daemonMessage('task_system_deaths', { deaths: 3, title: 'x', detail: 'Last error: hunter2-secret-value' }),
    });
    const stored = decodeDaemonMessage(dbApi.getNotification(row.id)?.message_code);
    assert.equal(stored?.code, 'task_system_deaths');
    assert.equal(stored?.params.deaths, 3);
    assert.ok(!String(stored?.params.detail).includes('hunter2-secret-value'));
    assert.equal(row.message_code, dbApi.getNotification(row.id)?.message_code);
  } finally {
    setRedactionSource(restore);
  }
});

test('a notification without a code stores NULL', () => {
  const row = dbApi.createNotification({ id: randomUUID(), type: 'report', title: 'Hand-written' });
  assert.equal(dbApi.getNotification(row.id)?.message_code, null);
});

test('a notification body that is another stored message survives the column, masked too', () => {
  const restore = setRedactionSource(() => ['hunter2-secret-value']);
  try {
    const message = withDaemonMessageBody(
      daemonMessage('task_blocked', { title: 'x', taskId: 'abcd1234' }),
      daemonMessage('task_base_missing', { base: 'hunter2-secret-value', type: 'code' }),
    );
    const row = dbApi.createNotification({ id: randomUUID(), type: 'alert', title: 'Task blocked: x', message });
    const stored = decodeDaemonMessage(dbApi.getNotification(row.id)?.message_code);
    assert.equal(stored?.code, 'task_blocked');
    assert.equal(stored?.body?.code, 'task_base_missing');
    assert.equal(stored?.body?.params.type, 'code');
    assert.ok(!String(stored?.body?.params.base).includes('hunter2-secret-value'));
    assert.equal(withDaemonMessageBody(message, null), message);
  } finally {
    setRedactionSource(restore);
  }
});
