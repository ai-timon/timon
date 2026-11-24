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
const { registerRoutes: registerTelemetryRoutes, ANONYMOUS_SCREEN_EVENTS } = await import('./routes.js');
const { resolvePreference, TELEMETRY_SETTING_KEY } = await import('./preference.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { startTelemetry, setTelemetryRuntime, clearTelemetryRuntime } = await import('./runtime.js');

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

test('first run, anonymous: an onboarding screen is reported, nothing else is', async () => {
  const sent: Array<{ name: string; properties: Record<string, unknown> }> = [];
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push((JSON.parse(String(init?.body)) as { payload: { name: string; properties: Record<string, unknown> } }).payload);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  const rt = startTelemetry({
    env: { TIMON_TELEMETRY_CAPTURE_URL: 'http://127.0.0.1:9' }, packaged: false,
    home: mkdtempSync(join(tmpdir(), 'timon-telemetry-route-screen-')), fetch: fake,
    preference: { configValue: () => undefined, stored: () => null }, collector: { missionFacts: () => null, taskFacts: () => null },
    intervalMs: 3_600_000,
  });
  setTelemetryRuntime(rt);
  try {
    const screen = { name: 'onboarding_screen', surface: 'web', screen: 'account', action: 'viewed' };
    assert.equal((await call('POST', '/api/telemetry/ui-event', {}, screen)).status, 200);
    assert.equal((await call('POST', '/api/telemetry/ui-event', {}, { name: 'page_viewed', surface: 'web', path: '/agents' })).status, 401);
    assert.equal((await call('POST', '/api/telemetry/ui-event', {}, { ...screen, screen: 'my-screen' })).status, 401);
    assert.equal((await call('POST', '/api/telemetry/ui-event', {}, { ...screen, note: 'typed text' })).status, 401);
    await rt.flushNow();
    const reported = sent.filter((p) => p.name === 'onboarding_screen');
    assert.equal(reported.length, 1);
    assert.equal(reported[0]!.properties.screen, 'account');
    assert.equal(reported[0]!.properties.action, 'viewed');
    assert.equal(reported[0]!.properties.account_slot, undefined, 'nobody behind it yet');
  } finally {
    clearTelemetryRuntime(rt);
    await rt.dispose();
  }
});

test('first run, anonymous: the onboarding screens are capped per daemon run', async () => {
  const real = startTelemetry({ env: {}, packaged: false, home: mkdtempSync(join(tmpdir(), 'timon-telemetry-route-cap-')) });
  let tracked = 0;
  const spy = { ...real, trackUi: () => { tracked += 1; } };
  setTelemetryRuntime(spy);
  try {
    const screen = { name: 'onboarding_screen', surface: 'web', screen: 'splash', action: 'viewed' };
    for (let i = 0; i < ANONYMOUS_SCREEN_EVENTS + 5; i += 1) {
      assert.equal((await call('POST', '/api/telemetry/ui-event', {}, screen)).status, 200);
    }
    // The previous test spent one.
    assert.equal(tracked, ANONYMOUS_SCREEN_EVENTS - 1);
  } finally {
    clearTelemetryRuntime(spy);
  }
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

test('turning sharing off through the route stops every event at once, without a restart', async () => {
  const cookie = await login();
  assert.equal((await call('PUT', '/api/telemetry/preference', { cookie }, { enabled: true })).status, 200);
  const sent: string[] = [];
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push((JSON.parse(String(init?.body)) as { payload: { name: string } }).payload.name);
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  // A local capture address, never reached: the injected fetch records instead.
  // The preference is the real one (the settings row this route writes); the
  // timer is out of the way, so nothing but the route can apply the change.
  const rt = startTelemetry({
    env: { TIMON_TELEMETRY_CAPTURE_URL: 'http://127.0.0.1:9' }, packaged: false,
    home: mkdtempSync(join(tmpdir(), 'timon-telemetry-route-off-')), fetch: fake,
    preference: { configValue: () => undefined }, collector: { missionFacts: () => null, taskFacts: () => null },
    intervalMs: 3_600_000,
  });
  setTelemetryRuntime(rt);
  try {
    await rt.flushNow();
    const atStart = sent.length;
    rt.track('onboarding_step', { step: 'team', action: 'completed' });
    const off = await call('PUT', '/api/telemetry/preference', { cookie }, { enabled: false });
    assert.equal(off.status, 200);
    assert.equal(off.body.enabled, false);
    // The same second, from every source: the daemon, the web app.
    rt.track('onboarding_step', { step: 'restart', action: 'completed' });
    assert.equal((await call('POST', '/api/telemetry/ui-event', { cookie }, { name: 'page_viewed', surface: 'web', path: '/agents' })).status, 200);
    await rt.flushNow();
    assert.deepEqual(sent.slice(atStart), ['telemetry_preference_changed'], 'the queued event is dropped; only the goodbye leaves');
  } finally {
    clearTelemetryRuntime(rt);
    await rt.dispose();
  }
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
  // Once an account exists, an onboarding screen needs its session like the rest.
  const screen = { name: 'onboarding_screen', surface: 'web', screen: 'llm', action: 'completed', llmChoice: 'plan', backend: 'claude', connection: 'ok' };
  assert.equal((await call('POST', '/api/telemetry/ui-event', {}, screen)).status, 401);
  assert.equal((await call('POST', '/api/telemetry/ui-event', { authorization: `Bearer ${missionToken}` }, event)).status, 403);
  assert.equal((await call('POST', '/api/telemetry/ui-event', { authorization: `Bearer ${DAEMON_TOKEN}` }, event)).status, 403);
  const cookie = await login();
  assert.equal((await call('POST', '/api/telemetry/ui-event', { cookie }, event)).status, 200);
  assert.equal((await call('POST', '/api/telemetry/ui-event', { cookie }, screen)).status, 200);
  for (const bad of [
    { ...screen, backend: 'https://my-proxy.example' },
    { ...screen, failureCode: 'invalid api key sk-123' },
    { ...screen, action: 'closed' },
    { ...event, name: 'prompt_sent' },
    { ...event, extra: 'acme' },
    { name: 'app_opened', surface: 'web', setupCompleted: 'yes' },
    { name: 'upgrade_action', surface: 'web', action: 'buy_opened', entryPoint: 'https://example.com' },
    { ...event, path: `/${'a'.repeat(600)}` },
  ]) {
    assert.equal((await call('POST', '/api/telemetry/ui-event', { cookie }, bad)).status, 400, JSON.stringify(bad).slice(0, 80));
  }
});
