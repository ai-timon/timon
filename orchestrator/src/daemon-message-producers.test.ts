/**
 * The daemon's producers store a code beside the English they write
 * (TODO #845): the verification loop, the merge guard, the death of a task's
 * mission. The English is unchanged; the code is what the webview translates.
 *
 * `npm test -- src/daemon-message-producers.test.ts`
 */
import '../tests/helpers/no-load-gate.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-daemon-message-producers-'));
const { dbApi, db, MAX_SYSTEM_REQUEUES } = await import('./db.js');
const { runTaskChain } = await import('./task-chain.js');
const { VERIFICATION_MAX_ITERATIONS } = await import('./verification-loop.js');
const { decodeDaemonMessage } = await import('./daemon-message.js');
const { interruptionMessage } = await import('./interruption.js');
const { notifyUser } = await import('./notify.js');

type Type = 'code' | 'review' | 'merge';

function mkTask(type: Type, deps: string[] = []): string {
  const id = randomUUID();
  dbApi.createTask(id, `${type} task`, 'p.coder', { type, deps });
  return id;
}

function codeOf(id: string) {
  return decodeDaemonMessage(dbApi.getTask(id)?.blocked_reason_code);
}

/** The payload of the last notification the orchestrator queued. */
function lastNotification(): Record<string, unknown> {
  const row = db.prepare(`SELECT payload FROM agent_messages WHERE kind = 'notification' ORDER BY rowid DESC LIMIT 1`)
    .get() as { payload: string } | undefined;
  return JSON.parse(row?.payload ?? '{}') as Record<string, unknown>;
}

test('a review with no usable verdict: the block and the notification carry their codes', async () => {
  const rootId = mkTask('code');
  dbApi.updateTaskStatus(rootId, 'DONE', { doneComment: 'code done' });
  const reviewId = mkTask('review', [rootId]);
  dbApi.setTaskVerificationMeta(reviewId, 1, rootId);
  dbApi.updateTaskStatus(reviewId, 'DONE', { doneComment: 'Looks fine to me.' });
  await runTaskChain(reviewId);

  const review = dbApi.getTask(reviewId)!;
  assert.equal(review.status, 'BLOCKED');
  assert.match(review.blocked_reason ?? '', /Review verdict not parsable/);
  assert.deepEqual(codeOf(reviewId), { code: 'review_verdict_unparsable', params: { excerpt: 'Looks fine to me.' } });

  const payload = lastNotification();
  assert.match(String(payload.title), /Review with no usable verdict/);
  assert.equal(payload.code, 'review_verdict_unusable');
  assert.deepEqual(payload.params, { title: 'review task', taskId: reviewId, excerpt: 'Looks fine to me.' });
});

test('the verification cap blocks the root with its code', async () => {
  const rootId = mkTask('code');
  dbApi.updateTaskStatus(rootId, 'DONE', { doneComment: 'code done' });
  const reviewId = mkTask('review', [rootId]);
  dbApi.setTaskVerificationMeta(reviewId, VERIFICATION_MAX_ITERATIONS, rootId);
  dbApi.updateTaskStatus(reviewId, 'DONE', { doneComment: '{"verdict":"changes_requested","feedback":"rename it"}' });
  await runTaskChain(reviewId);

  const code = codeOf(rootId);
  assert.equal(dbApi.getTask(rootId)?.status, 'BLOCKED');
  assert.equal(code?.code, 'verification_cap_reached');
  assert.equal(code?.params.max, VERIFICATION_MAX_ITERATIONS);
  assert.equal(code?.params.reviewId, reviewId);
});

test('the merge guard names its case: no sha, or an abbreviated one', () => {
  const missing = mkTask('merge');
  dbApi.updateTaskStatus(missing, 'DONE', { doneComment: 'merged' });
  assert.equal(dbApi.getTask(missing)?.status, 'BLOCKED');
  assert.deepEqual(codeOf(missing), { code: 'merge_sha_missing', params: { guard: 'merge' } });

  const short = mkTask('merge');
  dbApi.updateTaskStatus(short, 'DONE', { doneComment: 'merged as fe2dd84' });
  assert.deepEqual(codeOf(short), { code: 'merge_sha_abbreviated', params: { guard: 'merge', short: 'fe2dd84' } });
});

test('an interruption names its cause, its quota window and its reopening', () => {
  const at = new Date(2026, 10, 17, 3, 5).getTime();
  const message = interruptionMessage('rate_limit', at, { rateLimitType: 'five_hour', resetsAt: at + 3_600_000 });
  assert.equal(message.code, 'task_interrupted');
  assert.deepEqual(message.params, {
    reason: 'rate_limit', window: 'five_hour', reopens: '04:05', observed: '03:05',
    context: 'none', lastError: 'none', exhausted: 0, taskId: '',
  });
  // Outside a quota, the window and the reopening do not apply.
  assert.equal(interruptionMessage('killed', at, { rateLimitType: 'five_hour' }).params.window, 'none');
});

test('once the retries run out, the stored code says so, like the English', () => {
  const id = mkTask('code');
  for (let death = 0; death <= MAX_SYSTEM_REQUEUES; death++) {
    const mission = randomUUID();
    dbApi.createMission(mission, 'p.coder', 'anything');
    dbApi.assignTaskMission(id, mission);
    dbApi.setTaskInterrupted(id, 'crash', 'Mission interrupted (crash).', null, interruptionMessage('crash'));
  }
  const task = dbApi.getTask(id)!;
  assert.equal(task.status, 'BLOCKED');
  assert.match(task.blocked_reason ?? '', /Automatic retries are exhausted/);
  assert.equal(codeOf(id)?.params.exhausted, MAX_SYSTEM_REQUEUES + 1);
  assert.equal(codeOf(id)?.params.taskId, id);
});

test('a notification without a code keeps its payload as before', () => {
  notifyUser('Hand-written title', 'Hand-written body');
  const payload = lastNotification();
  assert.equal(payload.title, 'Hand-written title');
  assert.equal('code' in payload, false);
});

test('a signed-out backend raises a coded card; the breaker a coded notice', async () => {
  const { mountOfficialProviders } = await import('../tests/helpers/official-providers.js');
  await mountOfficialProviders();
  const { noteBackendUnavailable } = await import('./backend-fallback.js');
  const trip = { failures: 3, threshold: 3, windowMs: 600_000, spanMs: 9_000, signature: '0 turn / 0 token / 295 ms' };
  noteBackendUnavailable({ ...trip, backend: 'codex', cause: 'auth' });
  // The card is written behind a dynamic import.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const card = dbApi.listNotifications({ limit: 20 }).find((n) => n.title.startsWith('Backend codex: signed out'));
  const code = decodeDaemonMessage(card?.message_code);
  assert.equal(code?.code, 'backend_signed_out');
  assert.equal(code?.params.backend, 'codex');
  assert.equal(typeof code?.params.until, 'number');

  noteBackendUnavailable({ ...trip, backend: 'claude', cause: 'burst' });
  const payload = lastNotification();
  assert.match(String(payload.title), /claude: sidelined by the circuit breaker/);
  assert.equal(payload.code, 'backend_breaker_tripped');
  assert.equal((payload.params as Record<string, unknown>).failures, 3);
});

test('the blocked-task card reads the coded reason as its body, and the return card carries it', async () => {
  const { startNotificationResolver } = await import('./notifications.js');
  const { daemonMessage } = await import('./daemon-message.js');
  const { returnCardOf } = await import('./wake-digest.js');
  const stop = startNotificationResolver();
  try {
    const id = mkTask('code');
    dbApi.updateTaskStatus(id, 'BLOCKED', {
      blockedReason: 'Base nope does not exist in the repository.',
      blockedReasonCode: daemonMessage('task_base_missing', { base: 'nope', type: 'code' }),
    });
    const card = dbApi.listNotifications({ limit: 50 }).find((n) => n.task_id === id);
    const stored = decodeDaemonMessage(card?.message_code);
    assert.equal(card?.title, 'Task blocked: code task');
    assert.deepEqual(stored, {
      code: 'task_blocked',
      params: { title: 'code task', taskId: id.slice(0, 8) },
      body: { code: 'task_base_missing', params: { base: 'nope', type: 'code' } },
    });

    const shown = returnCardOf({
      kind: 'task_closed', task_id: id, task_status: 'BLOCKED',
      blocked_reason: 'Base nope does not exist in the repository.',
      blocked_reason_code: { code: 'task_base_missing', params: { base: 'nope', type: 'code' } },
    });
    assert.equal(shown.blocked_reason_code?.code, 'task_base_missing');
  } finally {
    stop();
  }
});

test('an agent\'s own reason gives the blocked-task card no body code', async () => {
  const { startNotificationResolver } = await import('./notifications.js');
  const stop = startNotificationResolver();
  try {
    const id = mkTask('code');
    dbApi.updateTaskStatus(id, 'BLOCKED', { blockedReason: 'I need the API key.' });
    const card = dbApi.listNotifications({ limit: 50 }).find((n) => n.task_id === id);
    const stored = decodeDaemonMessage(card?.message_code);
    assert.equal(stored?.code, 'task_blocked');
    assert.equal(stored?.body, undefined);
    assert.equal(card?.body, 'I need the API key.');
  } finally {
    stop();
  }
});
