import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deleteKanbanTask } from './kanban-delete';
import { setLocale } from './i18n';
import './i18n-test-locales';

test('deletes with the same-origin endpoint and no body', async (ctx) => {
  ctx.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    assert.equal(url, '/api/ui/tasks/task-id');
    assert.equal(init.method, 'DELETE');
    assert.equal(init.body, undefined);
    return Response.json({ ok: true });
  });
  assert.equal((await deleteKanbanTask('task-id')).ok, true);
});
test('shows a translated conflict reason instead of just the status', async (ctx) => {
  ctx.mock.method(globalThis, 'fetch', async () => Response.json({ code: 'task_dependents' }, { status: 409 }));
  setLocale('fr');
  try {
    const result = await deleteKanbanTask('task-id');
    assert.equal(result.ok, false);
    assert.match(result.message, /dépendances/); // french-ok: the French locale under test
  } finally { setLocale('en'); }
});
test('handles expired sessions, unreadable responses and network failures', async (ctx) => {
  const fetch = ctx.mock.method(globalThis, 'fetch', async () => new Response('', { status: 401 }));
  assert.match((await deleteKanbanTask('task-id')).message, /Sign in/);
  fetch.mock.mockImplementation(async () => new Response('<html>error</html>', { status: 502 }));
  const unreadable = await deleteKanbanTask('task-id');
  assert.equal(unreadable.ok, false);
  assert.match(unreadable.message, /try again/);
  fetch.mock.mockImplementation(async () => { throw new TypeError('offline'); });
  const offline = await deleteKanbanTask('task-id');
  assert.equal(offline.ok, false);
  assert.match(offline.message, /connection/);
});

test('a chain root asks for the chain deletion, which goes through the proxy with chain=1', async (ctx) => {
  const fetch = ctx.mock.method(globalThis, 'fetch', async () => Response.json({
    code: 'task_chain', chain_size: 4, task_id: 'task-id',
    blockers: [{ id: 'child-aaaaaaaa', title: 'review iter:1', status: 'BLOCKED', kind: 'chain' }],
  }, { status: 409 }));
  const refused = await deleteKanbanTask('task-id');
  assert.equal(refused.ok, false);
  assert.equal(refused.chainSize, 4);
  assert.match(refused.message, /verification chain \(4 tasks\)/);

  fetch.mock.mockImplementation(async (url: RequestInfo | URL) => {
    assert.equal(String(url), '/api/ui/tasks/task-id?chain=1');
    return Response.json({ ok: true, deleted: ['task-id', 'a', 'b', 'c'] });
  });
  const deleted = await deleteKanbanTask('task-id', { chain: true });
  assert.equal(deleted.ok, true);
  assert.match(deleted.message, /4 tasks/);
});
test('a refusal names the blocking tasks and the chain member that holds it back', async (ctx) => {
  ctx.mock.method(globalThis, 'fetch', async () => Response.json({
    code: 'task_dependents', task_id: 'task-id', hidden_blockers: 1,
    blockers: [{ id: 'dependent-1234', title: 'Waits on it', status: 'PENDING', kind: 'dep' }],
  }, { status: 409 }));
  const dependents = await deleteKanbanTask('task-id');
  assert.equal(dependents.chainSize, undefined);
  assert.match(dependents.message, /#dependen Waits on it/);
  assert.match(dependents.message, /1 more belongs to another account/);

  ctx.mock.method(globalThis, 'fetch', async () => Response.json({ code: 'task_worktree', task_id: 'child-12345678' }, { status: 409 }));
  assert.match((await deleteKanbanTask('task-id', { chain: true })).message, /^Chain task child-12: .*worktree/);
});
