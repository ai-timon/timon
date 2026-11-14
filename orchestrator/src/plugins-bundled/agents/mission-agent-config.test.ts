/**
 * An agent in a mission calls `agent_create` / `agent_update` (POST /api/agents,
 * PATCH /api/agents/:name/config) with a mission token. The secu-4 guard bounds
 * what it may put in the config; what it must NOT do is refuse a request that
 * grants nothing the caller does not already hold (two beta testers, 0.1.4).
 *
 * Callers: a superadmin's mission (relaxed, capped by its own permission mode)
 * and a delegated manager's mission without `agents:privileged-config`
 * (restricted). Real auth middleware, isolated TIMON_HOME, witness on :0.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-agent-config-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.TIMON_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { mountOfficialProviders, stubCliBinaries } = await import('../../../tests/helpers/official-providers.js');
await stubCliBinaries('grok');
await mountOfficialProviders();
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgentRoutes } = await import('./routes.js');
const { registerRoutes: registerProjectRoutes } = await import('../projects/routes.js');
const { dbApi } = await import('../../db.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { catalogBackend } = await import('../../backends/catalog.js');

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerAgentRoutes(app);
registerProjectRoutes(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

type Result = { status: number; json: Record<string, unknown> };

async function call(method: string, path: string, opts: { body?: unknown; bearer?: string } = {}): Promise<Result> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const reasonOf = (r: Result): string => String(r.json.reason ?? '');
function assertOk(r: Result): void { assert.equal(r.status, 200, JSON.stringify(r.json)); }
function assertDenied(r: Result, needle: RegExp): void {
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.match(reasonOf(r), needle);
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);
const adminId = (setup.json as { user: { id: string } }).user.id;

// A manager who holds the route permissions but NOT `agents:privileged-config`:
// the case the guard keeps bounded.
const made = await postTestAccount(dbApi, { email: 'mgr@example.com', name: 'Manager', password: 'mgr-secret' });
assert.equal(made.status, 201);
const managerId = (made.json as { user: { id: string } }).user.id;
grantTestPermissions(dbApi, managerId, ['agents:manage', 'projects:manage', 'missions:read']);

/** A running mission of `agent`, and the token its CLI would carry. */
function missionToken(agent: string, userId: string): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'work', undefined, userId);
  return issueMissionApiToken(id);
}

async function seedAgent(name: string, config: Record<string, unknown>): Promise<void> {
  assertOk(await call('POST', '/api/agents', { bearer: TOKEN, body: { name, system_prompt: 'p', config } }));
}

assert.ok(catalogBackend('codex'), 'the catalogue must hold the codex backend');

const projectDir = mkdtempSync(join(tmpdir(), 'timon-mission-agent-project-'));
const subDir = join(projectDir, 'packages', 'api');
mkdirSync(subDir, { recursive: true });
const outsideDir = mkdtempSync(join(tmpdir(), 'timon-mission-agent-outside-'));
dbApi.upsertProject('known', { cwd: projectDir });

// Callers. The permission mode of the calling agent is its ceiling.
await seedAgent('caller.codex', { backend: 'codex' });
await seedAgent('caller.codex-ws', { backend: 'codex', permission_mode: 'workspace-write' });
await seedAgent('caller.codex-ro', { backend: 'codex', permission_mode: 'read-only' });
await seedAgent('caller.claude-plan', { backend: 'claude', permission_mode: 'plan' });
await seedAgent('caller.claude-auto', { backend: 'claude', permission_mode: 'auto' });
await seedAgent('caller.claude', { backend: 'claude' });
const codex = missionToken('caller.codex', adminId);
const codexWs = missionToken('caller.codex-ws', adminId);
const codexRo = missionToken('caller.codex-ro', adminId);
const claudePlan = missionToken('caller.claude-plan', adminId);
const claudeAuto = missionToken('caller.claude-auto', adminId);
const claude = missionToken('caller.claude', adminId);
const manager = missionToken('caller.claude-auto', managerId);

let counter = 0;
const fresh = (): string => `child.agent-${++counter}`;
const create = (bearer: string, config: Record<string, unknown>, name = fresh()): Promise<Result> =>
  call('POST', '/api/agents', { bearer, body: { name, system_prompt: 'p', config } });

/* ─── 1 · the codex mode family ──────────────────────────────────────────── */

test('a codex agent with no mode of its own may create an agent in a codex mode', async () => {
  // It runs in the workspace sandbox: that is its real level, not `default`.
  assertOk(await create(codex, { backend: 'codex', permission_mode: 'workspace-write' }));
  assertOk(await create(codex, { backend: 'codex', permission_mode: 'read-only' }));
  assertOk(await create(codex, { backend: 'codex', permission_mode: 'auto' }));
});

test('the codex modes sit on the same ladder as the claude ones', async () => {
  // workspace-write ≈ auto: a workspace-write agent hands out auto and below.
  assertOk(await create(codexWs, { permission_mode: 'workspace-write' }));
  assertOk(await create(codexWs, { permission_mode: 'auto' }));
  assertOk(await create(codexWs, { permission_mode: 'acceptEdits' }));
  assertOk(await create(codexWs, { permission_mode: 'read-only' }));
  assertDenied(await create(codexWs, { permission_mode: 'bypassPermissions' }), /above the caller's own level/);
  assertDenied(await create(codexWs, { permission_mode: 'danger-full-access' }), /above the caller's own level/);
  // read-only ≈ plan: nothing but plan / read-only comes out of it.
  assertOk(await create(codexRo, { permission_mode: 'read-only' }));
  assertOk(await create(codexRo, { permission_mode: 'plan' }));
  assertDenied(await create(codexRo, { permission_mode: 'workspace-write' }), /above the caller's own level/);
  assertDenied(await create(codexRo, { permission_mode: 'default' }), /above the caller's own level/);
  // plan ≈ read-only, the other way round.
  assertOk(await create(claudePlan, { permission_mode: 'read-only' }));
  assertDenied(await create(claudePlan, { permission_mode: 'workspace-write' }), /above/);
});

test('a codex mode is never a way up past the caller, and a typo is still refused', async () => {
  assertDenied(await create(claudeAuto, { permission_mode: 'danger-full-access' }), /above the caller's own level/);
  assertOk(await create(claudeAuto, { permission_mode: 'workspace-write' }));
  assertDenied(await create(claude, { permission_mode: 'workspace-write' }), /above the caller's own level/);
  assertDenied(await create(codex, { permission_mode: 'workspace_write' }), /not a known permission mode/);
  assertDenied(await create(codex, { permission_mode: '' }), /not a known permission mode/);
});

test('a manager without agents:privileged-config stays bounded, codex modes included', async () => {
  assertDenied(await create(manager, { permission_mode: 'workspace-write' }), /not allowed: workspace-write.*agents:privileged-config/);
  assertDenied(await create(manager, { permission_mode: 'bypassPermissions' }), /not allowed/);
  assertDenied(await create(manager, { backend: 'codex' }), /cannot arbitrate.*agents:privileged-config/);
  assertOk(await create(manager, { permission_mode: 'auto' }));
});

test('a sandbox name is stored as the mode every backend understands', async () => {
  // grok keeps only `plan` and runs the rest in bypassPermissions; claude rejects the sandbox
  // names at spawn. A caller capped at `plan` must therefore never store `read-only` raw.
  const readOnly = fresh();
  assertOk(await create(claudePlan, { backend: 'grok', permission_mode: 'read-only' }, readOnly));
  assert.equal((await call('GET', `/api/agents/${readOnly}`, { bearer: TOKEN })).json.permission_mode, 'plan');
  const writable = fresh();
  assertOk(await create(claudeAuto, { permission_mode: 'workspace-write' }, writable));
  assert.equal((await call('GET', `/api/agents/${writable}`, { bearer: TOKEN })).json.permission_mode, 'auto');
  await seedAgent('child.stored', {});
  assertDenied(
    await call('PATCH', '/api/agents/child.stored/config', { bearer: codexWs, body: { permission_mode: 'danger-full-access' } }),
    /above the caller's own level/,
  );
  assertOk(await call('PATCH', '/api/agents/child.stored/config', { bearer: codexWs, body: { permission_mode: 'read-only' } }));
  assert.equal((await call('GET', '/api/agents/child.stored', { bearer: TOKEN })).json.permission_mode, 'plan');
});

test('a codex-mode PATCH on an existing agent follows the same ladder', async () => {
  await seedAgent('child.patched', { backend: 'codex' });
  assertOk(await call('PATCH', '/api/agents/child.patched/config', { bearer: codex, body: { permission_mode: 'workspace-write' } }));
  assertDenied(
    await call('PATCH', '/api/agents/child.patched/config', { bearer: codex, body: { permission_mode: 'danger-full-access' } }),
    /above the caller's own level/,
  );
});

/* ─── 2 · the ceiling is the caller's effective level ───────────────────── */

test('no permission_mode on a claude agent means `default`, which hands out nothing above it', async () => {
  assertOk(await create(claude, { permission_mode: 'default' }));
  assertOk(await create(claude, { permission_mode: 'plan' }));
  assertDenied(await create(claude, { permission_mode: 'acceptEdits' }), /above the caller's own level \(default\)/);
});

test('a mission override of the permission mode is the ceiling, not the agent config', async () => {
  const id = randomUUID();
  dbApi.createMission(id, 'caller.claude-auto', 'work', undefined, adminId);
  dbApi.setMissionPermissionModeOverride(id, 'plan');
  const token = issueMissionApiToken(id);
  assertDenied(await create(token, { permission_mode: 'auto' }), /above the caller's own level \(plan\)/);
  assertOk(await create(token, { permission_mode: 'plan' }));
});

/* ─── 3 · cwd: register the project, then point the agent at it ─────────── */

test('a project created in the same mission is a valid cwd for an agent, and so is a sub-folder', async () => {
  for (const token of [claudeAuto, manager]) {
    const dir = mkdtempSync(join(tmpdir(), 'timon-mission-agent-new-project-'));
    const sub = join(dir, 'src');
    mkdirSync(sub);
    assertOk(await call('POST', '/api/projects', { bearer: token, body: { slug: `fresh-${++counter}`, cwd: dir } }));
    assertOk(await create(token, { cwd: dir }));
    assertOk(await create(token, { cwd: sub }));
  }
});

test('a cwd outside every project is refused with what to do about it', async () => {
  const refused = await create(claudeAuto, { cwd: outsideDir });
  assertDenied(refused, /register the project first/i);
  assert.match(reasonOf(refused), /project_create/);
  assert.match(reasonOf(refused), new RegExp(outsideDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // A sibling that merely shares the prefix of a project is not inside it.
  const sibling = `${projectDir}-sibling`;
  mkdirSync(sibling);
  assertDenied(await create(claudeAuto, { cwd: sibling }), /register the project first/i);
});

/* ─── 4 · allowed_tools / mcp_servers ───────────────────────────────────── */

test('no mission token adds a tool or an undeclared MCP server, relaxed or not', async () => {
  // The maintainer's decision of 08/11/2026: a person does it, from the app.
  for (const bearer of [claudeAuto, manager]) {
    const tools = await create(bearer, { allowed_tools: ['Bash(git:*)'] });
    assertDenied(tools, /allowed_tools adds Bash\(git:\*\)/);
    assert.match(reasonOf(tools), /Agents page/);
    const mcp = await create(bearer, { mcp_servers: ['anything'] });
    assertDenied(mcp, /mcp_servers attaches anything/);
  }
});

/* ─── 5 · a field that does not change is never refused ─────────────────── */

test('a full upsert that sends the current config back is not an elevation, but its prompt rewrite is', async () => {
  // An agent an admin configured above anything the caller may hand out: a
  // codex sandbox agent, in a directory no project covers, on a model the
  // catalogue does not list.
  await seedAgent('legacy.codex', {
    backend: 'codex', model: 'gpt-custom-unlisted', permission_mode: 'danger-full-access',
    cwd: outsideDir, allowed_tools: ['Bash'], mcp_servers: ['ext-thing'],
  });
  const current = (await call('GET', '/api/agents/legacy.codex', { bearer: TOKEN })).json;
  // What `agent_update --system_prompt` sends: the whole current config, null/empty dropped.
  const merged: Record<string, unknown> = {};
  for (const key of ['backend', 'model', 'permission_mode', 'cwd', 'allowed_tools', 'mcp_servers']) {
    if (current[key] !== null && current[key] !== undefined) merged[key] = current[key];
  }
  // The config fields are unchanged, so none of them is an elevation — but the
  // same upsert also rewrites the prompt of an agent that runs above every
  // caller here (danger-full-access), and that is refused (secu-4, point 2 bis).
  for (const bearer of [manager, claude, claudePlan]) {
    const r = await call('POST', '/api/agents', { bearer, body: { name: 'legacy.codex', system_prompt: 'new prompt', config: merged } });
    assertDenied(r, /above the caller's own level/);
  }
  // Re-saved as it was, not rewritten behind the administrator's back.
  assert.equal((await call('GET', '/api/agents/legacy.codex', { bearer: TOKEN })).json.permission_mode, 'danger-full-access');
  // …and the same value through PATCH (config only, no prompt) is still a no-op.
  for (const bearer of [manager, claude]) {
    assertOk(await call('PATCH', '/api/agents/legacy.codex/config', {
      bearer, body: { permission_mode: 'danger-full-access', backend: 'codex', cwd: outsideDir, model: 'gpt-custom-unlisted' },
    }));
  }
});

test('an unchanged field does not excuse a changed one', async () => {
  mkdirSync(join(outsideDir, 'elsewhere'));
  const stillDenied = await call('PATCH', '/api/agents/legacy.codex/config', {
    bearer: claude, body: { permission_mode: 'danger-full-access', cwd: join(outsideDir, 'elsewhere') },
  });
  assert.equal(stillDenied.status, 403, JSON.stringify(stillDenied.json));
  const elevated = await call('PATCH', '/api/agents/legacy.codex/config', {
    bearer: claude, body: { cwd: outsideDir, permission_mode: 'workspace-write', model: 'another-unlisted' },
  });
  assert.equal(elevated.status, 403, JSON.stringify(elevated.json));
});

test('an agent that declares no backend is not refused for the default backend echoed back', async () => {
  await seedAgent('plain.agent', { permission_mode: 'default' });
  const current = (await call('GET', '/api/agents/plain.agent', { bearer: TOKEN })).json;
  assert.ok(current.backend, 'GET /api/agents/:name reports the effective backend');
  assertOk(await call('POST', '/api/agents', {
    bearer: manager,
    body: { name: 'plain.agent', system_prompt: 'new', config: { backend: current.backend, permission_mode: 'default' } },
  }));
});
