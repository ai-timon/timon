/**
 * Remote MCP endpoint behind the REAL daemon auth middleware (rule 8): every
 * credential other than a live, in-scope remote MCP token is refused, and a
 * tool runs as the token's mission — never as the daemon.
 *
 * The witness server listens on `127.0.0.1:0` and stands in for the REST API
 * the tools call back into (`TIMON_ORCH_URL`).
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-remote-mcp-routes-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { db, dbApi } = await import('../db.js');
const { hashPassword } = await import('../users/password.js');
const { issueMissionApiToken } = await import('../users/api-tokens.js');
const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { registerRemoteMcpRoutes } = await import('./routes.js');
const { issueRemoteMcpToken, revokeRemoteMcpToken } = await import('./tokens.js');

const DAEMON_TOKEN = 'd'.repeat(64);
const ada = createTestAccount(dbApi, {
  email: 'ada@example.com', name: 'Ada', passwordHash: await hashPassword('ada-secret'), isSuperadmin: false,
});

type Seen = { kind?: string; missionId?: string | null; headerMission?: string };
const seen: Seen[] = [];
/** Runs inside the stand-in REST route, i.e. while a tool call is in flight. */
let duringTasks: (() => void) | null = null;
let base = '';
let close: () => Promise<void> = async () => {};

function countDelegates(missionId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM api_tokens WHERE mission_id = ? AND label LIKE 'remote-mcp:%'`).get(missionId) as { n: number }).n;
}

// Delegates are deleted when their tool returns: a log keeps every one ever
// issued, so a test can prove a refused call never minted one.
db.exec(`CREATE TEMP TABLE delegate_log (label TEXT NOT NULL)`);
db.exec(`CREATE TEMP TRIGGER delegate_logged AFTER INSERT ON main.api_tokens
  WHEN NEW.label LIKE 'remote-mcp:%' BEGIN INSERT INTO delegate_log (label) VALUES (NEW.label); END`);

function delegatesIssued(grantId: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM delegate_log WHERE label = ?`).get(`remote-mcp:${grantId}`) as { n: number }).n;
}

before(async () => {
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: DAEMON_TOKEN, required: true }));
  app.use(express.json({ limit: '25mb' }));
  registerRemoteMcpRoutes(app);
  // Stand-in for the REST route `kanban_list` calls.
  app.get('/api/tasks', (req, res) => {
    seen.push({
      kind: req.auth?.kind,
      missionId: req.auth?.kind === 'api-token' ? req.auth.missionId : null,
      headerMission: typeof req.headers['x-timon-mission'] === 'string' ? req.headers['x-timon-mission'] : undefined,
    });
    duringTasks?.();
    res.json({ tasks: [{ id: 't1', title: 'from the mission' }] });
  });
  app.post('/api/memory/rules', (_req, res) => { res.status(403).json({ error: 'forbidden' }); });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as AddressInfo).port;
  base = `http://127.0.0.1:${port}`;
  process.env.TIMON_ORCH_URL = base;
  close = () => new Promise((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
});

after(async () => { await close(); });

function runningMission(agent = 'ada.agent'): string {
  const id = randomUUID();
  dbApi.createMission(id, agent, 'remote work', undefined, ada.id);
  return id;
}

async function rpc(body: unknown, headers: Record<string, string> = {}, path = '/api/remote-mcp'): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(body),
  });
}

const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
const callTool = (name: string, args: Record<string, unknown> = {}) =>
  ({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name, arguments: args } });

test('anonymous is refused, with no detail', async () => {
  const r = await rpc(LIST);
  assert.equal(r.status, 401);
  assert.match(r.headers.get('www-authenticate') ?? '', /^Bearer/);
  assert.deepEqual(await r.json(), { error: 'unauthorized' });
});

test('the daemon-token is refused on this route', async () => {
  const r = await rpc(LIST, { authorization: `Bearer ${DAEMON_TOKEN}` });
  assert.equal(r.status, 401);
  // Any spelling express would route the same way.
  const upper = await rpc(LIST, { authorization: `Bearer ${DAEMON_TOKEN}` }, '/API/Remote-MCP/');
  assert.equal(upper.status, 401);
});

test('a mission REST token is refused on this route', async () => {
  const missionId = runningMission();
  const r = await rpc(LIST, { authorization: `Bearer ${issueMissionApiToken(missionId)}` });
  assert.equal(r.status, 401);
});

test('a remote MCP token is refused by the REST API', async () => {
  const { token } = issueRemoteMcpToken({ missionId: runningMission(), scopes: ['kanban_*'], issuedBy: 'acme' });
  const r = await fetch(`${base}/api/tasks`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(r.status, 401);
});

test('the token is never read from the query string', async () => {
  const { token } = issueRemoteMcpToken({ missionId: runningMission(), scopes: ['kanban_*'], issuedBy: 'acme' });
  const r = await rpc(LIST, {}, `/api/remote-mcp?token=${token}`);
  assert.equal(r.status, 401);
});

test('initialize, notifications and the unsupported verbs follow the transport', async () => {
  const { token } = issueRemoteMcpToken({ missionId: runningMission(), scopes: ['kanban_list'], issuedBy: 'acme' });
  const auth = { authorization: `Bearer ${token}` };
  const init = await rpc({ jsonrpc: '2.0', id: 0, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } }, auth);
  assert.equal(init.status, 200);
  const body = await init.json() as { result: { protocolVersion: string; capabilities: { tools: unknown } } };
  assert.equal(body.result.protocolVersion, '2025-03-26');
  assert.ok(body.result.capabilities.tools);
  const note = await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, auth);
  assert.equal(note.status, 202);
  const get = await fetch(`${base}/api/remote-mcp`, { headers: auth });
  assert.equal(get.status, 405);
  const badVersion = await rpc(LIST, { ...auth, 'mcp-protocol-version': '1999-01-01' });
  assert.equal(badVersion.status, 400);
  const foreign = await rpc(LIST, { ...auth, origin: 'https://evil.example' });
  assert.equal(foreign.status, 403);
});

test('tools/list shows only the tools in scope', async () => {
  const { token } = issueRemoteMcpToken({ missionId: runningMission(), scopes: ['kanban_*', 'docs_search'], issuedBy: 'acme' });
  const r = await rpc(LIST, { authorization: `Bearer ${token}` });
  const { result } = await r.json() as { result: { tools: { name: string; title?: string }[] } };
  const names = result.tools.map((t) => t.name);
  assert.ok(names.includes('kanban_add') && names.includes('kanban_list') && names.includes('docs_search'));
  assert.ok(names.every((n) => n.startsWith('kanban_') || n === 'docs_search'), names.join(','));
  // The display name reaches a remote client too (docs/MCP-TOOL-CONVENTIONS.md).
  assert.equal(result.tools.find((t) => t.name === 'kanban_add')?.title, 'Create a Kanban task');
});

test('a tool outside the scopes is refused without running', async () => {
  const before = seen.length;
  const { token } = issueRemoteMcpToken({ missionId: runningMission(), scopes: ['docs_search'], issuedBy: 'acme' });
  const r = await rpc(callTool('kanban_list'), { authorization: `Bearer ${token}` });
  const body = await r.json() as { error?: { code: number; message: string } };
  assert.equal(body.error?.code, -32602);
  assert.match(body.error?.message ?? '', /outside this token's scopes/);
  assert.equal(seen.length, before, 'no REST call was made');
  // A deprecated alias never widens a scope.
  const alias = await rpc(callTool('todo_later_list'), { authorization: `Bearer ${token}` });
  assert.equal(((await alias.json()) as { error?: { code: number } }).error?.code, -32602);
});

test('a tool runs as the token mission, whatever the request claims, and the delegate dies after', async () => {
  const missionA = runningMission('ada.agent');
  const missionB = runningMission('ada.other');
  const { token } = issueRemoteMcpToken({ missionId: missionA, scopes: ['kanban_list'], issuedBy: 'acme' });
  const r = await rpc(callTool('kanban_list'), {
    authorization: `Bearer ${token}`,
    'x-timon-mission': missionB,
    'x-timon-agent': 'ada.other',
  });
  const body = await r.json() as { result: { content: { text: string }[]; isError?: boolean } };
  assert.equal(body.result.isError, undefined);
  assert.deepEqual(JSON.parse(body.result.content[0]!.text), [{ id: 't1', title: 'from the mission' }]);
  const last = seen.at(-1)!;
  assert.equal(last.kind, 'api-token', 'the REST API saw a mission credential, not the daemon-token');
  assert.equal(last.missionId, missionA);
  assert.equal(last.headerMission, missionA);
  assert.equal(countDelegates(missionA), 0, 'the per-call credential is deleted once the tool returns');
});

test("another mission's token is refused once that mission ends", async () => {
  const missionId = runningMission();
  const { token } = issueRemoteMcpToken({ missionId, scopes: ['kanban_list'], issuedBy: 'acme' });
  dbApi.finishMission(missionId, 'completed', 0);
  const r = await rpc(callTool('kanban_list'), { authorization: `Bearer ${token}` });
  assert.equal(r.status, 401);
});

test('expired and revoked tokens are refused', async () => {
  const missionId = runningMission();
  const expired = issueRemoteMcpToken({ missionId, scopes: ['kanban_list'], ttlMs: 60_000, issuedBy: 'acme', now: Date.now() - 61_000 });
  assert.equal((await rpc(LIST, { authorization: `Bearer ${expired.token}` })).status, 401);
  const revoked = issueRemoteMcpToken({ missionId, scopes: ['kanban_list'], issuedBy: 'acme' });
  assert.equal((await rpc(LIST, { authorization: `Bearer ${revoked.token}` })).status, 200);
  revokeRemoteMcpToken(revoked.id);
  assert.equal((await rpc(LIST, { authorization: `Bearer ${revoked.token}` })).status, 401);
});

test('a REST refusal comes back as a tool error that never carries a credential', async () => {
  const missionId = runningMission();
  const { token } = issueRemoteMcpToken({ missionId, scopes: ['memory_*'], issuedBy: 'acme' });
  const r = await rpc(callTool('memory_rule_add', { text: 'a rule' }), { authorization: `Bearer ${token}` });
  const raw = await r.text();
  const body = JSON.parse(raw) as { result: { isError: boolean; content: { text: string }[] } };
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0]!.text, /403/);
  assert.ok(!raw.includes(token) && !raw.includes(DAEMON_TOKEN));
});

test('a host file path is refused for a remote agent', async () => {
  const { token } = issueRemoteMcpToken({ missionId: runningMission(), scopes: ['agent_set_avatar'], issuedBy: 'acme' });
  const r = await rpc(callTool('agent_set_avatar', { agent_name: 'ada.agent', file: '/etc/passwd.png' }), { authorization: `Bearer ${token}` });
  const body = await r.json() as { result: { isError: boolean; content: { text: string }[] } };
  assert.equal(body.result.isError, true);
  assert.match(body.result.content[0]!.text, /not available over the remote MCP endpoint/);
});


type BatchAnswer = { id: number; result?: { isError?: boolean }; error?: { code: number; message: string } };

/** Two `kanban_list` calls in one batch; `between` runs while the first is in flight. */
async function batchAcross(between: (ctx: { missionId: string; grantId: string }) => void) {
  const missionId = runningMission();
  const { id: grantId, token } = issueRemoteMcpToken({ missionId, scopes: ['kanban_list'], issuedBy: 'acme' });
  const before = seen.length;
  duringTasks = () => between({ missionId, grantId });
  try {
    const r = await rpc([{ ...callTool('kanban_list'), id: 1 }, { ...callTool('kanban_list'), id: 2 }], { authorization: `Bearer ${token}` });
    const raw = await r.text();
    assert.ok(!raw.includes(token), 'no credential in the answer');
    return { status: r.status, answers: JSON.parse(raw) as BatchAnswer[], restCalls: seen.length - before, delegates: delegatesIssued(grantId) };
  } finally {
    duringTasks = null;
  }
}

function assertSecondRefused(out: Awaited<ReturnType<typeof batchAcross>>): void {
  assert.equal(out.status, 200);
  assert.equal(out.answers.length, 2);
  assert.equal(out.answers[0]!.result?.isError, undefined, 'the first call ran');
  assert.deepEqual(out.answers[1]!.error, { code: -32001, message: 'unauthorized' });
  assert.equal(out.restCalls, 1, 'the second call never reached the REST API');
  assert.equal(out.delegates, 1, 'no delegate credential was minted for the second call');
}

test('a batch call after an earlier call ended the mission is refused before any REST call', async () => {
  assertSecondRefused(await batchAcross(({ missionId }) => { dbApi.finishMission(missionId, 'completed', 0); }));
});

test('a batch call after the token expired mid-request is refused before any REST call', async () => {
  assertSecondRefused(await batchAcross(({ grantId }) => {
    db.prepare(`UPDATE mcp_tokens SET expires_at = ? WHERE id = ?`).run(Date.now() - 1, grantId);
  }));
});

test('a batch call after the token was revoked mid-request is refused before any REST call', async () => {
  assertSecondRefused(await batchAcross(({ grantId }) => { revokeRemoteMcpToken(grantId); }));
});

test('a batch call after the mission moved to another agent is refused before any REST call', async () => {
  assertSecondRefused(await batchAcross(({ missionId }) => {
    db.prepare(`UPDATE missions SET agent_name = 'ada.other' WHERE id = ?`).run(missionId);
  }));
});

test('a batch whose token stays valid runs every call', async () => {
  const out = await batchAcross(() => {});
  assert.equal(out.answers.length, 2);
  assert.ok(out.answers.every((a) => a.result && a.result.isError === undefined));
  assert.equal(out.restCalls, 2);
  assert.equal(out.delegates, 2);
});
