/**
 * `GET /api/missions` carries each mission's `parent_mission_id`, which the
 * chat rail groups by: null for a mission started by hand, the launcher's id
 * for a mission spawned by another one. An anonymous caller gets nothing.
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

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-mission-list-parent-'));
await import('../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { dbApi } = await import('./db.js');
const { hashPassword } = await import('./users/password.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes: registerMissionRoutes } = await import('./plugins-bundled/missions/routes.js');
const { registerRoutes: registerUserRoutes } = await import('./plugins-bundled/users/routes.js');
const { SESSION_COOKIE } = await import('./users/session.js');

createTestAccount(dbApi, { email: 'admin@example.com', name: 'Admin', passwordHash: await hashPassword('admin-secret'), isSuperadmin: true });

const orchestrator = randomUUID();
const child = randomUUID();
dbApi.createMission(orchestrator, 'acme.main', 'drive the series');
dbApi.createMission(child, 'acme.coder', 'code the feature');
dbApi.setMissionLineage(child, { parentMissionId: orchestrator, parentAgent: 'acme.main' });

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

type ListBody = { missions: { id: string; parent_mission_id?: string | null }[] };

async function list(cookie?: string): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}/api/missions?limit=100`, {
    headers: cookie ? { cookie: `${SESSION_COOKIE}=${encodeURIComponent(cookie)}` } : {},
  });
  return { status: res.status, text: await res.text() };
}

test('anonymous: refused', async () => {
  const r = await list();
  assert.equal(r.status, 401);
  assert.ok(!r.text.includes(orchestrator));
});

test('a mission started by hand has an explicit null parent; a spawned one names its launcher', async () => {
  const r = await list(await login('admin@example.com', 'admin-secret'));
  assert.equal(r.status, 200);
  const body = JSON.parse(r.text) as ListBody;
  const root = body.missions.find((m) => m.id === orchestrator);
  assert.ok(root && 'parent_mission_id' in root, 'the field is always present');
  assert.equal(root.parent_mission_id, null);
  assert.equal(body.missions.find((m) => m.id === child)?.parent_mission_id, orchestrator);
});
