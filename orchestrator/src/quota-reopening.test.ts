/**
 * A task stopped by a usage limit waits for the announced reopening, then leaves
 * on its own (TIM-0134).
 *
 * The chronology is the tester's: limit reached around 01:30, reopening announced
 * for 03:50, a pilot on the same dry account. Their report says the retries fell
 * before 03:50 and ate the requeue budget, and that the series then sat still
 * until 08:51. Their daemon log was never read, so each test below pins down one
 * path the code really has to that outcome, not THE cause of that night.
 *
 * The clock is simulated (`Date` only): the deaths, the backoffs and the registry
 * all read the same time, so a night fits in a few milliseconds.
 */
import '../tests/helpers/no-load-gate.js';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-quota-reopening-test-'));
process.env.TIMON_FALLBACK_ENABLED = '1';
process.env.TIMON_FALLBACK_BACKEND = '';
process.env.TIMON_FALLBACK_MODEL = '';
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { dbApi } = await import('./db.js');
const { mountOfficialProviders, stubCliBinaries, stubCodexSignIn } = await import('../tests/helpers/official-providers.js');
// A fallback goes only to a CLI that is on this host and signed in: stand-ins, never the machine's own.
await stubCliBinaries('grok', 'codex', 'claude');
await stubCodexSignIn();
await mountOfficialProviders();
const { bus } = await import('./bus.js');
const { clearBackendCooldown, noteBackendRateLimit } = await import('./backend-fallback.js');
const { reconcileOrphanedTasks, requeueBackendBlockedTasks, resetBackendRequeues, startDispatcher, watchMissionComplete } = await import('./dispatcher.js');
const { redirectIfStillDry } = await import('./backend-fallback.js');
const { RECHECK_INTERVAL_MS, setUsageProbeForTest } = await import('./backend-recheck.js');
const { MAX_BLIND_QUOTA_DEATHS, MAX_SYSTEM_REQUEUES } = await import('./db.js');
const { upsertAgent } = await import('./agent.js');
const { QUOTA_REOPEN_MARGIN_MS } = await import('./interruption.js');
const { bestRateLimit } = await import('./rate-limit.js');

const MINUTE = 60_000;
const night = (hhmm: string): number => new Date(`2026-10-31T${hhmm}:00`).getTime();
const setClock = (at: number): void => mock.timers.setTime(at);

const REOPENS = night('03:50');
const LEAVES = REOPENS + QUOTA_REOPEN_MARGIN_MS;

const quotaEvent = (status: 'queued' | 'rejected', resetsAt = REOPENS) => ({
  type: 'rate_limit_event',
  rate_limit_info: { status, rateLimitType: 'five_hour', resetsAt: Math.floor(resetsAt / 1000) },
});

let stopWatching: () => void = () => {};

beforeEach(() => {
  mock.timers.enable({ apis: ['Date'], now: night('01:30') });
  resetBackendRequeues();
  clearBackendCooldown('grok');
  clearBackendCooldown('codex');
  for (const status of ['BLOCKED', 'PENDING', 'IN_PROGRESS'] as const) {
    for (const t of dbApi.listTasks(status)) dbApi.updateTaskStatus(t.id, 'DONE', {});
  }
  stopWatching = watchMissionComplete();
});

afterEach(() => {
  stopWatching();
  setUsageProbeForTest(null);
  mock.timers.reset();
});

after(() => mock.timers.reset());

/** A task on grok with a live mission. `fallback` defaults to refusing every
 *  fallback: only a reopening can move it. */
function runningTask(opts: { fallback?: string; seriesId?: string; pilotId?: string } = {}): { taskId: string; missionId: string } {
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, 'night volet', 'p.coder', {
    type: 'code',
    backendOverride: 'grok',
    modelOverride: 'grok-4.6',
    fallbackBackendOverride: opts.fallback ?? 'none',
    ...(opts.seriesId ? { seriesId: opts.seriesId } : {}),
    ...(opts.pilotId ? { creatorMissionId: opts.pilotId } : {}),
  });
  dbApi.createMission(missionId, 'p.coder', 'night volet');
  dbApi.setMissionLlmOverrides(missionId, 'grok', 'grok-4.6');
  dbApi.assignTaskMission(taskId, missionId);
  return { taskId, missionId };
}

/** What `agent.ts` does when the process goes: finalise, publish the EFFECTIVE cause. */
function die(
  missionId: string,
  status: 'failed' | 'terminated' | 'completed',
  guess: 'killed' | 'timeout' | 'crash' | 'rate_limit' | null,
): void {
  const reason = dbApi.finishMission(missionId, status, status === 'completed' ? 0 : 1, guess);
  bus.publish({ kind: 'mission_complete', missionId, status, exitCode: status === 'completed' ? 0 : 1, reason });
}

/** What the dispatcher could spawn at this minute. */
const ready = (id: string): boolean => dbApi.listPendingReady().some((t) => t.id === id);

/** Runs the dispatcher's requeue minute by minute over [from, to), and fails on
 *  the first minute the task could have been spawned. */
function noSpawnBetween(id: string, from: number, to: number): void {
  for (let t = from; t < to; t += MINUTE) {
    setClock(t);
    requeueBackendBlockedTasks();
    const task = dbApi.getTask(id);
    assert.equal(
      ready(id), false,
      `spawnable at ${new Date(t).toTimeString().slice(0, 5)}, before the reopening `
      + `(status ${task?.status}, requeue_count ${task?.requeue_count})`,
    );
  }
}

test('a queued request reaped as idle waits for the announced reopening, without eating the budget', () => {
  const { taskId, missionId } = runningTask();
  dbApi.insertEvent(missionId, 'rate_limit_event', quotaEvent('queued'));

  // The reaper finalises some 12 minutes later, and the cause it guesses says
  // nothing about the quota.
  setClock(night('01:42'));
  die(missionId, 'terminated', 'killed');

  const blocked = dbApi.getTask(taskId);
  assert.equal(blocked?.status, 'BLOCKED');
  assert.equal(blocked?.interrupted_reason, 'rate_limit');
  assert.equal(blocked?.requeue_count, 0, 'a quota wall says nothing about the task');
  assert.equal(blocked?.quota_resets_at, REOPENS);
  assert.match(blocked?.blocked_reason ?? '', /five_hour/);

  // A queued hit recorded nothing while the turn could still succeed. Now that
  // the mission is dead, the rest of Timon must know too.
  const cooldown = dbApi.getBackendCooldown('grok');
  assert.equal(cooldown?.until, REOPENS);
  assert.equal(cooldown?.exact, 1);

  noSpawnBetween(taskId, night('01:43'), LEAVES);

  setClock(LEAVES);
  assert.equal(requeueBackendBlockedTasks(), 1);
  const task = dbApi.getTask(taskId);
  assert.equal(task?.status, 'PENDING');
  assert.equal(task?.requeue_count, 0);
  assert.equal(task?.quota_resets_at, null);
  assert.equal(ready(taskId), true);
});

test('a hung reap and a crash on a queued request read the same', () => {
  for (const guess of ['timeout', 'crash'] as const) {
    clearBackendCooldown('grok');
    resetBackendRequeues();
    setClock(night('01:30'));
    const { taskId, missionId } = runningTask();
    dbApi.insertEvent(missionId, 'rate_limit_event', quotaEvent('queued'));
    setClock(night('02:15'));
    die(missionId, 'failed', guess);
    const task = dbApi.getTask(taskId);
    assert.equal(task?.interrupted_reason, 'rate_limit', guess);
    assert.equal(task?.requeue_count, 0, guess);
    noSpawnBetween(taskId, night('02:16'), LEAVES);
    dbApi.updateTaskStatus(taskId, 'DONE', {});
  }
});

test('a death on a backend known dry does not eat the budget either, and takes its reopening from the registry', () => {
  noteBackendRateLimit('grok', { kind: 'rate_limit', window: 'five_hour', resetsAt: REOPENS, source: 'event', pending: false });
  const { taskId, missionId } = runningTask();
  // Nothing in this mission's own stream: it hung on a wall another mission saw.
  dbApi.insertEvent(missionId, 'system', { type: 'system', subtype: 'init' });
  setClock(night('02:30'));
  die(missionId, 'failed', 'timeout');

  const task = dbApi.getTask(taskId);
  assert.equal(task?.status, 'BLOCKED');
  assert.equal(task?.interrupted_reason, 'rate_limit');
  assert.equal(task?.requeue_count, 0);
  assert.equal(task?.quota_resets_at, REOPENS);
  noSpawnBetween(taskId, night('02:31'), LEAVES);
  setClock(LEAVES);
  assert.equal(requeueBackendBlockedTasks(), 1);
});

test('a limit announced at the time of death is held for the margin past its reopening', () => {
  const { taskId, missionId } = runningTask();
  noteBackendRateLimit('grok', { kind: 'rate_limit', window: 'five_hour', resetsAt: REOPENS, source: 'event', pending: false });
  dbApi.insertEvent(missionId, 'rate_limit_event', quotaEvent('rejected'));
  die(missionId, 'failed', 'rate_limit');

  // The registry purges the exclusion at its time; the provider's clock is not ours.
  setClock(REOPENS + 1000);
  assert.equal(requeueBackendBlockedTasks(), 0);
  assert.equal(dbApi.getTask(taskId)?.status, 'BLOCKED');
  setClock(LEAVES);
  assert.equal(requeueBackendBlockedTasks(), 1);
});

test('an estimate written before the reopening does not hold the task past it: the pilot on the same account', async () => {
  const seriesId = randomUUID();
  const pilotId = randomUUID();
  dbApi.createMission(pilotId, 'p.main', 'pilot of the series');
  dbApi.setMissionLlmOverrides(pilotId, 'grok', 'grok-4.6');
  dbApi.setSeriesFallback(seriesId, 'code', null, null);
  const { taskId, missionId } = runningTask({ seriesId, pilotId });
  dbApi.insertEvent(missionId, 'rate_limit_event', quotaEvent('queued'));

  setClock(night('03:01'));
  die(missionId, 'terminated', 'killed');
  assert.equal(dbApi.getTask(taskId)?.status, 'BLOCKED');

  // The pilot is woken on the same dry account and dies of a 429 that names no
  // time. Without an exact row in the way, that estimate says 08:01.
  clearBackendCooldown('grok');
  noteBackendRateLimit('grok', { kind: 'rate_limit', window: null, resetsAt: null, source: 'status', pending: false });
  dbApi.finishMission(pilotId, 'failed', 1, 'rate_limit');
  assert.equal(dbApi.getBackendCooldown('grok')?.exact, 0);
  await new Promise((resolve) => setTimeout(resolve, 20));

  noSpawnBetween(taskId, night('03:30'), LEAVES);
  setClock(LEAVES);
  assert.equal(requeueBackendBlockedTasks(), 1, 'the series leaves with nobody awake');
  assert.equal(dbApi.getTask(taskId)?.status, 'PENDING');
  assert.equal(dbApi.getMission(pilotId)?.status, 'failed', 'and the pilot was not needed for it');
});

test('an estimate written after the reopening is fresh evidence: the task keeps waiting', () => {
  const { taskId, missionId } = runningTask();
  dbApi.insertEvent(missionId, 'rate_limit_event', quotaEvent('queued'));
  setClock(night('02:00'));
  die(missionId, 'terminated', 'killed');
  clearBackendCooldown('grok');

  setClock(night('03:55'));
  noteBackendRateLimit('grok', { kind: 'rate_limit', window: null, resetsAt: null, source: 'status', pending: false });
  setClock(night('03:58'));
  assert.equal(requeueBackendBlockedTasks(), 0);
  assert.equal(dbApi.getTask(taskId)?.status, 'BLOCKED');
});

test('a later reset the provider announced keeps the task until that one', () => {
  const { taskId, missionId } = runningTask();
  dbApi.insertEvent(missionId, 'rate_limit_event', quotaEvent('queued'));
  setClock(night('02:00'));
  die(missionId, 'terminated', 'killed');
  // What the usage probe writes when another window turns out to be full.
  const later = night('06:00');
  dbApi.setBackendCooldown('grok', later, 'seven_day', true, 'rate_limit');

  noSpawnBetween(taskId, LEAVES, later);
  setClock(later + QUOTA_REOPEN_MARGIN_MS);
  assert.equal(requeueBackendBlockedTasks(), 1);
});

test('a reopening seen early wins once; a second wall on the same limit waits for the announced time', () => {
  const { taskId, missionId } = runningTask();
  dbApi.insertEvent(missionId, 'rate_limit_event', quotaEvent('queued'));
  setClock(night('01:42'));
  die(missionId, 'terminated', 'killed');

  // The usage probe, or a turn that succeeded elsewhere (TIM-0122): observation
  // beats the announced time.
  setClock(night('02:10'));
  clearBackendCooldown('grok');
  assert.equal(requeueBackendBlockedTasks(), 1);
  assert.equal(dbApi.getTask(taskId)?.status, 'PENDING');

  // It was wrong: the next run falls on the same limit.
  const second = randomUUID();
  dbApi.createMission(second, 'p.coder', 'night volet');
  dbApi.setMissionLlmOverrides(second, 'grok', 'grok-4.6');
  dbApi.assignTaskMission(taskId, second);
  dbApi.insertEvent(second, 'rate_limit_event', quotaEvent('rejected'));
  setClock(night('02:12'));
  die(second, 'failed', 'rate_limit');
  assert.equal(dbApi.getTask(taskId)?.requeue_count, 0);

  // The probe says open again: this task does not walk back into the wall.
  clearBackendCooldown('grok');
  noSpawnBetween(taskId, night('02:13'), LEAVES);

  // The exponential backoff of a limit that left no time does not apply here.
  setClock(LEAVES);
  assert.equal(requeueBackendBlockedTasks(), 1);
});

test('blocked again just before the reopening, a task leaves at the announced time, not after a longer backoff', () => {
  const { taskId, missionId } = runningTask();
  dbApi.insertEvent(missionId, 'rate_limit_event', quotaEvent('queued'));
  setClock(night('01:42'));
  die(missionId, 'terminated', 'killed');
  setClock(night('02:10'));
  clearBackendCooldown('grok');
  assert.equal(requeueBackendBlockedTasks(), 1);

  // Its second block is 3 min old at LEAVES; a limit with no time would wait 4.
  const second = randomUUID();
  dbApi.createMission(second, 'p.coder', 'night volet');
  dbApi.setMissionLlmOverrides(second, 'grok', 'grok-4.6');
  dbApi.assignTaskMission(taskId, second);
  dbApi.insertEvent(second, 'rate_limit_event', quotaEvent('rejected'));
  setClock(LEAVES - 3 * MINUTE);
  die(second, 'failed', 'rate_limit');
  assert.equal(dbApi.getTask(taskId)?.quota_resets_at, REOPENS);

  setClock(LEAVES);
  assert.equal(requeueBackendBlockedTasks(), 1);
});

test('a workable fallback does not wait for the reopening', () => {
  const { taskId, missionId } = runningTask({ fallback: 'codex' });
  dbApi.insertEvent(missionId, 'rate_limit_event', quotaEvent('queued'));
  setClock(night('01:42'));
  die(missionId, 'terminated', 'killed');
  assert.equal(dbApi.getTask(taskId)?.status, 'BLOCKED');

  setClock(night('01:45'));
  assert.equal(requeueBackendBlockedTasks(), 1);
  assert.equal(dbApi.getTask(taskId)?.status, 'PENDING');
  assert.equal(dbApi.getTask(taskId)?.quota_resets_at, null);
});

test('the announced reopening survives a daemon restart', () => {
  const { taskId, missionId } = runningTask();
  dbApi.insertEvent(missionId, 'rate_limit_event', quotaEvent('queued'));
  setClock(night('01:42'));
  die(missionId, 'terminated', 'killed');

  setClock(night('02:00'));
  resetBackendRequeues();
  assert.equal(requeueBackendBlockedTasks(), 0);
  setClock(LEAVES);
  assert.equal(requeueBackendBlockedTasks(), 1);
});

test('a spawn refused on a dry backend is a quota block, not three crashes', async () => {
  upsertAgent({
    name: 'p.dry',
    system_prompt: 'witness — does nothing.',
    config: { backend: 'grok', model: 'grok-4.6', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
  });
  noteBackendRateLimit('grok', { kind: 'rate_limit', window: 'five_hour', resetsAt: REOPENS, source: 'event', pending: false });
  const taskId = randomUUID();
  dbApi.createTask(taskId, 'next volet', 'p.dry', {
    type: 'chore', backendOverride: 'grok', modelOverride: 'grok-4.6', fallbackBackendOverride: 'none',
  });

  // Enough ticks to reach the 3 spawn failures that end as a `crash`.
  stopWatching();
  const stop = startDispatcher(30);
  try {
    await new Promise((resolve) => setTimeout(resolve, 500));
  } finally {
    stop();
  }

  const task = dbApi.getTask(taskId);
  assert.equal(task?.status, 'BLOCKED');
  assert.equal(task?.interrupted_reason, 'rate_limit');
  assert.equal(task?.requeue_count, 0);
  assert.equal(task?.quota_resets_at, REOPENS);
  assert.equal(task?.mission_id, null);
  noSpawnBetween(taskId, night('01:40'), LEAVES);
  setClock(LEAVES);
  assert.equal(requeueBackendBlockedTasks(), 1);
  assert.equal(dbApi.getTask(taskId)?.status, 'PENDING');
});

// ── Who serves as the probe when the probe is silent (TODO #738) ────────────

/** A task nobody started yet on a witness agent, on sidelined grok, past the
 *  interval in which the failure that recorded the exclusion stays the proof. */
function pendingOnSilentlySidelinedGrok(fallback: string): string {
  upsertAgent({
    name: 'p.witness',
    system_prompt: 'witness — does nothing.',
    config: { backend: 'grok', model: 'grok-4.6', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
  });
  setUsageProbeForTest(async () => null);
  sidelineGrok();
  setClock(night('01:30') + RECHECK_INTERVAL_MS + 1000);
  const taskId = randomUUID();
  dbApi.createTask(taskId, 'next volet', 'p.witness', {
    type: 'chore', backendOverride: 'grok', modelOverride: 'grok-4.6', fallbackBackendOverride: fallback,
  });
  return taskId;
}

/** The backend the dispatcher really launches the task's first mission on. */
async function backendSpawnedFor(taskId: string): Promise<string | null | undefined> {
  stopWatching();
  const stop = startDispatcher(30);
  try {
    for (let i = 0; i < 150; i++) {
      const [mission] = dbApi.listMissionsByTask(taskId);
      if (mission) return mission.backend_override;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  } finally {
    stop();
  }
  return assert.fail(`no mission for the task (status ${dbApi.getTask(taskId)?.status})`);
}

test('a silent probe does not send a task with a workable fallback to the sidelined backend', async () => {
  const taskId = pendingOnSilentlySidelinedGrok('codex');
  assert.equal(await backendSpawnedFor(taskId), 'codex');
  assert.ok(dbApi.getBackendCooldown('grok'), 'nothing tested grok, so nothing lifted its exclusion');
});

test('a task with no fallback still serves as the test (decision of 2026-10-18)', async () => {
  const taskId = pendingOnSilentlySidelinedGrok('none');
  assert.equal(await backendSpawnedFor(taskId), 'grok');
});

test('a task requeued on its fallback leaves on it, as the log announces', async () => {
  const warnings = mock.method(console, 'warn', () => {});
  try {
    const taskId = pendingOnSilentlySidelinedGrok('codex');
    dbApi.setTaskInterrupted(taskId, 'rate_limit', 'Mission interrupted (rate_limit)');
    setClock(night('02:00'));
    assert.equal(requeueBackendBlockedTasks(), 1);
    const said = warnings.mock.calls.map((call) => String(call.arguments[0]));
    assert.ok(said.some((line) => line.includes(taskId) && line.includes('it leaves on its fallback')), said.join('\n'));
    assert.equal(await backendSpawnedFor(taskId), 'codex');
  } finally {
    warnings.mock.restore();
  }
});

test('past the announced reopening, an estimate still standing: the log names the fallback the spawn takes', async () => {
  const warnings = mock.method(console, 'warn', () => {});
  try {
    const taskId = pendingOnSilentlySidelinedGrok('codex');
    // Its fallback was dry too when it stopped, so only the reopening could move it.
    dbApi.setBackendCooldown('codex', night('03:00'), 'five_hour', true, 'rate_limit');
    dbApi.setTaskInterrupted(taskId, 'rate_limit', 'Mission interrupted (rate_limit)', REOPENS);
    clearBackendCooldown('grok');
    noteBackendRateLimit('grok', { kind: 'rate_limit', window: null, resetsAt: null, source: 'status', pending: false });
    assert.equal(dbApi.getBackendCooldown('grok')?.exact, 0);

    setClock(LEAVES);
    assert.equal(requeueBackendBlockedTasks(), 1);
    const said = warnings.mock.calls.map((call) => String(call.arguments[0]));
    assert.ok(said.some((line) => line.includes(taskId) && line.includes('it leaves on its fallback')), said.join('\n'));
  } finally {
    warnings.mock.restore();
  }
});

test('a probe that answers still settles it: open means the task keeps its own backend', async () => {
  const taskId = pendingOnSilentlySidelinedGrok('codex');
  setUsageProbeForTest(async () => ({ state: 'open' }));
  assert.equal(await backendSpawnedFor(taskId), 'grok');
  assert.equal(dbApi.getBackendCooldown('grok'), undefined);
});

test('a pilot keeps its trial: only a task gives it up', async () => {
  setUsageProbeForTest(async () => null);
  sidelineGrok();
  setClock(night('01:30') + RECHECK_INTERVAL_MS + 1000);
  assert.equal(await redirectIfStillDry('grok', { seriesId: null, scope: 'orchestrator', fromModel: 'grok-4.6' }), null);
});

// ── What must NOT be read as a quota wall ───────────────────────────────────

test('a queued request the provider then served is not a death', () => {
  const answered = [
    ['assistant', { type: 'assistant', message: { content: [{ type: 'text', text: 'back' }] } }],
    ['result', { type: 'result', is_error: false }],
    ['rate_limit_event', { type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: Math.floor(REOPENS / 1000) } }],
  ] as const;
  for (const [type, payload] of answered) {
    clearBackendCooldown('grok');
    const { taskId, missionId } = runningTask();
    dbApi.insertEvent(missionId, 'rate_limit_event', quotaEvent('queued'));
    dbApi.insertEvent(missionId, type, payload);
    die(missionId, 'terminated', 'killed');
    const task = dbApi.getTask(taskId);
    assert.equal(task?.status, 'PENDING', type);
    assert.equal(task?.requeue_count, 1, type);
    assert.equal(dbApi.getBackendCooldown('grok'), undefined, type);
    dbApi.updateTaskStatus(taskId, 'DONE', {});
  }
});

test('a queued request whose reopening is already past says nothing any more', () => {
  const { taskId, missionId } = runningTask();
  dbApi.insertEvent(missionId, 'rate_limit_event', quotaEvent('queued', night('01:40')));
  setClock(night('01:42'));
  die(missionId, 'terminated', 'killed');
  assert.equal(dbApi.getTask(taskId)?.status, 'PENDING');
  assert.equal(dbApi.getTask(taskId)?.requeue_count, 1);
});

test('an ordinary crash on a backend with quota keeps its replay and its count', () => {
  const { taskId, missionId } = runningTask();
  dbApi.insertEvent(missionId, 'system', { type: 'system', subtype: 'init' });
  die(missionId, 'failed', 'crash');
  const task = dbApi.getTask(taskId);
  assert.equal(task?.status, 'PENDING');
  assert.equal(task?.requeue_count, 1);
});

test('only a quota window requalifies a death: a breaker or a dry account does not promise a reopening', () => {
  for (const kind of ['unavailable', 'exhausted'] as const) {
    dbApi.setBackendCooldown('grok', night('05:00'), kind, false, kind);
    const { taskId, missionId } = runningTask();
    dbApi.insertEvent(missionId, 'system', { type: 'system', subtype: 'init' });
    die(missionId, 'failed', 'crash');
    const task = dbApi.getTask(taskId);
    assert.equal(task?.status, 'PENDING', kind);
    assert.equal(task?.requeue_count, 1, kind);
    dbApi.updateTaskStatus(taskId, 'DONE', {});
    clearBackendCooldown('grok');
  }
});

// ── A real crash during an exclusion ────────────────────────────────────────

const FAR_REOPENING = night('23:00');

const sidelineGrok = (): void => noteBackendRateLimit('grok', {
  kind: 'rate_limit', window: 'five_hour', resetsAt: FAR_REOPENING, source: 'event', pending: false,
});

/** A new run of the task, whose process dies with nothing about quota in its stream. */
function diesWithoutSaying(taskId: string, guess: 'killed' | 'timeout' | 'crash' = 'crash'): void {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'p.coder', 'night volet');
  dbApi.setMissionLlmOverrides(missionId, 'grok', 'grok-4.6');
  dbApi.assignTaskMission(taskId, missionId);
  dbApi.insertEvent(missionId, 'system', { type: 'system', subtype: 'init' });
  die(missionId, 'failed', guess);
}

test('a task that crashes in a loop during an exclusion ends up blocked as a crash, not replayed forever', () => {
  // The fallback workable at the requeue is gone by the spawn, or the task would
  // leave on it (TODO #738). With no usage answer that spawn is the test, once per
  // interval, so the exclusion does not stop this mission from starting.
  setUsageProbeForTest(async () => null);
  sidelineGrok();
  const { taskId } = runningTask({ fallback: 'codex' });
  let clock = night('01:30');
  const WAIT = 16 * MINUTE; // past the longest backoff
  const LOOP_LIMIT = 20;

  let deaths = 0;
  while (deaths < LOOP_LIMIT) {
    diesWithoutSaying(taskId);
    deaths++;
    if (deaths <= MAX_BLIND_QUOTA_DEATHS) {
      assert.equal(dbApi.getTask(taskId)?.interrupted_reason, 'rate_limit', `death ${deaths}`);
      assert.equal(dbApi.getTask(taskId)?.requeue_count, 0, `death ${deaths}`);
    }
    clock += WAIT;
    setClock(clock);
    requeueBackendBlockedTasks();
    const task = dbApi.getTask(taskId);
    if (task?.status === 'BLOCKED') break;
    assert.equal(ready(taskId), true, `death ${deaths}: status ${task?.status}`);
  }
  assert.ok(deaths < LOOP_LIMIT, `still replayed after ${deaths} deaths`);
  assert.ok(clock < FAR_REOPENING, 'stopped by the bound, not by the end of the exclusion');

  const task = dbApi.getTask(taskId);
  assert.equal(task?.status, 'BLOCKED');
  assert.equal(task?.interrupted_reason, 'crash');
  assert.equal(task?.quota_resets_at, null);
  assert.equal(task?.requeue_count, MAX_SYSTEM_REQUEUES + 1);
  assert.equal(deaths, MAX_BLIND_QUOTA_DEATHS + MAX_SYSTEM_REQUEUES + 1);

  // Neither the fallback nor the reopening picks it up: it waits for a decision.
  setClock(FAR_REOPENING + QUOTA_REOPEN_MARGIN_MS);
  clearBackendCooldown('grok');
  assert.equal(requeueBackendBlockedTasks(), 0);
  assert.equal(dbApi.getTask(taskId)?.status, 'BLOCKED');
});

test('every guess the exclusion requalifies spends the same allowance, and it survives a restart', () => {
  sidelineGrok();
  const { taskId } = runningTask();
  const guesses = ['killed', 'timeout', 'crash'] as const;
  for (let i = 0; i < MAX_BLIND_QUOTA_DEATHS; i++) {
    diesWithoutSaying(taskId, guesses[i % guesses.length]);
    assert.equal(dbApi.getTask(taskId)?.interrupted_reason, 'rate_limit');
    assert.equal(dbApi.getTask(taskId)?.blind_quota_deaths, i + 1);
    resetBackendRequeues();
    assert.equal(dbApi.requeueBackendBlockedTask(taskId), true);
  }
  diesWithoutSaying(taskId, 'timeout');
  const task = dbApi.getTask(taskId);
  assert.equal(task?.status, 'PENDING', 'its own budget now applies');
  assert.equal(task?.requeue_count, 1);
  assert.equal(task?.blind_quota_deaths, MAX_BLIND_QUOTA_DEATHS);
});

test('a wall in the mission\'s own stream never spends that allowance', () => {
  const { taskId } = runningTask();
  for (let i = 0; i < MAX_BLIND_QUOTA_DEATHS + 2; i++) {
    const missionId = randomUUID();
    dbApi.createMission(missionId, 'p.coder', 'night volet');
    dbApi.setMissionLlmOverrides(missionId, 'grok', 'grok-4.6');
    dbApi.assignTaskMission(taskId, missionId);
    dbApi.insertEvent(missionId, 'rate_limit_event', quotaEvent('rejected', FAR_REOPENING));
    die(missionId, 'failed', 'crash');
    const task = dbApi.getTask(taskId);
    assert.equal(task?.interrupted_reason, 'rate_limit');
    assert.equal(task?.quota_resets_at, FAR_REOPENING);
    assert.equal(task?.requeue_count, 0);
    assert.equal(task?.blind_quota_deaths, 0);
    assert.equal(dbApi.requeueBackendBlockedTask(taskId), true);
  }
});

test('a wall the stream reports just after the finalisation is an observation too', () => {
  sidelineGrok();
  const { taskId, missionId } = runningTask();
  // The cause was settled before this event landed: the death arrives as a crash.
  const reason = dbApi.finishMission(missionId, 'failed', 1, 'crash');
  assert.equal(reason, 'crash');
  dbApi.insertEvent(missionId, 'rate_limit_event', quotaEvent('rejected', FAR_REOPENING));
  bus.publish({ kind: 'mission_complete', missionId, status: 'failed', exitCode: 1, reason });

  const task = dbApi.getTask(taskId);
  assert.equal(task?.interrupted_reason, 'rate_limit');
  assert.equal(task?.blind_quota_deaths, 0);
});

test('a human restart gives the allowance back', () => {
  sidelineGrok();
  const { taskId } = runningTask();
  for (let i = 0; i < MAX_BLIND_QUOTA_DEATHS; i++) {
    diesWithoutSaying(taskId);
    assert.equal(dbApi.requeueBackendBlockedTask(taskId), true);
  }
  dbApi.resetTaskRequeues(taskId);
  assert.equal(dbApi.getTask(taskId)?.blind_quota_deaths, 0);
  diesWithoutSaying(taskId);
  assert.equal(dbApi.getTask(taskId)?.interrupted_reason, 'rate_limit');
});

test('the orphan path applies the same bound as the live one', async () => {
  stopWatching();
  sidelineGrok();
  const { taskId } = runningTask();
  const orphan = (): void => {
    const missionId = randomUUID();
    dbApi.createMission(missionId, 'p.coder', 'night volet');
    dbApi.setMissionLlmOverrides(missionId, 'grok', 'grok-4.6');
    dbApi.assignTaskMission(taskId, missionId);
    dbApi.finishMission(missionId, 'failed', 1, 'crash');
  };
  for (let i = 0; i < MAX_BLIND_QUOTA_DEATHS; i++) {
    orphan();
    await reconcileOrphanedTasks();
    assert.equal(dbApi.getTask(taskId)?.interrupted_reason, 'rate_limit');
    assert.equal(dbApi.requeueBackendBlockedTask(taskId), true);
  }
  orphan();
  await reconcileOrphanedTasks();
  const task = dbApi.getTask(taskId);
  assert.equal(task?.status, 'PENDING');
  assert.equal(task?.requeue_count, 1);
});

test('a quota notice printed as the answer of a clean turn stops the task until the reopening it names', () => {
  // Antigravity, 2026-11-21: the CLI does not fail the turn, it ends it normally
  // with the provider's notice for an answer. Read as a success, the task waited
  // for the idle reaper and closed with no work done.
  const { taskId, missionId } = runningTask();
  const notice = '\n⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h20m0s.\n';
  dbApi.insertEvent(missionId, 'assistant', { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: notice }] } });
  const result = {
    type: 'result', subtype: 'success', is_error: false, result: notice, stop_reason: 'end_turn', total_cost_usd: 0,
  };
  // What the live stream does with each event (`processEvent`, agent.ts): the
  // account is sidelined for every mission, not only this one.
  const hit = bestRateLimit([{ type: 'result', payload: result }], { includePending: true });
  assert.equal(hit?.resetsAt, REOPENS);
  if (hit) noteBackendRateLimit('grok', hit);
  dbApi.insertEvent(missionId, 'result', result);

  // The reaper finalises some 12 minutes later: the duration is counted from the
  // notice, not from then.
  setClock(night('01:42'));
  die(missionId, 'terminated', 'killed');

  const blocked = dbApi.getTask(taskId);
  assert.equal(blocked?.status, 'BLOCKED');
  assert.equal(blocked?.interrupted_reason, 'rate_limit');
  assert.equal(blocked?.requeue_count, 0);
  assert.equal(blocked?.quota_resets_at, REOPENS);
  assert.equal(dbApi.getBackendCooldown('grok')?.until, REOPENS);

  noSpawnBetween(taskId, night('01:43'), LEAVES);
  setClock(LEAVES);
  assert.equal(requeueBackendBlockedTasks(), 1);
  assert.equal(dbApi.getTask(taskId)?.status, 'PENDING');
});
