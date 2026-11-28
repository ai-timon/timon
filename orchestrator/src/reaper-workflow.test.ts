import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as tick } from 'node:timers/promises';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

const MIN = 60_000;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
process.env.TIMON_REAP_IDLE_MS = String(10 * MIN);
process.env.TIMON_REAP_CHAT_IDLE_MS = String(30 * MIN);
process.env.TIMON_REAP_HUNG_MS = String(90 * MIN);
process.env.TIMON_REAP_TURN_MAX_MS = '0';
process.env.TIMON_REAP_ORPHAN_GRACE_MS = String(120 * MIN);

await import('../tests/helpers/claude-provider.js');
const { getHost } = await import('./host/index.js');
const { getTurnState, isAutonomousMission, evictIdleMission, reapStaleMissions, setProcessTableReaderForTest,
  spawnAgent, upsertAgent } = await import('./agent.js');
const { bus } = await import('./bus.js');
const { dbApi } = await import('./db.js');
const { missionMemoryDir, TIMON_HOME } = await import('./paths.js');
const { recordRequestDelivery } = await import('./agent-request-replies.js');

const AGENT = 'workflow-reaper-witness';
upsertAgent({ name: AGENT, system_prompt: 'Witness.', config: {
  backend: 'claude', model: 'opus', cwd: TIMON_HOME, skills: [], mcp_servers: [], memory_scope: 'SESSION',
} });

const host = getHost();
const originalSpawn = host.spawn;
let child: ChildProcessWithoutNullStreams;
const rootProcess = { pid: process.pid, ppid: process.ppid, name: 'fake-cli' };
setProcessTableReaderForTest(async () => [rootProcess]);
host.spawn = (() => {
  child = Object.assign(new EventEmitter(), {
    pid: process.pid, killed: false, exitCode: null, signalCode: null,
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  }) as ChildProcessWithoutNullStreams;
  const proc = child;
  proc.kill = (signal) => {
    if (proc.killed) return false;
    proc.killed = true;
    setImmediate(() => {
      (proc as { signalCode: NodeJS.Signals | null }).signalCode = 'SIGTERM';
      proc.emit('exit', null, signal);
      proc.emit('close', null, signal);
    });
    return true;
  };
  return proc;
}) as typeof host.spawn;
test.after(() => {
  host.spawn = originalSpawn;
  setProcessTableReaderForTest(null);
});

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (check()) return;
    await tick(10);
  }
  assert.fail('timed out waiting for fixture state');
}

const line = (event: unknown): string => `${JSON.stringify(event)}\n`;
const emitResult = (proc: ChildProcessWithoutNullStreams): void => {
  proc.stdout.write(line({ type: 'result', subtype: 'success', is_error: false, result: 'Finished.' }));
};

function run(status: string, ended = status === 'completed') {
  const workflowId = randomUUID(), id = randomUUID(), now = Date.now();
  dbApi.insertWorkflow({ id: workflowId, slug: `workflow-${workflowId.slice(0, 8)}`, name: 'Witness', description: null,
    project: null, owner_user_id: null, draft: '{}', published_version: null, enabled: 1, created_at: now,
    updated_at: now, agent_name: null });
  dbApi.insertWorkflowRun({ id, workflow_id: workflowId, version: 1, status, trigger: '{}', input: null,
    context: '{}', error: null, started_at: now, ended_at: ended ? now : null,
    owner_user_id: null, tokens_in: null, tokens_out: null, cost_usd: null });
  return id;
}

async function spawn(runId: string, finish = true) {
  const mission = await spawnAgent(AGENT, 'A synthetic workflow turn.', { channel: 'workflow' }, {
    explicitResume: null, traceId: runId, workflow: { runId, nodeId: 'witness' },
  });
  const proc = child;
  const sessionId = randomUUID();
  proc.stdout.write(line({ type: 'system', subtype: 'init', session_id: sessionId, tools: [], mcp_servers: [] }));
  if (finish) {
    emitResult(proc);
    await until(() => dbApi.missionTurnEnded(mission) && getTurnState(mission)?.turnActive === false);
  }
  return { mission, proc, sessionId };
}

async function close(mission: string, proc: ChildProcessWithoutNullStreams): Promise<void> {
  proc.kill('SIGTERM');
  await until(() => dbApi.getMission(mission)?.status !== 'running');
}

test('idle sweep releases a completed workflow and preserves its provider anchor and session memory', async () => {
  const runId = run('completed');
  const { mission, proc, sessionId } = await spawn(runId);
  const path = join(missionMemoryDir(AGENT, mission), 'witness.txt');
  writeFileSync(path, 'session memory');
  const row = dbApi.getMission(mission)!;
  assert.equal(isAutonomousMission(row), false, 'workflow cleanup grants no permission autonomy');
  reapStaleMissions([rootProcess], Date.now() + 11 * MIN);
  assert.equal(proc.killed, true);
  await until(() => dbApi.getMission(mission)?.status === 'terminated');
  assert.equal(dbApi.getMission(mission)?.session_id, sessionId);
  assert.equal(readFileSync(path, 'utf8'), 'session memory');
  assert.equal(dbApi.getWorkflowRun(runId)?.status, 'completed');
});

test('completed workflows can free a slot through admission without losing memory', async () => {
  const runId = run('completed');
  const { mission, proc } = await spawn(runId);
  const path = join(missionMemoryDir(AGENT, mission), 'witness.txt');
  writeFileSync(path, 'admission memory');
  const now = Date.now() + 2 * MIN;
  assert.equal(evictIdleMission(now), null, 'admission requires a background sweep');
  reapStaleMissions([rootProcess], now);
  assert.equal(proc.killed, false, 'ordinary idle threshold has not passed');
  dbApi.updateWorkflowRun(runId, { status: 'waiting' });
  assert.equal(evictIdleMission(now), null, 'admission checks the latest whole-run state');
  dbApi.updateWorkflowRun(runId, { status: 'completed' });
  assert.equal(evictIdleMission(now), mission);
  await until(() => dbApi.getMission(mission)?.status === 'terminated');
  assert.equal(readFileSync(path, 'utf8'), 'admission memory');
});

test('whole-run state and matching ownership stay mandatory past the ordinary chat threshold', async () => {
  for (const status of ['running', 'waiting', 'failed', 'cancelled']) {
    const { mission, proc } = await spawn(run(status));
    const now = Date.now() + 40 * MIN;
    reapStaleMissions([rootProcess], now);
    assert.equal(evictIdleMission(now), null);
    assert.equal(proc.killed, false, status);
    await close(mission, proc);
  }
  const { mission, proc } = await spawn(run('completed'));
  dbApi.setMissionOwner(mission, 'different-owner');
  const now = Date.now() + 40 * MIN;
  reapStaleMissions([rootProcess], now);
  assert.equal(evictIdleMission(now), null);
  assert.equal(proc.killed, false, 'different owner');
  await close(mission, proc);
});

test('proven failed and cancelled runs release only settled workflow processes', async () => {
  for (const status of ['failed', 'cancelled']) {
    const runId = run(status, true);
    const { mission, proc } = await spawn(runId);
    const result = await spawn(runId, false);
    reapStaleMissions([rootProcess], Date.now() + 11 * MIN);
    assert.equal(proc.killed, true, status);
    assert.equal(result.proc.killed, false, `open turn on ${status} run`);
    await until(() => dbApi.getMission(mission)?.status === 'terminated');
    assert.equal(dbApi.getWorkflowRun(runId)?.status, status);
    await close(result.mission, result.proc);
  }
});

test('a completed label without an end timestamp does not make the workflow releasable', async () => {
  const { mission, proc } = await spawn(run('completed', false));
  const now = Date.now() + 40 * MIN;
  reapStaleMissions([rootProcess], now);
  assert.equal(evictIdleMission(now), null);
  assert.equal(proc.killed, false);
  await close(mission, proc);
});

test('engagement, open turn, inbox, delivered request, permission and child each block release', async () => {
  for (const guard of ['human', 'turn', 'inbox', 'delivery', 'permission', 'child'] as const) {
    const { mission, proc } = await spawn(run('completed'), guard !== 'turn');
    const sender = randomUUID();
    switch (guard) {
      case 'human': dbApi.markMissionUserEngaged(mission); break;
      case 'turn': break;
      case 'inbox':
        dbApi.createMission(sender, 'sender', 'Original message.');
        dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'sender', toAgent: AGENT,
          toMission: mission, kind: 'msg', payload: 'Still owed.' });
        break;
      case 'delivery': {
        dbApi.createMission(sender, 'sender', 'Original request.');
        const request = dbApi.enqueueMessage({ id: randomUUID(), fromMission: sender, fromAgent: 'sender', toAgent: AGENT,
          toMission: mission, kind: 'request', payload: 'Still owed.' });
        dbApi.pickMessage(request.id);
        recordRequestDelivery(mission, dbApi.insertEvent(mission, 'system', {}).id, [request.id]);
        assert.deepEqual(dbApi.missionPendingWork(mission, AGENT, 'running'), { pending_messages: 0, open_deliveries: 1 });
        break;
      }
      case 'permission':
        bus.publish({ kind: 'event', missionId: mission, type: 'permission_request', timestamp: Date.now(), payload: {} });
        break;
      case 'child':
        dbApi.createMission(sender, 'child', 'Still running.');
        dbApi.setMissionLineage(sender, { parentMissionId: mission });
        break;
    }
    const now = Date.now() + 40 * MIN;
    reapStaleMissions([rootProcess], now);
    assert.equal(evictIdleMission(now), null);
    assert.equal(proc.killed, false, guard);
    await close(mission, proc);
  }
});

test('admission and sweep spare a workflow with a live background child or an unreadable process table', async () => {
  const { mission, proc } = await spawn(run('completed'));
  const now = Date.now() + 40 * MIN;
  reapStaleMissions([rootProcess, { pid: 987_654, ppid: rootProcess.pid, name: 'simulated-child' }], now);
  assert.equal(proc.killed, false);
  assert.equal(evictIdleMission(now), null);
  reapStaleMissions(undefined, now);
  assert.equal(proc.killed, false);
  assert.equal(evictIdleMission(now), null);
  reapStaleMissions([rootProcess], now);
  assert.equal(proc.killed, true);
  await until(() => dbApi.getMission(mission)?.status === 'terminated');
});

test('one-shot workflow rows close only after the whole run and the last turn settle', () => {
  const makeMission = (status: string, finished: boolean): string => {
    const runId = run(status), mission = randomUUID();
    dbApi.createMission(mission, AGENT, 'One-shot witness.', { channel: 'workflow' }, null, runId,
      { runId, nodeId: 'witness' });
    dbApi.setMissionLlmOverrides(mission, 'codex', null);
    dbApi.setMissionSession(mission, randomUUID());
    if (finished) dbApi.insertEvent(mission, 'result', { subtype: 'success', is_error: false });
    return mission;
  };
  const done = makeMission('completed', true);
  const pending = makeMission('waiting', true);
  const open = makeMission('completed', false);
  const sessionId = dbApi.getMission(done)?.session_id;
  reapStaleMissions([rootProcess], Date.now() + 121 * MIN);
  assert.equal(dbApi.getMission(done)?.status, 'terminated');
  assert.equal(dbApi.getMission(done)?.session_id, sessionId);
  assert.equal(dbApi.getMission(pending)?.status, 'running');
  assert.equal(dbApi.getMission(open)?.status, 'running');
});
