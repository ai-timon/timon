/**
 * `POST /api/daemon/shutdown` stops the daemon. Only the daemon token reaches
 * it — never an anonymous caller (not even on the first-run loopback, where
 * the middleware lets anonymous through), never a browser session, never a
 * mission token, never the daemon token sent from inside a mission. The
 * middleware is the real one; the stop is a recorder.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const home = mkdtempSync(join(tmpdir(), 'timon-daemon-shutdown-'));
process.env.TIMON_HOME = home;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
writeFileSync(join(home, 'timon.config.json'), JSON.stringify({
  daemon: { listen: { host: '127.0.0.1', port: 3100 }, auth: 'auto' },
}));

const { authIsRequired, createDaemonAuthMiddleware } = await import('./auth.js');
const { registerShutdownRoute, DAEMON_SHUTDOWN_PATH } = await import('./shutdown-route.js');
const { config } = await import('../../config/load.js');
const { dbApi } = await import('../../db.js');
const { issueSessionToken, hashSessionToken, SESSION_COOKIE } = await import('../../users/session.js');
type ShutdownRequest = import('../../daemon-shutdown.js').ShutdownRequest;

const TOKEN = 'witness-daemon-token';
const requested: string[] = [];
let state: ShutdownRequest = 'stopping';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: authIsRequired(config()) }));
app.use(express.json());
registerShutdownRoute(app, {
  state: () => state,
  request: (why) => { requested.push(why); return state; },
  pid: 4242,
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const shutdown = (headers: Record<string, string> = {}) => fetch(`${base}${DAEMON_SHUTDOWN_PATH}`, { method: 'POST', headers });
/** The stop is requested once the answer has left: give the `close` a turn. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('an anonymous caller is refused, even on the first-run loopback', async () => {
  assert.equal(dbApi.countUsers(), 0);
  assert.equal((await shutdown()).status, 401);
  assert.equal((await shutdown({ authorization: 'Bearer guess' })).status, 401);
  await settle();
  assert.deepEqual(requested, []);
});

test('a browser session is refused, superadmin included', async () => {
  const admin = createTestAccount(dbApi, { email: 'root@example.test', name: 'Root', passwordHash: 'hash', isSuperadmin: true, status: 'active' });
  const cookie = issueSessionToken();
  dbApi.createSession({ tokenHash: hashSessionToken(cookie), userId: admin.id, expiresAt: Date.now() + 600_000 });
  const res = await shutdown({ cookie: `${SESSION_COOKIE}=${cookie}`, 'sec-fetch-site': 'same-origin' });
  assert.equal(res.status, 403);
  assert.equal((await shutdown()).status, 401, 'once an account exists, anonymous is still refused');
  await settle();
  assert.deepEqual(requested, []);
});

test('a mission token is refused', async () => {
  const raw = 'mission-token-for-shutdown-test';
  dbApi.createApiToken({ tokenHash: hashSessionToken(raw), userId: dbApi.getActiveSuperadmin()!.id, scope: 'mission', label: 'test' });
  assert.equal((await shutdown({ authorization: `Bearer ${raw}` })).status, 403);
  await settle();
  assert.deepEqual(requested, []);
});

test('the daemon token sent from inside a mission is refused', async () => {
  const res = await shutdown({ authorization: `Bearer ${TOKEN}`, 'x-timon-mission': 'some-mission' });
  assert.equal(res.status, 403);
  await settle();
  assert.deepEqual(requested, []);
});

test('the daemon token gets 202 with the pid, then the stop is requested', async () => {
  state = 'stopping';
  const res = await shutdown({ authorization: `Bearer ${TOKEN}` });
  assert.equal(res.status, 202);
  assert.deepEqual(await res.json(), { ok: true, state: 'stopping', pid: 4242 });
  await settle();
  assert.deepEqual(requested, ['operator request']);
});

test('a stop already under way is not requested twice', async () => {
  requested.length = 0;
  state = 'already-stopping';
  const res = await shutdown({ authorization: `Bearer ${TOKEN}` });
  assert.equal(res.status, 202);
  assert.equal(((await res.json()) as { state: string }).state, 'already-stopping');
  await settle();
  assert.deepEqual(requested, []);
});

test('a daemon without its common stop says so instead of pretending', async () => {
  state = 'unavailable';
  const res = await shutdown({ authorization: `Bearer ${TOKEN}` });
  assert.equal(res.status, 503);
  await settle();
  assert.deepEqual(requested, []);
});
