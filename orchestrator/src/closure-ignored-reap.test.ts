/**
 * TIM-0149: a task mission that ends a clean turn, ignores both closure
 * questions, then is reaped idle has finished its work. Its task closes
 * (verdict `unknown` for a review, which escalates) instead of being replayed
 * as a system death; every other death keeps the system-death path, a
 * `killed` that did not come from the idle reap included (manual kill, scope
 * stop, plugin kill, config reload).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-closure-ignored-test-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
process.env.TIMON_REAP_IDLE_MS = '60000';
process.env.TIMON_REAP_ORPHAN_GRACE_MS = '60000';

const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
const { watchMissionComplete, reconcileOrphanedTasks } = await import('./dispatcher.js');
const { askUnclosedTaskMission, handleTurnStarted } = await import('./wake.js');
const { parseReviewVerdict, runVerificationChain } = await import('./verification-loop.js');
const { killAgent, reapStaleMissions, upsertAgent } = await import('./agent.js');
const { stopScope } = await import('./scope-stop.js');
const { registerDialect, registerProfile } = await import('./backends/registry.js');
import type { Dialect } from './backends/types.js';

// A backend whose process ends with every turn: the reaper closes its idle
// autonomous missions from the row alone, no live process needed.
const oneShot: Dialect = {
  defaultCmd: 'true', persistentProcess: false, finishMissionOnExit: false,
  sessionResumable: false, sessionStore: 'global', permissionModel: 'none', rateLimitReporting: 'none', hostedConnectors: false,
  async buildSpawn() { throw new Error('never spawned here'); },
  writeUserInput() {},
  parseLine() { return []; },
  extractSessionId() { return null; },
};
registerDialect('closure-ignored-test', 'closure-ignored-one-shot', oneShot);
registerProfile('closure-ignored-test', {
  id: 'closure-ignored-one-shot', dialect: 'closure-ignored-one-shot', label: 'One shot', vendor: 'Test', custom: true,
  defaultModel: 'witness', models: [{ slug: 'witness', label: 'Witness' }],
});

const delivered = async (): Promise<string> => 'delivered';

function reviewMission(): { taskId: string; missionId: string } {
  const rootId = randomUUID();
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(rootId, 'feature', 'p.coder', { type: 'code' });
  dbApi.createTask(taskId, 'review feature', 'p.reviewer', { type: 'review' });
  dbApi.setTaskVerificationMeta(taskId, 1, rootId);
  dbApi.createMission(missionId, 'p.reviewer', 'review', { channel: 'dispatcher' });
  dbApi.setMissionLineage(missionId, { taskId });
  dbApi.assignTaskMission(taskId, missionId);
  return { taskId, missionId };
}

/** Each call stands for a clean `turn_complete` with the task still open. */
async function cleanTurnsEnd(missionId: string, turns: number, send = delivered): Promise<void> {
  for (let i = 0; i < turns; i++) await askUnclosedTaskMission(missionId, send);
}

/** What the reaper's idle paths do: confirm the mark, then end the mission `killed`. */
function reapedIdle(missionId: string): void {
  dbApi.confirmClosureIgnoredReap(missionId);
  killedBy(missionId);
}

/** A `killed` end the reaper did not confirm: a config reload, a workflow cancel, a failed backend switch. */
function killedBy(missionId: string): void {
  const reason = dbApi.finishMission(missionId, 'terminated', 0, 'killed');
  bus.publish({ kind: 'mission_complete', missionId, status: 'terminated', exitCode: 0, reason });
}

/** Replayed as a system death: requeued, the death counted, never auto-closed. */
function assertSystemDeath(taskId: string): void {
  const task = dbApi.getTask(taskId);
  assert.notEqual(task?.status, 'DONE');
  assert.doesNotMatch(task?.done_comment ?? '', /auto-closed by the orchestrator/);
}

test('a clean turn after two ignored questions, then an idle reap: DONE, verdict unknown, escalated', async () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = reviewMission();
    // Turn 1 ends → question 1; turn 2 ends → question 2; turn 3 ends: ignored.
    await cleanTurnsEnd(missionId, 3);
    assert.equal(dbApi.getMission(missionId)?.closure_ignored, 1);
    reapedIdle(missionId);
    const task = dbApi.getTask(taskId);
    assert.equal(task?.status, 'DONE');
    assert.match(task?.done_comment ?? '', /auto-closed by the orchestrator/);
    assert.equal(parseReviewVerdict(task?.done_comment ?? null).verdict, 'unknown');
    assert.equal(task?.requeue_count, 0);
    assert.equal(task?.interrupted_reason, null);
    // The existing unknown-verdict path escalates it: never a fabricated pass.
    if (task) await runVerificationChain(task);
    const escalated = dbApi.getTask(taskId);
    assert.equal(escalated?.status, 'BLOCKED');
    assert.match(escalated?.blocked_reason ?? '', /verdict not parsable/);
    assert.equal(dbApi.listTasks().some((t) => t.type === 'merge' && t.verification_root_id === task?.verification_root_id), false);
  } finally { stop(); }
});

test('a turn started after the ignored questions: the reap stays a system death', async () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = reviewMission();
    await cleanTurnsEnd(missionId, 3);
    // A new turn began and never ended cleanly before the process was killed.
    handleTurnStarted(missionId);
    assert.equal(dbApi.getMission(missionId)?.closure_ignored, 0);
    reapedIdle(missionId);
    const task = dbApi.getTask(taskId);
    // Replayed as a system death: requeued, and the death counted.
    assert.equal(task?.status, 'PENDING');
    assert.equal(task?.requeue_count, 1);
  } finally { stop(); }
});

test('a turn cut short (hung) after the ignored questions stays a system death', async () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = reviewMission();
    await cleanTurnsEnd(missionId, 3);
    const reason = dbApi.finishMission(missionId, 'failed', 1, 'timeout');
    bus.publish({ kind: 'mission_complete', missionId, status: 'failed', exitCode: 1, reason });
    const task = dbApi.getTask(taskId);
    assert.equal(task?.status, 'PENDING');
    assert.equal(task?.requeue_count, 1);
  } finally { stop(); }
});

test('a single question asked: the idle reap is unchanged', async () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = reviewMission();
    await cleanTurnsEnd(missionId, 1);
    assert.equal(dbApi.getMission(missionId)?.closure_ignored, 0);
    reapedIdle(missionId);
    const task = dbApi.getTask(taskId);
    // Replayed as a system death: requeued, and the death counted.
    assert.equal(task?.status, 'PENDING');
    assert.equal(task?.requeue_count, 1);
  } finally { stop(); }
});

test('questions that never reached the agent were not ignored', async () => {
  const { missionId } = reviewMission();
  await cleanTurnsEnd(missionId, 3, async () => 'queued');
  assert.equal(dbApi.getMission(missionId)?.closure_ignored, 0);
});

test('reconciliation at boot reads the mark the same way', async () => {
  const { taskId, missionId } = reviewMission();
  await cleanTurnsEnd(missionId, 3);
  // The daemon stopped before the mission_complete event was handled.
  dbApi.confirmClosureIgnoredReap(missionId);
  dbApi.finishMission(missionId, 'terminated', 0, 'killed');
  await reconcileOrphanedTasks();
  const task = dbApi.getTask(taskId);
  assert.equal(task?.status, 'DONE');
  assert.equal(parseReviewVerdict(task?.done_comment ?? null).verdict, 'unknown');
  assert.equal(task?.requeue_count, 0);
});

test('reconciliation at boot: a kill the reaper did not confirm stays a system death', async () => {
  const { taskId, missionId } = reviewMission();
  await cleanTurnsEnd(missionId, 3);
  dbApi.finishMission(missionId, 'terminated', 0, 'killed');
  await reconcileOrphanedTasks();
  assertSystemDeath(taskId);
});

test('the reaper itself: an idle one-shot task mission that ignored its questions closes its task', async () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = reviewMission();
    dbApi.setMissionLlmOverrides(missionId, 'closure-ignored-one-shot', 'witness');
    await cleanTurnsEnd(missionId, 3);
    const now = Date.now() + 10 * 60_000; // past the idle threshold and the orphan grace
    reapStaleMissions([], now);
    assert.equal(dbApi.getMission(missionId)?.status, 'terminated');
    assert.equal(dbApi.getMission(missionId)?.closure_ignored, 2, 'confirmed by the reap');
    assert.equal(dbApi.getTask(taskId)?.status, 'DONE');
    assert.equal(dbApi.getTask(taskId)?.requeue_count, 0);
  } finally { stop(); }
});

test('a manual kill (DELETE /api/missions/:id, a plugin missions.kill) stays a system death', async () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = reviewMission();
    await cleanTurnsEnd(missionId, 3);
    assert.equal(killAgent(missionId, { source: 'DELETE /api/missions/:id' }), 'closed');
    assert.equal(dbApi.getMission(missionId)?.interrupted_reason, 'killed');
    assert.equal(dbApi.getMission(missionId)?.closure_ignored, 1, 'never confirmed');
    assertSystemDeath(taskId);
  } finally { stop(); }
});

test('a scope stop stays a system death', async () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = reviewMission();
    await cleanTurnsEnd(missionId, 3);
    upsertAgent({
      name: 'p.reviewer', system_prompt: 'witness',
      config: { backend: 'claude', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
    });
    const report = stopScope({ agent: 'p.reviewer' }, { owner: undefined, by: 'test' });
    assert.ok(report.missions.some((m) => m.id === missionId));
    assert.equal(dbApi.getMission(missionId)?.interrupted_reason, 'killed');
    assertSystemDeath(taskId);
    // The stop blocks the task itself, before the kill: the person's verdict stands.
    assert.equal(dbApi.getTask(taskId)?.status, 'BLOCKED');
    assert.match(dbApi.getTask(taskId)?.blocked_reason ?? '', /Stopped by test/);
  } finally { stop(); }
});

test('a config reload or any other unconfirmed kill stays a system death', async () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = reviewMission();
    await cleanTurnsEnd(missionId, 3);
    killedBy(missionId);
    const task = dbApi.getTask(taskId);
    assert.equal(task?.status, 'PENDING');
    assert.equal(task?.requeue_count, 1);
  } finally { stop(); }
});

test('the resource guard (an OOM kill ends `crash`) stays a system death, even after a confirmed reap', async () => {
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId } = reviewMission();
    await cleanTurnsEnd(missionId, 3);
    dbApi.confirmClosureIgnoredReap(missionId);
    const reason = dbApi.finishMission(missionId, 'failed', 137, 'crash');
    bus.publish({ kind: 'mission_complete', missionId, status: 'failed', exitCode: 137, reason });
    assertSystemDeath(taskId);
  } finally { stop(); }
});

test('a new turn clears a confirmed mark too', async () => {
  const { missionId } = reviewMission();
  await cleanTurnsEnd(missionId, 3);
  dbApi.confirmClosureIgnoredReap(missionId);
  handleTurnStarted(missionId);
  assert.equal(dbApi.getMission(missionId)?.closure_ignored, 0);
});
