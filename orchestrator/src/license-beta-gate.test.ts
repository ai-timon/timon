/**
 * A beta build that is expired, or whose licence ended, answers NOTHING but
 * licence, health and auth — for every identity. The refusals come first: an
 * anonymous caller, then the daemon-token and a superadmin session, on routes
 * that need no identity, on core routes and on routes the module guard does
 * not cover. Only then the ways out, and the builds the wall must not touch.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { removeHomeOnExit } from '../tests/helpers/test-home.js';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-beta-gate-'));
// Removed at exit, once the database is closed: Windows will not delete an open timon.db.
removeHomeOnExit(process.env.TIMON_HOME);
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
const { overrideBuildInfo } = await import('./build-info.js');
const { unlicensed } = await import('./license/license.js');
const runtime = await import('./license/runtime.js');
const { dbApi } = await import('./db.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { createBetaGate, betaGateAllows } = await import('./license/beta-gate.js');
const { registerRoutes: userRoutes } = await import('./plugins-bundled/users/routes.js');
const { registerRoutes: licenseRoutes } = await import('./kernel/routes/license.js');
const { registerRoutes: settingsRoutes } = await import('./plugins-bundled/settings/routes.js');
const { issueSessionToken, hashSessionToken, SESSION_COOKIE } = await import('./users/session.js');
const { registerRoutes: updateRoutes } = await import('./plugins-bundled/updates/routes.js');
const { UpdateChecker } = await import('./plugins-bundled/updates/checker.js');
const { betaLocked } = await import('./license/build-policy.js');
const { planEntries } = await import('./kernel/registry.js');
const { CATALOG } = await import('./kernel/catalog.js');
const { config } = await import('./config/load.js');
const { overrideSetupPolicyForTests } = await import('./users/setup-policy.js');
// The wall below is the closed-beta contract; the `free` case has its own test.
overrideSetupPolicyForTests('beta');

const hook = '/api/triggers/hooks/some-public-route';
const inbound = '/api/integrations/12345678-1234-1234-1234-123456789abc/inbound';

const app = express();
app.use(createDaemonAuthMiddleware({ token: 'test-admin', required: false }));
app.use(createBetaGate());
app.use(express.json());
// Stand-ins for the routes the daemon really has: what matters is that none of
// them is ever reached. `reached` is what an open wall would have let through.
const reached: string[] = [];
for (const [method, path] of [
  ['get', '/api/projects'], ['post', '/api/missions'], ['get', '/api/events'], ['get', '/api/backends'],
  ['post', '/api/auth/password'], ['post', hook], ['post', inbound], ['get', '/api/capabilities'], ['get', '/'],
] as const) {
  app[method](path, (_req, res) => { reached.push(path); res.json({ ok: true }); });
}
app.get('/api/health', (_req, res) => res.json({ ok: true }));
userRoutes(app); licenseRoutes(app); settingsRoutes(app);
// A real checker, switched off: what matters here is who reaches its routes.
// `checks` counts the requests to timon-ai.com that would have left.
let checks = 0;
const checker = new UpdateChecker({
  enabled: () => false, channel: () => 'beta', installed: () => '0.1.0', keyring: () => [],
  stateFile: join(process.env.TIMON_HOME!, 'updates.state.json'),
  fetch: async () => { checks += 1; throw new Error('no network in this test'); },
});
updateRoutes(app, { status: () => checker.status(), check: () => checker.check(), missions: () => ({ live: 0, working: 0 }) });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); overrideSetupPolicyForTests(undefined); overrideBuildInfo(undefined); });

type Who = 'anonymous' | 'daemon-token' | 'session';
let sessionCookie = '';
async function call(method: string, path: string, who: Who, body?: unknown) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who === 'daemon-token') headers.authorization = 'Bearer test-admin';
  if (who === 'session') headers.cookie = `${SESSION_COOKIE}=${sessionCookie}`;
  const res = await fetch(base + path, { method, headers, body: body === undefined || method === 'GET' ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, unknown> | null };
}

const live = (seconds: number) => overrideBuildInfo({ channel: 'beta', builtAt: new Date(Date.now() - 86_400_000).toISOString(), expiresAt: new Date(Date.now() + seconds * 1000).toISOString() });
const expiredBuild = () => { live(-60); runtime.setLicenseState(unlicensed('missing')); };

const BUSINESS: readonly (readonly [string, string])[] = [
  ['GET', '/api/projects'], ['POST', '/api/missions'], ['GET', '/api/events'], ['GET', '/api/backends'],
  ['POST', '/api/auth/password'], ['GET', '/api/capabilities'], ['GET', '/'], ['POST', hook], ['POST', inbound],
];
const OPEN: readonly (readonly [string, string])[] = [['GET', '/api/health'], ['GET', '/api/auth/me'], ['GET', '/api/license']];

test('first run, expired build: anonymous reaches neither a hook nor the business routes, and no account is created', async () => {
  expiredBuild();
  assert.equal(dbApi.countUsers(), 0);
  for (const [method, path] of BUSINESS) {
    const { status, body } = await call(method, path, 'anonymous', {});
    assert.equal(status, 403, `${method} ${path}`);
    assert.deepEqual(body, { error: 'license_required', reason: 'build_expired' });
  }
  const setup = await call('POST', '/api/auth/setup', 'anonymous', { email: 'a@example.test', name: 'A', password: 'long-enough-password', licenseKey: 'TMN-X' });
  assert.equal(setup.status, 403);
  assert.deepEqual(setup.body, { error: 'build_expired' });
  assert.equal(dbApi.countUsers(), 0);
  assert.deepEqual(reached, []);
});

test('expired build: an anonymous caller is refused once an account exists (401), hooks included (403)', async () => {
  const admin = createTestAccount(dbApi, { email: 'root@example.test', name: 'Root', passwordHash: 'hash', isSuperadmin: true, status: 'active' });
  const token = issueSessionToken();
  dbApi.createSession({ tokenHash: hashSessionToken(token), userId: admin.id, expiresAt: Date.now() + 600_000 });
  sessionCookie = token;
  expiredBuild();
  for (const [method, path] of BUSINESS) {
    const { status } = await call(method, path, 'anonymous', {});
    assert.ok(status === 401 || status === 403, `${method} ${path} → ${status}`);
  }
  // Public endpoints carry no identity: only the wall stops them.
  assert.equal((await call('POST', hook, 'anonymous', {})).status, 403);
  assert.equal((await call('POST', inbound, 'anonymous', {})).status, 403);
  assert.deepEqual(reached, []);
});

test('expired build: the daemon-token and a superadmin session are refused too, on everything but licence, health and auth', async () => {
  expiredBuild();
  for (const who of ['daemon-token', 'session'] as const) {
    for (const [method, path] of BUSINESS) {
      const { status, body } = await call(method, path, who, {});
      assert.equal(status, 403, `${who} ${method} ${path}`);
      assert.equal(body?.error, 'license_required');
      assert.equal(body?.reason, 'build_expired');
    }
    for (const [method, path] of OPEN) {
      assert.equal((await call(method, path, who)).status, 200, `${who} ${method} ${path}`);
    }
    const state = await call('GET', '/api/license', who);
    assert.equal(state.body?.status, 'unlicensed');
    assert.equal(state.body?.reason, 'build_expired');
    assert.equal(state.body?.localFree, false);
  }
  assert.deepEqual(reached, []);
});

test('beta_ended on a live build is walled the same way, and reports it', async () => {
  live(3600);
  runtime.setLicenseState(unlicensed('revoked'));
  for (const who of ['daemon-token', 'session'] as const) {
    for (const [method, path] of BUSINESS) {
      const { status, body } = await call(method, path, who, {});
      assert.equal(status, 403, `${who} ${method} ${path}`);
      assert.equal(body?.reason, 'beta_ended');
    }
  }
  assert.equal((await call('GET', '/api/license', 'session')).body?.reason, 'beta_ended');
  assert.deepEqual(reached, []);
});

test('the allowlist is exact: nothing else under /api/auth or /api/license gets through', () => {
  for (const [method, path] of [...OPEN, ['POST', '/api/auth/login'], ['POST', '/api/auth/logout'], ['POST', '/api/license/activate'], ['PUT', '/api/license'], ['POST', '/api/admin/export'], ['GET', '/api/updates'], ['POST', '/api/updates/check'], ['GET', '/api/updates/missions']] as const) {
    assert.equal(betaGateAllows(method, path), true, `${method} ${path}`);
  }
  for (const [method, path] of [
    ...BUSINESS, ['POST', '/api/auth/password'], ['PATCH', '/api/auth/profile'], ['POST', '/api/auth/email'], ['DELETE', '/api/license'],
    ['GET', '/api/license/export'], ['GET', '/api/admin/export'], ['PUT', '/api/admin/export'], ['POST', '/api/admin/export/x'], ['POST', '/api/admin/import'], ['GET', '/api/license/'], ['GET', '/api/license/../projects'], ['GET', '/api/health/x'], ['POST', '/api/health'],
    ['GET', '/API/HEALTH'], ['GET', '/api/auth/me/x'],
    ['POST', '/api/updates'], ['GET', '/api/updates/check'], ['GET', '/api/updates/x'], ['DELETE', '/api/updates'],
    ['POST', '/api/updates/missions'], ['GET', '/api/updates/missions/x'],
  ] as const) {
    assert.equal(betaGateAllows(method, path), false, `${method} ${path}`);
  }
});

test('a valid licence on a live beta build is not walled', async () => {
  live(3600);
  runtime.setLicenseState({ ...unlicensed('missing'), status: 'valid', reason: null, localFree: false, planId: 'beta', plan: 'Beta', modules: '*', plugins: '*', users: null, capabilities: undefined });
  for (const who of ['daemon-token', 'session'] as const) {
    assert.equal((await call('GET', '/api/projects', who)).status, 200, who);
  }
});

test('the end date is judged on the request itself, no tick needed', async () => {
  overrideBuildInfo({ channel: 'beta', builtAt: new Date(Date.now() - 86_400_000).toISOString(), expiresAt: new Date(Date.now() + 250).toISOString() });
  runtime.setLicenseState({ ...unlicensed('missing'), status: 'valid', reason: null, localFree: false, planId: 'beta', plan: 'Beta', modules: '*', plugins: '*', users: null, capabilities: undefined });
  assert.equal((await call('GET', '/api/projects', 'daemon-token')).status, 200);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const { status, body } = await call('GET', '/api/projects', 'daemon-token');
  assert.equal(status, 403);
  assert.equal(body?.reason, 'build_expired');
});

test('stable and dev builds are not walled: a dead licence is Free and the routes answer', async () => {
  for (const channel of ['stable', 'dev'] as const) {
    overrideBuildInfo({ channel, builtAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 60_000).toISOString() });
    runtime.setLicenseState(unlicensed('revoked'));
    assert.equal(runtime.licenseState().localFree, true, channel);
    assert.equal((await call('GET', '/api/projects', 'daemon-token')).status, 200, channel);
    assert.equal((await call('POST', hook, 'anonymous', {})).status, 200, channel);
  }
  overrideBuildInfo(undefined);
  runtime.setLicenseState(unlicensed('revoked'));
  assert.equal((await call('GET', '/api/projects', 'daemon-token')).status, 200);
});

test('free policy: a live beta build without a licence is not walled, an expired one still is', async () => {
  overrideSetupPolicyForTests('free');
  try {
    live(3600);
    runtime.setLicenseState(unlicensed('missing'));
    assert.equal(runtime.licenseState().localFree, true);
    assert.equal((await call('GET', '/api/projects', 'daemon-token')).status, 200);
    expiredBuild();
    const { status, body } = await call('GET', '/api/projects', 'daemon-token');
    assert.equal(status, 403);
    assert.equal(body?.reason, 'build_expired');
  } finally {
    overrideSetupPolicyForTests('beta');
  }
});

test('the daemon mounts the wall right after authentication and before the body parser', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('./kernel-boot.ts', import.meta.url), 'utf8');
  const auth = source.indexOf('app.use(createDaemonAuthMiddleware(');
  const gate = source.indexOf('app.use(createBetaGate())');
  // The parser lives in kernel/body-parser.ts; its mount point is what counts.
  const parser = source.indexOf('app.use(createBodyParser())');
  assert.ok(auth > 0 && gate > auth && parser > gate, 'auth < beta gate < body parser');
});

test('GET /api/license tells the tester when the build ends, and nothing of how that is judged', async () => {
  const expiresAt = new Date(Date.now() + 10 * 86_400_000).toISOString();
  overrideBuildInfo({ channel: 'beta', builtAt: new Date(Date.now() - 86_400_000).toISOString(), expiresAt });
  runtime.setLicenseState(unlicensed('revoked'));
  const { body } = await call('GET', '/api/license', 'session');
  assert.deepEqual(body?.build, { channel: 'beta', expiresAt });
  assert.equal(body?.reason, 'beta_ended');
  assert.doesNotMatch(JSON.stringify(body), /builtAt|clockHigh|maxSrv|lastSeen/);

  overrideBuildInfo(undefined);
  runtime.setLicenseState(unlicensed('revoked'));
  assert.deepEqual((await call('GET', '/api/license', 'session')).body?.build, { channel: 'dev', expiresAt: null });
});

test('the data export answers on a locked build, without anything to write but its own archive', async () => {
  const home = process.env.TIMON_HOME!;
  const archives = () => readdirSync(home).filter((name) => name.startsWith('timon-export-'));
  // An identity is required before the wall even speaks.
  expiredBuild();
  assert.equal((await call('POST', '/api/admin/export', 'anonymous', {})).status, 401);
  assert.deepEqual(archives(), []);

  for (const state of [() => expiredBuild(), () => { live(3600); runtime.setLicenseState(unlicensed('revoked')); }]) {
    state();
    // A caller-chosen `out` could overwrite the licence store or the database.
    for (const out of ['license.state.json', 'timon.db', 'timon-export-x.tar.gz']) {
      const refused = await call('POST', '/api/admin/export', 'session', { out });
      assert.equal(refused.status, 400, out);
      assert.deepEqual(refused.body, { error: 'out_not_allowed', code: 'export_out_not_allowed' });
    }
    assert.deepEqual(archives(), []);
    const { status, body } = await call('POST', '/api/admin/export', 'session', {});
    assert.equal(status, 200);
    assert.equal(body?.ok, true);
    assert.ok(existsSync(String(body?.out)));
    rmSync(String(body?.out));
  }
});

test('a locked beta build still shows the newer version: the update routes pass the wall, nothing else does', async () => {
  // Earlier tests open the wall on purpose (valid licence, stable and dev builds).
  reached.length = 0;
  for (const lock of [() => expiredBuild(), () => { live(3600); runtime.setLicenseState(unlicensed('revoked')); }]) {
    lock();
    // The routes keep their own authentication: an anonymous caller stays refused.
    assert.equal((await call('GET', '/api/updates', 'anonymous')).status, 401);
    assert.equal((await call('POST', '/api/updates/check', 'anonymous', {})).status, 401);
    assert.equal((await call('GET', '/api/updates/missions', 'anonymous')).status, 401);
    for (const who of ['daemon-token', 'session'] as const) {
      assert.deepEqual((await call('GET', '/api/updates/missions', who)).body, { live: 0, working: 0 }, `${who} GET /api/updates/missions`);
      const status = await call('GET', '/api/updates', who);
      assert.equal(status.status, 200, `${who} GET /api/updates`);
      assert.equal(status.body?.installed, '0.1.0');
      assert.equal((await call('POST', '/api/updates/check', who, {})).status, 200, `${who} POST /api/updates/check`);
      for (const [method, path] of BUSINESS) {
        assert.equal((await call(method, path, who, {})).status, 403, `${who} ${method} ${path}`);
      }
    }
  }
  // Switched off: the check answered without a single request.
  assert.equal(checks, 0);
  assert.deepEqual(reached, []);
});

test('a locked beta build keeps @timon/updates running and its routes unguarded by the module licence', () => {
  for (const reason of ['build_expired', 'beta_ended'] as const) {
    const plan = planEntries(CATALOG, { config: { ...config(), modules: {} }, capabilities: [], license: betaLocked(reason) });
    const updates = plan.find((entry) => entry.id === '@timon/updates');
    assert.equal(updates?.disabled, false, reason);
    // A paid module next to it is still off: the exemption is this one module.
    assert.equal(plan.find((entry) => entry.id === '@timon/machines')?.disabled, true, reason);
  }
});
