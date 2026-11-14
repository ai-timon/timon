/**
 * M.4 — `/api/capabilities` and `/api/plugins` filtered per viewer.
 * Direct surface APIs (`/api/settings`) follow the same permission.
 * Historical: empty users table does not filter.
 */
import { createTestAccount, grantTestPermissions, postTestAccount } from '../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-surfaces-http-m4-'));
await import('../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes: registerHttpRoutes } = await import('./plugins-bundled/http/routes.js');
const { registerRoutes: registerUserRoutes } = await import('./plugins-bundled/users/routes.js');
const { registerRoutes: registerSettingsRoutes } = await import('./plugins-bundled/settings/routes.js');
const { registerRoutes: registerPluginRoutes } = await import('./plugins-bundled/plugins/routes.js');
const { dbApi } = await import('./db.js');
const { SETUP_ROLE_PRESETS } = await import('../tests/helpers/presets.js');
const { SESSION_COOKIE } = await import('./users/session.js');
const { hashPassword } = await import('./users/password.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: false }));
app.use(express.json());
registerHttpRoutes(app);
registerUserRoutes(app, { setupPolicy: 'free' });
registerSettingsRoutes(app);
registerPluginRoutes(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;
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
  return { status: res.status, json: await res.json(), res };
}

type Caps = {
  surfaces: { all?: boolean; pages?: string[]; widgets?: string[]; plugins?: string[]; layouts?: string[] };
  modules: Array<{ id: string; active: boolean }>;
};

test('empty users table: capabilities stay unrestricted (historical)', async () => {
  assert.equal(dbApi.countUsers(), 0);
  const res = await call('GET', '/api/capabilities');
  assert.equal(res.status, 200);
  const body = res.json as Caps;
  assert.deepEqual(body.surfaces, { all: true });
  assert.ok(body.modules.some((m) => m.id === '@timon/kanban' && m.active));
});

test('superadmin sees every surface; employee does not see kanban or settings', async () => {
  const setup = await call('POST', '/api/auth/setup', {
    body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
  });
  assert.equal(setup.status, 201);
  const adminCookie = sessionCookie(setup.res);
  assert.ok(adminCookie);

  const adminCaps = await call('GET', '/api/capabilities', { cookie: adminCookie });
  assert.equal(adminCaps.status, 200);
  assert.deepEqual((adminCaps.json as Caps).surfaces, { all: true });

  const created = await postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'ada-secret' });
  assert.equal(created.status, 201);
  const adaId = (created.json as { user: { id: string } }).user.id;
  const employeePreset = SETUP_ROLE_PRESETS.find((p) => p.key === 'employee');
  assert.ok(employeePreset);
  grantTestPermissions(dbApi, adaId, [...employeePreset.permissions]);

  const adaLogin = await call('POST', '/api/auth/login', {
    body: { email: 'ada@example.com', password: 'ada-secret' },
  });
  const adaCookie = sessionCookie(adaLogin.res);
  assert.ok(adaCookie);

  const adaCaps = await call('GET', '/api/capabilities', { cookie: adaCookie });
  assert.equal(adaCaps.status, 200);
  const surfaces = (adaCaps.json as Caps).surfaces;
  assert.ok(!surfaces.all);
  assert.deepEqual(surfaces.pages, ['/', '/chat']);
  assert.equal(surfaces.pages?.includes('/kanban'), false);
  assert.equal(surfaces.pages?.includes('/settings'), false);
  assert.deepEqual(surfaces.layouts, ['ui-layout']);
  assert.ok(surfaces.plugins?.includes('@timon/ui-layout'));
  assert.ok((adaCaps.json as Caps).modules.some((m) => m.id === '@timon/kanban'), 'kernel truth stays');

  const adaPlugins = await call('GET', '/api/plugins', { cookie: adaCookie });
  assert.equal(adaPlugins.status, 200);
  const adaIds = ((adaPlugins.json as { plugins: Array<{ id: string }> }).plugins).map((p) => p.id);
  assert.equal(adaIds.includes('@timon/kanban'), false);
  assert.equal(adaIds.includes('acme-crm'), false);

  const hidden = await call('GET', `/api/plugins/${encodeURIComponent('@timon/kanban')}`, { cookie: adaCookie });
  assert.equal(hidden.status, 404);

  const adaSettings = await call('GET', '/api/settings', { cookie: adaCookie });
  assert.equal(adaSettings.status, 403);

  const adminSettings = await call('GET', '/api/settings', { cookie: adminCookie });
  assert.equal(adminSettings.status, 200);

  const adminPlugins = await call('GET', '/api/plugins', { cookie: adminCookie });
  const adminIds = ((adminPlugins.json as { plugins: Array<{ id: string }> }).plugins).map((p) => p.id);
  assert.ok(adminIds.includes('@timon/kanban'));
});

test('Administration role (not superadmin) sees settings via page:/settings', async () => {
  const hash = await hashPassword('boss-secret');
  const boss = createTestAccount(dbApi, {
    email: 'boss@example.com',
    name: 'Boss',
    passwordHash: hash,
  });
  const adminPreset = SETUP_ROLE_PRESETS.find((p) => p.key === 'administration');
  assert.ok(adminPreset);
  grantTestPermissions(dbApi, boss.id, adminPreset.permissions);

  const login = await call('POST', '/api/auth/login', {
    body: { email: 'boss@example.com', password: 'boss-secret' },
  });
  const cookie = sessionCookie(login.res);
  assert.ok(cookie);

  const caps = await call('GET', '/api/capabilities', { cookie });
  assert.deepEqual((caps.json as Caps).surfaces, { all: true });
  const settings = await call('GET', '/api/settings', { cookie });
  assert.equal(settings.status, 200);
});

test('capabilities carry the daemon version and its integer apiLevel, never to an anonymous caller', async () => {
  const { readFileSync } = await import('node:fs');
  const { API_LEVEL } = await import('./kernel/capabilities.js');
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  assert.ok(dbApi.countUsers() > 0, 'runs after the setup above');
  const anonymous = await call('GET', '/api/capabilities');
  assert.equal(anonymous.status, 401);
  const login = await call('POST', '/api/auth/login', { body: { email: 'admin@example.com', password: 'admin-secret' } });
  const cookie = sessionCookie(login.res);
  assert.ok(cookie);
  const caps = await call('GET', '/api/capabilities', { cookie });
  assert.equal(caps.status, 200);
  const body = caps.json as { version: unknown; apiLevel: unknown };
  assert.equal(body.version, pkg.version);
  assert.equal(body.apiLevel, API_LEVEL);
  assert.ok(Number.isInteger(body.apiLevel) && (body.apiLevel as number) >= 1);
});
