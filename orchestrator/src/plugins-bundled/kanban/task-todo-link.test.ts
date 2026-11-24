/**
 * Linking a task to a TO DO idea (`todo_id`) is what later CLOSES that idea, so
 * the link is an access decision: nobody may attach — hence close — an idea
 * they cannot see. A missing idea and someone else's idea answer the same way.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

const kanbanRoutes = await import('./routes.js');
await import('../../../tests/helpers/claude-provider.js');

const todoRoutes = await import('./project-todo-routes.js');
const { dbApi } = await import('../../db.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');

const ADA = 'user-ada';
const BOB = 'user-bob';

async function as<T>(who: string | null, fn: (url: (p: string) => string) => Promise<T>): Promise<T> {
  const app = express();
  app.use(express.json());
  if (who) {
    app.use((req, _res, next) => {
      req.auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: who, permissions: ['kanban:read', 'kanban:write'] };
      next();
    });
  }
  kanbanRoutes.registerRoutes(app);
  todoRoutes.registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try { return await fn((p) => `http://127.0.0.1:${port}${p}`); } finally { server.close(); }
}

function send(url: string, method: string, body: unknown): Promise<Response> {
  return fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

// french-ok-file: free-text sample ideas
const adaIdea = dbApi.insertProjectTodo({ text: 'idée d\'Ada', ownerUserId: ADA }).id;
const bobIdea = dbApi.insertProjectTodo({ text: 'idée de Bob', ownerUserId: BOB }).id;

test('the owner links a task to their idea at creation', async () => {
  await as(ADA, async (url) => {
    const r = await send(url('/api/tasks'), 'POST', { title: 't', agent_name: 'acme.coder', todo_id: adaIdea });
    assert.equal(r.status, 201);
    const { task } = (await r.json()) as { task: { id: string; todo_id: number | null } };
    assert.equal(task.todo_id, adaIdea);
    assert.equal(dbApi.getTask(task.id)?.todo_id, adaIdea);
  });
});

test('another account cannot link (hence close) an idea it cannot see — same answer as a missing one', async () => {
  const before = dbApi.listTasks().length;
  await as(BOB, async (url) => {
    const foreign = await send(url('/api/tasks'), 'POST', { title: 't', agent_name: 'acme.coder', todo_id: adaIdea });
    const missing = await send(url('/api/tasks'), 'POST', { title: 't', agent_name: 'acme.coder', todo_id: 999_999 });
    assert.equal(foreign.status, 400);
    assert.equal(missing.status, 400);
    const foreignError = ((await foreign.json()) as { error: string }).error;
    const missingError = ((await missing.json()) as { error: string }).error;
    assert.equal(foreignError.replace(String(adaIdea), 'N'), missingError.replace('999999', 'N'));
    assert.doesNotMatch(foreignError, /Ada/, 'the idea content never leaks');
  });
  assert.equal(dbApi.listTasks().length, before, 'a refused link leaves no task behind');
});

test('an anonymous caller is refused before any link is considered', async () => {
  const before = dbApi.listTasks().length;
  const app = express();
  app.use(express.json());
  app.use(createDaemonAuthMiddleware({ token: 'daemon-secret', required: true }));
  kanbanRoutes.registerRoutes(app);
  const server = app.listen(0);
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const r = await send(`http://127.0.0.1:${port}/api/tasks`, 'POST', { title: 't', agent_name: 'acme.coder', todo_id: adaIdea });
    assert.equal(r.status, 401);
  } finally { server.close(); }
  assert.equal(dbApi.listTasks().length, before);
});

test('a malformed todo_id is refused', async () => {
  await as(ADA, async (url) => {
    for (const todo_id of ['12', 0, -3, 1.5]) {
      const r = await send(url('/api/tasks'), 'POST', { title: 't', agent_name: 'acme.coder', todo_id });
      assert.equal(r.status, 400, `todo_id ${JSON.stringify(todo_id)}`);
    }
  });
});

test('PUT attaches, refuses a foreign idea, and detaches with null', async () => {
  await as(BOB, async (url) => {
    const created = await send(url('/api/tasks'), 'POST', { title: 't', agent_name: 'acme.coder' });
    const { task } = (await created.json()) as { task: { id: string } };
    const foreign = await send(url(`/api/tasks/${task.id}`), 'PUT', { todo_id: adaIdea, title: 'changed' });
    assert.equal(foreign.status, 400);
    assert.equal(dbApi.getTask(task.id)?.todo_id, null);
    assert.equal(dbApi.getTask(task.id)?.title, 't', 'a refused link writes nothing else either');
    assert.equal((await send(url(`/api/tasks/${task.id}`), 'PUT', { todo_id: bobIdea })).status, 200);
    assert.equal(dbApi.getTask(task.id)?.todo_id, bobIdea);
    assert.equal((await send(url(`/api/tasks/${task.id}`), 'PUT', { todo_id: null })).status, 200);
    assert.equal(dbApi.getTask(task.id)?.todo_id, null);
  });
});

test('promoting an idea links the task it creates', async () => {
  const id = dbApi.insertProjectTodo({ text: 'à promouvoir', ownerUserId: ADA }).id;
  await as(ADA, async (url) => {
    const r = await send(url(`/api/project-todo/${id}/promote`), 'POST', { agent_name: 'acme.coder', type: 'code' });
    assert.equal(r.status, 201);
    const { task } = (await r.json()) as { task: { id: string } };
    assert.equal(dbApi.getTask(task.id)?.todo_id, id);
  });
});

test('the task list filters on todo_id, within the caller\'s scope', async () => {
  const mine = dbApi.insertProjectTodo({ text: 'filtrée', ownerUserId: ADA }).id;
  const ids = await as(ADA, async (url) => {
    const r = await send(url('/api/tasks'), 'POST', { title: 'liée', agent_name: 'acme.coder', todo_id: mine });
    const { task } = (await r.json()) as { task: { id: string } };
    await send(url('/api/tasks'), 'POST', { title: 'libre', agent_name: 'acme.coder' });
    const list = await fetch(url(`/api/tasks?todo_id=${mine}`));
    assert.equal(list.status, 200);
    assert.equal((await fetch(url('/api/tasks?todo_id=abc'))).status, 400);
    return { task: task.id, listed: ((await list.json()) as { tasks: { id: string }[] }).tasks.map((t) => t.id) };
  });
  assert.deepEqual(ids.listed, [ids.task]);
  await as(BOB, async (url) => {
    const { tasks } = (await (await fetch(url(`/api/tasks?todo_id=${mine}`))).json()) as { tasks: unknown[] };
    assert.deepEqual(tasks, [], 'another account sees none of them');
  });
});
