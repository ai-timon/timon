/**
 * A Kanban task is a deferred spawn: its permission level, backend and extra
 * tools take the spawn guard. Without `agents:privileged-config` a mission
 * cannot raise them; with it, never above its own level.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

const kanbanRoutes = await import('./routes.js');
const { dbApi } = await import('../../db.js');

const OWNER = 'user-owner';
const lowMission = 'mission-low';
dbApi.createMission(lowMission, 'acme.low', 'orchestrate', undefined, OWNER);

/** `person`: a browser session, the only caller that may add tools to a task (decision of 08/11/2026). */
type Caller = { permissions: string[]; missionId?: string; superadmin?: boolean; person?: boolean };

async function call(method: string, path: string, caller: Caller, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.auth = {
      kind: caller.person ? 'session' : 'api-token', user: caller.person ? { id: OWNER, is_superadmin: caller.superadmin === true } : null, isSuperadmin: caller.superadmin === true, actorId: OWNER,
      // Every caller here may write the Kanban (TODO #752): what is judged is the override.
      permissions: ['kanban:write', ...caller.permissions], ...(caller.missionId ? { missionId: caller.missionId } : {}),
    } as never;
    next();
  });
  kanbanRoutes.registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    return { status: r.status, json: (await r.json()) as Record<string, unknown> };
  } finally { server.close(); }
}

function post(permissions: string[], missionId: string | undefined, body: Record<string, unknown>): Promise<{ status: number; json: Record<string, unknown> }> {
  return call('POST', '/api/tasks', { permissions, missionId }, { title: 't', agent_name: 'acme.coder', ...body });
}

{
  const { mountOfficialProviders } = await import('../../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test('without the permission a task cannot ask for bypassPermissions, and says why', async () => {
  const before = dbApi.listTasks().length;
  const r = await post([], undefined, { permission_mode_override: 'bypassPermissions' });
  assert.equal(r.status, 403);
  assert.match(String(r.json.reason), /permission_mode override is not allowed: bypassPermissions/);
  assert.equal(dbApi.listTasks().length, before);
});

test('without the permission a safe level still passes', async () => {
  const r = await post([], undefined, { permission_mode_override: 'acceptEdits' });
  assert.equal(r.status, 201);
});

test('with the permission and no mission behind the call, any known level passes', async () => {
  const r = await post(['agents:privileged-config'], undefined, { permission_mode_override: 'bypassPermissions' });
  assert.equal(r.status, 201);
});

test('with the permission, a mission cannot hand out more than its own level', async () => {
  // Assigned to the caller itself: the delegation list is not what this test is about.
  const r = await post(['agents:privileged-config'], lowMission, { agent_name: 'acme.low', permission_mode_override: 'bypassPermissions' });
  assert.equal(r.status, 403);
  assert.match(String(r.json.reason), /above the caller's own level/);
});

test('a codex sandbox name is stored as the mode every dialect understands', async () => {
  // `read-only` kept as is would run unrestricted on grok, which only keeps `plan`.
  const r = await post(['agents:privileged-config'], undefined, { permission_mode_override: 'read-only' });
  assert.equal(r.status, 201);
  const id = (r.json.task as { id: string }).id;
  assert.equal(dbApi.getTask(id)?.permission_mode_override, 'plan');
});

/** A task created by a caller who MAY grant `overrides`: an operator, from the app. */
async function privilegedTask(overrides: Record<string, unknown>): Promise<string> {
  const r = await call('POST', '/api/tasks', { permissions: [], superadmin: true, person: true }, { title: 't', agent_name: 'acme.coder', ...overrides });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return (r.json.task as { id: string }).id;
}

function overrideAudits(): string[] {
  return dbApi.listAuditLog(500).filter((row) => row.action === 'task.override_denied').map((row) => row.target ?? '');
}

test('reassigning a task that carries bypassPermissions is refused to a caller who could not grant it', async () => {
  const id = await privilegedTask({ permission_mode_override: 'bypassPermissions' });
  const audits = overrideAudits().length;
  const r = await call('PUT', `/api/tasks/${id}`, { permissions: [] }, { agent_name: 'acme.other' });
  assert.equal(r.status, 403);
  assert.match(String(r.json.reason), /already carries overrides.*bypassPermissions/);
  assert.equal(dbApi.getTask(id)?.agent_name, 'acme.coder');
  assert.equal(overrideAudits().length, audits + 1);
});

test('reassigning a task whose extra tools the new agent does not declare is refused', async () => {
  const id = await privilegedTask({ extra_allowed_tools: ['Bash'], extra_mcp_servers: ['shell'] });
  const r = await call('PUT', `/api/tasks/${id}`, { permissions: [] }, { agent_name: 'acme.other' });
  assert.equal(r.status, 403);
  assert.match(String(r.json.reason), /already carries extras.*extra_allowed_tools adds Bash/);
  assert.equal(dbApi.getTask(id)?.agent_name, 'acme.coder');
});

test('an empty list in the body keeps the stored tools, so it does not get the reassignment through', async () => {
  // `updateTask` writes an empty list as "unchanged": judging [] would judge nothing.
  const id = await privilegedTask({ extra_allowed_tools: ['Bash'] });
  const r = await call('PUT', `/api/tasks/${id}`, { permissions: [] }, { agent_name: 'acme.other', extra_allowed_tools: [] });
  assert.equal(r.status, 403);
  assert.equal(dbApi.getTask(id)?.agent_name, 'acme.coder');
});

test('a mission cannot reassign a task carrying a level above its own', async () => {
  const id = await privilegedTask({ permission_mode_override: 'bypassPermissions' });
  // To itself: the delegation list is not what this test is about.
  const r = await call('PUT', `/api/tasks/${id}`, { permissions: ['agents:privileged-config'], missionId: lowMission }, { agent_name: 'acme.low' });
  assert.equal(r.status, 403);
  assert.match(String(r.json.reason), /above the caller's own level/);
  assert.equal(dbApi.getTask(id)?.agent_name, 'acme.coder');
});

test('editing a task without reassigning it does not judge what it already carries', async () => {
  const id = await privilegedTask({ permission_mode_override: 'bypassPermissions' });
  const r = await call('PUT', `/api/tasks/${id}`, { permissions: [] }, { title: 'renamed', agent_name: 'acme.coder' });
  assert.equal(r.status, 200);
  assert.equal(dbApi.getTask(id)?.title, 'renamed');
});

test('a task without overrides is reassigned freely', async () => {
  const r0 = await post([], undefined, {});
  const id = (r0.json.task as { id: string }).id;
  const r = await call('PUT', `/api/tasks/${id}`, { permissions: [] }, { agent_name: 'acme.other' });
  assert.equal(r.status, 200);
  assert.equal(dbApi.getTask(id)?.agent_name, 'acme.other');
});

test('the superadmin reassigns a task whatever it carries, from the app', async () => {
  const id = await privilegedTask({ permission_mode_override: 'bypassPermissions', extra_allowed_tools: ['Bash'] });
  const r = await call('PUT', `/api/tasks/${id}`, { permissions: [], superadmin: true, person: true }, { agent_name: 'acme.other' });
  assert.equal(r.status, 200);
  assert.equal(dbApi.getTask(id)?.agent_name, 'acme.other');
});

// ── The task's own fallback (TODO #561) ───────────────────────────────────────

test('without the permission a task cannot get a backend through its fallback, and nothing is written', async () => {
  const before = dbApi.listTasks().length;
  const audits = overrideAudits().length;
  const r = await post([], undefined, { fallback_backend_override: 'codex', fallback_model_override: 'gpt-5.6-sol' });
  assert.equal(r.status, 403);
  assert.match(String(r.json.reason), /fallback_backend_override: backend codex cannot arbitrate/);
  assert.equal(dbApi.listTasks().length, before);
  assert.equal(overrideAudits().length, audits + 1);
});

test('without the permission a fallback that arbitrates each tool use, or none at all, still passes', async () => {
  assert.equal((await post([], undefined, { fallback_backend_override: 'claude', fallback_model_override: 'sonnet' })).status, 201);
  assert.equal((await post([], undefined, { fallback_backend_override: 'none' })).status, 201);
});

test('a fallback model foreign to its backend is refused to a non-operator', async () => {
  const r = await post(['agents:privileged-config'], undefined, { fallback_backend_override: 'claude', fallback_model_override: 'gpt-5.6-sol' });
  assert.equal(r.status, 403);
  assert.match(String(r.json.reason), /not in the catalogue of backend claude/);
});

test('with the permission any known fallback backend passes', async () => {
  const r = await post(['agents:privileged-config'], undefined, { fallback_backend_override: 'codex' });
  assert.equal(r.status, 201);
  assert.equal(dbApi.getTask((r.json.task as { id: string }).id)?.fallback_backend_override, 'codex');
});

test('without the permission a PUT cannot set the fallback either', async () => {
  const r0 = await post([], undefined, {});
  const id = (r0.json.task as { id: string }).id;
  const r = await call('PUT', `/api/tasks/${id}`, { permissions: [] }, { fallback_backend_override: 'codex' });
  assert.equal(r.status, 403);
  assert.equal(dbApi.getTask(id)?.fallback_backend_override, null);
});

test('re-sending the fallback an operator set does not judge it; changing its model does', async () => {
  const id = await privilegedTask({ fallback_backend_override: 'codex' });
  const same = await call('PUT', `/api/tasks/${id}`, { permissions: [] }, { title: 'renamed', fallback_backend_override: 'codex' });
  assert.equal(same.status, 200);
  assert.equal(dbApi.getTask(id)?.title, 'renamed');
  // The model rides the stored backend: a caller who could not pick it cannot retune it.
  const retuned = await call('PUT', `/api/tasks/${id}`, { permissions: [] }, { fallback_model_override: 'gpt-5.6-sol' });
  assert.equal(retuned.status, 403);
  assert.equal(dbApi.getTask(id)?.fallback_model_override, null);
});

test('the superadmin sets any fallback', async () => {
  const r = await call('POST', '/api/tasks', { permissions: [], superadmin: true }, { title: 't', agent_name: 'acme.coder', fallback_backend_override: 'codex' });
  assert.equal(r.status, 201);
});

// Explicit reset sentinels (TODO #750): null stays a no-op for older clients.
const STORED_OVERRIDES = {
  fallback_backend_override: 'codex', fallback_model_override: 'gpt-5.6-sol', permission_mode_override: 'bypassPermissions',
};

test('omitted, null and false reset fields keep the stored overrides', async () => {
  const id = await privilegedTask(STORED_OVERRIDES);
  for (const body of [
    { title: 'renamed' },
    { fallback_backend_override: null, fallback_model_override: null, permission_mode_override: null },
    { clear_fallback: false, clear_permission_mode: false },
  ]) {
    assert.equal((await call('PUT', `/api/tasks/${id}`, { permissions: [] }, body)).status, 200);
    const task = dbApi.getTask(id)!;
    for (const [field, value] of Object.entries(STORED_OVERRIDES)) {
      assert.equal(task[field as keyof typeof STORED_OVERRIDES], value);
    }
  }
});

test('a writer restores the inherited fallback, erasing both halves while keeping the mode', async () => {
  const id = await privilegedTask(STORED_OVERRIDES);
  const r = await call('PUT', `/api/tasks/${id}`, { permissions: [] }, { clear_fallback: true });
  assert.equal(r.status, 200);
  const task = dbApi.getTask(id)!;
  assert.equal(task.fallback_backend_override, null);
  assert.equal(task.fallback_model_override, null);
  assert.equal(task.permission_mode_override, 'bypassPermissions');
  assert.equal((r.json.task as typeof task).fallback_backend_override, null);
});

test('a writer restores the inherited mode without changing the fallback', async () => {
  const id = await privilegedTask(STORED_OVERRIDES);
  const r = await call('PUT', `/api/tasks/${id}`, { permissions: [] }, { clear_permission_mode: true });
  assert.equal(r.status, 200);
  const task = dbApi.getTask(id)!;
  assert.equal(task.permission_mode_override, null);
  assert.equal(task.fallback_backend_override, 'codex');
  assert.equal(task.fallback_model_override, 'gpt-5.6-sol');
});

test('reset sentinels win over values in the same update, also during reassignment', async () => {
  const id = await privilegedTask(STORED_OVERRIDES);
  const r = await call('PUT', `/api/tasks/${id}`, { permissions: [] }, {
    ...STORED_OVERRIDES, agent_name: 'acme.other', clear_fallback: true, clear_permission_mode: true,
  });
  assert.equal(r.status, 200);
  const task = dbApi.getTask(id)!;
  assert.equal(task.agent_name, 'acme.other');
  assert.equal(task.fallback_backend_override, null);
  assert.equal(task.fallback_model_override, null);
  assert.equal(task.permission_mode_override, null);
});

test('resetting a fallback does not hide a forbidden mode and writes nothing', async () => {
  const id = await privilegedTask(STORED_OVERRIDES);
  const audits = overrideAudits().length;
  const r = await call('PUT', `/api/tasks/${id}`, { permissions: [] }, {
    title: 'refused', clear_fallback: true, permission_mode_override: 'bypassPermissions',
  });
  assert.equal(r.status, 403);
  assert.match(String(r.json.reason), /permission_mode override is not allowed/);
  assert.equal(dbApi.getTask(id)?.fallback_backend_override, 'codex');
  assert.equal(dbApi.getTask(id)?.title, 't');
  assert.equal(overrideAudits().length, audits + 1);
});

test('resetting a mode does not hide a forbidden fallback or retained extra tools', async () => {
  const id = await privilegedTask({ permission_mode_override: 'bypassPermissions', extra_allowed_tools: ['Bash'] });
  for (const body of [
    { clear_permission_mode: true, fallback_backend_override: 'codex' },
    { clear_permission_mode: true, agent_name: 'acme.other' },
  ]) {
    assert.equal((await call('PUT', `/api/tasks/${id}`, { permissions: [] }, body)).status, 403);
    assert.equal(dbApi.getTask(id)?.permission_mode_override, 'bypassPermissions');
    assert.equal(dbApi.getTask(id)?.agent_name, 'acme.coder');
  }
});

test('false reset flags do not bypass override checks', async () => {
  const id = await privilegedTask({});
  assert.equal((await call('PUT', `/api/tasks/${id}`, { permissions: [] }, {
    clear_fallback: false, fallback_backend_override: 'codex',
  })).status, 403);
  assert.equal((await call('PUT', `/api/tasks/${id}`, { permissions: [] }, {
    clear_permission_mode: false, permission_mode_override: 'bypassPermissions',
  })).status, 403);
});

test('resetting a never-fallback or an orphan model erases both fallback columns', async () => {
  for (const overrides of [{ fallback_backend_override: 'none' }, { fallback_model_override: 'old-model' }]) {
    const id = await privilegedTask(overrides);
    assert.equal((await call('PUT', `/api/tasks/${id}`, { permissions: [] }, { clear_fallback: true })).status, 200);
    assert.equal(dbApi.getTask(id)?.fallback_backend_override, null);
    assert.equal(dbApi.getTask(id)?.fallback_model_override, null);
  }
});
