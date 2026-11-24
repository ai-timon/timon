/**
 * The extras of a routine (`extra_mcp_servers`, `extra_skills`,
 * `extra_allowed_tools`) go to a task at every tick, and that task then starts
 * like one a person wrote. So the save applies `kanban_add`'s rule: from an
 * agent's token, no tool and no stdio MCP server the agent does not already
 * hold; a person sets any of them. The body goes through zod first.
 *
 * Real auth middleware, isolated TIMON_HOME, witness on :0. Callers: a mission
 * of the superadmin, the superadmin's browser session, the daemon-token and
 * nobody.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-routine-extras-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.TIMON_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { mountOfficialProviders } = await import('../../../tests/helpers/official-providers.js');
await mountOfficialProviders();
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerAgentRoutes } = await import('../agents/routes.js');
const { registerRoutes: registerRoutineRoutes } = await import('./routes.js');
const { registerRoutes: registerTriggerRoutes } = await import('../triggers/routes.js');
const { dbApi } = await import('../../db.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { SESSION_COOKIE, hashSessionToken, issueSessionToken } = await import('../../users/session.js');

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerAgentRoutes(app);
registerRoutineRoutes(app);
registerTriggerRoutes(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

type Caller = { bearer: string } | { cookie: string } | null;
type Result = { status: number; json: Record<string, unknown> };

async function call(method: string, path: string, caller: Caller, body?: unknown): Promise<Result> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (caller && 'bearer' in caller) headers.authorization = `Bearer ${caller.bearer}`;
  if (caller && 'cookie' in caller) headers.cookie = caller.cookie;
  const res = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = text ? JSON.parse(text) as Record<string, unknown> : {}; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

const setup = await call('POST', '/api/auth/setup', null, { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' });
assert.equal(setup.status, 201);
const adminId = (setup.json as { user: { id: string } }).user.id;

const sessionToken = issueSessionToken();
dbApi.createSession({
  tokenHash: hashSessionToken(sessionToken),
  userId: adminId,
  expiresAt: Date.now() + 3_600_000,
  userAgent: null,
  createdAt: Date.now(),
});
const person: Caller = { cookie: `${SESSION_COOKIE}=${sessionToken}` };
const operator: Caller = { bearer: TOKEN };

async function seedAgent(name: string, config: Record<string, unknown>): Promise<void> {
  const r = await call('POST', '/api/agents', operator, { name, system_prompt: 'p', config });
  assert.equal(r.status, 200, JSON.stringify(r.json));
}

// A command on the host and an http server, both declared by a person.
assert.equal((await call('POST', '/api/mcp', operator, { id: 'mail-stdio', transport: { type: 'stdio', command: 'sh' } })).status, 200);
assert.equal((await call('POST', '/api/mcp', operator, { id: 'remote-docs', transport: { type: 'http', url: 'https://mcp.example.com/docs' } })).status, 200);

await seedAgent('caller.pilot', { backend: 'claude', permission_mode: 'bypassPermissions', role: 'orchestrator' });
await seedAgent('caller.assistant', { mcp_servers: ['mail-stdio'], allowed_tools: ['Read'] });
await seedAgent('caller.plain', {});
const missionId = randomUUID();
dbApi.createMission(missionId, 'caller.pilot', 'work', undefined, adminId);
const mission: Caller = { bearer: issueMissionApiToken(missionId) };

const routine = (agent: string, extras: Record<string, unknown>) => ({
  name: 'Inbox', agent_name: agent, prompt: 'Sort the inbox.', cron_expr: '0 8 * * *', ...extras,
});

test('anonymous is refused before anything is read', async () => {
  assert.equal((await call('POST', '/api/routines', null, routine('caller.plain', { extra_mcp_servers: ['mail-stdio'] }))).status, 401);
});

test('a person gives a routine a stdio server its agent does not hold', async () => {
  const r = await call('POST', '/api/routines', person, routine('caller.plain', { extra_mcp_servers: ['mail-stdio'], extra_allowed_tools: ['Bash'] }));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const row = r.json.routine as { id: string; extra_mcp_servers: string; extra_allowed_tools: string };
  assert.equal(row.extra_mcp_servers, '["mail-stdio"]');
  assert.equal(row.extra_allowed_tools, '["Bash"]');
});

test('a mission cannot hand a routine a stdio server its agent does not hold', async () => {
  const before = dbApi.listRoutines().length;
  const r = await call('POST', '/api/routines', mission, routine('caller.plain', { extra_mcp_servers: ['mail-stdio'] }));
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.match(String(r.json.reason), /extra_mcp_servers attaches mail-stdio/);
  assert.equal(dbApi.listRoutines().length, before, 'nothing was saved');
  const audit = dbApi.listAuditLog().find((row) => row.action === 'routine.override_denied');
  assert.ok(audit, 'the refusal is audited');
});

test('a mission cannot add a tool through a routine either', async () => {
  const r = await call('POST', '/api/routines', mission, routine('caller.assistant', { extra_allowed_tools: ['Bash'] }));
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.match(String(r.json.reason), /extra_allowed_tools adds Bash/);
});

test('a mission passes on what its agent already holds, and an http server', async () => {
  const r = await call('POST', '/api/routines', mission, routine('caller.assistant', { extra_mcp_servers: ['mail-stdio', 'remote-docs'] }));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const row = r.json.routine as { id: string; extra_mcp_servers: string; enabled: number };
  assert.equal(row.extra_mcp_servers, '["mail-stdio","remote-docs"]');
  assert.equal(row.enabled, 0, 'an agent\'s routine is born switched off');
});

test('handing a routine to another agent judges its extras against that agent', async () => {
  const created = await call('POST', '/api/routines', person, routine('caller.assistant', { extra_mcp_servers: ['mail-stdio'] }));
  const id = (created.json.routine as { id: string }).id;
  // Re-sending what it already carries grants nothing new.
  const kept = await call('PUT', `/api/routines/${id}`, mission, { prompt: 'Sort it again.', extra_mcp_servers: ['mail-stdio'] });
  assert.equal(kept.status, 200, JSON.stringify(kept.json));
  const moved = await call('PUT', `/api/routines/${id}`, mission, { agent_name: 'caller.plain' });
  assert.equal(moved.status, 403, JSON.stringify(moved.json));
  assert.match(String(moved.json.reason), /extra_mcp_servers attaches mail-stdio/);
  assert.equal(dbApi.getRoutine(id)?.agent_name, 'caller.assistant');
});

test('a mission that changes the extras of an enabled routine switches it off', async () => {
  const created = await call('POST', '/api/routines', person, routine('caller.assistant', { extra_mcp_servers: ['mail-stdio'] }));
  const id = (created.json.routine as { id: string; enabled: number }).id;
  assert.equal(dbApi.getRoutine(id)?.enabled, 1);
  const cleared = await call('PUT', `/api/routines/${id}`, mission, { extra_mcp_servers: [] });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.json));
  assert.equal(cleared.json.needs_activation, true);
  const row = dbApi.getRoutine(id)!;
  assert.equal(row.enabled, 0);
  assert.equal(row.extra_mcp_servers, null);
});

test('a malformed extras list is a 400 that names the field', async () => {
  const r = await call('POST', '/api/routines', person, routine('caller.plain', { extra_mcp_servers: 'mail-stdio' }));
  assert.equal(r.status, 400, JSON.stringify(r.json));
  assert.match(String(r.json.error), /extra_mcp_servers/);
});

test('the Triggers route cannot hand a routine and its extras to another agent either', async () => {
  const created = await call('POST', '/api/routines', person, routine('caller.assistant', { extra_mcp_servers: ['mail-stdio'] }));
  const id = (created.json.routine as { id: string }).id;
  const action = { type: 'task', prompt: 'Sort the inbox.', task_type: 'chore', raw: true };
  const moved = await call('PATCH', `/api/triggers/${id}`, mission, { actions: [{ ...action, agent: 'caller.plain' }] });
  assert.equal(moved.status, 403, JSON.stringify(moved.json));
  assert.match(String(moved.json.reason), /extra_mcp_servers attaches mail-stdio/);
  assert.equal(dbApi.getRoutine(id)?.agent_name, 'caller.assistant');
  const kept = await call('PATCH', `/api/triggers/${id}`, mission, { actions: [{ ...action, agent: 'caller.assistant', prompt: 'Sort it.' }] });
  assert.equal(kept.status, 200, JSON.stringify(kept.json));
});
