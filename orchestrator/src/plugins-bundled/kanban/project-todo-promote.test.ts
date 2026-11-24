/**
 * Promoting an idea into a task: part 3/4 of the Kanban work.
 *
 * What the test keeps under watch, because a future rename or refactor
 * would break it silently: the task is born `PENDING` (hence dispatchable, which
 * `project_todo_add` never does), the idea is marked AND keeps the link
 * to its task, and a second promotion is refused, naming the first one.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express, { type Router } from 'express';

const todoRoutes = await import('./project-todo-routes.js');
const kanbanRoutes = await import('./routes.js');
const { dbApi } = await import('../../db.js');

async function serve(register: (r: Router) => void): Promise<{ url: (p: string) => string; close: () => void }> {
  const app = express();
  app.use(express.json());
  // The PATCH route requires an authenticated caller: act as the CLI does.
  app.use((req, _res, next) => { req.auth = { kind: 'daemon-token', user: null, isSuperadmin: true }; next(); });
  register(app);
  const server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  return { url: (p) => `http://127.0.0.1:${port}${p}`, close: () => server.close() };
}

const d = await serve((r) => { kanbanRoutes.registerRoutes(r); todoRoutes.registerRoutes(r); });
dbApi.upsertProject('witness', { cwd: '/tmp' });

async function newIdea(fields: Record<string, unknown> = {}): Promise<number> {
  const r = await fetch(d.url('/api/project-todo'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'idée mûre', project: 'witness', notes: 'le contexte', ...fields }), // french-ok: free-text sample data
  });
  assert.equal(r.status, 201);
  return ((await r.json()) as { item: { id: number } }).item.id;
}

async function promote(id: number, body: Record<string, unknown> = {}): Promise<Response> {
  return fetch(d.url(`/api/project-todo/${id}/promote`), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agent_name: 'witness.coder', ...body }),
  });
}

test('promoting creates a PENDING task and marks the idea, link included', async () => {
  const id = await newIdea();
  const r = await promote(id, { type: 'code', base: 'main', priority: 4, pipeline: 'code-self' });
  assert.equal(r.status, 201);
  const { task, item } = (await r.json()) as {
    task: { id: string; status: string; title: string; type: string; priority: number; pipeline: string | null; agent_name: string };
    item: { status: string; promoted_task_id: string | null };
  };
  // PENDING: that is ALL the difference with `project_todo_add`, which never
  // exposes the idea to the dispatcher.
  assert.equal(task.status, 'PENDING');
  assert.equal(task.title, 'idée mûre'); // french-ok: free-text sample data
  assert.equal(task.type, 'code');
  assert.equal(task.priority, 4);
  assert.equal(task.pipeline, 'code-self');
  assert.equal(task.agent_name, 'witness.coder');
  // The idea is neither deleted nor left open.
  assert.equal(item.status, 'promoted');
  assert.equal(item.promoted_task_id, task.id);
  const reread = dbApi.getProjectTodo(id);
  assert.equal(reread?.promoted_task_id, task.id, 'the link is in the database, not only in the response');
  // The provenance travels in the brief too: the agent does not read the database.
  const created = dbApi.getTask(task.id);
  assert.equal(created?.base_branch, 'main', 'the worktree base follows, as for kanban_add');
  assert.match(created?.description ?? '', /idea #\d+ of the project.s TO DO notebook/);
  assert.match(created?.description ?? '', /le contexte/);
});

test('an idea already promoted is not promoted twice', async () => {
  const id = await newIdea();
  assert.equal((await promote(id)).status, 201);
  const second = await promote(id);
  assert.equal(second.status, 409);
  const body = (await second.json()) as { error: string; task_id: string };
  assert.match(body.error, /already promoted/);
  assert.equal(body.task_id, dbApi.getProjectTodo(id)?.promoted_task_id);
  // A single task for this idea: the guard does not just answer 409.
  const forIdea = dbApi.listTasks().filter((t) => (t.description ?? '').includes(`idea #${id} of the project`));
  assert.equal(forIdea.length, 1);
});

test('the "promoted" status cannot be set by PATCH', async () => {
  const id = await newIdea();
  const r = await fetch(d.url(`/api/project-todo/${id}`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'promoted' }),
  });
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /promote/);
  assert.equal(dbApi.getProjectTodo(id)?.promoted_task_id, null);
});

test('an idea set back to "open" after promotion stays promoted for the guard', async () => {
  const id = await newIdea();
  assert.equal((await promote(id)).status, 201);
  const back = await fetch(d.url(`/api/project-todo/${id}`), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status: 'open' }),
  });
  assert.equal(back.status, 200);
  // The link prevails, not the status: without it, a PATCH would reopen the door to
  // a second task and orphan the first one.
  assert.equal((await promote(id)).status, 409);
});

test('promoting without an agent is refused: the task does not guess who runs it', async () => {
  const id = await newIdea();
  const r = await fetch(d.url(`/api/project-todo/${id}/promote`), {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(r.status, 400);
  assert.match(((await r.json()) as { error: string }).error, /agent_name/);
});

test('idea attached to an unknown project: the error talks about the idea', async () => {
  const id = await newIdea({ project: 'projet-fantome' });
  const r = await promote(id);
  assert.equal(r.status, 400);
  const { error } = (await r.json()) as { error: string };
  assert.match(error, new RegExp(`idea #${id}`));
  assert.match(error, /projet-fantome/);
  assert.equal(dbApi.getProjectTodo(id)?.promoted_task_id, null, 'nothing promoted when nothing is created');
  // The project passed explicitly unblocks the promotion without touching the idea.
  assert.equal((await promote(id, { project: 'witness' })).status, 201);
});

test('what went to the board can be listed', async () => {
  const id = await newIdea();
  assert.equal((await promote(id)).status, 201);
  const r = await fetch(d.url('/api/project-todo?status=promoted'));
  assert.equal(r.status, 200);
  const { items } = (await r.json()) as { items: { id: number }[] };
  assert.ok(items.some((i) => i.id === id));
  // `open` does not bring them back: the "TO DO" column of the Kanban no longer shows them.
  const open = (await (await fetch(d.url('/api/project-todo?status=open'))).json()) as { items: { id: number }[] };
  assert.equal(open.items.some((i) => i.id === id), false);
});

test('promoting is not the handoff: both gestures coexist', async () => {
  // `handoff` sends a MESSAGE to `<project>.main` to discuss it; here no
  // agent exists on disk, so it refuses. The promotion goes through.
  const id = await newIdea();
  const handoff = await fetch(d.url(`/api/project-todo/${id}/handoff`), { method: 'POST' });
  assert.equal(handoff.status, 400);
  assert.equal((await promote(id)).status, 201);
});

test.after(() => d.close());
