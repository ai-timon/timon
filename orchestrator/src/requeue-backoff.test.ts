/**
 * Backoff on requeuing after a system death.
 *
 * What is locked here is the pace, not the decision: a dead task
 * restarts, but not within the second. On the night of 2026-09-01, three respawns in
 * three minutes were sent to a backend answering in 295 ms: the more
 * instantaneous a cause, the faster the loop replays it.
 *
 * `node --test --import tsx src/requeue-backoff.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-backoff-test-'));

const { dbApi } = await import('./db.js');
const mkMission = (): string => {
  const id = randomUUID();
  dbApi.createMission(id, 'p.coder', 'volet coder');
  return id;
};

const {
  requeueBackoffMs, REQUEUE_BACKOFF_BASE_MS, REQUEUE_BACKOFF_MAX_MS, describeInterruption,
} = await import('./interruption.js');

test('the delay doubles at each attempt, without exceeding the cap', () => {
  assert.equal(requeueBackoffMs(1), REQUEUE_BACKOFF_BASE_MS);
  assert.equal(requeueBackoffMs(2), 2 * REQUEUE_BACKOFF_BASE_MS);
  assert.equal(requeueBackoffMs(3), 4 * REQUEUE_BACKOFF_BASE_MS);
  assert.equal(requeueBackoffMs(50), REQUEUE_BACKOFF_MAX_MS);
  // An aberrant counter coming from the database must produce neither Infinity nor a
  // delay shorter than the first one.
  assert.equal(requeueBackoffMs(0), REQUEUE_BACKOFF_BASE_MS);
  assert.equal(requeueBackoffMs(-3), REQUEUE_BACKOFF_BASE_MS);
});

test('a task requeued after a crash cannot be redispatched right away', () => {
  const id = randomUUID();
  dbApi.createTask(id, 'volet coder', 'p.coder', { type: 'code' });
  dbApi.assignTaskMission(id, mkMission());

  const outcome = dbApi.setTaskInterrupted(id, 'crash', describeInterruption('crash'));
  assert.equal(outcome, 'requeued');

  const first = dbApi.getTask(id)!;
  assert.equal(first.status, 'PENDING');
  assert.equal(first.requeue_count, 1);
  assert.ok(
    (first.scheduled_at ?? 0) - Date.now() > REQUEUE_BACKOFF_BASE_MS - 5_000,
    'the first retry waits for the base delay',
  );
  // The guard is the one that already exists: the dispatcher only sees the
  // tasks whose time has come.
  assert.equal(dbApi.listPendingReady().some((t) => t.id === id), false);

  // Second death: the delay doubles.
  dbApi.assignTaskMission(id, mkMission());
  assert.equal(dbApi.setTaskInterrupted(id, 'crash', describeInterruption('crash')), 'requeued');
  const second = dbApi.getTask(id)!;
  assert.equal(second.requeue_count, 2);
  assert.ok((second.scheduled_at ?? 0) - Date.now() > 2 * REQUEUE_BACKOFF_BASE_MS - 5_000);
});

test('the backoff never brings forward a task scheduled later', () => {
  const id = randomUUID();
  const far = Date.now() + 6 * 3600_000;
  dbApi.createTask(id, 'task de nuit', 'p.coder', { type: 'code', scheduledAt: far });
  dbApi.assignTaskMission(id, mkMission());

  dbApi.setTaskInterrupted(id, 'killed', describeInterruption('killed'));
  assert.equal(dbApi.getTask(id)?.scheduled_at, far);
});

test('a non-replayable cause stays BLOCKED, without a retry time', () => {
  const id = randomUUID();
  dbApi.createTask(id, 'volet coder', 'p.coder', { type: 'code' });
  dbApi.assignTaskMission(id, mkMission());

  const outcome = dbApi.setTaskInterrupted(
    id, 'backend_unavailable', describeInterruption('backend_unavailable'),
  );
  assert.equal(outcome, 'blocked');
  const row = dbApi.getTask(id)!;
  assert.equal(row.status, 'BLOCKED');
  assert.equal(row.scheduled_at, null);
});
