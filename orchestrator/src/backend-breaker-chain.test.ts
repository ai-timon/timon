/**
 * End to end of the circuit breaker: three missions sent back instantly
 * set the backend aside AND move the series, WITHOUT any readable error
 * message.
 *
 * It is the reconstruction of the night of 2026-09-01, rid of what made it
 * fail: the incident payload is taken as is but emptied of its
 * `errors[]`. If the chain starts depending on a provider sentence again, these
 * tests fall: that is exactly their reason to be.
 *
 * `node --test --import tsx src/backend-breaker-chain.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-breaker-chain-test-'));
process.env.TIMON_FALLBACK_ENABLED = '1';
process.env.TIMON_FALLBACK_BACKEND = 'codex';
process.env.TIMON_BREAKER_ENABLED = '1';
process.env.TIMON_BREAKER_THRESHOLD = '3';
process.env.TIMON_BREAKER_COOLDOWN_MS = '1800000';

const { dbApi } = await import('./db.js');
const { mountOfficialProviders, stubCliBinaries, stubCodexSignIn } = await import('../tests/helpers/official-providers.js');
// A fallback goes only to a CLI that is on this host and signed in: stand-ins, never the machine's own.
await stubCliBinaries('grok', 'claude', 'codex');
await stubCodexSignIn();
await mountOfficialProviders();
const { bus } = await import('./bus.js');
const { rateLimitFromEvent } = await import('./rate-limit.js');
const { sterileResultSignature, noteSterileTurn, noteProductiveTurn, resetBreakers } = await import('./backend-breaker.js');
const { noteBackendUnavailable, isBackendCoolingDown, clearBackendCooldown } =
  await import('./backend-fallback.js');
const { watchMissionComplete } = await import('./dispatcher.js');

/** The `result` of the incident, STRIPPED of its message: 0 turns, 0 tokens, 300 ms. */
const MUTE_BOUNCE = {
  type: 'result',
  subtype: 'error_during_execution',
  is_error: true,
  duration_ms: 300,
  num_turns: 0,
  total_cost_usd: 0,
  usage: { input_tokens: 0, output_tokens: 0 },
};

/** The three bounces of the night, as `agent.ts` would see them. */
function bounceThreeTimes(backend: string): void {
  for (let i = 0; i < 3; i++) {
    const signature = sterileResultSignature('result', MUTE_BOUNCE);
    assert.ok(signature, 'each bounce must be recognised by its shape alone');
    const trip = noteSterileTurn(backend, signature);
    if (trip) noteBackendUnavailable(trip);
  }
}

test('three mute bounces set the backend aside, without any message to read', () => {
  resetBreakers();
  clearBackendCooldown('grok');
  // The precondition of the whole test: text detection sees NOTHING here.
  assert.equal(rateLimitFromEvent('result', MUTE_BOUNCE), null);
  assert.equal(isBackendCoolingDown('grok'), false);

  bounceThreeTimes('grok');

  const cooldown = dbApi.getBackendCooldown('grok');
  assert.equal(cooldown?.kind, 'unavailable');
  assert.equal(cooldown?.quota_window, 'circuit breaker');
  assert.equal(isBackendCoolingDown('grok'), true);
});

test('a better-informed cooldown (402) is not shortened by the circuit breaker', () => {
  resetBreakers();
  clearBackendCooldown('grok');
  const dry = Date.now() + 24 * 3600_000;
  dbApi.setBackendCooldown('grok', dry, 'balance exhausted', false, 'exhausted');

  bounceThreeTimes('grok');

  // The exhausted balance knows WHY; the circuit breaker does not. Bringing the
  // backend back into rotation in 30 min would put it back against the wall.
  const cooldown = dbApi.getBackendCooldown('grok');
  assert.equal(cooldown?.kind, 'exhausted');
  assert.equal(cooldown?.until, dry);
  clearBackendCooldown('grok');
});

test('a mission killed by the circuit breaker switches its series to its fallback', async () => {
  resetBreakers();
  clearBackendCooldown('grok');
  const stop = watchMissionComplete();
  try {
    const seriesId = randomUUID();
    const taskId = randomUUID();
    const missionId = randomUUID();
    dbApi.createTask(taskId, 'volet coder', 'p.coder', {
      type: 'code', seriesId, backendOverride: 'grok', modelOverride: 'grok-4.6',
    });
    dbApi.createMission(missionId, 'p.coder', 'volet coder');
    dbApi.assignTaskMission(taskId, missionId);

    bus.publish({
      kind: 'mission_complete', missionId, status: 'failed', exitCode: 1,
      reason: 'backend_unavailable',
    });

    const blocked = dbApi.getTask(taskId);
    assert.equal(blocked?.status, 'BLOCKED');
    // A qualified cause, not the generic `crash` that made the task replay
    // identically on the dead backend.
    assert.equal(blocked?.interrupted_reason, 'backend_unavailable');
    assert.ok(
      (blocked?.blocked_reason ?? '').includes('backend structurally unavailable'),
      'the reason on the Kanban must say what happened',
    );

    // The series switch is asynchronous (lazy import of agent.ts).
    await new Promise((r) => setTimeout(r, 200));
    const moved = dbApi.getTask(taskId);
    assert.equal(moved?.backend_override, 'codex', 'the series must restart on its fallback');
    // And the task, blocked by the state of the BACKEND and not by its work, is
    // requeued rather than left waiting for a human.
    assert.equal(moved?.status, 'PENDING');
  } finally {
    stop();
  }
});

test('a backend that never produced a turn is only set aside briefly (TIM-0009)', () => {
  resetBreakers();
  clearBackendCooldown('grok');
  const before = Date.now();
  bounceThreeTimes('grok');
  const unproven = dbApi.getBackendCooldown('grok');
  assert.equal(unproven?.kind, 'unavailable');
  // 5 min, not the 30 min of the setting: the tester who just fixed their
  // login or CLI version must be able to retry without rearming anything.
  assert.ok(unproven!.until - before <= 5 * 60_000 + 1000, `set aside too long: ${unproven!.until - before} ms`);

  // The same backend, once it has produced a turn, gets the full cooldown back.
  resetBreakers();
  clearBackendCooldown('grok');
  noteProductiveTurn('grok');
  bounceThreeTimes('grok');
  const proven = dbApi.getBackendCooldown('grok');
  assert.ok(proven!.until - before >= 25 * 60_000, `full cooldown expected: ${proven!.until - before} ms`);
});
