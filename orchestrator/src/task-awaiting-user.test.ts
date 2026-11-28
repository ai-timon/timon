/**
 * A task that waits only for a person is BLOCKED with `awaiting_user` set: the
 * board shows it as a turn to take, not a breakdown, while the status keeps every
 * dispatcher path away from it. The flag lasts as long as the block.
 */
import './test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import express from 'express';
import { dbApi } from './db.js';
import { registerRoutes } from './plugins-bundled/kanban/routes.js';
import { createDaemonAuthMiddleware } from './plugins-bundled/http/auth.js';
await import('../tests/helpers/claude-provider.js');

const app = express();
app.use((_req, res, next) => { res.setHeader('connection', 'close'); next(); });
app.use(express.json());
app.use(createDaemonAuthMiddleware({ token: 'await-test', required: true }));
registerRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

type Json = { error?: string; code?: string; task?: { status: string; awaiting_user: number } };

async function call(method: string, path: string, body: unknown, token: string | null = 'await-test'): Promise<{ status: number; json: Json }> {
  const r = await fetch(`${api}${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() as Json };
}

function chore(): string {
  const id = randomUUID();
  dbApi.createTask(id, 'wait for the merge', 'witness', { type: 'chore' });
  return id;
}

test('an anonymous close is refused and flags nothing', async () => {
  const id = chore();
  const r = await call('POST', '/api/tasks/close', { id, outcome: 'failed', reason: 'x', awaiting_user: true }, null);
  assert.equal(r.status, 401);
  assert.equal(dbApi.getTask(id)!.awaiting_user, 0);
});

test('mark-as-failed with awaiting_user keeps the status BLOCKED and the agent reason readable', async () => {
  const id = chore();
  const r = await call('POST', '/api/tasks/close', { id, outcome: 'failed', reason: 'Merge request !42 is ready', awaiting_user: true });
  assert.equal(r.status, 200);
  const row = dbApi.getTask(id)!;
  assert.equal(row.status, 'BLOCKED');
  assert.equal(row.awaiting_user, 1);
  assert.equal(row.blocked_reason, 'Merge request !42 is ready');
  assert.equal(dbApi.listPendingReady().some((t) => t.id === id), false, 'the dispatcher never picks it up');
});

test('a plain block, and a non-boolean flag, stay a repair block', async () => {
  const plain = chore();
  assert.equal((await call('POST', '/api/tasks/close', { id: plain, outcome: 'failed', reason: 'conflict' })).status, 200);
  assert.equal(dbApi.getTask(plain)!.awaiting_user, 0);

  const bad = chore();
  const r = await call('POST', '/api/tasks/close', { id: bad, outcome: 'failed', reason: 'x', awaiting_user: 'yes' });
  assert.equal(r.status, 400);
  assert.equal(dbApi.getTask(bad)!.status, 'PENDING');
});

test('the PUT that blocks a task carries the flag too', async () => {
  const id = chore();
  const r = await call('PUT', `/api/tasks/${id}`, { status: 'BLOCKED', blocked_reason: 'Validate the plan', awaiting_user: true });
  assert.equal(r.status, 200);
  assert.equal(dbApi.getTask(id)!.awaiting_user, 1);
});

test('the wait ends with the block: reopening the task, or blocking it again for a repair, clears it', async () => {
  const id = chore();
  await call('POST', '/api/tasks/close', { id, outcome: 'failed', reason: 'Merge it', awaiting_user: true });
  assert.equal((await call('PUT', `/api/tasks/${id}`, { status: 'PENDING' })).status, 200);
  const reopened = dbApi.getTask(id)!;
  assert.equal(reopened.status, 'PENDING');
  assert.equal(reopened.awaiting_user, 0);

  const again = chore();
  await call('POST', '/api/tasks/close', { id: again, outcome: 'failed', reason: 'Merge it', awaiting_user: true });
  dbApi.updateTaskStatus(again, 'BLOCKED', { blockedReason: 'check failed' });
  assert.equal(dbApi.getTask(again)!.awaiting_user, 0, 'a block written without the flag is a repair block');

  const system = chore();
  await call('POST', '/api/tasks/close', { id: system, outcome: 'failed', reason: 'Merge it', awaiting_user: true });
  dbApi.updateTaskStatus(system, 'DONE', { doneComment: 'merged by hand' });
  assert.equal(dbApi.getTask(system)!.awaiting_user, 0);
});
