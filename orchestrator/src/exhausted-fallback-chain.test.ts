/**
 * End to end of the 402: the incident payload, and nothing else, must
 * move the series.
 *
 * It is THE test that would have caught the night of 2026-09-01. The full chain
 * is replayed with the incident `result` copied as is: autopsy of the
 * events (`finishMission`), interruption cause, series switch, requeue.
 * Nothing is simulated along the way: `mission_complete` is published with
 * the cause `finishMission` returned, exactly as `agent.ts` does at
 * the death of a process.
 *
 * The fb-2 circuit breaker is left OUT of the test (no sterile turn is
 * counted here): if it took part, the series would move for the right reason without
 * proving anything about the 402 path.
 *
 * `node --test --import tsx src/exhausted-fallback-chain.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-exhausted-chain-test-'));
process.env.TIMON_FALLBACK_ENABLED = '1';
process.env.TIMON_FALLBACK_BACKEND = 'codex';
process.env.TIMON_FALLBACK_MODEL = '';

const { dbApi } = await import('./db.js');
const { mountOfficialProviders, stubCliBinaries, stubCodexSignIn } = await import('../tests/helpers/official-providers.js');
// A fallback goes only to a CLI that is on this host and signed in: stand-ins, never the machine's own.
await stubCliBinaries('grok', 'claude', 'codex');
await stubCodexSignIn();
await mountOfficialProviders();
const { bus } = await import('./bus.js');
const { bestRateLimit } = await import('./rate-limit.js');
const { clearBackendCooldown, noteBackendRateLimit } = await import('./backend-fallback.js');
const { watchMissionComplete, reconcileOrphanedTasks } = await import('./dispatcher.js');
const { systemMissionId } = await import('./notify.js');

/** Switchover notifications sent to the notification centre. Counting them is
 *  the only way to check "no second notification": the task state alone says
 *  nothing about what the user was told. */
function countFallbackNotifications(): number {
  return dbApi.listMessagesForMission(systemMissionId(), 500)
    .filter((m) => m.kind === 'notification' && /switched to its fallback plan/.test(m.payload))
    .length;
}

/**
 * The `result` received four times that night, copied from
 * `docs/INCIDENT-402-GROK-FALLBACK.md`. The HTTP status is buried in an
 * `errors[]` string: no structured field says 402.
 */
const EXHAUSTED_RESULT = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  duration_ms: 295,
  num_turns: 0,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
  errors: [
    'Internal error: {\n  "message": "API error (status 402 Payment Required): '
    + 'Grok Build usage balance exhausted",\n  "http_status": 402\n}',
  ],
};

test("the incident's 402 moves the series and requeues its tasks", async () => {
  clearBackendCooldown('grok');
  const stop = watchMissionComplete();
  try {
    const seriesId = randomUUID();
    const pilotId = randomUUID();
    const codeId = randomUUID();
    const missionId = randomUUID();
    const blockedId = randomUUID();

    dbApi.createMission(pilotId, 'p.main', 'pilote de la série'); // french-ok: free-text sample data
    dbApi.createTask(codeId, 'volet coder', 'p.coder', {
      type: 'code', seriesId, creatorMissionId: pilotId,
      backendOverride: 'grok', modelOverride: 'grok-4.6',
    });
    // The next task of the work, already blocked by an earlier 402: it is
    // the one left stranded when only the `rate_limit` cause was
    // requeued.
    dbApi.createTask(blockedId, 'volet suivant', 'p.coder', {
      type: 'code', seriesId, creatorMissionId: pilotId,
      backendOverride: 'grok', modelOverride: 'grok-4.6',
    });
    dbApi.setTaskInterrupted(blockedId, 'exhausted', 'compte sans crédit (HTTP 402)'); // french-ok: free-text sample data

    dbApi.createMission(missionId, 'p.coder', 'volet coder');
    dbApi.assignTaskMission(codeId, missionId);
    dbApi.insertEvent(missionId, 'result', EXHAUSTED_RESULT);

    // What `agent.ts` does on seeing the event go by: recognise the hit and
    // set the backend aside for ALL of Timon, otherwise the requeued task
    // would leave again on the dry account at the next tick.
    const rl = bestRateLimit([{ type: 'result', payload: EXHAUSTED_RESULT }], { includePending: true });
    assert.ok(rl && rl.kind === 'exhausted', 'the 402 must be read as an exhausted balance, not a quota');
    noteBackendRateLimit('grok', rl);

    // What `agent.ts` does at the exit of the process: finalise, then publish
    // the EFFECTIVE cause, the one the autopsy of the events established, not the
    // `crash` guessed by the caller.
    const effective = dbApi.finishMission(missionId, 'failed', 1, 'crash');
    assert.equal(effective, 'exhausted', 'the 402 must no longer read "crash"');
    bus.publish({
      kind: 'mission_complete', missionId, status: 'failed', exitCode: 1, reason: effective,
    });

    const blocked = dbApi.getTask(codeId);
    assert.equal(blocked?.status, 'BLOCKED');
    assert.equal(blocked?.interrupted_reason, 'exhausted');
    // A dry account announces no reopening: writing a time (or even
    // "time not communicated") would make one wait for an event that will not
    // come, only a top-up brings the backend back.
    const motif = blocked?.blocked_reason ?? '';
    assert.ok(motif.includes('out of credit'), `unexpected reason: ${motif}`);
    // The label says "nothing reopens on its own": what is forbidden is
    // ANNOUNCING a reopening (a given time, or a missing time).
    assert.ok(
      !/reopens at|reopening time/.test(motif),
      `the reason must not announce a reopening: ${motif}`,
    );

    // The series switch is asynchronous (lazy import of agent.ts).
    await new Promise((r) => setTimeout(r, 200));

    for (const id of [codeId, blockedId]) {
      const moved = dbApi.getTask(id);
      assert.equal(moved?.backend_override, 'codex', 'the series must restart on its fallback');
      // A FULL requeue: a task that keeps its reason or its dead mission
      // cannot be picked up, it is only less visible.
      assert.equal(moved?.status, 'PENDING');
      assert.equal(moved?.interrupted_reason, null);
      assert.equal(moved?.blocked_reason, null);
      assert.equal(moved?.mission_id, null);
    }

    // And the backend is set aside for all of Timon: without that, the requeued task
    // would leave again on the dry account at the next tick.
    assert.equal(dbApi.getBackendCooldown('grok')?.kind, 'exhausted');
  } finally {
    stop();
  }
});

test('a scope without a fallback is not unblocked on the dead backend', async () => {
  clearBackendCooldown('grok');
  const stop = watchMissionComplete();
  try {
    const seriesId = randomUUID();
    const pilotId = randomUUID();
    const codeId = randomUUID();
    const docId = randomUUID();
    const missionId = randomUUID();

    dbApi.createMission(pilotId, 'p.main', 'pilote de la série'); // french-ok: free-text sample data
    dbApi.createTask(codeId, 'volet coder', 'p.coder', {
      type: 'code', seriesId, creatorMissionId: pilotId,
      backendOverride: 'grok', modelOverride: 'grok-4.6',
    });
    dbApi.createTask(docId, 'doc du volet', 'p.librarian', {
      type: 'doc', seriesId, creatorMissionId: pilotId,
      backendOverride: 'grok', modelOverride: 'grok-4.6',
    });
    // "this scope does not switch": an explicit refusal, not an omission.
    dbApi.setSeriesFallback(seriesId, 'doc', null, null);
    dbApi.setTaskInterrupted(docId, 'exhausted', 'compte sans crédit (HTTP 402)'); // french-ok: free-text sample data

    dbApi.createMission(missionId, 'p.coder', 'volet coder');
    dbApi.assignTaskMission(codeId, missionId);
    dbApi.insertEvent(missionId, 'result', EXHAUSTED_RESULT);
    const effective = dbApi.finishMission(missionId, 'failed', 1, 'crash');
    bus.publish({
      kind: 'mission_complete', missionId, status: 'failed', exitCode: 1, reason: effective,
    });
    await new Promise((r) => setTimeout(r, 200));

    assert.equal(dbApi.getTask(codeId)?.backend_override, 'codex');
    // The doc has no fallback: requeuing it would relaunch it on the
    // dry account; the accepted failure is better than the wall replayed.
    const doc = dbApi.getTask(docId);
    assert.equal(doc?.backend_override, 'grok');
    assert.equal(doc?.status, 'BLOCKED');
  } finally {
    stop();
  }
});

/**
 * Same outage, other door: the daemon restarts while a series' backend runs
 * dry. `mission_complete` is an in-memory event — it dies with the process, so
 * nothing ever switched the series over. Boot reconciliation qualified the
 * cause and stopped there: the task went BLOCKED on a backend everyone knew to
 * be dead, and the next one left for the same wall.
 *
 * Comments here are in English (CLAUDE.md rule); the tests above predate it and
 * are left as they are — a translation pass is not an assertion pass.
 */
test('an orphan discovered at boot switches its series over and requeues its tasks', async () => {
  clearBackendCooldown('grok');
  const seriesId = randomUUID();
  const pilotId = randomUUID();
  const runningId = randomUUID();
  const nextId = randomUUID();
  const missionId = randomUUID();

  // The pilot died with the daemon: `terminated`, not `running`.
  dbApi.createMission(pilotId, 'p.main', 'pilote de la série'); // french-ok: free-text sample data
  dbApi.setMissionLlmOverrides(pilotId, 'grok', 'grok-4.6');
  dbApi.finishMission(pilotId, 'terminated', 0, 'killed');

  dbApi.createTask(runningId, 'volet en vol', 'p.coder', {
    type: 'code', seriesId, creatorMissionId: pilotId,
    backendOverride: 'grok', modelOverride: 'grok-4.6',
  });
  // The next task of the job, still PENDING: it is the one that would leave for
  // the dead backend at the first dispatch after the restart.
  dbApi.createTask(nextId, 'volet suivant', 'p.coder', {
    type: 'code', seriesId, creatorMissionId: pilotId,
    backendOverride: 'grok', modelOverride: 'grok-4.6',
  });

  dbApi.createMission(missionId, 'p.coder', 'volet en vol');
  dbApi.assignTaskMission(runningId, missionId);
  dbApi.insertEvent(missionId, 'result', EXHAUSTED_RESULT);
  const rl = bestRateLimit([{ type: 'result', payload: EXHAUSTED_RESULT }], { includePending: true });
  noteBackendRateLimit('grok', rl!);
  // The mission is finalized, its task is NOT transitioned, and — the whole
  // point — no `mission_complete` is published: that event was lost.
  assert.equal(dbApi.finishMission(missionId, 'failed', 1, 'crash'), 'exhausted');
  assert.equal(dbApi.getTask(runningId)?.status, 'IN_PROGRESS');

  const notifsBefore = countFallbackNotifications();
  await reconcileOrphanedTasks(0);

  for (const id of [runningId, nextId]) {
    const moved = dbApi.getTask(id);
    assert.equal(moved?.backend_override, 'codex', `task ${id} must restart on the fallback`);
    assert.equal(moved?.status, 'PENDING');
    assert.equal(moved?.interrupted_reason, null);
    assert.equal(moved?.blocked_reason, null);
    assert.equal(moved?.mission_id, null);
  }

  // The pilot is repointed so that whatever resumes it starts on the fallback,
  // but it is NOT resurrected: reopening it here would relaunch, at boot, an
  // orchestrator nobody asked to restart.
  const pilot = dbApi.getMission(pilotId);
  assert.equal(pilot?.backend_override, 'codex');
  assert.equal(pilot?.status, 'terminated');

  assert.equal(countFallbackNotifications(), notifsBefore + 1, 'one switchover, one notification');

  // Second pass on the same state: the reconciliation is replayed at every
  // tick, it must find nothing left to do and above all not notify again.
  await reconcileOrphanedTasks(0);
  assert.equal(countFallbackNotifications(), notifsBefore + 1, 'a switched series does not switch twice');
  assert.equal(dbApi.getTask(runningId)?.status, 'PENDING');
});
