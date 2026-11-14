/**
 * The mission isolation card (`/api/admin/isolation`), through the real
 * routes: only a superadmin signed in to the app may read or change it, never
 * the daemon token nor a mission token, whose own fence it is; a write lands
 * in `timon.config.json`, every other key kept, AND in the live config; a body
 * the fence could not apply faithfully is refused before anything is written.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
// Two accounts, one superadmin: a paid install, as the Multi-user plugin serves it.
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import type { RequestAuth } from '../../users/identity.js';

const { dbApi } = await import('../../db.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { createBodyParser } = await import('../../kernel/body-parser.js');
const { createHttpPlugin } = await import('../../kernel/http-service.js');
const { registerIsolationRoutes, ISOLATION_SETTINGS_PATH } = await import('./isolation-routes.js');
const { CONFIG_FILE, config, resetConfig } = await import('../../config/load.js');

const DAEMON = 'daemon-isolation-token';
function user(name: string, superadmin: boolean) {
  const id = randomUUID();
  return createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'x', isSuperadmin: superadmin });
}
const admin = user('admin', true);
const bob = user('bob', false);
const IDENTITIES: Record<string, RequestAuth> = {
  admin: { kind: 'session', user: admin, isSuperadmin: true },
  bob: { kind: 'session', user: bob, isSuperadmin: false, permissions: ['settings:write'] },
  mission: { kind: 'api-token', user: admin, isSuperadmin: true, missionId: 'm-1' },
};

const app = express();
app.use((req, res, next) => {
  const as = req.header('x-test-as');
  if (as && IDENTITIES[as]) { req.auth = IDENTITIES[as]; next(); return; }
  createDaemonAuthMiddleware({ token: DAEMON, required: true })(req, res, next);
});
app.use(createBodyParser());
const ctx = new Context();
await ctx.plugin(createHttpPlugin(app));
registerIsolationRoutes(ctx.http.router());

const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(async () => {
  server.closeAllConnections();
  server.close();
  await ctx.fiber.dispose();
  rmSync(CONFIG_FILE, { force: true });
  resetConfig();
});

type Caller = 'admin' | 'bob' | 'mission' | 'daemon' | null;
async function call(method: 'GET' | 'PUT', body?: unknown, as: Caller = 'admin') {
  const headers: Record<string, string> = {};
  if (as === 'daemon') headers.authorization = `Bearer ${DAEMON}`;
  else if (as) headers['x-test-as'] = as;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${ISOLATION_SETTINGS_PATH}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}
const onDisk = (): Record<string, unknown> | undefined => (existsSync(CONFIG_FILE) ? JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown> : undefined);

test('anonymous is refused on both verbs (401), first run included', async () => {
  assert.equal((await call('GET', undefined, null)).status, 401);
  assert.equal((await call('PUT', { filesystem: 'off' }, null)).status, 401);
  assert.equal(onDisk(), undefined);
});

test('a non-superadmin session is refused (403), even with settings:write', async () => {
  assert.equal((await call('GET', undefined, 'bob')).status, 403);
  assert.equal((await call('PUT', { filesystem: 'off' }, 'bob')).status, 403);
  assert.equal(onDisk(), undefined, 'a refused write leaves the file alone');
});

test('neither the daemon token nor a superadmin mission token may read or widen the fence (403)', async () => {
  for (const as of ['daemon', 'mission'] as const) {
    assert.equal((await call('GET', undefined, as)).status, 403, as);
    assert.equal((await call('PUT', { unixSockets: 'allow' }, as)).status, 403, as);
  }
  assert.equal(onDisk(), undefined);
  assert.equal(config().host.isolation.unixSockets, 'deny');
});

test('the superadmin reads the state: what a launch gets, next to its settings', async () => {
  const { status, json } = await call('GET');
  assert.equal(status, 200);
  const state = json as { status: { configured: string; mechanism: string; message: string }; settings: { filesystem: string; unixSockets: string } };
  assert.equal(state.status.configured, 'auto');
  assert.ok(['landlock', 'seatbelt', 'none'].includes(state.status.mechanism));
  assert.ok(state.status.message.length > 0);
  assert.deepEqual(state.settings, { filesystem: 'auto', unixSockets: 'deny', exceptions: { agents: {}, projects: {} } });
});

test('a write lands in the file, every other key kept, and in the live config', async () => {
  writeFileSync(CONFIG_FILE, `${JSON.stringify({ profile: 'local', host: { docker: 'auto', isolation: { deny: ['~/.secret'] } } }, null, 2)}\n`);
  const exceptions = {
    agents: { 'timon.deployer': { unixSockets: 'allow', writable: [] } },
    projects: { site: { writable: ['~/.npm'] } },
  };
  const { status, json } = await call('PUT', { filesystem: 'enforce', unixSockets: 'deny', exceptions });
  assert.equal(status, 200, JSON.stringify(json));
  const file = onDisk() as { profile: string; host: { docker: string; isolation: Record<string, unknown> } };
  assert.equal(file.profile, 'local');
  assert.equal(file.host.docker, 'auto');
  assert.deepEqual(file.host.isolation, { deny: ['~/.secret'], filesystem: 'enforce', unixSockets: 'deny', exceptions });
  if (process.platform !== 'win32') assert.equal(statSync(CONFIG_FILE).mode & 0o777, 0o600);

  const live = config().host.isolation;
  assert.equal(live.filesystem, 'enforce');
  assert.deepEqual(live.exceptions, exceptions);
  const state = json as { status: { configured: string; exceptions: unknown }; settings: { filesystem: string } };
  assert.equal(state.settings.filesystem, 'enforce');
  assert.deepEqual(state.status.exceptions, { agents: ['timon.deployer'], projects: ['site'] });

  // A partial write touches only its key.
  assert.equal((await call('PUT', { filesystem: 'auto' })).status, 200);
  assert.deepEqual((onDisk() as { host: { isolation: { exceptions: unknown } } }).host.isolation.exceptions, exceptions);
  assert.equal(config().host.isolation.filesystem, 'auto');
});

test('a body the fence could not apply faithfully is refused before any write (400)', async () => {
  const before = readFileSync(CONFIG_FILE, 'utf8');
  const bad: unknown[] = [
    {},
    { filesystem: 'strict' },
    { unixSockets: 'maybe' },
    { runAs: 'nobody' },
    { exceptions: { agents: { '../escape': { writable: [] } }, projects: {} } },
    { exceptions: { agents: { ok: { writable: ['relative/path'] } }, projects: {} } },
    { exceptions: { agents: { ok: { writable: ['/tmp/a\nb'] } }, projects: {} } },
    { exceptions: { agents: { ok: { writable: [], extra: true } }, projects: {} } },
    { exceptions: { agents: {} } },
  ];
  for (const body of bad) {
    const { status, json } = await call('PUT', body);
    assert.equal(status, 400, JSON.stringify(body));
    assert.equal(json.error, 'invalid-body');
  }
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before);
});

test('an unreadable configuration file is never overwritten (409)', async () => {
  writeFileSync(CONFIG_FILE, '{ not json');
  const { status, json } = await call('PUT', { filesystem: 'off' });
  assert.equal(status, 409);
  assert.equal(json.error, 'config-unreadable');
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), '{ not json');
});
