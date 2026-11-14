/**
 * Who may read the update status and force a check. The auth middleware runs
 * in its permissive mode (`required: false`) and the first test runs before
 * any account exists — the first-run window where the middleware lets an
 * anonymous caller through — so its refusals are the routes' own.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-updates-routes-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { dbApi } = await import('../../db.js');
const { hashPassword } = await import('../../users/password.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes } = await import('./routes.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
type UpdateStatus = import('./checker.js').UpdateStatus;

const DAEMON_TOKEN = 'updates-daemon-token';
const STATUS: UpdateStatus = {
  installed: '0.1.6', channel: 'beta', enabled: true, state: 'unchecked', checkedAt: null, available: null,
  host: { os: 'linux', arch: 'x64' }, buildExpiresAt: null,
};
let checks = 0;

const app = express();
app.use(createDaemonAuthMiddleware({ token: DAEMON_TOKEN, required: false }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerRoutes(app, {
  status: () => STATUS,
  check: async () => { checks += 1; return { ...STATUS, state: 'up_to_date' }; },
  missions: () => ({ live: 3, working: 2 }),
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

async function login(email = 'admin@example.com', password = 'admin-secret'): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return `${SESSION_COOKIE}=${match[1]}`;
  }
  throw new Error('no session cookie');
}

async function call(method: string, path: string, headers: Record<string, string>, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() as Record<string, unknown> };
}

test('first run, anonymous: no status, no check', async () => {
  assert.equal(dbApi.countUsers(), 0);
  assert.equal((await call('GET', '/api/updates', {})).status, 401);
  assert.equal((await call('POST', '/api/updates/check', {})).status, 401);
  assert.equal((await call('GET', '/api/updates/missions', {})).status, 401);
  assert.equal(checks, 0);
});

let missionToken = '';
test('accounts exist from here on', async () => {
  createTestAccount(dbApi, { email: 'admin@example.com', name: 'Admin', passwordHash: await hashPassword('admin-secret'), isSuperadmin: true });
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'acme.coder', 'work');
  missionToken = issueMissionApiToken(missionId);
});

test('anonymous, or a forged cookie, is refused', async () => {
  for (const headers of [{}, { cookie: `${SESSION_COOKIE}=forged` }]) {
    assert.equal((await call('GET', '/api/updates', headers)).status, 401);
    assert.equal((await call('POST', '/api/updates/check', headers)).status, 401);
    const count = await call('GET', '/api/updates/missions', headers);
    assert.equal(count.status, 401);
    assert.equal(count.body.working, undefined);
  }
  assert.equal(checks, 0);
});

test('a mission token cannot force a check', async () => {
  const headers = { authorization: `Bearer ${missionToken}` };
  assert.equal((await call('POST', '/api/updates/check', headers)).status, 403);
  assert.equal(checks, 0);
});

test('a signed-in administrator reads the status and forces a check', async () => {
  const cookie = await login();
  const status = await call('GET', '/api/updates', { cookie });
  assert.equal(status.status, 200);
  assert.equal(status.body.installed, '0.1.6');
  const check = await call('POST', '/api/updates/check', { cookie });
  assert.equal(check.status, 200);
  assert.equal(check.body.state, 'up_to_date');
  assert.equal(checks, 1);
});

test('a member without `settings` reads the offer but cannot force a check', async () => {
  const member = createTestAccount(dbApi, { email: 'member@example.com', name: 'Member', passwordHash: await hashPassword('member-secret') });
  assert.ok(!dbApi.listPermissionsForUser(member.id).some((permission) => permission.startsWith('settings')));
  const cookie = await login('member@example.com', 'member-secret');
  const status = await call('GET', '/api/updates', { cookie });
  assert.equal(status.status, 200);
  assert.equal(status.body.installed, '0.1.6');
  assert.equal((await call('POST', '/api/updates/check', { cookie })).status, 403);
  assert.equal(checks, 1);
});

test('the daemon token (CLI) forces a check; a body is refused', async () => {
  const headers = { authorization: `Bearer ${DAEMON_TOKEN}` };
  assert.equal((await call('POST', '/api/updates/check', headers)).status, 200);
  assert.equal((await call('POST', '/api/updates/check', headers, { url: 'https://evil.example/' })).status, 400);
  assert.equal(checks, 2);
});

test('the mission count: counts only, for a signed-in administrator or the desktop (daemon token); a query is refused', async () => {
  const cookie = await login();
  for (const headers of [{ cookie }, { authorization: `Bearer ${DAEMON_TOKEN}` }]) {
    const count = await call('GET', '/api/updates/missions', headers);
    assert.equal(count.status, 200);
    assert.deepEqual(count.body, { live: 3, working: 2 });
  }
  assert.equal((await call('GET', '/api/updates/missions?agent=acme.coder', { authorization: `Bearer ${DAEMON_TOKEN}` })).status, 400);
});
