/**
 * `GET /api/missions` carries each mission's CLI session id (TODO #419), on
 * the list's own scoping: a non-admin account reads the session of the
 * missions it already sees, and never the one of another account's mission,
 * nor of an unowned (system) one. An anonymous caller gets nothing at all.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-list-session-'));
await import('../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { dbApi } = await import('./db.js');
const { hashPassword } = await import('./users/password.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes: registerMissionRoutes } = await import('./plugins-bundled/missions/routes.js');
const { registerRoutes: registerUserRoutes } = await import('./plugins-bundled/users/routes.js');
const { SESSION_COOKIE } = await import('./users/session.js');

createTestAccount(dbApi, { email: 'admin@example.com', name: 'Admin', passwordHash: await hashPassword('admin-secret'), isSuperadmin: true });
const ada = createTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', passwordHash: await hashPassword('ada-secret'), isSuperadmin: false });
const bob = createTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', passwordHash: await hashPassword('bob-secret'), isSuperadmin: false });

const adaMission = randomUUID();
const adaFresh = randomUUID();
const bobMission = randomUUID();
const systemMission = randomUUID();
dbApi.createMission(adaMission, 'ada.agent', 'ada mission', undefined, ada.id);
dbApi.createMission(adaFresh, 'ada.agent', 'ada mission before init', undefined, ada.id);
dbApi.createMission(bobMission, 'bob.agent', 'bob mission', undefined, bob.id);
dbApi.createMission(systemMission, 'system.agent', 'system mission');
const ADA_SESSION = `ada-session-${randomUUID()}`;
const BOB_SESSION = `bob-session-${randomUUID()}`;
const SYSTEM_SESSION = `system-session-${randomUUID()}`;
dbApi.setMissionSession(adaMission, ADA_SESSION);
dbApi.setMissionSession(bobMission, BOB_SESSION);
dbApi.setMissionSession(systemMission, SYSTEM_SESSION);

const app = express();
app.use(createDaemonAuthMiddleware({ token: 'witness-daemon-token', required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerMissionRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

async function login(email: string, password: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  assert.equal(res.status, 200);
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  throw new Error('no session cookie');
}

type ListBody = { missions: { id: string; session_id: string | null }[] };

async function list(cookie?: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}/api/missions?limit=100`, {
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` } : {},
  });
  return { status: res.status, text: await res.text() };
}

test('anonymous: refused, no session id leaks', async () => {
  const r = await list();
  assert.equal(r.status, 401);
  for (const s of [ADA_SESSION, BOB_SESSION, SYSTEM_SESSION]) assert.ok(!r.text.includes(s));
});

test('a non-admin account reads the session of its own missions only', async () => {
  const r = await list(await login('ada@example.com', 'ada-secret'));
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text) as ListBody;
  assert.equal(body.missions.find((m) => m.id === adaMission)?.session_id, ADA_SESSION);
  // A mission whose CLI has not reported its session yet: an explicit null.
  assert.equal(body.missions.find((m) => m.id === adaFresh)?.session_id, null);
  assert.ok(!r.text.includes(BOB_SESSION), 'another account\'s session never appears');
  assert.ok(!r.text.includes(SYSTEM_SESSION), 'an unowned mission\'s session never appears');
});

test('the superadmin sees every session, as it sees every mission', async () => {
  const r = await list(await login('admin@example.com', 'admin-secret'));
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text) as ListBody;
  assert.equal(body.missions.find((m) => m.id === bobMission)?.session_id, BOB_SESSION);
  assert.equal(body.missions.find((m) => m.id === systemMission)?.session_id, SYSTEM_SESSION);
});
