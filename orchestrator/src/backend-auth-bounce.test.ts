/**
 * Expired CLI login, end to end: the first bounce sidelines the backend, the
 * task mission is finalised on the spot, and the task restarts on the fallback.
 *
 * Replays the stream of mission 49c90448 (night of 2026-09-17) through a fake
 * claude process. That night the fallback was configured and never took over:
 * the bounce reported `num_turns: 1`, so the breaker ignored it, and the idle
 * process waited out the reaper (10 min) before dying as `killed`.
 *
 * No real CLI, no bind, throwaway TIMON_HOME.
 */
import './test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
process.env.TIMON_FALLBACK_ENABLED = '1';
process.env.TIMON_FALLBACK_BACKEND = 'codex';
process.env.TIMON_BREAKER_ENABLED = '1';
process.env.TIMON_BREAKER_THRESHOLD = '3';

const { getHost } = await import('./host/index.js');
const { spawnAgent, upsertAgent, reapStaleMissions, isRunning } = await import('./agent.js');
const { dbApi } = await import('./db.js');
const { watchMissionComplete } = await import('./dispatcher.js');
const { clearBackendCooldown, isBackendCoolingDown } = await import('./backend-fallback.js');
const { resetBreakers } = await import('./backend-breaker.js');
const { invalidateSettingsCache } = await import('./settings.js');

type FakeChild = ChildProcessWithoutNullStreams & { killed: boolean };

/** Like a real CLI, the exit arrives on a later tick, never inside `kill()`. */
function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  // A pid that is alive, and no exit seen yet: the reaper's liveness probe
  // must take this child for a running process.
  (child as { pid: number }).pid = process.pid;
  (child as { exitCode: number | null }).exitCode = null;
  (child as { signalCode: NodeJS.Signals | null }).signalCode = null;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = ((signal?: NodeJS.Signals | number) => {
    if (child.killed) return false;
    child.killed = true;
    setImmediate(() => {
      (child as { signalCode: NodeJS.Signals | null }).signalCode = typeof signal === 'string' ? signal : 'SIGTERM';
      child.emit('exit', null, signal ?? 'SIGTERM');
      child.emit('close', null, signal ?? 'SIGTERM');
    });
    return true;
  }) as ChildProcessWithoutNullStreams['kill'];
  return child;
}

const SESSION = 'cd2d7ca8-fe0e-4e8a-bb7a-440918714be6';
const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

/** The incident's two events, as recorded in `events`. */
const AUTH_ASSISTANT = {
  type: 'assistant',
  message: {
    id: 'cb59f805-20db-47fc-bb77-92f7efb97393', model: '<synthetic>', role: 'assistant', type: 'message',
    stop_reason: 'stop_sequence', usage: ZERO_USAGE,
    content: [{ type: 'text', text: 'Failed to authenticate: OAuth session expired and could not be refreshed' }],
  },
  parent_tool_use_id: null,
  session_id: SESSION,
  error: 'authentication_failed',
};
const AUTH_RESULT = {
  type: 'result', subtype: 'success', is_error: true, num_turns: 1, duration_ms: 45, duration_api_ms: 0,
  stop_reason: 'stop_sequence', session_id: SESSION, total_cost_usd: 0, usage: ZERO_USAGE,
  terminal_reason: 'api_error', permission_denials: [],
};

const AGENT = 'bounce-temoin';
upsertAgent({
  name: AGENT,
  system_prompt: 'witness — does nothing.',
  config: { backend: 'claude', model: 'opus', cwd: tmpdir(), skills: [], mcp_servers: [], memory_scope: 'NONE' },
});

const host = getHost();
const originalSpawn = host.spawn;
const children: FakeChild[] = [];
host.spawn = (() => {
  const child = fakeChild();
  children.push(child);
  return child;
}) as typeof host.spawn;

function tick(ms = 20): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function until(check: () => boolean, what: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > timeoutMs) assert.fail(`timed out waiting for: ${what}`);
    await tick(10);
  }
}

/** A task mission of a series, on claude, with its fake process. */
async function spawnTaskMission(): Promise<{ taskId: string; missionId: string; seriesId: string; child: FakeChild }> {
  const seriesId = randomUUID();
  const taskId = randomUUID();
  dbApi.createTask(taskId, 'merge — toggle plugins', AGENT, {
    type: 'merge', seriesId, backendOverride: 'claude', modelOverride: 'opus',
  });
  const missionId = await spawnAgent(AGENT, `TASK_ID: ${taskId}`, { channel: 'dispatcher', meta: { task_id: taskId } });
  dbApi.assignTaskMission(taskId, missionId);
  return { taskId, missionId, seriesId, child: children[children.length - 1]! };
}

function emit(child: FakeChild, ...events: unknown[]): void {
  for (const ev of events) child.stdout.write(`${JSON.stringify(ev)}\n`);
}

function reset(): void {
  resetBreakers();
  clearBackendCooldown('claude');
  clearBackendCooldown('codex');
}

{
  const { mountOfficialProviders, stubCliBinaries, stubCodexSignIn } = await import('../tests/helpers/official-providers.js');
  // A fallback goes only to a CLI that is on this host and signed in: stand-ins, never the machine's own.
  await stubCliBinaries('claude', 'codex');
  await stubCodexSignIn();
  await mountOfficialProviders();
}

test('expired OAuth: set aside at the first bounce, mission finalised without the reaper, task restarted on codex', async () => {
  reset();
  const stop = watchMissionComplete();
  try {
    const { taskId, missionId, child } = await spawnTaskMission();
    emit(child,
      { type: 'system', subtype: 'init', session_id: SESSION, tools: [], mcp_servers: [] },
      AUTH_ASSISTANT,
      AUTH_RESULT,
    );

    await until(() => dbApi.getMission(missionId)?.status !== 'running', 'mission finalised');
    assert.equal(child.killed, true, 'the idle process is ended by us, not by the reaper');
    assert.equal(isRunning(missionId), false);

    // One bounce, not three: an expired login does not heal on its own.
    assert.equal(isBackendCoolingDown('claude'), true);
    const cooldown = dbApi.getBackendCooldown('claude');
    assert.equal(cooldown?.kind, 'unavailable');
    assert.equal(cooldown?.quota_window, 'authentication failed');

    const mission = dbApi.getMission(missionId);
    assert.equal(mission?.status, 'failed');
    assert.equal(mission?.interrupted_reason, 'backend_unavailable');

    // The series switch is asynchronous (lazy import of agent.ts).
    await until(() => dbApi.getTask(taskId)?.status === 'PENDING', 'task requeued');
    const task = dbApi.getTask(taskId);
    assert.equal(task?.backend_override, 'codex', 'the requeued task must not go back to the sidelined backend');
    assert.equal(task?.interrupted_reason, null);

    const signedOut = () => dbApi.listNotifications({ limit: 50 })
      .find((n) => n.title.includes('claude') && n.title.includes('log in again'));
    // Raised through a lazy import: it lands a few ticks after the trip.
    await until(() => !!signedOut(), 'a signed-out CLI needs a human: an alert must say so');
    const alert = signedOut()!;
    assert.equal(alert.type, 'alert');
    assert.equal(alert.urgent, 1);
  } finally {
    stop();
  }
});

test('an is_error result that consumed tokens triggers nothing', async () => {
  reset();
  const { missionId, child } = await spawnTaskMission();
  emit(child, {
    ...AUTH_RESULT,
    num_turns: 1,
    duration_ms: 900,
    total_cost_usd: 0.03,
    usage: { ...ZERO_USAGE, input_tokens: 8_000, output_tokens: 250 },
  });
  await tick(50);
  assert.equal(isBackendCoolingDown('claude'), false);
  assert.equal(child.killed, false, 'a productive turn leaves the mission to its agent');
  assert.equal(dbApi.getMission(missionId)?.status, 'running');
  child.kill();
  await tick();
});

test('an isolated mute bounce finalises the mission as a crash, without setting the backend aside', async () => {
  reset();
  const { missionId, child } = await spawnTaskMission();
  // Same shape, no authentication code: one shapeless bounce is a fluke.
  emit(child, AUTH_RESULT);
  await until(() => dbApi.getMission(missionId)?.status !== 'running', 'mission finalised');
  assert.equal(isBackendCoolingDown('claude'), false);
  assert.equal(dbApi.getMission(missionId)?.interrupted_reason, 'crash');
});

test('the reaper of a really idle mission stays a kill', async () => {
  reset();
  const { missionId, child } = await spawnTaskMission();
  emit(child, {
    ...AUTH_RESULT,
    is_error: false,
    duration_ms: 12_000,
    total_cost_usd: 0.4,
    usage: { ...ZERO_USAGE, input_tokens: 40_000, output_tokens: 3_000 },
  });
  await tick(30);
  assert.equal(child.killed, false);
  const previous = process.env.TIMON_REAP_IDLE_MS;
  process.env.TIMON_REAP_IDLE_MS = '1';
  invalidateSettingsCache();
  try {
    await tick(10);
    reapStaleMissions();
    await until(() => dbApi.getMission(missionId)?.status !== 'running', 'mission reaped');
  } finally {
    if (previous === undefined) delete process.env.TIMON_REAP_IDLE_MS;
    else process.env.TIMON_REAP_IDLE_MS = previous;
    invalidateSettingsCache();
  }
  assert.equal(dbApi.getMission(missionId)?.interrupted_reason, 'killed');
  assert.equal(isBackendCoolingDown('claude'), false);
});

test.after(() => {
  host.spawn = originalSpawn;
  for (const child of children) if (!child.killed) child.kill();
});
