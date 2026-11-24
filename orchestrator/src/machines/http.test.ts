/**
 * The fleet routes (multi-machine P2c): every refusal first, then the paths
 * that must pass. The witness daemon on 127.0.0.1:0 plays both parts — the
 * local daemon that keeps the fleet, and the remote one it pairs with (plain
 * HTTP is allowed on the loopback only). A second witness answers what a real
 * daemon never would (wrong code, redirect, garbage).
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const HOME = mkdtempSync(join(tmpdir(), 'timon-machines-'));
process.env.TIMON_HOME = HOME;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
writeFileSync(
  join(HOME, 'timon.config.json'),
  JSON.stringify({
    version: 1,
    authThrottle: { maxAttempts: 4, windowMs: 60_000, lockoutMs: 150, maxLockoutMs: 300 },
  }),
);

await import('../../tests/helpers/paid-license.js');
const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../plugins-bundled/users/routes.js');
const { registerRoutes: registerHttpRoutes } = await import('../plugins-bundled/http/routes.js');
const { registerDeviceRoutes } = await import('../users/devices-http.js');
const { registerMachineRoutes } = await import('./http.js');
const { relayProof, RELAY_PROOF_HEADER } = await import('./relay-proof.js');
const { getDevice, hashDeviceToken } = await import('../users/devices.js');
const { resetThrottle } = await import('../users/login-throttle.js');
const { setActiveModules, resetActiveModules } = await import('../kernel/module-state.js');
const { API_LEVEL } = await import('../kernel/capabilities.js');
const { dbApi, db } = await import('../db.js');
const { hashPassword } = await import('../users/password.js');
const { SESSION_COOKIE } = await import('../users/session.js');

const TOKEN = 'witness-daemon-token';
const PASSWORD = 'super-secret';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerHttpRoutes(app);
registerDeviceRoutes(app);
registerMachineRoutes(app, { daemonToken: () => TOKEN });

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;

/** A "machine" that answers what the test asks for. */
let fakeAnswer: { status: number; headers?: Record<string, string>; body?: string } = { status: 404 };
const fake = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(fakeAnswer.status, { 'content-type': 'application/json', ...fakeAnswer.headers });
    res.end(fakeAnswer.body ?? '{}');
  });
});
fake.listen(0, '127.0.0.1');
await once(fake, 'listening');
const fakeUrl = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;

test.after(() => {
  server.closeAllConnections();
  server.close();
  fake.closeAllConnections();
  fake.close();
});

type Call = { status: number; json: Record<string, unknown>; res: Response; text: string };

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; cookie?: string; bearer?: string; headers?: Record<string, string> } = {},
): Promise<Call> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {}, res, text };
}

function sessionCookie(res: Response): string {
  for (const line of res.headers.getSetCookie()) {
    const match = new RegExp(`^${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  throw new Error('no session cookie');
}

async function login(email: string): Promise<string> {
  const res = await call('POST', '/api/auth/login', { body: { email, password: PASSWORD } });
  assert.equal(res.status, 200);
  return sessionCookie(res.res);
}

async function issueCode(cookie: string): Promise<string> {
  const res = await call('POST', '/api/devices/pairing-codes', { cookie, body: {} });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return String(res.json.code);
}

const setup = await call('POST', '/api/auth/setup', { body: { email: 'alice@example.com', name: 'Alice', password: PASSWORD } });
assert.equal(setup.status, 201);
createTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', passwordHash: await hashPassword(PASSWORD), status: 'active' });
const aliceCookie = await login('alice@example.com');
const bobCookie = await login('bob@example.com');

/** Alice's machine, paired once the refusals are out of the way. */
let machineId = '';
let machineToken = '';

test('anonymous callers are refused on every fleet route', async () => {
  for (const [method, path] of [
    ['GET', '/api/machines'], ['POST', '/api/machines/pair'], ['PATCH', '/api/machines/x'],
    ['DELETE', '/api/machines/x'], ['GET', '/api/machines/x/status'], ['GET', '/api/machines/x/credential'],
  ] as const) {
    const res = await call(method, path, method === 'POST' || method === 'PATCH' ? { body: {} } : {});
    assert.equal(res.status, 401, `${method} ${path}`);
  }
});

test('the daemon-token, a mission token and a paired device are not a fleet owner', async () => {
  assert.equal((await call('GET', '/api/machines', { bearer: TOKEN })).status, 403);
  const raw = 'mission-token-for-machines-test';
  dbApi.createApiToken({ tokenHash: hashDeviceToken(raw), userId: dbApi.getActiveSuperadmin()!.id, scope: 'mission', label: 'test' });
  assert.equal((await call('GET', '/api/machines', { bearer: raw })).status, 403);
  // A device driving this daemon from elsewhere cannot read the fleet's tokens.
  resetThrottle();
  const redeem = await call('POST', '/api/devices/redeem', { body: { code: await issueCode(aliceCookie), name: 'Elsewhere' } });
  assert.equal(redeem.status, 200);
  const device = String(redeem.json.token);
  assert.equal((await call('GET', '/api/machines', { bearer: device })).status, 403);
  assert.equal((await call('POST', '/api/machines/pair', { bearer: device, body: { url: base, code: 'x' } })).status, 403);
  assert.equal((await call('GET', '/api/machines/x/credential', {
    bearer: device, headers: { [RELAY_PROOF_HEADER]: relayProof(TOKEN, 'x') },
  })).status, 403);
});

test('a URL outside the policy is refused before any call', async () => {
  resetThrottle();
  const tried = async (url: string) => (await call('POST', '/api/machines/pair', { cookie: aliceCookie, body: { url, code: 'ABCD-EFGH-JKMN' } })).json.code;
  assert.equal(await tried('http://vps.example.com'), 'https_required');
  assert.equal(await tried('http://192.168.1.20:3001'), 'https_required');
  assert.equal(await tried('https://169.254.169.254'), 'blocked_address');
  assert.equal(await tried('https://[fe80::1]'), 'blocked_address');
  assert.equal(await tried('https://rom:pw@vps.example.com'), 'credentials_in_url');
  assert.equal(await tried('https://vps.example.com/?token=x'), 'query_in_url');
  assert.equal(await tried('file:///etc/passwd'), 'invalid_url');
  const extra = await call('POST', '/api/machines/pair', { cookie: aliceCookie, body: { url: base, code: 'x', admin: true } });
  assert.equal(extra.status, 400);
  assert.equal(extra.json.error, 'invalid_request');
});

test('what a remote answers is mapped, never relayed', async () => {
  resetThrottle();
  const pairFake = async () => call('POST', '/api/machines/pair', { cookie: aliceCookie, body: { url: fakeUrl, code: 'ABCD-EFGH-JKMN' } });
  fakeAnswer = { status: 401, body: JSON.stringify({ error: 'invalid_code' }) };
  let res = await pairFake();
  assert.equal(res.status, 422);
  assert.equal(res.json.code, 'invalid_code');
  fakeAnswer = { status: 404, body: '{"error":"Cannot POST"}' };
  res = await pairFake();
  assert.equal(res.json.code, 'not_a_timon_machine');
  resetThrottle();
  fakeAnswer = { status: 302, headers: { location: 'http://169.254.169.254/' } };
  res = await pairFake();
  assert.equal(res.status, 502);
  assert.equal(res.json.code, 'machine_redirect');
  fakeAnswer = { status: 200, body: JSON.stringify({ token: 'not-a-device-token', device: { id: 'd' }, user: {} }) };
  res = await pairFake();
  assert.equal(res.json.code, 'machine_bad_response');
  resetThrottle();
  fakeAnswer = { status: 403, body: JSON.stringify({ error: 'device_requires_tls' }) };
  res = await pairFake();
  assert.equal(res.json.code, 'machine_requires_tls');
  fakeAnswer = { status: 429, headers: { 'retry-after': '30' } };
  res = await pairFake();
  assert.equal(res.status, 429);
  assert.equal(res.res.headers.get('retry-after'), '30');
  assert.deepEqual((await call('GET', '/api/machines', { cookie: aliceCookie })).json.machines, []);
});

test('failed pairings are throttled per account', async (t) => {
  // A frozen clock: on a loaded machine, a pairing took longer than the 150 ms lockout and the last one came back unlocked.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  resetThrottle();
  fakeAnswer = { status: 401, body: JSON.stringify({ error: 'invalid_code' }) };
  let last = 0;
  for (let i = 0; i < 6; i += 1) {
    last = (await call('POST', '/api/machines/pair', { cookie: aliceCookie, body: { url: fakeUrl, code: 'ABCD-EFGH-JKMN' } })).status;
  }
  assert.equal(last, 429);
  resetThrottle();
});

test('with the vault switched off, nothing is paired', async () => {
  setActiveModules(['@timon/users', '@timon/http']);
  try {
    const res = await call('POST', '/api/machines/pair', { cookie: aliceCookie, body: { url: base, code: 'ABCD-EFGH-JKMN' } });
    assert.equal(res.status, 503);
    assert.equal(res.json.code, 'vault_unavailable');
  } finally {
    resetActiveModules();
  }
});

test('pairing for real: the remote device is created, the token stays sealed', async () => {
  resetThrottle();
  const code = await issueCode(aliceCookie);
  const res = await call('POST', '/api/machines/pair', {
    cookie: aliceCookie, body: { url: `${base}/`, code, name: 'Self', device_name: 'Fleet witness' },
  });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  const machine = res.json.machine as Record<string, unknown>;
  machineId = String(machine.id);
  assert.equal(machine.url, base);
  assert.equal(machine.name, 'Self');
  assert.equal(machine.status, 'online');
  assert.equal(machine.api_level, API_LEVEL);
  assert.deepEqual(machine.remote_user, { email: 'alice@example.com', name: 'Alice', is_superadmin: true });
  assert.ok(!res.text.includes('tdev_'), 'no token in the answer');
  const listed = await call('GET', '/api/machines', { cookie: aliceCookie });
  assert.equal((listed.json.machines as unknown[]).length, 1);
  assert.ok(!listed.text.includes('tdev_') && !listed.text.includes('enc:1:'), 'no token, sealed or not, in a listing');
  const stored = db.prepare(`SELECT token_enc FROM machines WHERE id = ?`).get(machineId) as { token_enc: string };
  assert.ok(stored.token_enc.startsWith('enc:1:'));
  assert.ok(dbApi.listAuditLog(200).some((row) => row.action === 'machine.pair' && row.target === `machine:${machineId}`));
});

test('another account sees nothing of the fleet: 404, not 403', async () => {
  assert.deepEqual((await call('GET', '/api/machines', { cookie: bobCookie })).json.machines, []);
  assert.equal((await call('PATCH', `/api/machines/${machineId}`, { cookie: bobCookie, body: { name: 'mine' } })).status, 404);
  assert.equal((await call('GET', `/api/machines/${machineId}/status`, { cookie: bobCookie })).status, 404);
  assert.equal((await call('DELETE', `/api/machines/${machineId}`, { cookie: bobCookie })).status, 404);
  const credential = await call('GET', `/api/machines/${machineId}/credential`, {
    cookie: bobCookie, headers: { [RELAY_PROOF_HEADER]: relayProof(TOKEN, machineId) },
  });
  assert.equal(credential.status, 404);
  assert.ok(!credential.text.includes('tdev_'));
  assert.equal((await call('GET', '/api/machines', { cookie: aliceCookie })).status, 200);
});

test('the credential is the relay’s alone: a browser never reads it', async () => {
  const path = `/api/machines/${machineId}/credential`;
  // The session alone, as a browser on this host would send it.
  assert.equal((await call('GET', path, { cookie: aliceCookie })).status, 403);
  // A valid proof does not cover a browser's own fetch.
  for (const headers of [
    { 'sec-fetch-site': 'same-origin' }, { 'sec-fetch-dest': 'empty' }, { origin: base },
  ]) {
    const res = await call('GET', path, { cookie: aliceCookie, headers: { ...headers, [RELAY_PROOF_HEADER]: relayProof(TOKEN, machineId) } });
    assert.equal(res.status, 403);
    assert.ok(!res.text.includes('tdev_'));
  }
  // Stale, forged, another machine's, or keyed by something else.
  for (const proof of [
    relayProof(TOKEN, machineId, Date.now() - 5 * 60_000),
    relayProof(TOKEN, 'another-machine'),
    relayProof('not-the-daemon-token', machineId),
    `${Math.floor(Date.now() / 1000)}.${'0'.repeat(64)}`,
    'garbage',
  ]) {
    assert.equal((await call('GET', path, { cookie: aliceCookie, headers: { [RELAY_PROOF_HEADER]: proof } })).status, 403, proof);
  }
  // The daemon-token is never a way in either.
  assert.equal((await call('GET', path, { bearer: TOKEN, headers: { [RELAY_PROOF_HEADER]: relayProof(TOKEN, machineId) } })).status, 403);
  // The relay: session + proof.
  const ok = await call('GET', path, { cookie: aliceCookie, headers: { [RELAY_PROOF_HEADER]: relayProof(TOKEN, machineId) } });
  assert.equal(ok.status, 200);
  assert.equal(ok.res.headers.get('cache-control'), 'no-store');
  assert.equal(ok.json.id, machineId);
  assert.equal(ok.json.url, base);
  machineToken = String(ok.json.token);
  assert.match(machineToken, /^tdev_/);
  // And it is a working device token on the remote.
  assert.equal((await call('GET', '/api/devices', { bearer: machineToken })).status, 200);
});

test('status asks the machine itself', async () => {
  const res = await call('GET', `/api/machines/${machineId}/status`, { cookie: aliceCookie });
  assert.equal(res.status, 200);
  assert.equal(res.json.reachable, true);
  assert.equal(res.json.apiLevel, API_LEVEL);
  assert.equal(typeof res.json.version, 'string');
  assert.ok(!res.text.includes('tdev_'));
});

test('rename is validated, pairing the same URL again replaces the device', async () => {
  assert.equal((await call('PATCH', `/api/machines/${machineId}`, { cookie: aliceCookie, body: { name: '' } })).status, 400);
  assert.equal((await call('PATCH', `/api/machines/${machineId}`, { cookie: aliceCookie, body: { name: 'a\u0007b' } })).status, 400);
  const renamed = await call('PATCH', `/api/machines/${machineId}`, { cookie: aliceCookie, body: { name: 'Home server' } });
  assert.equal((renamed.json.machine as { name: string }).name, 'Home server');
  const oldDeviceId = (db.prepare(`SELECT remote_device_id FROM machines WHERE id = ?`).get(machineId) as { remote_device_id: string }).remote_device_id;
  resetThrottle();
  const again = await call('POST', '/api/machines/pair', { cookie: aliceCookie, body: { url: base, code: await issueCode(aliceCookie) } });
  assert.equal(again.status, 200);
  assert.equal(again.json.created, false);
  assert.equal((again.json.machine as { id: string }).id, machineId);
  // The device the fleet no longer holds is revoked on the remote.
  assert.notEqual(getDevice(oldDeviceId)?.revoked_at, null);
  assert.equal((await call('GET', '/api/devices', { bearer: machineToken })).status, 401);
});

test('removing a machine revokes this daemon’s device on it', async () => {
  const deviceId = (db.prepare(`SELECT remote_device_id FROM machines WHERE id = ?`).get(machineId) as { remote_device_id: string }).remote_device_id;
  const res = await call('DELETE', `/api/machines/${machineId}`, { cookie: aliceCookie });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { removed: true, remote_revoked: true });
  assert.notEqual(getDevice(deviceId)?.revoked_at, null);
  assert.deepEqual((await call('GET', '/api/machines', { cookie: aliceCookie })).json.machines, []);
  assert.equal((await call('GET', `/api/machines/${machineId}/status`, { cookie: aliceCookie })).status, 404);
});
