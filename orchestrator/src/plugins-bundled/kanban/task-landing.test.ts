/**
 * `landing: "pr"` marks the final `merge` task of a job that lands through a
 * pull request. Any other value, or on another type of task, is refused before
 * a task exists: it would be read by nothing.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

const kanbanRoutes = await import('./routes.js');
await import('../../../tests/helpers/claude-provider.js');
const { dbApi } = await import('../../db.js');
const { landingRefusal } = await import('./task-field-guards.js');

async function post(body: unknown): Promise<Response> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: 'user-ada', permissions: ['kanban:read', 'kanban:write'] };
    next();
  });
  kanbanRoutes.registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    return await fetch(`http://127.0.0.1:${port}/api/tasks`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
  } finally {
    server.close();
  }
}

test('landingRefusal: "pr" or "local", only on a merge task', () => {
  assert.equal(landingRefusal(undefined, 'code'), null);
  assert.equal(landingRefusal(null, 'merge'), null);
  assert.equal(landingRefusal('pr', 'merge'), null);
  assert.equal(landingRefusal('local', 'merge'), null);
  assert.match(landingRefusal('local', 'code') ?? '', /only for a merge task/);
  assert.match(landingRefusal('pr', 'code') ?? '', /only for a merge task/);
  assert.match(landingRefusal('pr', undefined) ?? '', /only for a merge task/);
  assert.match(landingRefusal('push', 'merge') ?? '', /invalid landing "push"/);
});

test('a merge task created with landing pr keeps it; a task without it has none', async () => {
  const marked = await post({ title: 'Open the pull request', agent_name: 'acme.merger', type: 'merge', landing: 'pr' });
  assert.equal(marked.status, 201);
  const { task } = (await marked.json()) as { task: { id: string } };
  assert.equal(dbApi.getTask(task.id)?.landing, 'pr');

  const local = await post({ title: 'Merge into main', agent_name: 'acme.merger', type: 'merge', landing: 'local' });
  assert.equal(local.status, 201);
  assert.equal(dbApi.getTask(((await local.json()) as { task: { id: string } }).task.id)?.landing, 'local');

  const plain = await post({ title: 'Merge', agent_name: 'acme.merger', type: 'merge' });
  assert.equal(plain.status, 201);
  const created = (await plain.json()) as { task: { id: string } };
  assert.equal(dbApi.getTask(created.task.id)?.landing, null);
});

test('landing on another type, or an unknown value, is a 400 that leaves no task', async () => {
  const before = dbApi.listTasks().length;
  for (const body of [
    { title: 't', agent_name: 'acme.coder', type: 'code', landing: 'pr' },
    { title: 't', agent_name: 'acme.coder', landing: 'pr' },
    { title: 't', agent_name: 'acme.merger', type: 'merge', landing: 'push' },
  ]) {
    const r = await post(body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.equal(((await r.json()) as { code?: string }).code, 'task_field_invalid');
  }
  assert.equal(dbApi.listTasks().length, before);
});
