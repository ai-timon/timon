/**
 * Archiving: routes, list filter, owner scope, and the automatic unarchive
 * when a new user message lands.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { postTestAccount } from '../../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-archive-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerMissionRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerMissionRoutes(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

type ListBody = { missions: Array<{ id: string; archived_at: number | null; archived_by: string | null }> };

function sessionCookie(res: Response): string | undefined {
  for (const line of res.headers.getSetCookie()) {
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

async function login(email: string, password: string): Promise<string> {
  const res = await call('POST', '/api/auth/login', { body: { email, password } });
  const cookie = sessionCookie(res.res);
  assert.ok(cookie, `no session for ${email}`);
  return cookie;
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
});
assert.equal(setup.status, 201);
const adminId = (setup.json as { user: { id: string } }).user.id;

const created = await postTestAccount(dbApi, { email: 'bea@example.com', name: 'Bea', password: 'bea-secret' });
assert.equal(created.status, 201);
const beaId = (created.json as { user: { id: string } }).user.id;
dbApi.setUserAvatar(beaId, '/api/uploads/avatars/bea.png');

const mine = randomUUID();
dbApi.createMission(mine, 'arch.agent', 'finished work', undefined, adminId);
dbApi.finishMission(mine, 'completed', 0);
const live = randomUUID();
dbApi.createMission(live, 'arch.agent', 'still running', undefined, adminId);
const other = randomUUID();
dbApi.createMission(other, 'bea.agent', 'bea work', undefined, beaId);
dbApi.finishMission(other, 'completed', 0);

const ids = (r: { json: unknown }) => (r.json as ListBody).missions.map((m) => m.id);

test('anonymous archive and unarchive are refused', async () => {
  assert.equal((await call('POST', `/api/missions/${mine}/archive`)).status, 401);
  assert.equal((await call('POST', `/api/missions/${mine}/unarchive`)).status, 401);
  assert.equal(dbApi.getMission(mine)?.archived_at, null);
});

test('a running mission cannot be archived (409)', async () => {
  const cookie = await login('admin@example.com', 'admin-secret');
  const res = await call('POST', `/api/missions/${live}/archive`, { cookie });
  assert.equal(res.status, 409);
  assert.equal(dbApi.getMission(live)?.archived_at, null);
});

test('a non-owner gets 404 and the mission stays visible', async () => {
  const cookie = await login('bea@example.com', 'bea-secret');
  assert.equal((await call('POST', `/api/missions/${mine}/archive`, { cookie })).status, 404);
  assert.equal(dbApi.getMission(mine)?.archived_at, null);
});

test('archive hides from the default list; the filter shows them back', async () => {
  const cookie = await login('admin@example.com', 'admin-secret');
  const res = await call('POST', `/api/missions/${mine}/archive`, { cookie });
  assert.equal(res.status, 200);
  assert.equal(dbApi.getMission(mine)?.status, 'completed');
  assert.ok(!ids(await call('GET', '/api/missions', { cookie })).includes(mine));
  assert.ok(!ids(await call('GET', '/api/missions?archived=exclude', { cookie })).includes(mine));
  const inc = await call('GET', '/api/missions?archived=include', { cookie });
  const row = (inc.json as ListBody).missions.find((m) => m.id === mine);
  assert.ok(row?.archived_at && row.archived_by === 'user');
  assert.deepEqual(ids(await call('GET', '/api/missions?archived=only', { cookie })), [mine]);
  assert.equal((await call('GET', '/api/missions?archived=bogus', { cookie })).status, 400);
});

test('unarchive restores the mission to the default list', async () => {
  const cookie = await login('admin@example.com', 'admin-secret');
  assert.equal((await call('POST', `/api/missions/${mine}/unarchive`, { cookie })).status, 200);
  assert.ok(ids(await call('GET', '/api/missions', { cookie })).includes(mine));
  assert.equal(dbApi.getMission(mine)?.archived_by, null);
});

test('a new user message unarchives the mission', () => {
  assert.equal(dbApi.archiveMission(mine, 'user'), 'archived');
  dbApi.insertEvent(mine, 'user', { type: 'user', message: { role: 'user', content: 'hello again' } });
  assert.equal(dbApi.getMission(mine)?.archived_at, null);
  assert.equal(dbApi.archiveMission(other, 'auto'), 'archived');
  dbApi.insertEvent(other, 'assistant', { type: 'assistant' });
  assert.ok(dbApi.getMission(other)?.archived_at, 'a non-user event must not unarchive');
});

test('a delegation return (a user row with a runtime origin) also unarchives', () => {
  assert.equal(dbApi.archiveMission(mine, 'user'), 'archived');
  dbApi.insertEvent(mine, 'user', {
    type: 'user',
    message: { role: 'user', content: 'result of the delegated mission' },
    origin: { kind: 'system', from: 'orchestrator' },
  });
  assert.equal(dbApi.getMission(mine)?.archived_at, null);
});
