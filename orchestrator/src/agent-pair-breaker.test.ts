/**
 * Circuit breaker of agent↔agent exchanges (tester incident of 07/10/2026:
 * two agents woke each other up in a loop, despite written "STOP"s,
 * since every answer is itself a message that wakes the other).
 *
 * What these tests protect: a pair that exceeds the cap is no longer
 * woken and its messages leave `pending`; a human input
 * restarts it; Kanban task returns never count.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { test, beforeEach } from 'node:test';
import { randomUUID } from 'node:crypto';

process.env.TIMON_WAKE_PAIR_MAX_MESSAGES = '3';
process.env.TIMON_WAKE_PAIR_WINDOW_MS = '600000';
const { dbApi } = await import('./db.js');
const { handleAgentMessage, handleUserInput } = await import('./wake.js');
const { admitAgentMessage, clearAgentPairs, isHumanInput } = await import('./agent-pair-breaker.js');

const missions = new Map<string, string>();
function missionOf(agent: string): string {
  let id = missions.get(agent);
  if (!id) {
    id = randomUUID();
    dbApi.createMission(id, agent, 'test', { channel: 'agent' });
    missions.set(agent, id);
  }
  return id;
}

/** Enqueue a message and run the wake-loop handler on it. True if woken.
 *  `request` by default: a free `msg` wakes nobody, so it never reaches the breaker. */
function send(
  from: string, to: string, payload = 'ping', id = randomUUID(), kind: 'msg' | 'request' = 'request',
): { id: string; woken: boolean } {
  const row = dbApi.enqueueMessage({ id, fromMission: missionOf(from), fromAgent: from, toAgent: to, kind, payload });
  let woken = false;
  handleAgentMessage(
    { kind: 'agent_message', missionId: row.from_mission, messageId: row.id, toAgent: to, fromAgent: from, fromMission: row.from_mission },
    () => { woken = true; },
  );
  return { id: row.id, woken };
}

function alertsAbout(a: string, b: string): number {
  return dbApi.listAllInbox({ limit: 500 })
    .filter((m) => m.from_agent === 'orchestrator' && m.payload.includes(`${a} ↔ ${b}`)).length;
}

beforeEach(() => clearAgentPairs());

test('a pair that exceeds the cap is no longer woken, in both directions', () => {
  assert.equal(send('jeff', 'nexus').woken, true);
  assert.equal(send('nexus', 'jeff').woken, true);
  assert.equal(send('jeff', 'nexus').woken, true);
  const over = send('nexus', 'jeff', 'STOP');
  assert.equal(over.woken, false);
  assert.equal(dbApi.getMessage(over.id)?.status, 'held');
  // Held back = out of `pending`: neither the sweep, nor a wake from another cause,
  // nor an agent picking up its inbox will see it.
  assert.ok(!dbApi.listInbox('jeff', { status: 'pending' }).some((m) => m.id === over.id));

  // Locked: the rest stays held back, without a second alert.
  const next = send('jeff', 'nexus', 'STOP STOP');
  assert.equal(next.woken, false);
  assert.equal(dbApi.getMessage(next.id)?.status, 'held');
  assert.equal(alertsAbout('jeff', 'nexus'), 1);
  const alert = dbApi.listAllInbox({ limit: 500 })
    .find((m) => m.from_agent === 'orchestrator' && m.payload.includes('jeff ↔ nexus'));
  const payload = JSON.parse(alert?.payload ?? '{}') as { code?: string; params?: Record<string, unknown> };
  assert.equal(payload.code, 'agent_pair_loop_stopped');
  assert.equal(payload.params?.count, 4);
});

test('the case of the name does not create a second pair', () => {
  send('Ana', 'bob');
  send('bob', 'ana');
  send('ANA', 'Bob');
  assert.equal(send('bob', 'Ana').woken, false);
});

test('a human input restarts the pair', () => {
  for (let i = 0; i < 3; i++) send('alpha', 'beta');
  assert.equal(send('beta', 'alpha').woken, false);

  // A tool_result and a message injected by the daemon are not a human.
  handleUserInput(missionOf('beta'), {
    type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }] },
  });
  handleUserInput(missionOf('beta'), {
    type: 'user', message: { role: 'user', content: 'digest' }, origin: { kind: 'wake', from: 'orchestrator-wake' },
  });
  assert.equal(send('alpha', 'beta').woken, false);

  handleUserInput(missionOf('beta'), { type: 'user', message: { role: 'user', content: 'reprenez' } });
  assert.equal(send('alpha', 'beta').woken, true);
  assert.equal(send('beta', 'alpha').woken, true);
});

test('an idea pushed from the TO DO restarts the pair too', () => {
  for (let i = 0; i < 4; i++) send('gamma', 'delta');
  assert.equal(send('gamma', 'delta').woken, false);
  assert.equal(send('cockpit', 'delta', 'Idée remontée').woken, true); // french-ok: free-text sample data
  assert.equal(send('gamma', 'delta').woken, true);
});

test('Kanban task and mission returns are never held back', () => {
  for (let i = 0; i < 10; i++) {
    const task = send('p.coder', 'p.main', JSON.stringify({ kind: 'task_closed', task_id: randomUUID(), task_status: 'DONE' }));
    assert.equal(task.woken, true);
    assert.equal(dbApi.getMessage(task.id)?.status, 'pending');
    const mission = send('p.coder', 'p.main', JSON.stringify({ kind: 'mission_complete', status: 'completed' }));
    assert.equal(mission.woken, true);
  }
  // And they do not eat into the credit of the pair.
  for (let i = 0; i < 3; i++) assert.equal(send('p.coder', 'p.main').woken, true);
});

test('a free msg does not wake and does not count against the pair', () => {
  for (let i = 0; i < 10; i++) {
    const free = send('theta', 'iota', 'ping', randomUUID(), 'msg');
    assert.equal(free.woken, false);
    assert.equal(dbApi.getMessage(free.id)?.status, 'pending');
  }
  for (let i = 0; i < 3; i++) assert.equal(send('theta', 'iota').woken, true);
});

test('the window slides: old messages no longer count', () => {
  const t0 = 1_000_000;
  const msg = (n: number) => ({ id: `w-${n}`, from_agent: 'eps', to_agent: 'zeta', payload: 'x' });
  assert.equal(admitAgentMessage(msg(1), t0), 'wake');
  assert.equal(admitAgentMessage(msg(2), t0 + 1), 'wake');
  assert.equal(admitAgentMessage(msg(3), t0 + 2), 'wake');
  assert.equal(admitAgentMessage(msg(4), t0 + 600_001), 'wake');
});

test('isHumanInput: only text typed by a human counts', () => {
  assert.equal(isHumanInput({ type: 'user', message: { role: 'user', content: 'go' } }), true);
  assert.equal(isHumanInput({
    type: 'user', message: { role: 'user', content: '/plan x' }, origin: { presentation: { parts: [] } },
  }), true);
  // Raw event of a CLI (sub-agent prompt): extra keys.
  assert.equal(isHumanInput({
    type: 'user', message: { role: 'user', content: 'sub' }, session_id: 's', parent_tool_use_id: 't',
  }), false);
  assert.equal(isHumanInput({ type: 'user', message: { role: 'user', content: 'r' }, origin: { kind: 'task_return', from: 'p.coder' } }), false);
  assert.equal(isHumanInput(null), false);
});
