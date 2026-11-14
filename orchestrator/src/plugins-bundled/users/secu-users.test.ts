/**
 * SECU-USERS (audit of 2026-09-04): the write side of the owner scope.
 * Two sessions — the superadmin and Ada (no role) — go through the real
 * routes; what Ada cannot read she cannot kill, fork, reconfigure or
 * delete either, and the operator-only routes are 403 for her.
 */
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { grantTestPermissions, postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-secu-users-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('./routes.js');
const { registerRoutes: registerMissions } = await import('../missions/routes.js');
const { registerRoutes: registerWorkflows } = await import('../workflows/routes.js');
const { registerRoutes: registerProjects } = await import('../projects/routes.js');
const { registerRoutes: registerSettings } = await import('../settings/routes.js');
const { registerRoutes: registerHttp } = await import('../http/routes.js');
const { registerRoutes: registerNotifs } = await import('../notifications/routes.js');
const { registerRoutes: registerAgents } = await import('../agents/routes.js');
const { registerRoutes: registerMemory } = await import('../memory/routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { datedLogName, localDay } = await import('../../log-file.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerMissions(app);
registerWorkflows(app);
registerProjects(app);
registerSettings(app);
registerHttp(app);
registerNotifs(app);
registerAgents(app);
registerMemory(app);
const { registerRoutes: registerKanban } = await import('../kanban/routes.js');
registerKanban(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
{
  const { mountOfficialProviders } = await import('../../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

test.after(() => { server.close(); });

function sessionCookie(res: Response): string | undefined {
  const lines = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')!] : []);
  for (const line of lines) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; json: unknown; res: Response }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, res };
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);
const adminId = (setup.json as { user: { id: string } }).user.id;
const adminCookie = sessionCookie(setup.res)!;

const created = await postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'ada-secret' });
assert.equal(created.status, 201);
const adaId = (created.json as { user: { id: string } }).user.id;
const adaLogin = await call('POST', '/api/auth/login', {
  body: { email: 'ada@example.com', password: 'ada-secret' },
});
const adaCookie = sessionCookie(adaLogin.res)!;

const adaMission = randomUUID();
const adminMission = randomUUID();
dbApi.createMission(adaMission, 'ada.agent', 'ada', undefined, adaId);
dbApi.createMission(adminMission, 'admin.agent', 'admin', undefined, adminId);

function seedWorkflow(ownerUserId: string): string {
  const id = randomUUID();
  const now = Date.now();
  dbApi.insertWorkflow({
    id, slug: `wf-${id.slice(0, 8)}`, name: 'Witness', description: null, project: null,
    owner_user_id: ownerUserId, draft: JSON.stringify({ schemaVersion: 1, nodes: [], edges: [] }),
    published_version: null, enabled: 1, created_at: now, updated_at: now,
  });
  return id;
}
const adminWorkflow = seedWorkflow(adminId);

test('U-1: Ada cannot kill, reconfigure, summarize or fork the superadmin mission (404, not 403)', async () => {
  for (const [method, path, body] of [
    ['DELETE', `/api/missions/${adminMission}`, undefined],
    ['POST', `/api/missions/${adminMission}/interrupt`, undefined],
    ['POST', `/api/missions/${adminMission}/steer`, { input: 'go left' }],
    ['POST', `/api/missions/${adminMission}/summarize`, {}],
    ['POST', `/api/missions/${adminMission}/model`, { model: 'haiku' }],
    ['POST', `/api/missions/${adminMission}/reasoning-effort`, { effort: 'low' }],
    ['POST', `/api/missions/${adminMission}/permission-mode`, { mode: 'plan' }],
    ['GET', `/api/missions/${adminMission}/permission-mode`, undefined],
    ['POST', `/api/missions/${adminMission}/backend`, { backend: 'codex' }],
    ['POST', `/api/missions/${adminMission}/fork`, { agent: 'ada.agent' }],
  ] as const) {
    const r = await call(method, path, { cookie: adaCookie, body });
    assert.equal(r.status, 404, `${method} ${path} → ${r.status}`);
  }
  // The superadmin's mission still has its model after Ada's attempt.
  assert.notEqual(dbApi.getMission(adminMission)?.model_override ?? null, 'haiku');
});

test('U-1: the owner (and the superadmin, who sees all) reach the same routes', async () => {
  const own = await call('POST', `/api/missions/${adaMission}/reasoning-effort`, { cookie: adaCookie, body: { effort: 'low' } });
  assert.equal(own.status, 200);
  const admin = await call('POST', `/api/missions/${adaMission}/reasoning-effort`, { cookie: adminCookie, body: { effort: 'high' } });
  assert.equal(admin.status, 200);
});

test('permission mode: an anonymous caller is refused before anything is read or written', async () => {
  const post = await call('POST', `/api/missions/${adaMission}/permission-mode`, { body: { mode: 'bypassPermissions' } });
  assert.equal(post.status, 401);
  const get = await call('GET', `/api/missions/${adaMission}/permission-mode`);
  assert.equal(get.status, 401);
  assert.equal(dbApi.getMission(adaMission)?.permission_mode_override ?? null, null);
});

test('permission mode: without agents:privileged-config the owner cannot raise her mission to bypassPermissions', async () => {
  for (const mode of ['bypassPermissions', 'danger-full-access', 'dontAsk']) {
    const r = await call('POST', `/api/missions/${adaMission}/permission-mode`, { cookie: adaCookie, body: { mode } });
    assert.equal(r.status, 403, mode);
    assert.match(String((r.json as { reason?: string }).reason), /needs the agents:privileged-config permission/);
  }
  assert.equal(dbApi.getMission(adaMission)?.permission_mode_override ?? null, null);
  const state = await call('GET', `/api/missions/${adaMission}/permission-mode`, { cookie: adaCookie });
  assert.equal(state.status, 200);
  const choices = (state.json as { choices: string[] }).choices;
  assert.ok(!choices.includes('bypassPermissions'), 'the selector never offers what the route refuses');
  assert.ok(choices.includes('plan'));
});

test('permission mode: the owner picks a safe level, an unknown one is a 400, an extra field too', async () => {
  const ok = await call('POST', `/api/missions/${adaMission}/permission-mode`, { cookie: adaCookie, body: { mode: 'acceptEdits' } });
  assert.equal(ok.status, 200);
  assert.equal(dbApi.getMission(adaMission)?.permission_mode_override, 'acceptEdits');
  const typo = await call('POST', `/api/missions/${adaMission}/permission-mode`, { cookie: adaCookie, body: { mode: 'bypass' } });
  assert.equal(typo.status, 400);
  const extra = await call('POST', `/api/missions/${adaMission}/permission-mode`, { cookie: adaCookie, body: { mode: 'plan', backend: 'grok' } });
  assert.equal(extra.status, 400);
  const empty = await call('POST', `/api/missions/${adaMission}/permission-mode`, { cookie: adaCookie, body: {} });
  assert.equal(empty.status, 400);
  assert.equal(dbApi.getMission(adaMission)?.permission_mode_override, 'acceptEdits');
});

test('permission mode: the superadmin may raise any mission she sees, and a sandbox name is stored as its Claude name', async () => {
  const r = await call('POST', `/api/missions/${adaMission}/permission-mode`, { cookie: adminCookie, body: { mode: 'danger-full-access' } });
  assert.equal(r.status, 200);
  assert.equal(dbApi.getMission(adaMission)?.permission_mode_override, 'bypassPermissions');
  dbApi.setMissionPermissionModeOverride(adaMission, null);
});

test('U-6: Ada cannot edit, publish, run or delete the superadmin workflow', async () => {
  for (const [method, path, body] of [
    ['PUT', `/api/workflows/${adminWorkflow}`, { name: 'pwned' }],
    ['POST', `/api/workflows/${adminWorkflow}/publish`, {}],
    ['POST', `/api/workflows/${adminWorkflow}/run`, {}],
    ['DELETE', `/api/workflows/${adminWorkflow}`, undefined],
  ] as const) {
    const r = await call(method, path, { cookie: adaCookie, body });
    assert.equal(r.status, 404, `${method} ${path} → ${r.status}`);
  }
  assert.equal(dbApi.getWorkflow(adminWorkflow)?.name, 'Witness');
});

test('U-3: project CRUD is projects:manage; export and setup are superadmin-only', async () => {
  assert.equal((await call('POST', '/api/projects', { cookie: adaCookie, body: { slug: 'pwn' } })).status, 403);
  assert.equal((await call('POST', '/api/projects/demo', { cookie: adaCookie, body: {} })).status, 403);
  assert.equal((await call('POST', '/api/projects/demo', { body: {} })).status, 401);
  assert.equal((await call('DELETE', '/api/projects/anything', { cookie: adaCookie })).status, 403);
  assert.equal((await call('PUT', '/api/projects/anything/meta', { cookie: adaCookie, body: { cwd: '/' } })).status, 403);
  assert.equal((await call('POST', '/api/admin/export', { cookie: adaCookie, body: {} })).status, 403);
  assert.equal((await call('POST', '/api/setup', { cookie: adaCookie, body: {} })).status, 403);
  // The superadmin may export, but never outside TIMON_HOME.
  const outside = await call('POST', '/api/admin/export', { cookie: adminCookie, body: { out: '/tmp/timon-leak.tar.gz' } });
  assert.equal(outside.status, 400);
  const traversal = await call('POST', '/api/admin/export', { cookie: adminCookie, body: { out: '../leak.tar.gz' } });
  assert.equal(traversal.status, 400);
});

test('Settings › System: machine report and service install are superadmin-only, without secrets', async () => {
  assert.equal((await call('GET', '/api/admin/system')).status, 401);
  assert.equal((await call('POST', '/api/admin/service/install', { body: {} })).status, 401);
  assert.equal((await call('GET', '/api/admin/system', { cookie: adaCookie })).status, 403);
  assert.equal((await call('POST', '/api/admin/service/install', { cookie: adaCookie, body: {} })).status, 403);
  // An agent or the CLI holds the daemon token: superadmin, but no person to answer the prompt.
  assert.equal((await call('POST', '/api/admin/service/install', { bearer: TOKEN, body: {} })).status, 403);
  // Lingering lets agents run with nobody at the screen: same gates as the install.
  const always = { mode: 'always' };
  assert.equal((await call('POST', '/api/admin/service/session-mode', { body: always })).status, 401);
  assert.equal((await call('POST', '/api/admin/service/session-mode', { cookie: adaCookie, body: always })).status, 403);
  assert.equal((await call('POST', '/api/admin/service/session-mode', { bearer: TOKEN, body: always })).status, 403);
  assert.equal((await call('POST', '/api/admin/service/session-mode', { cookie: adminCookie, body: { mode: 'forever' } })).status, 400);
  // The superadmin POST is not exercised here: it would install a service on
  // the machine running the tests.
  const report = await call('GET', '/api/admin/system', { cookie: adminCookie });
  assert.equal(report.status, 200);
  const body = report.json as { version: string; paths: { home: string }; service: { command: string } };
  assert.equal(body.paths.home, process.env.TIMON_HOME);
  assert.equal(body.service.command, 'timon service install');
  const text = JSON.stringify(report.json);
  assert.ok(!text.includes(TOKEN), 'the daemon token leaks');
  for (const key of ['token', 'licenseId', 'licenseKey', 'secret', 'password']) {
    assert.ok(!new RegExp(`"${key}"`, 'i').test(text), `a ${key} field leaks`);
  }
});

test('Settings › System: the support report is superadmin-only and masks the daemon token (TODO #343)', { timeout: 60_000 }, async () => {
  assert.equal((await call('GET', '/api/admin/system/diagnostic')).status, 401);
  assert.equal((await call('GET', '/api/admin/system/diagnostic', { cookie: adaCookie })).status, 403);
  assert.equal((await call('GET', '/api/admin/system/diagnostic?app=x;rm', { cookie: adminCookie })).status, 400);
  const home = process.env.TIMON_HOME!;
  mkdirSync(join(home, 'tmp'), { recursive: true });
  writeFileSync(join(home, 'daemon-token'), TOKEN);
  appendFileSync(join(home, 'tmp', datedLogName('daemon', localDay(new Date()))), `request with ${TOKEN}\n`);
  const report = await call('GET', '/api/admin/system/diagnostic?app=0.1.5', { cookie: adminCookie });
  assert.equal(report.status, 200);
  const body = report.json as { text: string; findings: { id: string }[] };
  assert.match(body.text, /== Findings ==/);
  assert.match(body.text, /app {7}0\.1\.5/);
  assert.match(body.text, /request with \*\*\*/);
  assert.ok(!body.text.includes(TOKEN), 'the daemon token leaks');
});

test('U-2: agent configuration, files and memory read behind agents:read; the list is reduced without it', async () => {
  const list = await call('GET', '/api/agents', { cookie: adaCookie });
  assert.equal(list.status, 200);
  for (const a of (list.json as { agents: Array<Record<string, unknown>> }).agents) {
    assert.ok(!('cwd' in a) && !('mcp_servers' in a) && !('allowed_tools' in a), 'reduced list leaks config');
  }
  assert.equal((await call('GET', '/api/agents/_main', { cookie: adaCookie })).status, 403);
  assert.equal((await call('GET', '/api/agents/_main/files?path=.', { cookie: adaCookie })).status, 403);
  assert.equal((await call('GET', '/api/agents/_main/memory', { cookie: adaCookie })).status, 403);
  assert.equal((await call('GET', '/api/agents/_main/learnings', { cookie: adaCookie })).status, 403);
  assert.equal((await call('GET', '/api/projects/p/memory', { cookie: adaCookie })).status, 403);
  assert.equal((await call('DELETE', '/api/agents/_main/memory/x.md', { cookie: adaCookie })).status, 403);
  // The superadmin (and by extension an Administration role carrying `*`) reads everything.
  const full = await call('GET', '/api/agents', { cookie: adminCookie });
  assert.equal(full.status, 200);
  assert.notEqual((await call('GET', '/api/agents/_main/memory', { cookie: adminCookie })).status, 403);
});

test('U-7: a notification may only be linked to a task / mission the caller can read', async () => {
  const foreign = await call('POST', '/api/notifications', {
    cookie: adaCookie, body: { type: 'report', title: 'spam', mission_id: adminMission },
  });
  assert.equal(foreign.status, 404);
  const own = await call('POST', '/api/notifications', {
    cookie: adaCookie, body: { type: 'report', title: 'mine', mission_id: adaMission },
  });
  assert.equal(own.status, 201);
});

test('U-10: a cookie-authenticated mutation from another site is refused; same-origin and CLI pass', async () => {
  const headers = (extra: Record<string, string>) => ({
    'content-type': 'application/json',
    cookie: `${SESSION_COOKIE}=${encodeURIComponent(adaCookie)}`,
    ...extra,
  });
  const body = JSON.stringify({ effort: 'low' });
  const path = `${base}/api/missions/${adaMission}/reasoning-effort`;
  const cross = await fetch(path, { method: 'POST', headers: headers({ 'sec-fetch-site': 'cross-site' }), body });
  assert.equal(cross.status, 403);
  const foreignOrigin = await fetch(path, { method: 'POST', headers: headers({ origin: 'https://evil.example' }), body });
  assert.equal(foreignOrigin.status, 403);
  const opaque = await fetch(path, { method: 'POST', headers: headers({ origin: 'null' }), body });
  assert.equal(opaque.status, 403, 'an opaque Origin: null is cross-site');
  const proxied = await fetch(path, {
    method: 'POST',
    headers: headers({ origin: 'https://timon.example', 'x-forwarded-host': 'timon.example' }),
    body,
  });
  assert.equal(proxied.status, 200, 'the Next proxy relays the browser host next to its Origin');
  const proxiedForeign = await fetch(path, {
    method: 'POST',
    headers: headers({ origin: 'https://evil.example', 'x-forwarded-host': 'timon.example' }),
    body,
  });
  assert.equal(proxiedForeign.status, 403);
  const same = await fetch(path, { method: 'POST', headers: headers({ 'sec-fetch-site': 'same-origin' }), body });
  assert.equal(same.status, 200);
  const sameOrigin = await fetch(path, { method: 'POST', headers: headers({ origin: `http://127.0.0.1:${port}` }), body });
  assert.equal(sameOrigin.status, 200);
  const bare = await fetch(path, { method: 'POST', headers: headers({}), body });
  assert.equal(bare.status, 200);
  // A GET from anywhere is untouched (SameSite=Lax territory, no mutation).
  const get = await fetch(`${base}/api/missions/${adaMission}`, { headers: headers({ 'sec-fetch-site': 'cross-site' }) });
  assert.equal(get.status, 200);
});


test('task deletion enforces anonymous and owner scope, including within one project', async () => {
  const own = randomUUID(), other = randomUUID();
  dbApi.createTask(own, 'Own task', 'ada.agent', { ownerUserId: adaId, project: 'shared' });
  dbApi.createTask(other, 'Other task', 'admin.agent', { ownerUserId: adminId, project: 'shared' });
  assert.equal((await call('DELETE', `/api/tasks/${own}`)).status, 401);
  // Owning the task is not enough: deleting is writing the Kanban (TODO #752).
  assert.equal((await call('DELETE', `/api/tasks/${own}`, { cookie: adaCookie })).status, 403);
  assert.ok(dbApi.getTask(own));
  grantTestPermissions(dbApi, adaId, ['kanban:read', 'kanban:write']);
  try {
    assert.equal((await call('DELETE', `/api/tasks/${other}`, { cookie: adaCookie })).status, 404);
    assert.ok(dbApi.getTask(other));
    assert.equal((await call('DELETE', `/api/tasks/${own}`, { cookie: adaCookie })).status, 200);
    assert.equal(dbApi.getTask(own), undefined);
  } finally {
    grantTestPermissions(dbApi, adaId, []);
  }
  assert.equal((await call('DELETE', `/api/tasks/${other}`, { cookie: adminCookie })).status, 200);
});
