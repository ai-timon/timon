import { createTestAccount, grantTestPermissions } from '../tests/helpers/accounts.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';
import express from 'express';
process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-communication-'));
await import('../tests/helpers/paid-license.js');
await import('../tests/helpers/claude-provider.js');

process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const { dbApi } = await import('./db.js');
const { agentDir } = await import('./paths.js');
const { issueMissionApiToken } = await import('./users/api-tokens.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes: missions } = await import('./plugins-bundled/missions/routes.js');
const { registerRoutes: agents } = await import('./plugins-bundled/agents/routes.js');
const { createDelegationHandler } = await import('./mission-delegation.js');
const { MISSION_TOKEN_PERMISSIONS } = await import('./users/permissions.js');
for (const [name, config] of Object.entries({
  _main: { role: 'orchestrator' }, 'TIMON.librarian': { role: 'librarian' },
  independent: { reports_to: null }, 'company.ceo': { role: 'orchestrator', reports_to: null },
  'company.marketing': { reports_to: 'company.ceo' },
})) {
  mkdirSync(agentDir(name), { recursive: true });
  writeFileSync(join(agentDir(name), 'config.json'), JSON.stringify({ cwd: process.env.TIMON_HOME, ...config }));
}
const owner = createTestAccount(dbApi, { email: 'owner@example.test', name: 'Owner', passwordHash: 'x', isSuperadmin: true });
const employee = createTestAccount(dbApi, { email: 'employee@example.test', name: 'Employee', passwordHash: 'x' });
function token(agent: string, userId = owner.id) {
  const id = randomUUID(); dbApi.createMission(id, agent, 'communication test', undefined, userId);
  return { id, bearer: issueMissionApiToken(id) };
}
const main = token('_main');
let launches = 0;
let lastLaunch: Parameters<Parameters<typeof createDelegationHandler>[0] & object>[3] | undefined;
const delegation = createDelegationHandler(async (agent, brief, source, opts) => {
  launches++; lastLaunch = opts; const id = randomUUID();
  dbApi.createMission(id, agent, brief, source, opts?.ownerUserId); return id;
});
const app = express();
app.use(createDaemonAuthMiddleware({ token: 'operator-test-token', required: true })); app.use(express.json());
// Replace only the LLM launcher; keep the real auth, handler and message routes.
missions(app, delegation); agents(app);
const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });
async function post(path: string, body: unknown, bearer = main.bearer) {
  return fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify(body) });
}
/**
 * A child with an empty PATH. A URL's `pathname` is no file path on Windows
 * (`/D:/…`), and Windows needs SystemRoot to open a socket.
 */
const script = (rel: string): string => fileURLToPath(new URL(rel, import.meta.url));
const systemRoot = process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {};
type Reply = { result?: { isError?: boolean; content: Array<{ text: string }> }; error?: { message: string } };
async function tool(name: string, args: unknown, caller = main): Promise<Reply> {
  const child = spawn(process.execPath, [script('../bin/timon-mcp.mjs')], {
    env: { ...systemRoot, PATH: '', TIMON_HOME: process.env.TIMON_HOME, TIMON_API_TOKEN: caller.bearer, TIMON_ORCH_URL: base, TIMON_MISSION_ID: caller.id, TIMON_AGENT: dbApi.getMission(caller.id)!.agent_name }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  return new Promise((resolve, reject) => {
    // A cold Node start of the MCP server takes seconds on a loaded Windows machine.
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP timeout')); }, 30_000);
    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => { clearTimeout(timer); child.kill(); lines.close(); resolve(JSON.parse(line)); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) + '\n');
  });
}
/** One `timon spawn` CLI process, in a mission: the CLI's own spawn path (not the MCP). */
async function cliSpawn(args: string[], caller = main): Promise<{ code: number; out: string }> {
  const child = spawn(process.execPath, [script('../bin/timon'), 'spawn', ...args], {
    env: { ...systemRoot, PATH: '', TIMON_HOME: process.env.TIMON_HOME, TIMON_API: base, TIMON_API_TOKEN: caller.bearer, TIMON_MISSION_ID: caller.id, TIMON_AGENT: dbApi.getMission(caller.id)!.agent_name }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  let err = '';
  child.stdout.on('data', (c: Buffer) => { out += String(c); });
  child.stderr.on('data', (c: Buffer) => { err += String(c); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timeout')); }, 5000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('exit', (code) => { clearTimeout(timer); resolve({ code: code ?? 0, out: out + err }); });
  });
}
test('MCP discovers exact names and sends to librarian without a CLI', async () => {
  const listing = await tool('agent_list', {}); assert.equal(listing.error, undefined);
  const roster = JSON.parse(listing.result!.content[0]!.text).agents as Array<{name: string; cwd?: string}>;
  const librarian = roster.find((a) => a.name === 'TIMON.librarian'); assert.ok(librarian); assert.equal(librarian.cwd, undefined);
  const sent = await tool('agent_send_message', { to_agent: librarian.name, kind: 'request', payload: 'What is planned?' });
  assert.equal(sent.error, undefined); assert.ok(JSON.parse(sent.result!.content[0]!.text).message_id);
  const wrong = await tool('agent_send_message', { to_agent: 'librarian', payload: 'Hello' }); assert.equal(wrong.result!.isError, true); assert.match(wrong.result!.content[0]!.text, /404/);
});
test('delegation preserves owner and parent without unrestricted spawn grant', async () => {
  assert.ok(!([...MISSION_TOKEN_PERMISSIONS] as string[]).includes('missions:spawn'));
  const result = await tool('mission_spawn', { agent_name: 'TIMON.librarian', mission: 'Prepare a summary' }); assert.equal(result.error, undefined);
  const id = JSON.parse(result.result!.content[0]!.text).mission_id;
  assert.equal(dbApi.getMission(id)!.owner_user_id, owner.id); assert.equal(dbApi.getMission(id)!.parent_mission_id, main.id);
  assert.equal((await post('/api/missions', { agent_name: 'TIMON.librarian', mission: 'No' })).status, 403);
});
test('the `timon spawn` CLI in a mission delegates through the same route as the MCP', async () => {
  const count = launches;
  const r = await cliSpawn(['TIMON.librarian', 'CLI spawn']);
  assert.equal(r.code, 0);
  const id = JSON.parse(r.out).mission_id;
  assert.equal(launches, count + 1);
  assert.equal(dbApi.getMission(id)!.owner_user_id, owner.id);
  assert.equal(dbApi.getMission(id)!.parent_mission_id, main.id);
  // The CLI no longer sends the fields the .strict() delegate body refuses.
  assert.equal((await post('/api/missions', { agent: 'TIMON.librarian', input: 'No' })).status, 403);
});
test('Company leader delegates to its direct report', async () => {
  assert.equal((await post('/api/missions/delegate', { agent_name: 'company.marketing', mission: 'Draft ideas' }, token('company.ceo').bearer)).status, 201);
});
test('rejects self-recursion, unknown names and override payloads before launch', async () => {
  const count = launches; const body = { agent_name: 'TIMON.librarian', mission: 'No' };
  for (const agent_name of ['_main']) assert.equal((await post('/api/missions/delegate', { agent_name, mission: 'No' })).status, 403);
  assert.equal((await post('/api/missions/delegate', { agent_name: 'librarian', mission: 'No' })).status, 404);
  assert.equal((await post('/api/missions/delegate', { ...body, source_meta: { parent_mission_id: 'forged' } })).status, 400);
  assert.equal((await post('/api/missions/delegate', { ...body, extra_allowed_tools: '*' })).status, 400);
  assert.equal((await post('/api/missions/delegate', { ...body, permission_mode: 'bypassPermissions' })).status, 400);
  assert.equal(launches, count);
});

test('TIM-0074: mission_spawn from a mission carries its overrides through delegation, deduplicated per key', async () => {
  const count = launches;
  const args = { agent_name: 'TIMON.librarian', mission: 'Summarise', model: 'sonnet', backend: 'claude', extra_skills: ['skill-a'], idempotency_key: 'tim-0074', title: 'Résumé du jour' }; // french-ok: an accented title the launcher keeps
  const first = await tool('mission_spawn', args);
  assert.notEqual(first.result?.isError, true, first.result?.content[0]?.text);
  const id = JSON.parse(first.result!.content[0]!.text).mission_id;
  assert.equal(launches, count + 1);
  assert.equal(lastLaunch?.modelOverride, 'sonnet');
  assert.equal(lastLaunch?.backendOverride, 'claude');
  assert.deepEqual(lastLaunch?.extraSkills, ['skill-a']);
  assert.equal(lastLaunch?.ownerUserId, owner.id);
  assert.equal(lastLaunch?.title, 'Résumé du jour', 'the preset title reaches the launcher (TODO #358)'); // french-ok: an accented title the launcher keeps
  assert.equal(dbApi.getMission(id)!.parent_mission_id, main.id);
  const replay = await tool('mission_spawn', args);
  assert.deepEqual(JSON.parse(replay.result!.content[0]!.text), { mission_id: id, idempotent: true });
  assert.equal(launches, count + 1);
  // The unrestricted route stays closed to a mission token.
  assert.equal((await post('/api/missions', { agent: 'TIMON.librarian', input: 'No', model_override: 'sonnet' })).status, 403);
});

test('TIM-0074: delegation overrides refuse anonymous, operator and restricted callers before launch', async () => {
  const count = launches;
  const body = { agent_name: 'independent', mission: 'Peer work', extra_allowed_tools: ['Bash'] };
  const anonymous = await fetch(base + '/api/missions/delegate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal(anonymous.status, 401);
  assert.equal((await post('/api/missions/delegate', body, 'operator-test-token')).status, 403);
  const ended = token('company.ceo', employee.id); dbApi.finishMission(ended.id, 'completed', 0);
  assert.ok([401, 403].includes((await post('/api/missions/delegate', body, ended.bearer)).status));
  // An employee's mission holds no `agents:privileged-config`: it may delegate,
  // but not widen the target's tools — and the refusal names the value.
  const leader = token('company.ceo', employee.id);
  const refused = await post('/api/missions/delegate', body, leader.bearer);
  assert.equal(refused.status, 403);
  assert.match((await refused.json()).reason, /extra_allowed_tools.*Bash/);
  const viaMcp = await tool('mission_spawn', body, leader);
  assert.equal(viaMcp.result?.isError, true);
  assert.match(viaMcp.result!.content[0]!.text, /extra_allowed_tools/);
  assert.equal((await post('/api/missions/delegate', { ...body, extra_allowed_tools: undefined, backend: 'no-such-backend' }, leader.bearer)).status, 403);
  assert.equal(launches, count);
  // Without the widening value, the same caller delegates.
  assert.equal((await post('/api/missions/delegate', { agent_name: 'independent', mission: 'Peer work', extra_skills: ['skill-a'] }, leader.bearer)).status, 201);
});

test('ended, revoked, operator and cyclic requests never launch a child', async () => {
  const count = launches;
  const body = { agent_name: 'TIMON.librarian', mission: 'No' };
  const ended = token('_main'); dbApi.finishMission(ended.id, 'completed', 0);
  assert.ok([401, 403].includes((await post('/api/missions/delegate', body, ended.bearer)).status));
  const revoked = token('_main'); issueMissionApiToken(revoked.id);
  assert.equal((await post('/api/missions/delegate', body, revoked.bearer)).status, 401);
  assert.equal((await post('/api/missions/delegate', body, 'operator-test-token')).status, 403);
  const ancestor = token('TIMON.librarian');
  dbApi.setMissionLineage(main.id, { parentMissionId: ancestor.id });
  try { assert.equal((await post('/api/missions/delegate', body)).status, 403); }
  finally { dbApi.setMissionLineage(main.id, { parentMissionId: null }); }
  assert.equal(launches, count);
});


test('ordinary agents communicate without grants or reporting lines, delegation follows the list, explicit denial wins', async () => {
  const caller = token('company.marketing', employee.id);
  const body = { agent_name: 'independent', mission: 'Peer work' };
  // Messages are not delegation: the orchestration list does not touch them.
  const sent = await tool('agent_send_message', { to_agent: 'independent', payload: 'Peer question' }, caller);
  assert.notEqual(sent.result?.isError, true);
  const messageId = JSON.parse(sent.result!.content[0]!.text).message_id;
  const foreign = await fetch(base + '/api/messages/' + messageId, { headers: { authorization: `Bearer ${main.bearer}` } });
  assert.equal(foreign.status, 404);
  // Delegation is: an agent nobody put under the caller is out of reach, the leader's own peer is not.
  const before = launches;
  assert.equal((await post('/api/missions/delegate', body, caller.bearer)).status, 403);
  assert.equal(launches, before);
  const leader = token('company.ceo', employee.id);
  assert.equal((await post('/api/missions/delegate', body, leader.bearer)).status, 201);
  grantTestPermissions(dbApi, employee.id, ['*', '-agents:communicate']);
  try {
    assert.equal((await post('/api/missions/delegate', body, leader.bearer)).status, 403);
    const denied = await tool('agent_send_message', { to_agent: 'independent', payload: 'No' }, caller);
    assert.equal(denied.result?.isError, true);
    assert.match(denied.result!.content[0]!.text, /403/);
    const inbox = await fetch(base + '/api/messages?to=independent', { headers: { authorization: `Bearer ${caller.bearer}` } });
    assert.equal(inbox.status, 403);
    // An exploitable body: what is denied and what to ask for, not a bare sentence.
    const refusal = await inbox.json() as { error: string; code: string; reason: string; hint: string | null };
    assert.equal(refusal.error, 'forbidden');
    assert.equal(refusal.code, 'explicitly_denied');
    assert.match(refusal.reason, /explicitly denied agents:communicate or messages:read/);
    assert.ok(refusal.hint);
  } finally { grantTestPermissions(dbApi, employee.id, []); }
});

test("adding a tool or a stdio MCP server needs a person: a superadmin's mission and a developer-owner one are refused", async () => {
  const count = launches;
  const body = { agent_name: 'independent', mission: 'Peer work', extra_allowed_tools: ['Bash'] };
  const relaxed = await post('/api/missions/delegate', body);
  assert.equal(relaxed.status, 403);
  assert.match((await relaxed.json()).reason, /extra_allowed_tools adds Bash.*whatever its account holds/);
  const viaMcp = await tool('mission_spawn', body);
  assert.equal(viaMcp.result?.isError, true);
  assert.match(viaMcp.result!.content[0]!.text, /extra_allowed_tools adds Bash/);
  const patch = (bearer: string) => fetch(base + '/api/agents/independent/config', {
    method: 'PATCH', headers: { 'content-type': 'application/json', authorization: `Bearer ${bearer}` }, body: JSON.stringify({ allowed_tools: ['Bash'] }),
  });
  const { licenseState, setLicenseState } = await import('./license/runtime.js');
  const original = licenseState();
  try {
    setLicenseState({ ...original, status: 'valid' as const, reason: null, plan: 'Renamed label', planId: 'internal', expiresAt: new Date(Date.now() + 60000).toISOString() });
    // The developer-owner mission is superadmin in every other respect…
    assert.equal(dbApi.getLiveApiToken((await import('./users/api-tokens.js')).hashApiToken(main.bearer))!.isSuperadmin, true);
    // …and still not a person.
    assert.equal((await post('/api/missions/delegate', body)).status, 403);
    const widened = await patch(main.bearer);
    assert.equal(widened.status, 403);
    assert.match((await widened.json()).reason, /allowed_tools adds Bash.*Agents page/);
    const stdio = await post('/api/mcp', { id: 'dev-shell', transport: { type: 'stdio', command: 'sh' } });
    assert.equal(stdio.status, 403);
    assert.match((await stdio.json()).reason, /command on the host.*MCP servers page/);
  } finally { setLicenseState(original); }
  assert.equal(launches, count);
  assert.equal(JSON.parse(readFileSync(join(agentDir('independent'), 'config.json'), 'utf8')).allowed_tools, undefined);
});

test('verified developer-owner missions inherit full rights; ordinary users and expired licences do not', async () => {
  const { licenseState, setLicenseState } = await import('./license/runtime.js');
  const { hashApiToken } = await import('./users/api-tokens.js');
  const original = licenseState();
  const dev = { ...original, status: 'valid' as const, reason: null, plan: 'Renamed label', planId: 'internal', expiresAt: new Date(Date.now() + 60000).toISOString() };
  try {
    setLicenseState(dev);
    assert.equal(dbApi.getLiveApiToken(hashApiToken(main.bearer))!.isSuperadmin, true);
    const child = token('independent');
    assert.equal(dbApi.getLiveApiToken(hashApiToken(child.bearer))!.isSuperadmin, true);
    assert.equal(dbApi.getLiveApiToken(hashApiToken(token('_main', employee.id).bearer))!.isSuperadmin, false);
    const allowed = await post('/api/permissions/request', { mission_id: main.id, tool_name: 'Bash', tool_use_id: randomUUID(), input: { command: 'echo test' } });
    assert.equal(allowed.status, 200); assert.equal((await allowed.json()).behavior, 'allow');
    // General spawn now passes the auth gate: an invalid body returns 400, not 403.
    assert.equal((await post('/api/missions', {})).status, 400);
    setLicenseState({ ...dev, expiresAt: new Date(0).toISOString() });
    assert.equal(dbApi.getLiveApiToken(hashApiToken(main.bearer))!.isSuperadmin, false);
    setLicenseState({ ...dev, plan: 'Developer', planId: 'ordinary' });
    assert.equal(dbApi.getLiveApiToken(hashApiToken(main.bearer))!.isSuperadmin, false);
    setLicenseState({ ...dev, status: 'unlicensed' });
    assert.equal(dbApi.getLiveApiToken(hashApiToken(main.bearer))!.isSuperadmin, false);
  } finally { setLicenseState(original); }
});


test('communication denials cover actions and wildcards; developer authority overrides them', async () => {
  const { agentCommunicationAllowed } = await import('./users/agent-permissions.js');
  const { licenseState, setLicenseState } = await import('./license/runtime.js');
  const original = licenseState();
  try {
    for (const denial of ['-agents:communicate', '-agents:*', '-*', '-missions:spawn']) {
      assert.equal(agentCommunicationAllowed(employee, ['*', denial], 'missions:spawn'), false);
    }
    assert.equal(agentCommunicationAllowed(employee, ['-messages:send'], 'missions:spawn'), true);
    assert.equal(agentCommunicationAllowed(employee, ['*', '-messages:send'], 'messages:send'), false);
    setLicenseState({ ...original, status: 'valid', planId: 'internal', expiresAt: new Date(Date.now() + 60000).toISOString() });
    assert.equal(agentCommunicationAllowed(owner, ['-*'], 'missions:spawn'), true);
    assert.equal(agentCommunicationAllowed(employee, ['-*'], 'missions:spawn'), false);
  } finally { setLicenseState(original); }
});

test('developer auto-allow covers tool uses but never a form card, on every path that asks', async () => {
  const { developerAutoAllows } = await import('./users/agent-permissions.js');
  const { licenseState, setLicenseState } = await import('./license/runtime.js');
  const original = licenseState();
  try {
    setLicenseState({ ...original, status: 'valid', planId: 'internal', expiresAt: new Date(Date.now() + 60000).toISOString() });
    assert.equal(developerAutoAllows(owner, 'Bash'), true);
    assert.equal(developerAutoAllows(owner, 'ask_user'), false);
    assert.equal(developerAutoAllows(owner, 'ask_series_plan'), false);
    // The public names are NOT form cards: opencode has its own `question` tool.
    assert.equal(developerAutoAllows(owner, 'question'), true);
    assert.equal(developerAutoAllows(employee, 'Bash'), false);
  } finally { setLicenseState(original); }
});

test('message sender comes from the token and foreign recipient missions remain inaccessible', async () => {
  const caller = token('company.marketing', employee.id);
  const sent = await post('/api/messages', { to_agent: 'independent', payload: 'Peer question', from_mission: main.id, from_agent: '_main' }, caller.bearer);
  assert.equal(sent.status, 201);
  const id = (await sent.json()).message_id;
  const response = await fetch(base + '/api/messages/' + id, { headers: { authorization: `Bearer ${caller.bearer}` } });
  const { message } = await response.json();
  assert.equal(message.from_mission, caller.id);
  assert.equal(message.from_agent, 'company.marketing');
  assert.equal((await post('/api/messages', { to_agent: '_main', to_mission: main.id, payload: 'No' }, caller.bearer)).status, 404);
});
