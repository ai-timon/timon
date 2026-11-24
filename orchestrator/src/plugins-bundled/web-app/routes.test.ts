/**
 * TODO #485: `POST /api/app/rearm` relaunches a process on the host. Only the
 * daemon token reaches it — never an anonymous caller (not even on the
 * first-run loopback, where the middleware lets anonymous through), never a
 * browser session, never a mission token. The middleware is the real one.
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

const home = mkdtempSync(join(tmpdir(), 'timon-app-rearm-'));
process.env.TIMON_HOME = home;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
writeFileSync(join(home, 'timon.config.json'), JSON.stringify({
  daemon: { listen: { host: '127.0.0.1', port: 3100 }, auth: 'auto' },
  app: { enabled: true, listen: { host: '127.0.0.1', port: 3101 } },
}));

const { authIsRequired, createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes, rearmResponse } = await import('./routes.js');
const { config } = await import('../../config/load.js');
const { dbApi } = await import('../../db.js');
const { issueSessionToken, hashSessionToken, SESSION_COOKIE } = await import('../../users/session.js');
type WakeResult = import('../../kernel/child-supervisor.js').WakeResult;

const TOKEN = 'witness-daemon-token';
const woken: string[] = [];
let next: WakeResult = 'rearmed';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: authIsRequired(config()) }));
app.use(express.json());
registerRoutes(app, (label) => { woken.push(label); return next; });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

const rearm = (headers: Record<string, string> = {}) => fetch(`${base}/api/app/rearm`, { method: 'POST', headers });

test('an anonymous caller is refused, even on the first-run loopback', async () => {
  assert.equal(dbApi.countUsers(), 0);
  assert.equal((await rearm()).status, 401);
  assert.equal((await rearm({ authorization: 'Bearer guess' })).status, 401);
  assert.deepEqual(woken, []);
});

test('a browser session is refused, superadmin included', async () => {
  const admin = createTestAccount(dbApi, { email: 'root@example.test', name: 'Root', passwordHash: 'hash', isSuperadmin: true, status: 'active' });
  const cookie = issueSessionToken();
  dbApi.createSession({ tokenHash: hashSessionToken(cookie), userId: admin.id, expiresAt: Date.now() + 600_000 });
  const res = await rearm({ cookie: `${SESSION_COOKIE}=${cookie}`, 'sec-fetch-site': 'same-origin' });
  assert.equal(res.status, 403);
  assert.equal((await rearm()).status, 401, 'once an account exists, anonymous is still refused');
  assert.deepEqual(woken, []);
});

test('a mission token is refused', async () => {
  const raw = 'mission-token-for-rearm-test';
  dbApi.createApiToken({ tokenHash: hashSessionToken(raw), userId: dbApi.getActiveSuperadmin()!.id, scope: 'mission', label: 'test' });
  assert.equal((await rearm({ authorization: `Bearer ${raw}` })).status, 403);
  assert.deepEqual(woken, []);
});

test('the daemon token wakes the web-app supervisor', async () => {
  next = 'rearmed';
  const res = await rearm({ authorization: `Bearer ${TOKEN}` });
  assert.equal(res.status, 200);
  const body = (await res.json()) as { ok: boolean; result: string };
  assert.deepEqual([body.ok, body.result], [true, 'rearmed']);
  assert.deepEqual(woken, ['web-app']);
});

test('no supervisor: 409 with the reason', async () => {
  next = 'unknown';
  const res = await rearm({ authorization: `Bearer ${TOKEN}` });
  assert.equal(res.status, 409);
  const body = (await res.json()) as { ok: boolean; message: string };
  assert.equal(body.ok, false);
  assert.match(body.message, /not built|app non buildée|restart the Timon service/); // french-ok: an older French message the route may still return
});

test('a disabled app says so rather than blaming the daemon', () => {
  const st = { state: 'disabled' as const, message: 'app.enabled = false', pid: null, appDir: 'app-dir', listen: { host: '127.0.0.1', port: 1 } };
  assert.deepEqual(rearmResponse('unknown', () => st), { code: 409, body: { ok: false, result: 'unknown', message: 'app.enabled = false' } });
  assert.equal(rearmResponse('woken').code, 200);
});
