/**
 * The operator's account recovery left in the core: `GET /api/users` and
 * `POST /api/users/:id/reset-password`, for the CLI's daemon token only
 * (`timon user list`, `timon user reset-password`). Everything else about
 * administering accounts belongs to the account provider plugin.
 * Witness on 127.0.0.1:0.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-users-lifecycle-http-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app, { setupPolicy: 'free' });
app.get('/api/stats', (_req, res) => { res.json({ ok: true }); });

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
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, res };
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'robin@example.com', name: 'Robin', password: 'super-secret' },
});
assert.equal(setup.status, 201);
const adminCookie = sessionCookie(setup.res);
assert.ok(adminCookie);

const created = postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'employee-secret' });
assert.equal(created.status, 201);
const adaId = created.json.user!.id;

test('only the daemon token reaches the recovery routes: a session, even superadmin, reads 404', async () => {
  const login = await call('POST', '/api/auth/login', {
    body: { email: 'ada@example.com', password: 'employee-secret' },
  });
  const cookie = sessionCookie(login.res);
  assert.ok(cookie);
  for (const who of [cookie, adminCookie]) {
    assert.equal((await call('GET', '/api/users', { cookie: who })).status, 404);
    assert.equal((await call('POST', `/api/users/${adaId}/reset-password`, { cookie: who })).status, 404);
  }
  assert.equal((await call('GET', '/api/users')).status, 401, 'anonymous');
  assert.equal((await call('POST', `/api/users/${adaId}/reset-password`)).status, 401, 'anonymous');
});

test('the directory names the accounts to a superadmin only, without an e-mail', async () => {
  assert.equal((await call('GET', '/api/users/directory')).status, 401, 'anonymous');
  const login = await call('POST', '/api/auth/login', {
    body: { email: 'ada@example.com', password: 'employee-secret' },
  });
  const member = sessionCookie(login.res);
  assert.ok(member);
  assert.equal((await call('GET', '/api/users/directory', { cookie: member })).status, 403, 'member');
  for (const auth of [{ cookie: adminCookie }, { bearer: TOKEN }]) {
    const list = await call('GET', '/api/users/directory', auth);
    assert.equal(list.status, 200);
    const users = (list.json as { users: Record<string, unknown>[] }).users;
    assert.deepEqual(users.map((u) => u.name).sort(), ['Ada', 'Robin']);
    assert.ok(users.every((u) => Object.keys(u).sort().join() === 'id,name'), 'id and name only');
  }
});

test('the administration routes are gone from the core', async () => {
  for (const [method, path] of [
    ['POST', '/api/users'], ['GET', `/api/users/${adaId}`], ['PATCH', `/api/users/${adaId}`],
    ['PUT', `/api/users/${adaId}/groups`], ['GET', '/api/invitations'], ['POST', '/api/invitations'],
    ['GET', '/api/audit-log'], ['GET', '/api/permissions/catalog'], ['GET', '/api/roles'], ['GET', '/api/groups'],
  ] as const) {
    const res = await call(method, path, { bearer: TOKEN, body: method === 'GET' ? undefined : { email: 'eve@example.com', name: 'Eve', password: 'eve-secret-1' } });
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  assert.equal(dbApi.getUserByEmail('eve@example.com'), undefined, 'no account was made');
});

test('the daemon token lists the accounts, without any credential', async () => {
  const list = await call('GET', '/api/users', { bearer: TOKEN });
  assert.equal(list.status, 200);
  const users = (list.json as { users: Record<string, unknown>[] }).users;
  assert.deepEqual(users.map((u) => u.email).sort(), ['ada@example.com', 'robin@example.com']);
  assert.ok(users.every((u) => !('password_hash' in u)));
});

test('reset-password returns a one-shot password, kills the old session, old password fails', async () => {
  const login = await call('POST', '/api/auth/login', {
    body: { email: 'ada@example.com', password: 'employee-secret' },
  });
  const cookie = sessionCookie(login.res);
  assert.ok(cookie);

  const reset = await call('POST', `/api/users/${adaId}/reset-password`, { bearer: TOKEN });
  assert.equal(reset.status, 200);
  const payload = reset.json as { password: string; user: { id: string } };
  assert.ok(payload.password.length >= 16);
  assert.equal(payload.user.id, adaId);
  assert.ok(dbApi.listAuditLog(20).some((row) => row.action === 'user.reset_password' && row.target === `user:${adaId}`));

  const me = await call('GET', '/api/auth/me', { cookie });
  assert.equal((me.json as { user: unknown }).user, null);

  const stats = await call('GET', '/api/stats', { cookie });
  assert.equal(stats.status, 401);

  const oldPass = await call('POST', '/api/auth/login', {
    body: { email: 'ada@example.com', password: 'employee-secret' },
  });
  assert.equal(oldPass.status, 401);

  const fresh = await call('POST', '/api/auth/login', {
    body: { email: 'ada@example.com', password: payload.password },
  });
  assert.equal(fresh.status, 200);
});
