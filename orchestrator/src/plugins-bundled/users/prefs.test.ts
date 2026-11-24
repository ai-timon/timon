/**
 * T.2 / T.7 — GET /api/auth/me carries prefs; PUT /api/prefs writes scheme,
 * theme and layout. Two sessions stay isolated. A daemon-token with no
 * user is 403 on PUT. Ungranted chrome is 404.
 *
 * Witness server on 127.0.0.1:0, never :3000.
 */
import { createTestAccount, grantTestPermissions } from '../../../tests/helpers/accounts.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-users-prefs-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { dbApi, DEFAULT_USER_PREFS } = await import('../../db.js');
const { SESSION_COOKIE, hashSessionToken, issueSessionToken } = await import('../../users/session.js');
const { SETUP_ROLE_PRESETS } = await import('../../../tests/helpers/presets.js');
const { attachPluginLoader } = await import('../../plugins/runtime.js');

const TOKEN = 'witness-prefs-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app, { setupPolicy: 'free' });

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;

test.after(() => { server.close(); });

function sessionFor(userId: string): string {
  const raw = issueSessionToken();
  dbApi.createSession({
    tokenHash: hashSessionToken(raw),
    userId,
    expiresAt: Date.now() + 60_000,
  });
  return raw;
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string } = {},
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  return { status: res.status, json: await res.json() };
}

test('GET /api/auth/me before setup returns product-default prefs', async () => {
  const me = await call('GET', '/api/auth/me');
  assert.equal(me.status, 200);
  assert.deepEqual(me.json, { user: null, needsSetup: true, setupRequiresToken: false, setupRequiresLicense: false, setupRequiresEmailCode: false, prefs: DEFAULT_USER_PREFS, can: { 'projects:manage': false, 'agents:manage': false, 'agents:privileged-config': false, 'providers:manage': false, 'providers:accounts': false, 'settings:write': false }, welcome: null, emailUnverified: false });
});

test('daemon-token without a user: GET defaults, PUT 403', async () => {
  const me = await call('GET', '/api/auth/me', { bearer: TOKEN });
  assert.equal(me.status, 200);
  const body = me.json as { user: unknown; prefs: unknown };
  assert.equal(body.user, null);
  assert.deepEqual(body.prefs, DEFAULT_USER_PREFS);

  const put = await call('PUT', '/api/prefs', {
    bearer: TOKEN,
    body: { scheme: 'light' },
  });
  assert.equal(put.status, 403);
});

test('Ada light and Bob dark stay distinct; invalid scheme is 400', async () => {
  const ada = createTestAccount(dbApi, {
    email: 'ada@example.com',
    name: 'Ada',
    passwordHash: 'x',
    isSuperadmin: false,
  });
  const bob = createTestAccount(dbApi, {
    email: 'bob@example.com',
    name: 'Bob',
    passwordHash: 'x',
    isSuperadmin: false,
  });
  const adaCookie = sessionFor(ada.id);
  const bobCookie = sessionFor(bob.id);

  const adaPut = await call('PUT', '/api/prefs', {
    cookie: adaCookie,
    body: { scheme: 'light' },
  });
  assert.equal(adaPut.status, 200);
  assert.deepEqual((adaPut.json as { prefs: unknown }).prefs, {
    // An account made today wears the Timon theme (0.1.7).
    theme: 'theme-timon',
    layout: '@timon/ui-layout',
    scheme: 'light',
  });

  const bobPut = await call('PUT', '/api/prefs', {
    cookie: bobCookie,
    body: { scheme: 'dark' },
  });
  assert.equal(bobPut.status, 200);

  const adaMe = await call('GET', '/api/auth/me', { cookie: adaCookie });
  const bobMe = await call('GET', '/api/auth/me', { cookie: bobCookie });
  assert.equal((adaMe.json as { prefs: { scheme: string } }).prefs.scheme, 'light');
  assert.equal((bobMe.json as { prefs: { scheme: string } }).prefs.scheme, 'dark');
  assert.equal((adaMe.json as { prefs: { theme: string } }).prefs.theme, 'theme-timon');
  assert.equal((bobMe.json as { prefs: { layout: string } }).prefs.layout, '@timon/ui-layout');

  const bad = await call('PUT', '/api/prefs', {
    cookie: adaCookie,
    body: { scheme: 'auto' },
  });
  assert.equal(bad.status, 400);

  const missing = await call('PUT', '/api/prefs', {
    cookie: adaCookie,
    body: {},
  });
  assert.equal(missing.status, 400);

  const stillAda = await call('GET', '/api/auth/me', { cookie: adaCookie });
  assert.equal((stillAda.json as { prefs: { scheme: string } }).prefs.scheme, 'light');
});

function stubChromePlugin(
  id: string,
  kind: 'theme' | 'layout' | 'widget',
  state: 'active' | 'disabled' = 'active',
) {
  const slot = kind === 'layout' ? 'root' : kind === 'theme' ? 'theme' : 'cockpit.widget';
  return {
    id,
    pkg: id,
    dir: `/tmp/${id}`,
    version: '0.1.0',
    state,
    reason: null,
    error: null,
    manifest: {
      id,
      apiVersion: 1,
      kind: [kind],
      label: id === 'plugin-theme' ? 'Nord' : id,
      permissions: [],
      client: { slots: [slot], external: [] as string[], mode: 'esm' as const },
      settings: [],
      license: { required: false },
      declares: {},
      modifies: [],
      contains: [],
      screenshots: [],
    },
    client: true,
    signed: false,
  };
}

test('Ada chooses plugin-theme, Bob keeps salmon; revoked grant is 404 and does not break GET', async () => {
  attachPluginLoader(app, {
    list: () => [
      stubChromePlugin('plugin-theme', 'theme'),
      stubChromePlugin('blank-layout', 'layout'),
      stubChromePlugin('idle-theme', 'theme', 'disabled'),
      stubChromePlugin('hello', 'widget'),
    ],
    bundles: { get: () => null },
    covers: { get: () => null },
  } as Parameters<typeof attachPluginLoader>[1]);

  const ada = createTestAccount(dbApi, {
    email: 'ada-chrome@example.com',
    name: 'Ada Chrome',
    passwordHash: 'x',
    isSuperadmin: false,
  });
  const bob = createTestAccount(dbApi, {
    email: 'bob-chrome@example.com',
    name: 'Bob Chrome',
    passwordHash: 'x',
    isSuperadmin: false,
  });
  grantTestPermissions(dbApi, ada.id, [
    'theme:ui-theme',
    'theme:plugin-theme',
    'layout:ui-layout',
    'layout:blank-layout',
  ]);

  const employee = SETUP_ROLE_PRESETS.find((row) => row.key === 'employee');
  assert.ok(employee);
  grantTestPermissions(dbApi, bob.id, [...employee.permissions]);

  const adaCookie = sessionFor(ada.id);
  const bobCookie = sessionFor(bob.id);

  const adaPut = await call('PUT', '/api/prefs', {
    cookie: adaCookie,
    body: { theme: 'plugin-theme' },
  });
  assert.equal(adaPut.status, 200);
  assert.equal((adaPut.json as { prefs: { theme: string } }).prefs.theme, 'plugin-theme');
  assert.equal((adaPut.json as { prefs: { scheme: string } }).prefs.scheme, 'dark');

  const bobDenied = await call('PUT', '/api/prefs', {
    cookie: bobCookie,
    body: { theme: 'plugin-theme' },
  });
  assert.equal(bobDenied.status, 404, 'Bob must not learn that plugin-theme exists');

  const bobKeep = await call('PUT', '/api/prefs', {
    cookie: bobCookie,
    body: { theme: '@timon/ui-theme' },
  });
  assert.equal(bobKeep.status, 200);

  const adaMe = await call('GET', '/api/auth/me', { cookie: adaCookie });
  const bobMe = await call('GET', '/api/auth/me', { cookie: bobCookie });
  assert.equal((adaMe.json as { prefs: { theme: string } }).prefs.theme, 'plugin-theme');
  assert.equal((bobMe.json as { prefs: { theme: string } }).prefs.theme, '@timon/ui-theme');

  const unknown = await call('PUT', '/api/prefs', {
    cookie: adaCookie,
    body: { theme: 'missing-theme' },
  });
  assert.equal(unknown.status, 404);
  const idle = await call('PUT', '/api/prefs', {
    cookie: adaCookie,
    body: { theme: 'idle-theme' },
  });
  assert.equal(idle.status, 404);
  const wrongKind = await call('PUT', '/api/prefs', {
    cookie: adaCookie,
    body: { theme: 'hello' },
  });
  assert.equal(wrongKind.status, 404);

  const adaLayout = await call('PUT', '/api/prefs', {
    cookie: adaCookie,
    body: { layout: 'blank-layout' },
  });
  assert.equal(adaLayout.status, 200);
  assert.equal((adaLayout.json as { prefs: { layout: string } }).prefs.layout, 'blank-layout');
  assert.equal((adaLayout.json as { prefs: { theme: string } }).prefs.theme, 'plugin-theme');

  grantTestPermissions(dbApi, ada.id, ['theme:ui-theme', 'layout:ui-layout']);
  const revoked = await call('PUT', '/api/prefs', {
    cookie: adaCookie,
    body: { theme: 'plugin-theme' },
  });
  assert.equal(revoked.status, 404);
  const stillAda = await call('GET', '/api/auth/me', { cookie: adaCookie });
  assert.equal(
    (stillAda.json as { prefs: { theme: string } }).prefs.theme,
    'plugin-theme',
    'revoked grant does not rewrite stored prefs; the loader falls back',
  );
});
