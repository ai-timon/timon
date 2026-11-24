/**
 * The "TO DO" notebook belongs to the Kanban: part 2/4 of the Kanban work.
 *
 * This test replaces the old `backlog/split.test.ts`, which checked the
 * separation just undone. What it keeps from it: the risk of
 * moving routes is not the code (verbatim), it is a path mounted
 * twice or not at all. So the routers are mounted ALONE and we look at what
 * they serve.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Router } from 'express';

const todoLaterRoutes = await import('./project-todo-routes.js');
const kanbanRoutes = await import('./routes.js');
const { CATALOG } = await import('../../kernel/catalog.js');
const { RETIRED_IDS, canonicalModuleId, isRetiredModuleId } = await import('../../kernel/legacy-ids.js');

/** One ephemeral server per router: no state shared between the tests. */
async function serve(register: (r: Router) => void): Promise<{ url: (p: string) => string; close: () => void }> {
  const app = express();
  app.use(express.json());
  register(app);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return { url: (p) => `http://127.0.0.1:${port}${p}`, close: () => server.close() };
}

test('the Kanban serves the "TO DO" notebook on top of its tasks', async () => {
  const d = await serve((r) => { kanbanRoutes.registerRoutes(r); todoLaterRoutes.registerRoutes(r); });
  try {
    assert.equal((await fetch(d.url('/api/project-todo'))).status, 200);
    assert.equal((await fetch(d.url('/api/tasks'))).status, 200);
    // What left for `dreams` in the previous part has not come back here.
    assert.equal((await fetch(d.url('/api/dreams'))).status, 404);
    assert.equal((await fetch(d.url('/api/projects/scores'))).status, 404);
  } finally { d.close(); }
});

test('the two Kanban routers do not step on each other', async () => {
  // No path mounted twice: the task router ignores the notebook, and
  // the other way round. A duplicate would show here before showing in production.
  const tasks = await serve(kanbanRoutes.registerRoutes);
  try {
    assert.equal((await fetch(tasks.url('/api/project-todo'))).status, 404);
  } finally { tasks.close(); }

  const carnet = await serve(todoLaterRoutes.registerRoutes);
  try {
    assert.equal((await fetch(carnet.url('/api/tasks'))).status, 404);
    assert.equal((await fetch(carnet.url('/api/project-todo'))).status, 200);
  } finally { carnet.close(); }
});

test('@timon/kanban off: no project-todo route at all', async () => {
  // The notebook no longer has a switch of its own: turning the board off takes it,
  // and that is the only gesture that makes it disappear.
  const d = await serve(() => { /* module absent */ });
  try {
    for (const path of ['/api/project-todo', '/api/project-todo/1', '/api/project-todo/1/handoff']) {
      assert.equal((await fetch(d.url(path))).status, 404, path);
    }
  } finally { d.close(); }
});

test('@timon/backlog is no longer a module: neither in the catalogue nor sold separately', () => {
  assert.equal(CATALOG.some((m) => m.id === '@timon/backlog'), false);
  // The notebook follows the board, which is free: it is no longer sold on its own.
  assert.equal(CATALOG.find((m) => m.id === '@timon/kanban')?.licensed, undefined);
});

test('a config still carrying @timon/backlog does not turn the Kanban off', () => {
  // Id removed, not aliased: translating it to `@timon/kanban` would turn
  // "I do not want the notebook" into "I do not want the board".
  assert.equal(RETIRED_IDS.has('@timon/backlog'), true);
  assert.equal(isRetiredModuleId('@timon/backlog'), true);
  assert.equal(canonicalModuleId('@timon/backlog'), '@timon/backlog');
});

test('the alice module is gone from the catalogue, its two halves outlive it', () => {
  // Part 11: the `alice` identity goes back to what it always was, an
  // agent of the user. What was code is here, or in `dreams`.
  assert.equal(CATALOG.some((m) => m.id === '@timon/alice'), false);
  assert.ok(CATALOG.some((m) => m.id === '@timon/kanban'));
  assert.ok(CATALOG.some((m) => m.id === '@timon/dreams'));
});

test('todo mutations publish once after writing, addressed to the row owner', async () => {
  const { dbApi } = await import('../../db.js');
  const { bus } = await import('../../bus.js');
  type Event = Extract<import('../../bus.js').BusEvent, { kind: 'plugin_realtime' }>;
  const events: { event: Event; status: string | undefined }[] = [];
  const listener = (event: import('../../bus.js').BusEvent) => {
    if (event.kind !== 'plugin_realtime') return;
    const { id } = event.payload as { id: number };
    events.push({ event, status: dbApi.getProjectTodo(id)?.status });
  };
  const owner = 'todo-realtime-owner';
  const d = await serve((r) => {
    r.use((req, _res, next) => {
      req.auth = { kind: 'api-token', user: null, isSuperadmin: false, actorId: owner, permissions: [] };
      next();
    });
    todoLaterRoutes.registerRoutes(r);
  });
  bus.on('event', listener);
  try {
    const created = await fetch(d.url('/api/project-todo'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Live idea' }),
    });
    assert.equal(created.status, 201);
    const { item } = await created.json() as { item: { id: number } };
    const patch = (status: string) => fetch(d.url(`/api/project-todo/${item.id}`), {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }),
    });
    assert.equal((await patch('done')).status, 200);
    assert.equal((await patch('promoted')).status, 400);
    assert.equal(events.length, 2);
    assert.equal((await fetch(d.url(`/api/project-todo/${item.id}`), { method: 'DELETE' })).status, 200);
    assert.equal((await patch('open')).status, 404);
    assert.equal((await fetch(d.url(`/api/project-todo/${item.id}`), { method: 'DELETE' })).status, 404);
    assert.deepEqual(events.map(({ status }) => status), ['open', 'done', undefined]);
    for (const { event } of events) {
      assert.deepEqual(event, {
        kind: 'plugin_realtime', pluginId: '@timon/kanban', topic: 'project-todo.changed',
        ownerUserId: owner, payload: { id: item.id },
      });
    }
  } finally { bus.off('event', listener); d.close(); }
});

test('system-owned todo rows never publish realtime', async () => {
  const { bus } = await import('../../bus.js');
  let count = 0;
  const listener = (event: import('../../bus.js').BusEvent) => { if (event.kind === 'plugin_realtime') count++; };
  const d = await serve((r) => {
    // Authenticated edit (the PATCH route requires it) on a row created
    // without an account: a superadmin on the POST would own the row.
    r.use((req, _res, next) => {
      if (req.method === 'PATCH') req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true };
      next();
    });
    todoLaterRoutes.registerRoutes(r);
  });
  bus.on('event', listener);
  try {
    const response = await fetch(d.url('/api/project-todo'), {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'System idea' }),
    });
    assert.equal(response.status, 201);
    const { item } = await response.json() as { item: { id: number; owner_user_id: null } };
    assert.equal(item.owner_user_id, null);
    assert.equal((await fetch(d.url(`/api/project-todo/${item.id}`), {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'done' }),
    })).status, 200);
    assert.equal((await fetch(d.url(`/api/project-todo/${item.id}`), { method: 'DELETE' })).status, 200);
    assert.equal(count, 0);
  } finally { bus.off('event', listener); d.close(); }
});
