/**
 * POST /api/agent-trash/:id/restore (TODO #527) recreates an agent, so it obeys
 * what creating it would: a caller holding `agents:manage` but not
 * `agents:privileged-config` cannot bring back tools, MCP servers or a
 * permission level it could not have set itself; an agent cannot bring back
 * delegation rights; a mission in a team only sees and restores its team's
 * trashed agents. The operator restores anything.
 *
 * Real auth middleware, isolated TIMON_HOME, witness on :0.
 */
import { mkdirSync, mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-agent-trash-guard-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
delete process.env.TIMON_AGENT_TRASH_ENABLED;
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.TIMON_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
await import('../../../tests/helpers/claude-provider.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgentRoutes } = await import('./routes.js');
const { agentDir } = await import('../../paths.js');
const { dbApi } = await import('../../db.js');
const { listAgentTrash } = await import('../../agent-trash.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerAgentRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);
const adminId = (setup.json as { user: { id: string } }).user.id;

// Holds `agents:manage` (create, delete, restore) but NOT `agents:privileged-config`.
const made = await postTestAccount(dbApi, { email: 'mgr@example.com', name: 'Manager', password: 'mgr-secret' });
assert.equal(made.status, 201);
const managerId = (made.json as { user: { id: string } }).user.id;
grantTestPermissions(dbApi, managerId, ['agents:manage', 'agents:read']);

/** Written on disk, as an administrator (or a hand edit) left it. */
function seed(name: string, config: Record<string, unknown>): void {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'system-prompt.md'), `prompt of ${name}`);
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify(config));
}

function missionToken(agent: string, userId: string): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'work', undefined, userId);
  return issueMissionApiToken(id);
}

/** Seeds an agent, deletes it as the operator, returns its trash id. */
async function trashed(name: string, config: Record<string, unknown>): Promise<string> {
  seed(name, config);
  const del = await call('DELETE', `/api/agents/${encodeURIComponent(name)}`, { bearer: TOKEN });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  assert.equal(existsSync(agentDir(name)), false);
  return String(del.json.trash_id);
}

const restore = (id: string, bearer: string): Promise<Result> =>
  call('POST', `/api/agent-trash/${encodeURIComponent(id)}/restore`, { bearer });

function assertRefused(r: Result, id: string, name: string, needle: RegExp): void {
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.match(String(r.json.reason ?? ''), needle);
  assert.equal(existsSync(agentDir(name)), false, 'the agent stays in the trash');
  assert.ok(listAgentTrash().some((e) => e.id === id), 'the entry is kept');
}

seed('caller.mgr', { role: 'coder' });
seed('caller.admin', { role: 'coder', permission_mode: 'auto' });
seed('caller.team-b', { role: 'coder', team: 'tm-b' });
const managerMission = missionToken('caller.mgr', managerId);
const adminMission = missionToken('caller.admin', adminId);
const teamBMission = missionToken('caller.team-b', managerId);

test('a manager mission cannot restore an agent with MCP servers or tools nobody gave it', async () => {
  const id = await trashed('risky.mcp', { role: 'coder', mcp_servers: ['host-shell'] });
  assertRefused(await restore(id, managerMission), id, 'risky.mcp', /mcp_servers attaches host-shell.*stdio.*Agents page/);

  const tools = await trashed('risky.tools', { role: 'coder', allowed_tools: ['Bash'] });
  assertRefused(await restore(tools, managerMission), tools, 'risky.tools', /allowed_tools adds Bash.*Agents page/);
});

test('a manager mission cannot restore a permission level above the safe ones', async () => {
  const id = await trashed('risky.bypass', { role: 'coder', permission_mode: 'bypassPermissions' });
  assertRefused(await restore(id, managerMission), id, 'risky.bypass', /permission_mode.*bypassPermissions/);
});

test('even a privileged mission cannot restore an agent above its own level', async () => {
  const id = listAgentTrash().find((e) => e.name === 'risky.bypass')?.id;
  assert.ok(id);
  assertRefused(await restore(id, adminMission), id, 'risky.bypass', /above the caller's own level/);
});

test('an agent cannot restore an agent holding delegation rights', async () => {
  const id = await trashed('risky.chief', { role: 'coder', orchestrates: '*' });
  assertRefused(await restore(id, adminMission), id, 'risky.chief', /delegation rights/);
  const flag = await trashed('risky.flag', { role: 'coder', orchestrator: true });
  assertRefused(await restore(flag, managerMission), flag, 'risky.flag', /delegation rights/);
});

test('a bare agent comes back from a manager mission: nothing is granted', async () => {
  const id = await trashed('plain', { role: 'coder' });
  const r = await restore(id, managerMission);
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.ok(existsSync(join(agentDir('plain'), 'system-prompt.md')));
});

test('a mission in a team neither lists nor restores another team\'s trashed agent', async () => {
  const id = await trashed('other.team', { role: 'coder', team: 'tm-a' });
  const listed = await call('GET', '/api/agent-trash', { bearer: teamBMission });
  assert.equal(listed.status, 200);
  const names = (listed.json.entries as Array<{ name: string }>).map((e) => e.name);
  assert.ok(!names.includes('other.team'), `hidden from team tm-b: ${names.join(', ')}`);
  assert.equal((await restore(id, teamBMission)).status, 404);
  assert.equal(existsSync(agentDir('other.team')), false);

  const unteamed = await call('GET', '/api/agent-trash', { bearer: managerMission });
  assert.ok((unteamed.json.entries as Array<{ name: string }>).some((e) => e.name === 'other.team'));
});

test('the operator restores what a mission was refused', async () => {
  for (const name of ['risky.mcp', 'risky.bypass', 'risky.chief']) {
    const id = listAgentTrash().find((e) => e.name === name)?.id;
    assert.ok(id, name);
    const r = await restore(id, TOKEN);
    assert.equal(r.status, 200, JSON.stringify(r.json));
    assert.ok(existsSync(agentDir(name)));
  }
});
