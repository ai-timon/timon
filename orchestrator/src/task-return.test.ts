/**
 * Sending the work return up to the pilot, at the CLOSING of the task.
 *
 * `handleTaskDone` exited on `if (!mission?.parent_agent) return`: a task
 * closed outside dispatch (a typed closing by an agent the dispatcher did not
 * launch, a manual takeover, a replay) sent nothing up at all. The orchestrator
 * saw the column move on the Kanban and never learnt what the work
 * had produced.
 *
 * `mark_as_done` AND `mark_as_failed` must both go up without an extra
 * gesture: the first through this return, the second through the
 * `task_blocked` event the closing publishes and the wake loop already handles.
 *
 * `node --test --import tsx src/task-return.test.ts`
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

// french-ok-file: French sample comments and reasons the test feeds in

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-task-return-test-'));

const { dbApi } = await import('./db.js');
const { bus } = await import('./bus.js');
type BusEvent = import('./bus.js').BusEvent;
const { handleTaskDone } = await import('./wake.js');
const { registerRoutes } = await import('./plugins-bundled/kanban/routes.js');

/** `task_closed` returns dropped in an agent's inbox. */
function returnsTo(agent: string) {
  return dbApi.listInbox(agent, { limit: 50 })
    .map((m) => JSON.parse(m.payload) as { kind?: string; task_id?: string; done_comment?: string })
    .filter((p) => p.kind === 'task_closed');
}

async function withApi<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  // The operator: closing by id or by a claimed mission needs kanban:write (TODO #787).
  app.use((req, _res, next) => { req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true }; next(); });
  registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try { return await fn(`http://127.0.0.1:${port}`); } finally { server.close(); }
}

test('a task closed WITHOUT parent_agent still goes up to the pilot', () => {
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, 'volet hors dispatch', 'p.coder', { type: 'code' });
  // A mission without `parent_agent`: the case that sent nothing up.
  dbApi.createMission(missionId, 'p.coder', 'volet hors dispatch');
  dbApi.assignTaskMission(taskId, missionId);
  dbApi.updateTaskStatus(taskId, 'DONE', { doneComment: 'branche intégrée, sha en commentaire' });

  handleTaskDone(taskId);

  const sent = returnsTo('_main').filter((p) => p.task_id === taskId);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.done_comment, 'branche intégrée, sha en commentaire');
  assert.equal(dbApi.isTaskReturnNotified(taskId), true);
});

test('sending up stays idempotent: never the same return twice', () => {
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, 'volet idempotent', 'p.coder', { type: 'code' });
  dbApi.createMission(missionId, 'p.coder', 'volet idempotent');
  dbApi.assignTaskMission(taskId, missionId);
  dbApi.updateTaskStatus(taskId, 'DONE', { doneComment: 'fait' });

  handleTaskDone(taskId);
  handleTaskDone(taskId);

  assert.equal(returnsTo('_main').filter((p) => p.task_id === taskId).length, 1);
});

test('an orchestrator closing its own task does not wake itself up', () => {
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, 'task du pilote', '_main', { type: 'chore' });
  dbApi.createMission(missionId, '_main', 'task du pilote');
  dbApi.assignTaskMission(taskId, missionId);
  dbApi.updateTaskStatus(taskId, 'DONE', { doneComment: 'fait moi-même' });

  handleTaskDone(taskId);

  assert.equal(returnsTo('_main').filter((p) => p.task_id === taskId).length, 0);
});

test('mark_as_failed publishes task_blocked: the pilot is warned without an extra gesture', async () => {
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, 'volet bloqué', 'p.coder', { type: 'code' });
  dbApi.createMission(missionId, 'p.coder', 'volet bloqué');
  dbApi.assignTaskMission(taskId, missionId);

  const seen: BusEvent[] = [];
  const listen = (ev: BusEvent) => { if (ev.kind === 'task_blocked') seen.push(ev); };
  bus.on('event', listen);
  try {
    await withApi(async (base) => {
      const r = await fetch(`${base}/api/tasks/close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-TIMON-Mission': missionId },
        body: JSON.stringify({ outcome: 'failed', reason: 'clé API absente du coffre' }),
      });
      assert.equal(r.status, 200);
    });
  } finally { bus.off('event', listen); }

  const ev = seen.find((e) => e.kind === 'task_blocked' && e.taskId === taskId);
  assert.ok(ev, 'no task_blocked published for this task');
  assert.equal(ev.kind === 'task_blocked' ? ev.reason : null, 'clé API absente du coffre');
});

test('mark_as_done publishes task_done: that is what triggers the sending up', async () => {
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, 'volet livré', 'p.coder', { type: 'chore' });
  dbApi.createMission(missionId, 'p.coder', 'volet livré');
  dbApi.assignTaskMission(taskId, missionId);

  const seen: string[] = [];
  const listen = (ev: BusEvent) => { if (ev.kind === 'task_done') seen.push(ev.taskId); };
  bus.on('event', listen);
  try {
    await withApi(async (base) => {
      await fetch(`${base}/api/tasks/close`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-TIMON-Mission': missionId },
        body: JSON.stringify({ outcome: 'done', comment: 'volet livré' }),
      });
    });
  } finally { bus.off('event', listen); }

  assert.ok(seen.includes(taskId));
});

test('the human summary travels in the task_closed return', async () => {
  const taskId = randomUUID();
  const missionId = randomUUID();
  dbApi.createTask(taskId, 'volet résumé', 'p.coder', { type: 'chore' });
  dbApi.createMission(missionId, 'p.coder', 'volet résumé');
  dbApi.assignTaskMission(taskId, missionId);
  await withApi(async (base) => {
    await fetch(`${base}/api/tasks/close`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-TIMON-Mission': missionId },
      body: JSON.stringify({ outcome: 'done', comment: 'rapport complet', summary: 'Le bouton Exporter marche.' }),
    });
  });
  handleTaskDone(taskId);
  const sent = dbApi.listInbox('_main', { limit: 50 })
    .map((m) => JSON.parse(m.payload) as { kind?: string; task_id?: string; summary?: string | null })
    .filter((p) => p.kind === 'task_closed' && p.task_id === taskId);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.summary, 'Le bouton Exporter marche.');
});
