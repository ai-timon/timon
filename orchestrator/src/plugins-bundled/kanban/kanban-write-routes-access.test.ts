/**
 * TODO #787 — the Kanban writes beside the task PUT/POST/DELETE refuse in the
 * order of TODO #752: no identity 401, no `kanban:write` 403 (`kanban:read`
 * alone included), a malformed or unknown body field 400, someone else's task
 * 404. A refused caller learns neither the body's shape nor whether the task
 * exists, and nothing is written.
 */
import '../../test-home.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, test } from 'node:test';
import express from 'express';
import { dbApi } from '../../db.js';
import { getPipeline, listPipelines } from '../../pipelines.js';
import { registerRoutes } from './routes.js';
import { registerRoutes as registerCodeRoutes } from '../kanban-code/routes.js';
await import('../../../tests/helpers/claude-provider.js');

const OWNER = randomUUID();
const STRANGER = randomUUID();
const ACTORS: Record<string, { actor: string; permissions: string[] }> = {
  writer: { actor: OWNER, permissions: ['kanban:read', 'kanban:write'] },
  reader: { actor: OWNER, permissions: ['kanban:read'] },
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
registerCodeRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

function call(method: string, path: string, as: string | null, body?: unknown) {
  const headers: Record<string, string> = as ? { 'x-test-as': as } : {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  return fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
}

function seed(type: 'code' | 'merge' | 'research' = 'code'): string {
  const id = randomUUID();
  dbApi.createTask(id, 'Write witness', 'witness', { ownerUserId: OWNER, type });
  return id;
}

function snapshot(id: string) {
  const t = dbApi.getTask(id);
  assert.ok(t);
  return { status: t.status, sha: t.merged_commit_sha, comment: t.done_comment, worktree: t.worktree_path };
}

async function assertRefused(r: Response, status: 401 | 403): Promise<void> {
  assert.equal(r.status, status);
  if (status === 403) assert.equal(((await r.json()) as { permission?: unknown }).permission, 'kanban:write');
}

/** Each task route: method, path, a valid body, a body with a stray field. */
const TASK_ROUTES = [
  { name: 'close by id', method: 'POST', path: () => '/api/tasks/close', body: (id: string) => ({ id, outcome: 'done', comment: 'closed' }) },
  { name: 'mark-merged', method: 'POST', path: (id: string) => `/api/tasks/${id}/mark-merged`, body: () => ({ sha: 'abcdef1234567' }) },
  { name: 'merged-sha', method: 'POST', path: (id: string) => `/api/tasks/${id}/merged-sha`, body: () => ({ sha: 'abcdef1234567' }) },
  { name: 'worktree create', method: 'POST', path: (id: string) => `/api/tasks/${id}/worktree`, body: () => ({}) },
  { name: 'worktree dispose', method: 'DELETE', path: (id: string) => `/api/tasks/${id}/worktree`, body: () => undefined },
  { name: 'worktree detach', method: 'POST', path: (id: string) => `/api/tasks/${id}/worktree/detach`, body: () => ({}) },
] as const;

for (const route of TASK_ROUTES) {
  test(`${route.name}: anonymous 401, kanban:read alone 403, nothing written`, async () => {
    const id = seed();
    const before = snapshot(id);
    await assertRefused(await call(route.method, route.path(id), null, route.body(id)), 401);
    await assertRefused(await call(route.method, route.path(id), 'reader', route.body(id)), 403);
    assert.deepEqual(snapshot(id), before);
  });

  test(`${route.name}: the right is checked before the task's existence`, async () => {
    const ghost = randomUUID();
    await assertRefused(await call(route.method, route.path(ghost), 'reader', route.body(ghost)), 403);
    // With the right, the same call reaches the visibility step.
    assert.equal((await call(route.method, route.path(ghost), 'writer', route.body(ghost))).status, 404);
  });

  test(`${route.name}: someone else's task answers 404 with the right`, async () => {
    const id = seed();
    const before = snapshot(id);
    assert.equal((await call(route.method, route.path(id), 'stranger', route.body(id))).status, 404);
    assert.deepEqual(snapshot(id), before);
  });

  const valid = route.body('x');
  if (valid !== undefined) {
    test(`${route.name}: a stray field is a 400 that names it, and only after the right`, async () => {
      const id = seed();
      const before = snapshot(id);
      const stray = { ...route.body(id), escalate: true };
      await assertRefused(await call(route.method, route.path(id), 'reader', stray), 403);
      const r = await call(route.method, route.path(id), 'writer', stray);
      assert.equal(r.status, 400);
      const json = (await r.json()) as { error: string; code: string };
      assert.equal(json.code, 'task_body_invalid');
      assert.match(json.error, /unknown field "escalate"/);
      assert.deepEqual(snapshot(id), before);
    });
  }
}

test('close by id: the writer closes the task, the finer messages stay', async () => {
  const id = seed('research');
  const bad = await call('POST', '/api/tasks/close', 'writer', { id, outcome: 'maybe', comment: 'x' });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /invalid outcome "maybe"/);
  const ok = await call('POST', '/api/tasks/close', 'writer', { id, outcome: 'done', comment: 'closed by hand' });
  assert.equal(ok.status, 200);
  assert.equal(dbApi.getTask(id)?.status, 'DONE');
});

test('close: a claimed mission is no own task — anonymous 401, reader 403 before any resolution', async () => {
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'witness', 'brief', undefined, OWNER);
  const id = seed('research');
  dbApi.assignTaskMission(id, missionId);
  await assertRefused(await call('POST', '/api/tasks/close', null, { mission_id: missionId, outcome: 'done', comment: 'x' }), 401);
  await assertRefused(await call('POST', '/api/tasks/close', 'reader', { mission_id: missionId, outcome: 'done', comment: 'x' }), 403);
  await assertRefused(await call('POST', '/api/tasks/close', 'reader', { mission_id: randomUUID(), outcome: 'done', comment: 'x' }), 403);
  assert.equal(dbApi.getTask(id)?.status, 'IN_PROGRESS');
});

test('merged-sha: the writer records it, the sha message stays', async () => {
  const id = seed();
  const bad = await call('POST', `/api/tasks/${id}/merged-sha`, 'writer', { sha: 'HEAD~1' });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /sha \(7-40 hex chars\) required/);
  assert.equal((await call('POST', `/api/tasks/${id}/merged-sha`, 'writer', { sha: 'abcdef1234567' })).status, 200);
  assert.equal(dbApi.getTask(id)?.merged_commit_sha, 'abcdef1234567');
});

test('mark-merged: a sha that is not hex keeps its own code', async () => {
  const id = seed();
  const r = await call('POST', `/api/tasks/${id}/mark-merged`, 'writer', { sha: 'nope' });
  assert.equal(r.status, 400);
  assert.equal(((await r.json()) as { code: string }).code, 'sha_invalid');
});

// ── Pipelines ──────────────────────────────────────────────────────────────

const DEFINITION = { steps: [{ id: 'plan', agent: 'witness', type: 'research', prompt: 'Plan {{input.feature}}' }] };

test('pipelines: create, change, delete and run need kanban:write', async () => {
  const count = listPipelines().length;
  const created = { name: 'witness-flow', definition: DEFINITION };
  await assertRefused(await call('POST', '/api/pipelines', null, created), 401);
  await assertRefused(await call('POST', '/api/pipelines', 'reader', created), 403);
  assert.equal(listPipelines().length, count);

  const r = await call('POST', '/api/pipelines', 'writer', created);
  assert.equal(r.status, 201);
  const id = ((await r.json()) as { pipeline: { id: string } }).pipeline.id;

  for (const [method, path, body] of [
    ['PUT', `/api/pipelines/${id}`, { name: 'renamed' }],
    ['DELETE', `/api/pipelines/${id}`, undefined],
    ['POST', `/api/pipelines/${id}/run`, { input: { feature: 'x' } }],
  ] as const) {
    await assertRefused(await call(method, path, null, body), 401);
    await assertRefused(await call(method, path, 'reader', body), 403);
  }
  assert.equal(getPipeline(id)?.name, 'witness-flow', 'nothing renamed');
  assert.ok(!dbApi.listTasks().some((t) => t.title.startsWith('witness-flow ·')), 'nothing run');

  const run = await call('POST', `/api/pipelines/${id}/run`, 'writer', { input: { feature: 'x' } });
  assert.equal(run.status, 201);
  assert.equal((await call('PUT', `/api/pipelines/${id}`, 'writer', { name: 'renamed' })).status, 200);
  assert.equal(getPipeline(id)?.name, 'renamed');
  assert.equal((await call('DELETE', `/api/pipelines/${id}`, 'writer')).status, 200);
  assert.equal(getPipeline(id), null);
});

test('pipelines: a stray field, top-level or in a step, is a 400 that names it', async () => {
  const count = listPipelines().length;
  const top = await call('POST', '/api/pipelines', 'writer', { name: 'p', definition: DEFINITION, owner_user_id: STRANGER });
  assert.equal(top.status, 400);
  assert.match(((await top.json()) as { error: string }).error, /unknown field "owner_user_id"/);
  const step = await call('POST', '/api/pipelines', 'writer', {
    name: 'p', definition: { steps: [{ ...DEFINITION.steps[0], depends_on: ['x'] }] },
  });
  assert.equal(step.status, 400);
  const json = (await step.json()) as { error: string; code: string };
  assert.equal(json.code, 'pipeline_body_invalid');
  assert.match(json.error, /unknown field "depends_on" in definition\.steps\.0/);
  // The finer refusals of `validateDefinition` keep their message.
  const cycle = await call('POST', '/api/pipelines', 'writer', { name: 'p', definition: { steps: [] } });
  assert.equal(cycle.status, 400);
  assert.match(((await cycle.json()) as { error: string }).error, /at least one step/);
  assert.equal(listPipelines().length, count);
});

test('pipelines: an unknown pipeline answers 404 to a writer, after the right', async () => {
  const ghost = randomUUID();
  await assertRefused(await call('POST', `/api/pipelines/${ghost}/run`, 'reader', { input: {} }), 403);
  assert.equal((await call('POST', `/api/pipelines/${ghost}/run`, 'writer', { input: {} })).status, 404);
  assert.equal((await call('PUT', `/api/pipelines/${ghost}`, 'writer', { name: 'x' })).status, 404);
  const stray = await call('POST', `/api/pipelines/${ghost}/run`, 'writer', { input: {}, owner: 'x' });
  assert.equal(stray.status, 400);
});

test('pipelines: a run takes the override guard of a task created by hand, before writing anything', async () => {
  const created = await call('POST', '/api/pipelines', 'writer', {
    name: 'escalation-flow',
    definition: { steps: [
      { id: 'plain', agent: 'witness', prompt: 'x' },
      { id: 'escalate', agent: 'witness', prompt: 'x', permission_mode_override: 'bypassPermissions' },
    ] },
  });
  assert.equal(created.status, 201);
  // Extra tools on a step are refused to an agent's token when the pipeline is
  // written, not only when it runs.
  const before = listPipelines().length;
  const widened = await call('POST', '/api/pipelines', 'writer', {
    name: 'widening-flow',
    definition: { steps: [{ id: 'tools', agent: 'witness', prompt: 'x', extra_allowed_tools: ['Bash(*)'] }] },
  });
  assert.equal(widened.status, 403);
  assert.match(((await widened.json()) as { reason?: string }).reason ?? '', /step tools: extra_allowed_tools adds Bash\(\*\)/);
  assert.equal(listPipelines().length, before);
  const id = ((await created.json()) as { pipeline: { id: string } }).pipeline.id;
  const runs = () => dbApi.listTasks().filter((t) => t.title.startsWith('escalation-flow ·')).length;

  // The same overrides on a task created by hand are refused to this caller.
  const byHand = await call('POST', '/api/tasks', 'writer', {
    title: 'by hand', agent_name: 'witness', permission_mode_override: 'bypassPermissions',
  });
  assert.equal(byHand.status, 403);

  const r = await call('POST', `/api/pipelines/${id}/run`, 'writer', { input: {} });
  assert.equal(r.status, 403);
  assert.match(((await r.json()) as { reason?: string }).reason ?? '', /step escalate/);
  assert.equal(runs(), 0, 'no step opened, not even the plain one');
});
