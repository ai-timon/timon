/**
 * `GET /api/missions/:id/egress` (TODO #590, T3): explicit authentication —
 * an anonymous caller is refused even before the first account exists —,
 * someone else's mission answers exactly like an absent one, a mission's
 * egress proxy credential opens nothing, and the query is validated.
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
import { grantTestPermissions, postTestAccount } from '../../tests/helpers/accounts.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-egress-routes-'));
await import('../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../plugins-bundled/users/routes.js');
const { registerEgressRoutes } = await import('./routes.js');
const { recordEgress } = await import('./journal.js');
const { dbApi } = await import('../db.js');
const { issueMissionApiToken, issueMissionEgressToken } = await import('../users/api-tokens.js');
const { SESSION_COOKIE } = await import('../users/session.js');
const { config, setConfig } = await import('../config/load.js');
const { TimonConfigSchema } = await import('../config/schema.js');

const TOKEN = 'witness-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerEgressRoutes(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

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

function sessionCookie(res: Response): string | undefined {
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function login(email: string, password: string): Promise<string> {
  const res = await call('POST', '/api/auth/login', { body: { email, password } });
  const cookie = sessionCookie(res.res);
  assert.ok(cookie, `no session for ${email}`);
  return cookie;
}

const early = randomUUID();
dbApi.createMission(early, 'nobody.agent', 'before any account');

test('no account yet: the loopback API is open, this route is not', async () => {
  assert.equal(dbApi.countUsers(), 0);
  const anonymous = await call('GET', `/api/missions/${early}/egress`);
  assert.equal(anonymous.status, 401);
  assert.equal((await call('GET', `/api/missions/${early}/egress`, { bearer: issueMissionEgressToken(early) })).status, 401);
  assert.equal((await call('GET', `/api/missions/${early}/egress`, { bearer: TOKEN })).status, 200);
});

const adminMission = randomUUID();
const beaMission = randomUUID();
let adminId = '';
let beaId = '';

// Inside a test, not at module level: an `await` there leaves no test queued,
// and the root `after` hook closes the server before the next test exists.
test('accounts and missions exist from here on', async () => {
  const setup = await call('POST', '/api/auth/setup', {
    body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' },
  });
  assert.equal(setup.status, 201);
  adminId = (setup.json as { user: { id: string } }).user.id;
  const created = await postTestAccount(dbApi, { email: 'bea@example.com', name: 'Bea', password: 'bea-secret' });
  assert.equal(created.status, 201);
  beaId = (created.json as { user: { id: string } }).user.id;

  dbApi.createMission(adminMission, 'admin.agent', 'admin only', undefined, adminId);
  dbApi.createMission(beaMission, 'bea.agent', 'bea only', undefined, beaId);
  for (let i = 0; i < 3; i += 1) {
    recordEgress({ missionId: adminMission, method: 'CONNECT', host: 'secret-partner.example', port: 443, status: 200, bytesOut: 1, bytesIn: 2, startedAt: Date.now(), durationMs: 3 });
  }
  recordEgress({ missionId: beaMission, method: 'GET', host: 'bea.example', port: 80, status: 200, bytesOut: 1, bytesIn: 2, startedAt: Date.now(), durationMs: 3 });
});

type EgressBody = {
  notice?: string;
  mission_id: string;
  connections: Array<{ id: number; host: string }>;
  has_more: boolean;
  next_before: number | null;
  hosts: Array<{ host: string; connections: number }>;
  proxy: { mode: string; listening: boolean };
};

test('by default the journal is said to be disabled, with the way to enable it, before the empty list', async () => {
  const cookie = await login('admin@example.com', 'admin-secret');
  const empty = randomUUID();
  dbApi.createMission(empty, 'admin.agent', 'no journal', undefined, adminId);
  const res = await call('GET', `/api/missions/${empty}/egress`, { cookie });
  assert.equal(res.status, 200);
  const body = res.json as EgressBody;
  assert.deepEqual(body.proxy, { mode: 'off', listening: false });
  assert.deepEqual(body.connections, []);
  assert.equal(Object.keys(body)[0], 'notice');
  assert.match(body.notice!, /journal disabled/);
  assert.match(body.notice!, /host\.isolation\.egress\.mode to "log"/);
  // Rows kept from when it was on stay readable, under the same notice.
  const kept = await call('GET', `/api/missions/${adminMission}/egress`, { cookie });
  assert.equal((kept.json as EgressBody).connections.length, 3);
  assert.match((kept.json as EgressBody).notice!, /dates from before/);
});

test('anonymous is refused once accounts exist', async () => {
  assert.equal((await call('GET', `/api/missions/${adminMission}/egress`)).status, 401);
});

test('the owner reads its mission, page by page', async (t) => {
  const defaults = config();
  t.after(() => setConfig(defaults));
  setConfig(TimonConfigSchema.parse({ host: { isolation: { egress: { mode: 'log' } } } }));
  const cookie = await login('admin@example.com', 'admin-secret');
  const first = await call('GET', `/api/missions/${adminMission}/egress?limit=2`, { cookie });
  assert.equal(first.status, 200);
  const body = first.json as EgressBody;
  assert.equal(body.connections.length, 2);
  assert.equal(body.has_more, true);
  assert.deepEqual(body.hosts.map((h) => [h.host, h.connections]), [['secret-partner.example', 3]]);
  // The proxy is never started here: the reader is told the journal had nothing to fill it.
  assert.deepEqual(body.proxy, { mode: 'log', listening: false });
  assert.equal(body.notice, undefined);
  const second = await call('GET', `/api/missions/${adminMission}/egress?limit=2&before=${body.next_before}`, { cookie });
  assert.equal((second.json as EgressBody).connections.length, 1);
  assert.equal((second.json as EgressBody).has_more, false);
});

test('an account without missions:read is refused, its own mission included', async () => {
  const cookie = await login('bea@example.com', 'bea-secret');
  const refused = await call('GET', `/api/missions/${beaMission}/egress`, { cookie });
  assert.equal(refused.status, 403);
  assert.equal((refused.json as { permission: unknown }).permission, 'missions:read');
});

test("another account's mission answers exactly like an absent one", async () => {
  grantTestPermissions(dbApi, beaId, ['missions:read']);
  const cookie = await login('bea@example.com', 'bea-secret');
  const own = await call('GET', `/api/missions/${beaMission}/egress`, { cookie });
  assert.equal(own.status, 200);
  assert.deepEqual((own.json as EgressBody).connections.map((c) => c.host), ['bea.example']);

  const foreign = await call('GET', `/api/missions/${adminMission}/egress`, { cookie });
  const absent = await call('GET', `/api/missions/${randomUUID()}/egress`, { cookie });
  assert.equal(foreign.status, 404);
  assert.deepEqual(foreign.json, absent.json);
  assert.equal(JSON.stringify(foreign.json).includes('secret-partner'), false);

  // Bea's agent, with its own mission token, is held to the same rule.
  const missionToken = issueMissionApiToken(beaMission);
  assert.equal((await call('GET', `/api/missions/${beaMission}/egress`, { bearer: missionToken })).status, 200);
  const fromAgent = await call('GET', `/api/missions/${adminMission}/egress`, { bearer: missionToken });
  assert.equal(fromAgent.status, 404);
  assert.deepEqual(fromAgent.json, absent.json);
});

test("a mission's egress proxy credential opens no route, not even its own mission's journal", async () => {
  const egressToken = issueMissionEgressToken(beaMission);
  const own = await call('GET', `/api/missions/${beaMission}/egress`, { bearer: egressToken });
  assert.equal(own.status, 401);
  assert.equal(JSON.stringify(own.json).includes('bea.example'), false);
});

test('the query is validated before anything is read', async () => {
  const cookie = await login('admin@example.com', 'admin-secret');
  for (const query of ['limit=0', 'limit=501', 'limit=abc', 'before=-1', 'limit=1&limit=2', 'path=/x']) {
    const res = await call('GET', `/api/missions/${adminMission}/egress?${query}`, { cookie });
    assert.equal(res.status, 400, query);
  }
});
