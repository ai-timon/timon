/**
 * Every stop of a mission names its caller in the daemon log (#607). A codex mission was killed on
 * 24/10/2026 (TIM-0111) and nothing said by whom: the HTTP route, the task close and the other
 * internal paths all went through the same silent `killAgent`.
 *
 * Witness app: the real auth middleware and the real mission and Kanban routes. Rows without a
 * process: `killAgent` closes them, which is enough to read what it logs.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import './test-home.js';
import '../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { dbApi } from './db.js';
import { issueMissionApiToken } from './users/api-tokens.js';
import { createDaemonAuthMiddleware } from './plugins-bundled/http/auth.js';
import { registerRoutes as registerMissionRoutes } from './plugins-bundled/missions/routes.js';
import { registerRoutes as registerKanbanRoutes, CLOSED_TASK_STOP_DELAY_MS } from './plugins-bundled/kanban/routes.js';
import { describeKillOrigin } from './agent.js';

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const DAEMON_TOKEN = 'kill-origin-daemon-token';

const alice = createTestAccount(dbApi, { email: 'kill-alice@example.test', name: 'Alice', passwordHash: 'unused' });
const bob = createTestAccount(dbApi, { email: 'kill-bob@example.test', name: 'Bob', passwordHash: 'unused' });

const app = express();
app.use(createDaemonAuthMiddleware({ required: true, token: DAEMON_TOKEN }));
app.use(express.json());
registerMissionRoutes(app);
registerKanbanRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
test.after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

/** What `killAgent` writes, and nothing else. */
const killLines: string[] = [];
const warn = console.warn;
console.warn = (...args: unknown[]) => {
  const line = args.map(String).join(' ');
  if (line.startsWith('[kill]')) killLines.push(line);
  else warn(...args);
};
test.after(() => { console.warn = warn; });

function mission(agent: string, owner: string): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'brief', { channel: 'chat' }, owner);
  return id;
}

const linesFor = (missionId: string) => killLines.filter((l) => l.includes(missionId.slice(0, 8)));

function kill(missionId: string, headers: Record<string, string>) {
  return fetch(`${base}/api/missions/${missionId}`, { method: 'DELETE', headers });
}

test('an anonymous or forged caller stops nothing, and leaves no stop in the log', async () => {
  const target = mission('alice.agent', alice.id);
  assert.equal((await kill(target, {})).status, 401);
  assert.equal((await kill(target, { authorization: 'Bearer not-a-token' })).status, 401);
  assert.equal(dbApi.getMission(target)?.status, 'running');
  assert.deepEqual(linesFor(target), []);
});

test("another account's mission token cannot stop the mission", async () => {
  const target = mission('alice.agent', alice.id);
  const intruder = mission('bob.agent', bob.id);
  const res = await kill(target, { authorization: `Bearer ${issueMissionApiToken(intruder)}` });
  assert.equal(res.status, 404);
  assert.equal(dbApi.getMission(target)?.status, 'running');
  assert.deepEqual(linesFor(target), []);
});

test('a stop through the route names the calling mission and its agent, never its token', async () => {
  const target = mission('alice.agent', alice.id);
  const caller = mission('alice.pilot', alice.id);
  const token = issueMissionApiToken(caller);
  const res = await kill(target, { authorization: `Bearer ${token}` });
  assert.equal(res.status, 200);
  assert.equal(dbApi.getMission(target)?.status, 'terminated');
  const [line, ...rest] = linesFor(target);
  assert.equal(rest.length, 0);
  assert.match(line!, /by DELETE \/api\/missions\/:id/);
  assert.match(line!, new RegExp(`actor mission ${caller} \\(alice\\.pilot\\) from 127\\.0\\.0\\.1`));
  assert.ok(!line!.includes(token), 'the token never reaches the log');
  const audit = dbApi.listAuditLog(50).find((row) => row.action === 'mission.kill' && row.target === target);
  assert.ok(audit, 'the stop is in the audit log too');
  assert.equal(audit.user_id, alice.id);
});

test('the daemon-token is reported with the mission its holder claims, a malformed claim is not echoed', async () => {
  const claimed = mission('alice.pilot', alice.id);
  const first = mission('alice.agent', alice.id);
  assert.equal((await kill(first, { authorization: `Bearer ${DAEMON_TOKEN}`, 'X-TIMON-Mission': claimed })).status, 200);
  assert.match(linesFor(first)[0]!, new RegExp(`actor daemon-token \\(claims mission ${claimed}\\)`));
  const second = mission('alice.agent', alice.id);
  assert.equal((await kill(second, { authorization: `Bearer ${DAEMON_TOKEN}`, 'X-TIMON-Mission': 'x y; rm -rf' })).status, 200);
  const line = linesFor(second)[0]!;
  assert.match(line, /actor daemon-token from /);
  assert.ok(!line.includes('rm -rf'));
  assert.ok(!line.includes(DAEMON_TOKEN));
});

test('closing a task names the task in the stop of its mission', async () => {
  const missionId = mission('p.coder', alice.id);
  const taskId = randomUUID();
  dbApi.createTask(taskId, 'volet', 'p.coder', { type: 'chore' });
  dbApi.assignTaskMission(taskId, missionId);
  const res = await fetch(`${base}/api/tasks/close`, {
    method: 'POST',
    headers: { authorization: `Bearer ${DAEMON_TOKEN}`, 'content-type': 'application/json', 'X-TIMON-Mission': missionId },
    body: JSON.stringify({ outcome: 'done', comment: 'livré' }), // french-ok: a free-text comment
  });
  assert.equal(res.status, 200);
  dbApi.insertEvent(missionId, 'result', { type: 'result', subtype: 'success' });
  const deadline = Date.now() + CLOSED_TASK_STOP_DELAY_MS * 4;
  while (linesFor(missionId).length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert.match(linesFor(missionId)[0] ?? '', new RegExp(`by kanban: task closed \\(task ${taskId} DONE\\)`));
});

test('DELETE still stops a mission immediately while its task closure awaits a result', async () => {
  const missionId = mission('p.coder', alice.id);
  const taskId = randomUUID();
  dbApi.createTask(taskId, 'task', 'p.coder', { type: 'chore' });
  dbApi.assignTaskMission(taskId, missionId);
  const res = await fetch(`${base}/api/tasks/close`, {
    method: 'POST',
    headers: { authorization: `Bearer ${DAEMON_TOKEN}`, 'content-type': 'application/json', 'X-TIMON-Mission': missionId },
    body: JSON.stringify({ outcome: 'done', comment: 'Report submitted' }),
  });
  assert.equal(res.status, 200);
  assert.equal(dbApi.missionTurnEnded(missionId), false);
  assert.equal((await kill(missionId, { authorization: `Bearer ${DAEMON_TOKEN}` })).status, 200);
  assert.equal(dbApi.getMission(missionId)?.status, 'terminated');
  await new Promise((resolve) => setTimeout(resolve, CLOSED_TASK_STOP_DELAY_MS + 100));
  assert.equal(linesFor(missionId).length, 1);
  assert.match(linesFor(missionId)[0]!, /by DELETE/);
});

test('a caller-chosen field cannot forge a second log line', () => {
  const line = describeKillOrigin({ source: 'stop scope', actor: 'agent x\n[kill] mission deadbeef stopped', detail: 'a'.repeat(500) });
  assert.ok(!line.includes('\n'));
  assert.match(line, /^by stop scope actor agent x \[kill\]/);
  assert.ok(line.length < 450, 'bounded');
});
