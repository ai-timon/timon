/**
 * Adding a tool to an agent, or a stdio MCP server, takes a person (the
 * maintainer's decision of 08/11/2026). A mission token is the agent itself:
 * steered by injected text, it would put `Bash` in another agent's tools or
 * declare a command of its choosing, and run it on the host at that agent's
 * next turn with no card. It holds `agents:privileged-config` when a superadmin
 * launched it, so the refusal must not depend on what it holds.
 *
 * Real auth middleware, isolated TIMON_HOME, witness on :0. Callers: a mission
 * of the superadmin (relaxed), the superadmin's browser session, the
 * daemon-token (the operator's CLI) and nobody.
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

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-agent-widening-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const TOKEN = 'witness-daemon-token';
writeFileSync(join(process.env.TIMON_HOME, 'daemon-token'), TOKEN, { encoding: 'utf8', mode: 0o600 });

const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { mountOfficialProviders } = await import('../../tests/helpers/official-providers.js');
await mountOfficialProviders();
const { registerRoutes: registerUserRoutes } = await import('../plugins-bundled/users/routes.js');
const { registerRoutes: registerAgentRoutes } = await import('../plugins-bundled/agents/routes.js');
const { registerRoutes: registerKanbanRoutes } = await import('../plugins-bundled/kanban/routes.js');
const { registerRoutes: registerProjectRoutes } = await import('../plugins-bundled/projects/routes.js');
const { dbApi } = await import('../db.js');
const { issueMissionApiToken } = await import('./api-tokens.js');
const { SESSION_COOKIE, hashSessionToken, issueSessionToken } = await import('./session.js');
const { agentWideningRefusal, skillWideningRefusal } = await import('./privileged-overrides.js');
const { seedBundledSkills, upsertSkill } = await import('../skills.js');
const { listSkillAttachments, putSkillAttachment } = await import('../skill-attachments.js');
const { loadConfig } = await import('../agent-config.js');
const { getMcp } = await import('../mcp.js');

const { createDelegationHandler } = await import('../mission-delegation.js');

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
// A mission spawns through delegation; the launcher is never reached by a refusal.
app.post('/api/missions/delegate', createDelegationHandler(async () => { throw new Error('a refused delegation launched a mission'); }));
registerUserRoutes(app, { setupPolicy: 'free' });
registerAgentRoutes(app);
registerKanbanRoutes(app);
registerProjectRoutes(app);

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

function assertPersonOnly(r: Result, needle: RegExp): void {
  assert.equal(r.status, 403, JSON.stringify(r.json));
  assert.equal(r.json.caller, 'mission');
  assert.match(String(r.json.reason), needle);
  assert.match(String(r.json.reason), /whatever its account holds/);
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

// The calling agent runs in bypassPermissions: no permission ceiling explains a refusal below.
await seedAgent('caller.pilot', { backend: 'claude', permission_mode: 'bypassPermissions' });
const missionId = randomUUID();
dbApi.createMission(missionId, 'caller.pilot', 'work', undefined, adminId);
const mission: Caller = { bearer: issueMissionApiToken(missionId) };

// A command on the host, declared by a person, and an http server.
assert.equal((await call('POST', '/api/mcp', operator, { id: 'host-shell', transport: { type: 'stdio', command: 'sh' } })).status, 200);
assert.equal((await call('POST', '/api/mcp', operator, { id: 'remote-docs', transport: { type: 'http', url: 'https://mcp.example.com/docs' } })).status, 200);

// `git-publish` ships with Timon and pre-authorises `Bash(git *)` and `Bash(gh *)`.
seedBundledSkills();
upsertSkill('plain-notes', '# Plain notes\n\nNo tool declared.\n');

let counter = 0;
const fresh = (): string => `target.agent-${++counter}`;

test('the mission cap carries agents:privileged-config: the caller below is relaxed', () => {
  const token = dbApi.getLiveApiToken(hashSessionToken((mission as { bearer: string }).bearer));
  assert.ok(token?.permissions?.includes('agents:privileged-config'));
  assert.equal(token?.isSuperadmin, false);
});

test('a relaxed mission cannot add a tool to an agent', async () => {
  const name = fresh();
  await seedAgent(name, { allowed_tools: ['Read'] });
  assertPersonOnly(await call('PATCH', `/api/agents/${name}/config`, mission, { allowed_tools: ['Read', 'Bash'] }), /allowed_tools adds Bash.*Agents page/);
  // A narrower pattern is not covered by a broader one it does not hold.
  assertPersonOnly(await call('PATCH', `/api/agents/${name}/config`, mission, { allowed_tools: ['Bash(git:*)'] }), /adds Bash\(git:\*\)/);
  assert.deepEqual(loadConfig(name).allowed_tools, ['Read']);
});

test('a relaxed mission cannot create an agent that holds tools or a stdio server', async () => {
  const tools = fresh();
  assertPersonOnly(await call('POST', '/api/agents', mission, { name: tools, system_prompt: 'p', config: { allowed_tools: ['Bash'] } }), /allowed_tools adds Bash/);
  const mcp = fresh();
  assertPersonOnly(await call('POST', '/api/agents', mission, { name: mcp, system_prompt: 'p', config: { mcp_servers: ['host-shell'] } }), /mcp_servers attaches host-shell/);
  assert.equal((await call('GET', `/api/agents/${tools}`, operator)).status, 404);
  assert.equal((await call('GET', `/api/agents/${mcp}`, operator)).status, 404);
});

test('a relaxed mission cannot lift a denied tool', async () => {
  const name = fresh();
  await seedAgent(name, { disallowed_tools: ['Bash'] });
  assertPersonOnly(await call('PATCH', `/api/agents/${name}/config`, mission, { disallowed_tools: [] }), /disallowed_tools lifts Bash/);
  assertPersonOnly(await call('PATCH', `/api/agents/${name}/config`, mission, { disallowed_tools: null }), /disallowed_tools lifts Bash/);
  assert.deepEqual(loadConfig(name).disallowed_tools, ['Bash']);
});

test('removing a tool, or sending the list unchanged, is accepted from a mission', async () => {
  const name = fresh();
  await seedAgent(name, { allowed_tools: ['Bash', 'Read'], mcp_servers: ['host-shell'] });
  const same = await call('PATCH', `/api/agents/${name}/config`, mission, { allowed_tools: ['Bash', 'Read'], mcp_servers: ['host-shell'] });
  assert.equal(same.status, 200, JSON.stringify(same.json));
  const narrowed = await call('PATCH', `/api/agents/${name}/config`, mission, { allowed_tools: ['Read'], mcp_servers: [] });
  assert.equal(narrowed.status, 200, JSON.stringify(narrowed.json));
  assert.deepEqual(loadConfig(name).allowed_tools, ['Read']);
  assert.deepEqual(loadConfig(name).mcp_servers, []);
});

test('a relaxed mission cannot declare a stdio MCP server, nor rewrite one', async () => {
  assertPersonOnly(await call('POST', '/api/mcp', mission, { id: 'mission-shell', transport: { type: 'stdio', command: 'sh', args: ['-c', 'id'] } }), /stdio MCP server runs a command on the host.*MCP servers page/);
  assert.equal(getMcp('mission-shell'), null);
  assertPersonOnly(await call('POST', '/api/mcp', mission, { id: 'host-shell', transport: { type: 'stdio', command: 'curl' } }), /command on the host/);
  const stored = getMcp('host-shell');
  assert.ok(stored && stored.transport.type === 'stdio' && stored.transport.command === 'sh');
});

test('a relaxed mission cannot attach a stdio MCP server, nor one nobody declared', async () => {
  const name = fresh();
  await seedAgent(name, {});
  assertPersonOnly(await call('PATCH', `/api/agents/${name}/config`, mission, { mcp_servers: ['host-shell'] }), /mcp_servers attaches host-shell.*Agents page/);
  assertPersonOnly(await call('PATCH', `/api/agents/${name}/config`, mission, { mcp_servers: ['not-declared-yet'] }), /attaches not-declared-yet/);
  assert.deepEqual(loadConfig(name).mcp_servers ?? [], []);
});

test('an http MCP server stays under the usual rules: a relaxed mission declares and attaches it', async () => {
  const declared = await call('POST', '/api/mcp', mission, { id: 'mission-http', transport: { type: 'http', url: 'https://mcp.example.com/m' } });
  assert.equal(declared.status, 200, JSON.stringify(declared.json));
  const name = fresh();
  await seedAgent(name, {});
  const attached = await call('PATCH', `/api/agents/${name}/config`, mission, { mcp_servers: ['remote-docs', 'mission-http'] });
  assert.equal(attached.status, 200, JSON.stringify(attached.json));
  assert.deepEqual(loadConfig(name).mcp_servers, ['remote-docs', 'mission-http']);
});

test('a relaxed mission cannot hand a task or a role extra tools or a stdio server', async () => {
  const before = dbApi.listTasks().length;
  // Assigned to the caller itself: the delegation list is not what this test is about.
  assertPersonOnly(await call('POST', '/api/tasks', mission, { title: 't', agent_name: 'caller.pilot', extra_allowed_tools: ['Bash'] }), /extra_allowed_tools adds Bash/);
  assertPersonOnly(await call('POST', '/api/tasks', mission, { title: 't', agent_name: 'caller.pilot', extra_mcp_servers: ['host-shell'] }), /extra_mcp_servers attaches host-shell/);
  assert.equal(dbApi.listTasks().length, before);
  const http = await call('POST', '/api/tasks', mission, { title: 't', agent_name: 'caller.pilot', extra_mcp_servers: ['remote-docs'] });
  assert.equal(http.status, 201, JSON.stringify(http.json));

  const projectDir = mkdtempSync(join(tmpdir(), 'timon-agent-widening-project-'));
  dbApi.upsertProject('widen', { cwd: projectDir });
  await seedAgent('widen.coder', { cwd: projectDir });
  assertPersonOnly(await call('PATCH', '/api/projects/widen/roles/code', mission, { agent: 'widen.coder', mcp_servers: ['host-shell'] }), /role code mcp_servers attaches host-shell/);
});

test('a relaxed mission cannot attach a skill that pre-authorises tools, at any scope', async () => {
  const name = fresh();
  await seedAgent(name, { reports_to: 'caller.pilot' });
  assertPersonOnly(
    await call('POST', '/api/skill-attachments', mission, { skill: 'git-publish', scope: 'agent', target: name }),
    /skill adds skill git-publish, which pre-authorises Bash\(git \*\).*Agents or Skills page/,
  );
  const projectDir = mkdtempSync(join(tmpdir(), 'timon-agent-widening-skills-'));
  dbApi.upsertProject('skillwiden', { cwd: projectDir });
  for (const [scope, target] of [['project', 'skillwiden'], ['role', 'coder'], ['global', undefined]] as const) {
    assertPersonOnly(
      await call('POST', '/api/skill-attachments', mission, { skill: 'git-publish', scope, ...(target ? { target } : {}) }),
      /git-publish, which pre-authorises .*the agents of/,
    );
  }
  assert.deepEqual(listSkillAttachments({ skill: 'git-publish' }), []);
  // A skill that declares no tool passes, at the agent and at a wider scope.
  const plain = await call('POST', '/api/skill-attachments', mission, { skill: 'plain-notes', scope: 'agent', target: name });
  assert.equal(plain.status, 200, JSON.stringify(plain.json));
  const wide = await call('POST', '/api/skill-attachments', mission, { skill: 'plain-notes', scope: 'project', target: 'skillwiden' });
  assert.equal(wide.status, 200, JSON.stringify(wide.json));
  // Excluding a skill narrows: accepted.
  const excluded = await call('POST', '/api/skill-attachments', mission, { skill: 'git-publish', scope: 'agent', target: name, exclude: true });
  assert.equal(excluded.status, 200, JSON.stringify(excluded.json));
});

test('a relaxed mission cannot lift an exclusion that held back a skill with tools', async () => {
  const name = fresh();
  await seedAgent(name, { reports_to: 'caller.pilot' });
  const row = putSkillAttachment({ skill: 'git-publish', scope: 'agent', target: name, mode: 'include', exclude: true });
  assertPersonOnly(await call('DELETE', `/api/skill-attachments/${row.id}`, mission), /git-publish, which pre-authorises/);
  assert.equal(listSkillAttachments({ scope: 'agent', target: name }).length, 1);
});

test('a relaxed mission cannot hand an agent a skill with tools through its `skills`', async () => {
  const name = fresh();
  await seedAgent(name, { reports_to: 'caller.pilot' });
  assertPersonOnly(await call('PATCH', `/api/agents/${name}/config`, mission, { skills: ['plain-notes', 'git-publish'] }), /skills adds skill git-publish/);
  assertPersonOnly(
    await call('POST', '/api/agents', mission, { name: fresh(), system_prompt: 'p', config: { skills: ['git-publish'] } }),
    /skills adds skill git-publish/,
  );
  const plain = await call('PATCH', `/api/agents/${name}/config`, mission, { skills: ['plain-notes'] });
  assert.equal(plain.status, 200, JSON.stringify(plain.json));
  // An agent a person gave the skill keeps it, and a mission may re-send or drop it.
  const held = fresh();
  await seedAgent(held, { reports_to: 'caller.pilot', skills: ['git-publish'] });
  const same = await call('PATCH', `/api/agents/${held}/config`, mission, { skills: ['git-publish', 'plain-notes'] });
  assert.equal(same.status, 200, JSON.stringify(same.json));
  const dropped = await call('PATCH', `/api/agents/${held}/config`, mission, { skills: [] });
  assert.equal(dropped.status, 200, JSON.stringify(dropped.json));
});

test('a relaxed mission cannot pass a skill with tools as extra_skills', async () => {
  const before = dbApi.listTasks().length;
  assertPersonOnly(
    await call('POST', '/api/tasks', mission, { title: 't', agent_name: 'caller.pilot', extra_skills: ['git-publish'] }),
    /extra_skills adds skill git-publish/,
  );
  assert.equal(dbApi.listTasks().length, before);
  assertPersonOnly(
    await call('POST', '/api/missions/delegate', mission, { agent_name: 'caller.pilot', mission: 'go', extra_skills: ['git-publish'] }),
    /extra_skills adds skill git-publish/,
  );
  assertPersonOnly(
    await call('POST', '/api/pipelines', mission, {
      name: 'p', definition: { steps: [{ id: 's1', agent: 'caller.pilot', prompt: 'go', extra_skills: ['git-publish'] }] },
    }),
    /step s1: extra_skills adds skill git-publish/,
  );
  const plain = await call('POST', '/api/tasks', mission, { title: 't', agent_name: 'caller.pilot', extra_skills: ['plain-notes'] });
  assert.equal(plain.status, 201, JSON.stringify(plain.json));
});

test('a person attaches a skill with tools from the app', async () => {
  const name = fresh();
  await seedAgent(name, {});
  const attached = await call('POST', '/api/skill-attachments', person, { skill: 'git-publish', scope: 'agent', target: name });
  assert.equal(attached.status, 200, JSON.stringify(attached.json));
  const patched = await call('PATCH', `/api/agents/${name}/config`, person, { skills: ['git-publish', 'plain-notes'] });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  const task = await call('POST', '/api/tasks', person, { title: 't', agent_name: name, extra_skills: ['git-publish'] });
  assert.equal(task.status, 201, JSON.stringify(task.json));
  assert.equal((await call('POST', '/api/skill-attachments', null, { skill: 'git-publish', scope: 'agent', target: name })).status, 401);
});

test('a person does all of it from the app', async () => {
  const name = fresh();
  const created = await call('POST', '/api/agents', person, { name, system_prompt: 'p', config: { allowed_tools: ['Bash'], mcp_servers: ['host-shell'] } });
  assert.equal(created.status, 200, JSON.stringify(created.json));
  const patched = await call('PATCH', `/api/agents/${name}/config`, person, { allowed_tools: ['Bash', 'Write'], disallowed_tools: [] });
  assert.equal(patched.status, 200, JSON.stringify(patched.json));
  assert.deepEqual(loadConfig(name).allowed_tools, ['Bash', 'Write']);
  assert.equal((await call('POST', '/api/mcp', person, { id: 'person-shell', transport: { type: 'stdio', command: 'sh' } })).status, 200);
  const task = await call('POST', '/api/tasks', person, { title: 't', agent_name: name, extra_allowed_tools: ['Edit'], extra_mcp_servers: ['person-shell'] });
  assert.equal(task.status, 201, JSON.stringify(task.json));
});

test('the daemon-token is the operator: it is not bounded by this rule', async () => {
  const name = fresh();
  await seedAgent(name, {});
  const r = await call('PATCH', `/api/agents/${name}/config`, operator, { allowed_tools: ['Bash'], mcp_servers: ['host-shell'] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test('nobody is refused before any of it', async () => {
  const name = fresh();
  await seedAgent(name, {});
  assert.equal((await call('PATCH', `/api/agents/${name}/config`, null, { allowed_tools: ['Bash'] })).status, 401);
  assert.equal((await call('POST', '/api/agents', null, { name: fresh(), system_prompt: 'p', config: { allowed_tools: ['Bash'] } })).status, 401);
  assert.equal((await call('POST', '/api/mcp', null, { id: 'anon-shell', transport: { type: 'stdio', command: 'sh' } })).status, 401);
  assert.equal(getMcp('anon-shell'), null);
  assert.equal(loadConfig(name).allowed_tools, undefined);
});

test('the pure rule: coverage, lifted denials, transports', () => {
  assert.equal(agentWideningRefusal({ allowed_tools: ['Bash(git:log)'] }, { allowed_tools: ['Bash(git:*)'] }), null);
  assert.equal(agentWideningRefusal({ allowed_tools: ['Bash(git:*)'] }, { allowed_tools: ['Bash'] }), null);
  assert.match(agentWideningRefusal({ allowed_tools: ['Bash'] }, { allowed_tools: ['Bash(git:*)'] }) ?? '', /adds Bash/);
  assert.match(agentWideningRefusal({ allowed_tools: 'Bash' }, null) ?? '', /array of strings/);
  assert.equal(agentWideningRefusal({ disallowed_tools: ['Bash', 'Write'] }, { disallowed_tools: ['Bash'] }), null);
  assert.equal(agentWideningRefusal({ mcp_servers: ['remote-docs', 'timon'] }, null), null);
  assert.match(agentWideningRefusal({ mcp_servers: ['host-shell'] }, null) ?? '', /attaches host-shell/);
  assert.match(agentWideningRefusal({ mcp_servers: ['../escape'] }, null) ?? '', /attaches \.\.\/escape/);
  assert.equal(agentWideningRefusal({ allowed_tools: null, mcp_servers: undefined }, null), null);
  assert.equal(skillWideningRefusal(['git-publish'], ['Bash']), null);
  assert.equal(skillWideningRefusal(['plain-notes', 'not-a-skill'], []), null);
  assert.match(skillWideningRefusal(['git-publish'], ['Bash(git *)']) ?? '', /pre-authorises Bash\(gh \*\)/);
  assert.match(skillWideningRefusal({}, []) ?? '', /array of skill ids/);
});
