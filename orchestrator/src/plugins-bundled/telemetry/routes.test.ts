/**
 * Who may read and change what this installation shares. The auth middleware
 * runs in its permissive mode (`required: false`) and the first tests run
 * before any account exists — the first-run window where the middleware lets
 * an anonymous caller through — so their refusals are the routes' own.
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

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-telemetry-routes-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { dbApi } = await import('../../db.js');
const { hashPassword } = await import('../../users/password.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerSettingsRoutes } = await import('../settings/routes.js');
const { registerRoutes: registerTelemetryRoutes } = await import('./routes.js');
const { resolvePreference, TELEMETRY_SETTING_KEY } = await import('./preference.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { SESSION_COOKIE } = await import('../../users/session.js');

const DAEMON_TOKEN = 'telemetry-daemon-token';

const app = express();
app.use(createDaemonAuthMiddleware({ token: DAEMON_TOKEN, required: false }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerSettingsRoutes(app);
registerTelemetryRoutes(app, () => resolvePreference({ env: {}, configValue: () => undefined }));
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

async function login(): Promise<string> {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'admin@example.com', password: 'admin-secret' }),
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

const stored = () => dbApi.getAllSettings()[TELEMETRY_SETTING_KEY] ?? null;

test('first run, anonymous: no read, no write', async () => {
  assert.equal(dbApi.countUsers(), 0);
  assert.equal((await call('GET', '/api/telemetry/preference', {})).status, 401);
  const put = await call('PUT', '/api/telemetry/preference', {}, { enabled: false });
  assert.equal(put.status, 401);
  assert.equal(stored(), null);
});

test('first run, anonymous: the generic settings route cannot write the telemetry row', async () => {
  // This route lets an anonymous caller through while no account exists;
  // the row is not in its registry, so it refuses the key itself.
  const put = await call('PUT', `/api/settings/${TELEMETRY_SETTING_KEY}`, {}, { value: '1' });
  assert.equal(put.status, 400);
  assert.equal(stored(), null);
});

let missionToken = '';
test('accounts exist from here on', async () => {
  createTestAccount(dbApi, { email: 'admin@example.com', name: 'Admin', passwordHash: await hashPassword('admin-secret'), isSuperadmin: true });
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'acme.coder', 'work');
  missionToken = issueMissionApiToken(missionId);
});

test('an agent mission cannot change what its user shares', async () => {
  const put = await call('PUT', '/api/telemetry/preference', { authorization: `Bearer ${missionToken}` }, { enabled: false });
  assert.equal(put.status, 403);
  assert.equal(stored(), null);
});

test('the daemon token is not a person either', async () => {
  const put = await call('PUT', '/api/telemetry/preference', { authorization: `Bearer ${DAEMON_TOKEN}` }, { enabled: false });
  assert.equal(put.status, 403);
  assert.equal(stored(), null);
});

test('nor can the operator through the generic settings route', async () => {
  const put = await call('PUT', `/api/settings/${TELEMETRY_SETTING_KEY}`, { authorization: `Bearer ${DAEMON_TOKEN}` }, { value: '1' });
  assert.equal(put.status, 400);
  assert.equal(stored(), null);
});

test('a signed-in person turns sharing off and on', async () => {
  const cookie = await login();
  const read = await call('GET', '/api/telemetry/preference', { cookie });
  assert.equal(read.status, 200);
  assert.equal(read.body.enabled, true);
  assert.equal(read.body.source, 'default');
  assert.equal((await call('PUT', '/api/telemetry/preference', { cookie }, { enabled: 'no' })).status, 400);
  const off = await call('PUT', '/api/telemetry/preference', { cookie }, { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.enabled, false);
  assert.equal(stored(), '0');
  const on = await call('PUT', '/api/telemetry/preference', { cookie }, { enabled: true });
  assert.equal(on.body.enabled, true);
  assert.equal(stored(), '1');
});

test('desktop-opened takes the daemon token alone', async () => {
  assert.equal((await call('POST', '/api/telemetry/desktop-opened', {}, { version: '0.1.6' })).status, 401);
  const cookie = await login();
  assert.equal((await call('POST', '/api/telemetry/desktop-opened', { cookie }, { version: '0.1.6' })).status, 403);
  assert.equal((await call('POST', '/api/telemetry/desktop-opened', { authorization: `Bearer ${DAEMON_TOKEN}` }, { version: '0.1.6', path: '/x' })).status, 400);
  assert.equal((await call('POST', '/api/telemetry/desktop-opened', { authorization: `Bearer ${DAEMON_TOKEN}` }, { version: '0.1.6' })).status, 200);
});

test('ui-event: only a signed-in person reports what they open, in a closed shape', async () => {
  const event = { name: 'page_viewed', surface: 'web', path: '/agents/acme.coder' };
  assert.equal((await call('POST', '/api/telemetry/ui-event', {}, event)).status, 401);
  assert.equal((await call('POST', '/api/telemetry/ui-event', { authorization: `Bearer ${missionToken}` }, event)).status, 403);
  assert.equal((await call('POST', '/api/telemetry/ui-event', { authorization: `Bearer ${DAEMON_TOKEN}` }, event)).status, 403);
  const cookie = await login();
  assert.equal((await call('POST', '/api/telemetry/ui-event', { cookie }, event)).status, 200);
  for (const bad of [
    { ...event, name: 'prompt_sent' },
    { ...event, extra: 'acme' },
    { name: 'app_opened', surface: 'web', setupCompleted: 'yes' },
    { name: 'upgrade_action', surface: 'web', action: 'buy_opened', entryPoint: 'https://example.com' },
    { ...event, path: `/${'a'.repeat(600)}` },
  ]) {
    assert.equal((await call('POST', '/api/telemetry/ui-event', { cookie }, bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
});
