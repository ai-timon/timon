/**
 * TODO #752 — the routes that change a task refuse in this order: no identity
 * 401, no `kanban:write` 403 (`kanban:read` alone included), then a malformed
 * or unknown body field 400, then someone else's task 404. A refused caller
 * learns neither the body's expected shape nor whether the task exists.
 */
import '../../test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import express from 'express';
import { dbApi } from '../../db.js';
import { registerRoutes } from './routes.js';
import { registerRoutes as registerTodoRoutes } from './project-todo-routes.js';
await import('../../../tests/helpers/claude-provider.js');

const OWNER = randomUUID();
const STRANGER = randomUUID();
const ACTORS: Record<string, { actor: string; permissions: string[] }> = {
  writer: { actor: OWNER, permissions: ['kanban:read', 'kanban:write'] },
  reader: { actor: OWNER, permissions: ['kanban:read'] },
  nokanban: { actor: OWNER, permissions: ['missions:read'] },
  stranger: { actor: STRANGER, permissions: ['kanban:read', 'kanban:write'] },
};

const app = express();
app.use((req, _res, next) => {
  const who = ACTORS[req.header('x-test-as') ?? ''];
  if (who) req.auth = { kind: 'api-token', isSuperadmin: false, actorId: who.actor, permissions: who.permissions };
  next();
});
app.use(express.json());
registerRoutes(app);
registerTodoRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function call(method: string, path: string, as: string | null, body?: unknown) {
  const headers: Record<string, string> = as ? { 'x-test-as': as } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}
const put = (id: string, as: string | null, body: unknown) => call('PUT', `/api/tasks/${id}`, as, body);

function seed(): string {
  const id = randomUUID();
  dbApi.createTask(id, 'Write witness', 'witness', { ownerUserId: OWNER, type: 'research' });
  return id;
}

/** The fields a refused caller would have liked to change, as they are stored. */
function snapshot(id: string) {
  const t = dbApi.getTask(id);
  assert.ok(t);
  return {
    title: t.title, status: t.status, agent: t.agent_name,
    permission: t.permission_mode_override, tools: t.extra_allowed_tools,
  };
}

const ESCALATION = {
  title: 'taken over',
  status: 'BLOCKED',
  agent_name: 'someone-else',
  permission_mode_override: 'bypassPermissions',
  extra_allowed_tools: ['Bash(*)'],
};

// ── PUT /api/tasks/:id ─────────────────────────────────────────────────────

test('PUT: anonymous is refused with 401 and changes nothing', async () => {
  const id = seed();
  const before = snapshot(id);
  assert.equal((await put(id, null, ESCALATION)).status, 401);
  assert.deepEqual(snapshot(id), before);
});

test('PUT: kanban:read alone is refused with 403 naming kanban:write, and changes nothing', async () => {
  const id = seed();
  const before = snapshot(id);
  const res = await put(id, 'reader', ESCALATION);
  assert.equal(res.status, 403);
  const body = await res.json() as { code: string; permission: unknown };
  assert.equal(body.permission, 'kanban:write');
  assert.deepEqual(snapshot(id), before);
});

test('PUT: no Kanban permission at all is refused with 403', async () => {
  const id = seed();
  assert.equal((await put(id, 'nokanban', { title: 'x' })).status, 403);
  assert.equal(dbApi.getTask(id)?.title, 'Write witness');
});

test('PUT: the refusal comes before the shape and the existence checks', async () => {
  assert.equal((await put(randomUUID(), 'reader', { title: 'x' })).status, 403, 'an unknown task id reveals nothing');
  assert.equal((await put(seed(), 'reader', { not_a_field: 1 })).status, 403, 'an unknown field reveals nothing');
});

test('PUT: an unknown field is a 400 that names it and lists the accepted ones', async () => {
  const id = seed();
  const before = snapshot(id);
  const res = await put(id, 'writer', { title: 'renamed', reasoning_effort: 'high', pipeline: 'code-self' });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string; code: string };
  assert.equal(body.code, 'task_body_invalid');
  assert.match(body.error, /"reasoning_effort"/);
  assert.match(body.error, /"pipeline"/);
  assert.match(body.error, /accepted:.*permission_mode_override/);
  assert.deepEqual(snapshot(id), before, 'a refused body writes no field, not even the valid ones');
});

test('PUT: a field of the wrong type is a 400 naming the field', async () => {
  const id = seed();
  for (const [field, value] of [
    ['priority', 'high'], ['priority', 2.5], ['status', 'CANCELLED'], ['deps', 'abc'],
    ['extra_allowed_tools', 'Bash(*)'], ['permission_mode_override', 3], ['clear_scheduled_at', 'yes'],
    ['clear_fallback', 'true'], ['clear_permission_mode', 1], ['clear_fallback', null], ['clear_permission_mode', null],
  ] as const) {
    const res = await put(id, 'writer', { [field]: value });
    assert.equal(res.status, 400, `${field}: ${JSON.stringify(value)}`);
    assert.match((await res.json() as { error: string }).error, new RegExp(field));
  }
  assert.equal((await put(id, 'writer', ['title'])).status, 400, 'a body that is not an object');
  assert.deepEqual(snapshot(id).title, 'Write witness');
});

test('PUT: the explicit refusals of the finer checks keep their message', async () => {
  const id = seed();
  const sched = await put(id, 'writer', { scheduled_at: '2026-01-01' });
  assert.equal(sched.status, 400);
  assert.match((await sched.json() as { error: string }).error, /scheduled_at/);
  const type = await put(id, 'writer', { type: 'nope' });
  assert.equal(type.status, 400);
  assert.match((await type.json() as { error: string }).error, /invalid type "nope"/);
});

test('PUT: a valid merge sha next to a later invalid field writes nothing, the sha included', async () => {
  const id = seed();
  for (const late of [{ scheduled_at: '2026-01-01' }, { type: 'nope' }, { todo_id: -3 }]) {
    const res = await put(id, 'writer', { merged_commit_sha: 'abcdef1234567', title: 'half-written', ...late });
    assert.equal(res.status, 400, JSON.stringify(late));
    const t = dbApi.getTask(id);
    assert.equal(t?.merged_commit_sha ?? null, null, `sha left unchanged with ${JSON.stringify(late)}`);
    assert.equal(t?.title, 'Write witness');
  }
  // The same sha alone still goes through: the refusal above was the late field's.
  assert.equal((await put(id, 'writer', { merged_commit_sha: 'abcdef1234567' })).status, 200);
  assert.equal(dbApi.getTask(id)?.merged_commit_sha, 'abcdef1234567');
});

test('PUT: someone else\'s task stays a 404 for a writer', async () => {
  assert.equal((await put(seed(), 'stranger', { title: 'x' })).status, 404);
});

test('PUT: the task form\'s whole body is accepted', async () => {
  const id = seed();
  // Shape of `buildBody(form, 'edit')` (app/src/components/task-form/task-form-model.ts).
  const res = await put(id, 'writer', {
    title: 'Edited', description: 'More', agent_name: 'witness', priority: 4, type: 'research', deps: [],
    scheduled_at: null, clear_scheduled_at: false, backend_override: null, model_override: null,
    fallback_backend_override: null, fallback_model_override: null, permission_mode_override: null,
    clear_fallback: true, clear_permission_mode: true,
    extra_skills: [], extra_mcp_servers: [], extra_allowed_tools: [], todo_id: null,
  });
  assert.equal(res.status, 200, await res.clone().text());
  const t = dbApi.getTask(id);
  assert.equal(t?.title, 'Edited');
  assert.equal(t?.priority, 4);
});

test('PUT: the CLI\'s block gesture is accepted', async () => {
  const id = seed();
  const res = await put(id, 'writer', { status: 'BLOCKED', blocked_reason: 'waiting on a decision' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(dbApi.getTask(id)?.status, 'BLOCKED');
});

// ── POST /api/tasks, promotion and DELETE /api/tasks/:id ───────────────────

test('POST: anonymous is 401, kanban:read alone 403, and no task is created', async () => {
  const title = `Refused ${randomUUID()}`;
  assert.equal((await call('POST', '/api/tasks', null, { title, agent_name: 'witness' })).status, 401);
  const res = await call('POST', '/api/tasks', 'reader', { title, agent_name: 'witness' });
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { permission: unknown }).permission, 'kanban:write');
  assert.equal(dbApi.listTasks().some((t) => t.title === title), false);
});

test('POST: a writer still creates a task', async () => {
  const res = await call('POST', '/api/tasks', 'writer', { title: 'Created by a writer', agent_name: 'witness', type: 'research' });
  assert.equal(res.status, 201, await res.clone().text());
});

test('POST: an unknown field is a 400 that names it, and no task is created', async () => {
  const title = `Unknown field ${randomUUID()}`;
  const res = await call('POST', '/api/tasks', 'writer', { title, agent_name: 'witness', type: 'research', priorty: 4 });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: string; code: string };
  assert.equal(body.code, 'task_body_invalid');
  assert.match(body.error, /"priorty"/);
  assert.match(body.error, /accepted:.*permission_mode_override/);
  assert.equal(dbApi.listTasks().some((t) => t.title === title), false);
});

test('POST: a field of the wrong type is a 400 naming the field, and no task is created', async () => {
  const title = `Wrong type ${randomUUID()}`;
  for (const [field, value] of [
    ['priority', 'high'], ['deps', 'abc'], ['extra_allowed_tools', 'Bash(*)'],
    ['permission_mode_override', 3], ['agent_name', 7], ['base', ['main']],
  ] as const) {
    const res = await call('POST', '/api/tasks', 'writer', { title, agent_name: 'witness', type: 'research', [field]: value });
    assert.equal(res.status, 400, `${field}: ${JSON.stringify(value)}`);
    assert.match((await res.json() as { error: string }).error, new RegExp(field));
  }
  assert.equal((await call('POST', '/api/tasks', 'writer', ['title'])).status, 400, 'a body that is not an object');
  assert.equal(dbApi.listTasks().some((t) => t.title === title), false);
});

test('POST: the bodies of the task form, the CLI and the MCP are accepted', async () => {
  // `buildBody(form, 'create')`: empty optional values travel as `null`.
  const form = await call('POST', '/api/tasks', 'writer', {
    title: 'From the form', agent_name: 'witness', priority: 3, description: '', type: 'research', deps: [],
    scheduled_at: null, backend_override: null, model_override: null, fallback_backend_override: null,
    fallback_model_override: null, permission_mode_override: null, extra_skills: [], extra_mcp_servers: [],
    extra_allowed_tools: [], todo_id: null,
  });
  assert.equal(form.status, 201, await form.clone().text());
  // `timon task create`: a priority that is not a number reaches the wire as `null`.
  const cli = await call('POST', '/api/tasks', 'writer', {
    title: 'From the CLI', agent_name: 'witness', type: 'research', priority: null,
    group_id: randomUUID(), plan_group: 'volet-a', trace_id: 'trace-1', reasoning_effort: null, creator_mission_id: null,
  });
  assert.equal(cli.status, 201, await cli.clone().text());
  const { task } = await cli.json() as { task: { priority: number; group_id: string | null } };
  assert.ok(task.group_id);
});

test('POST: the finer refusals keep their message, and carry the code the board translates', async () => {
  type Coded = { error: string; code?: string; params?: Record<string, unknown> };
  const missing = await call('POST', '/api/tasks', 'writer', { title: 'No agent' });
  assert.equal(missing.status, 400);
  const missingBody = await missing.json() as Coded;
  assert.match(missingBody.error, /title and agent_name required/);
  assert.equal(missingBody.code, 'task_fields_required');
  const pipeline = await call('POST', '/api/tasks', 'writer', { title: 'Bad pipeline', agent_name: 'witness', pipeline: 'yolo' });
  assert.equal(pipeline.status, 400);
  const pipelineBody = await pipeline.json() as Coded;
  assert.match(pipelineBody.error, /pipeline/);
  // A reason computed elsewhere travels whole, as the message's detail.
  assert.equal(pipelineBody.code, 'task_field_invalid');
  assert.equal(pipelineBody.params?.detail, pipelineBody.error);
});

test('DELETE: kanban:read alone is refused with 403 and the task stays', async () => {
  const id = seed();
  const res = await call('DELETE', `/api/tasks/${id}`, 'reader');
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { permission: unknown }).permission, 'kanban:write');
  assert.ok(dbApi.getTask(id));
  assert.equal((await call('DELETE', `/api/tasks/${id}`, 'writer')).status, 200);
  assert.equal(dbApi.getTask(id), undefined);
});

test('promote: turning an idea into a task needs kanban:write too', async () => {
  const created = await call('POST', '/api/project-todo', 'writer', { text: 'An idea to promote' });
  assert.equal(created.status, 201, await created.clone().text());
  const { item } = await created.json() as { item: { id: number } };
  assert.equal((await call('POST', `/api/project-todo/${item.id}/promote`, null, { agent_name: 'witness' })).status, 401);
  const res = await call('POST', `/api/project-todo/${item.id}/promote`, 'reader', { agent_name: 'witness' });
  assert.equal(res.status, 403);
  assert.equal(dbApi.getProjectTodo(item.id)?.status, 'open');
});


test('PUT: reset sentinels require identity, write permission and task visibility', async () => {
  const id = seed();
  dbApi.updateTask(id, { fallbackBackendOverride: 'none', permissionModeOverride: 'plan' });
  const before = dbApi.getTask(id);
  for (const [as, status] of [[null, 401], ['reader', 403], ['stranger', 404]] as const) {
    assert.equal((await put(id, as, { clear_fallback: true, clear_permission_mode: true })).status, status);
    assert.deepEqual(dbApi.getTask(id), before);
  }
});
