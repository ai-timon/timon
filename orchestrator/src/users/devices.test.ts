/**
 * Device pairing (multi-machine P2a): every refusal first, then the paths
 * that must pass. Witness server on 127.0.0.1:0, never :3000.
 */
import { createTestAccount } from '../../tests/helpers/accounts.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import type { Request } from 'express';

const HOME = mkdtempSync(join(tmpdir(), 'timon-devices-'));
process.env.TIMON_HOME = HOME;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
writeFileSync(
  join(HOME, 'timon.config.json'),
  JSON.stringify({
    version: 1,
    authThrottle: { maxAttempts: 8, windowMs: 60_000, lockoutMs: 150, maxLockoutMs: 300 },
    // Belt and braces: the reachable route is given a double below, and the
    // real `tailscale` of this machine must stay out of reach regardless.
    host: { binaries: { tailscale: join(HOME, 'no-tailscale-here') } },
  }),
);

await import('../../tests/helpers/paid-license.js');
const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { registerRoutes } = await import('../plugins-bundled/users/routes.js');
const { registerDeviceRoutes, deviceTransportAllowed } = await import('./devices-http.js');
const devices = await import('./devices.js');
const { resetThrottle } = await import('./login-throttle.js');
const { dbApi } = await import('../db.js');
const { hashPassword } = await import('./password.js');
const { SESSION_COOKIE } = await import('./session.js');
const { sseHandler } = await import('../sse.js');
const { deviceConnectionCount } = await import('./device-connections.js');

const TOKEN = 'witness-daemon-token';
const PASSWORD = 'super-secret';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app, { setupPolicy: 'free' });
let publishCalls = 0;
const setupCalls: string[] = [];
const setupStatus = (job: 'install' | 'connect' | 'operator' | null) => ({
  platform: 'linux' as const,
  state: 'not_installed' as const,
  error: null,
  job: job && {
    kind: job, phase: 'installing' as const, failure: null, command: null, detail: null, authUrl: null, installer: null, startedAt: 1,
  },
});
registerDeviceRoutes(app, {
  publishDaemon: async () => {
    publishCalls += 1;
    return { ok: true, address: 'https://my-laptop.tail0000.ts.net:10000', port: 10000, reused: false };
  },
  // Never the real installer, `tailscale up` or pkexec.
  tailscaleSetup: () => ({
    status: async () => { setupCalls.push('status'); return setupStatus(null); },
    install: async (opts) => { setupCalls.push(opts?.client === 'desktop' ? 'install:desktop' : 'install'); return setupStatus('install'); },
    reportInstaller: async (report) => { setupCalls.push(`report:${report.outcome}`); return setupStatus('install'); },
    connect: async () => { setupCalls.push('connect'); return setupStatus('connect'); },
    allowOperator: async () => { setupCalls.push('operator'); return setupStatus('operator'); },
  }),
});
app.get('/api/stream', sseHandler);
// A superadmin-only probe: the account list the test used is the operator's own now (daemon token only).
const { requireSuperadmin } = await import('./identity.js');
app.get('/api/test/superadmin-only', (req, res) => {
  if (!requireSuperadmin(req, res)) return;
  res.json({ ok: true });
});

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;

test.after(() => { server.close(); });

type Call = { status: number; json: Record<string, unknown>; res: Response };

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
  return { status: res.status, json: text ? JSON.parse(text) as Record<string, unknown> : {}, res };
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

async function issue(cookie: string): Promise<string> {
  const res = await call('POST', '/api/devices/pairing-codes', { cookie, body: {} });
  assert.equal(res.status, 201, JSON.stringify(res.json));
  return String(res.json.code);
}

async function pair(cookie: string, name: string): Promise<{ id: string; token: string }> {
  const code = await issue(cookie);
  const res = await call('POST', '/api/devices/redeem', { body: { code, name } });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  return { id: String((res.json.device as { id: string }).id), token: String(res.json.token) };
}

function auditActions(): string[] {
  return dbApi.listAuditLog(1000).map((row) => row.action);
}

const setup = await call('POST', '/api/auth/setup', {
  body: { email: 'robin@example.com', name: 'Robin', password: PASSWORD },
});
assert.equal(setup.status, 201);
const bob = createTestAccount(dbApi, {
  email: 'bob@example.com', name: 'Bob', passwordHash: await hashPassword(PASSWORD), status: 'active',
});
const romCookie = await login('robin@example.com');
const bobCookie = await login('bob@example.com');

test('anonymous callers are refused on every device route but redeem', async () => {
  assert.equal((await call('GET', '/api/devices')).status, 401);
  assert.equal((await call('POST', '/api/devices/pairing-codes', { body: {} })).status, 401);
  assert.equal((await call('PATCH', '/api/devices/x', { body: { name: 'n' } })).status, 401);
  assert.equal((await call('DELETE', '/api/devices/x')).status, 401);
});

test('a mission token can neither issue a code nor manage devices', async () => {
  const raw = 'mission-token-for-devices-test';
  dbApi.createApiToken({ tokenHash: devices.hashDeviceToken(raw), userId: bob.id, scope: 'mission', label: 'test' });
  assert.equal((await call('POST', '/api/devices/pairing-codes', { bearer: raw, body: {} })).status, 403);
  assert.equal((await call('GET', '/api/devices', { bearer: raw })).status, 403);
});

test('making the machine reachable: anonymous, non-admin, mission and device are all refused', async () => {
  resetThrottle();
  const before = publishCalls;
  assert.equal((await call('POST', '/api/devices/reachable', { body: {} })).status, 401);
  assert.equal((await call('POST', '/api/devices/reachable', { cookie: bobCookie, body: {} })).status, 403);
  const rom = dbApi.getActiveSuperadmin()!;
  const raw = 'superadmin-mission-token-for-reachable';
  dbApi.createApiToken({ tokenHash: devices.hashDeviceToken(raw), userId: rom.id, scope: 'mission', label: 'test' });
  assert.equal((await call('POST', '/api/devices/reachable', { bearer: raw, body: {} })).status, 403);
  // A superadmin's own paired device: a request relayed from another machine.
  const device = await pair(romCookie, 'Relay');
  const relayed = await call('POST', '/api/devices/reachable', { bearer: device.token, body: {} });
  assert.equal(relayed.status, 403);
  assert.equal(publishCalls, before, 'no refused caller may reach tailscale');
});

test('making the machine reachable: a superadmin on this machine gets the address', async () => {
  const before = publishCalls;
  const res = await call('POST', '/api/devices/reachable', { cookie: romCookie, body: {} });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual(res.json, { address: 'https://my-laptop.tail0000.ts.net:10000', port: 10000, reused: false });
  assert.ok(auditActions().includes('daemon.tailnet.publish'));
  // The operator's CLI on the host is the other way to sit at this machine.
  assert.equal((await call('POST', '/api/devices/reachable', { bearer: TOKEN, body: {} })).status, 200);
  assert.equal(publishCalls, before + 2);
});

test('making the machine reachable: the body takes no field', async () => {
  const res = await call('POST', '/api/devices/reachable', { cookie: romCookie, body: { port: 22, target: 'http://10.0.0.1' } });
  assert.equal(res.status, 400);
});

const SETUP_ROUTES: [string, string][] = [
  ['GET', '/api/devices/tailscale'],
  ['POST', '/api/devices/tailscale/install'],
  ['POST', '/api/devices/tailscale/connect'],
  ['POST', '/api/devices/tailscale/operator'],
  ['POST', '/api/devices/tailscale/install/report'],
];
const REPORT = { sha256: 'e'.repeat(64), outcome: 'cancelled', code: 1602 };

test('Tailscale setup: anonymous, non-admin, mission and relayed device are all refused, nothing runs', async () => {
  resetThrottle();
  const before = setupCalls.length;
  const rom = dbApi.getActiveSuperadmin()!;
  const raw = 'superadmin-mission-token-for-tailscale-setup';
  dbApi.createApiToken({ tokenHash: devices.hashDeviceToken(raw), userId: rom.id, scope: 'mission', label: 'test' });
  const device = await pair(romCookie, 'Relay for setup');
  for (const [method, path] of SETUP_ROUTES) {
    const body = path.endsWith('/report') ? REPORT : method === 'POST' ? {} : undefined;
    assert.equal((await call(method, path, { body })).status, 401, `${path} anonymous`);
    assert.equal((await call(method, path, { cookie: bobCookie, body })).status, 403, `${path} non-admin`);
    assert.equal((await call(method, path, { bearer: raw, body })).status, 403, `${path} mission`);
    assert.equal((await call(method, path, { bearer: device.token, body })).status, 403, `${path} relayed`);
  }
  assert.equal(setupCalls.length, before, 'no refused caller may reach the installer');
});

test('Tailscale setup: a superadmin on this machine starts each step and reads the job, audited', async () => {
  const status = await call('GET', '/api/devices/tailscale', { cookie: romCookie });
  assert.equal(status.status, 200);
  assert.deepEqual(status.json, { platform: 'linux', state: 'not_installed', error: null, job: null });
  for (const step of ['install', 'connect', 'operator']) {
    const res = await call('POST', `/api/devices/tailscale/${step}`, { cookie: romCookie, body: {} });
    assert.equal(res.status, 202, JSON.stringify(res.json));
    assert.equal((res.json.job as { kind: string }).kind, step);
    assert.ok('auth_url' in (res.json.job as object));
    assert.ok(auditActions().includes(`daemon.tailscale.${step}`));
  }
});

test('Tailscale setup: the desktop app says so, and reports how its installer ended — audited', async () => {
  const res = await call('POST', '/api/devices/tailscale/install', { cookie: romCookie, body: { client: 'desktop' } });
  assert.equal(res.status, 202);
  assert.equal(setupCalls.at(-1), 'install:desktop');
  const report = await call('POST', '/api/devices/tailscale/install/report', { cookie: romCookie, body: REPORT });
  assert.equal(report.status, 200, JSON.stringify(report.json));
  assert.equal(setupCalls.at(-1), 'report:cancelled');
  assert.ok(auditActions().includes('daemon.tailscale.install_report'));
  // The installer's path is shown only while the app has to open it.
  assert.equal((report.json.job as { installer: unknown }).installer, null);
});

test('Tailscale setup: the report names a package by its sha256 and nothing else', async () => {
  const before = setupCalls.length;
  for (const body of [
    {},
    { ...REPORT, sha256: 'not-a-sha' },
    { ...REPORT, outcome: 'pwned' },
    { ...REPORT, code: 1.5 },
    { ...REPORT, path: 'C:\\Windows\\evil.msi' },
    { ...REPORT, command: 'rm -rf /' },
  ]) {
    assert.equal((await call('POST', '/api/devices/tailscale/install/report', { cookie: romCookie, body })).status, 400, JSON.stringify(body));
  }
  for (const body of [{ client: 'browser' }, { client: 'desktop', url: 'https://evil.example/x.pkg' }]) {
    assert.equal((await call('POST', '/api/devices/tailscale/install', { cookie: romCookie, body })).status, 400, JSON.stringify(body));
  }
  // `client` belongs to install alone.
  assert.equal((await call('POST', '/api/devices/tailscale/connect', { cookie: romCookie, body: { client: 'desktop' } })).status, 400);
  assert.equal(setupCalls.length, before);
});

test('Tailscale setup: the body takes no field — no URL, no account, no command from the client', async () => {
  const before = setupCalls.length;
  for (const body of [{ url: 'https://evil.example/x.pkg' }, { operator: 'root' }, { command: 'rm -rf /' }]) {
    assert.equal((await call('POST', '/api/devices/tailscale/install', { cookie: romCookie, body })).status, 400);
    assert.equal((await call('POST', '/api/devices/tailscale/operator', { cookie: romCookie, body })).status, 400);
  }
  assert.equal(setupCalls.length, before);
});

test('a code is single-use, and an unknown code gets the same answer', async () => {
  resetThrottle();
  const code = await issue(bobCookie);
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/);
  const first = await call('POST', '/api/devices/redeem', { body: { code: code.toLowerCase(), name: 'Laptop' } });
  assert.equal(first.status, 200);
  assert.equal(first.res.headers.get('cache-control'), 'no-store');
  const again = await call('POST', '/api/devices/redeem', { body: { code, name: 'Thief' } });
  assert.equal(again.status, 401);
  assert.deepEqual(again.json, { error: 'invalid_code' });
  const unknown = await call('POST', '/api/devices/redeem', { body: { code: 'ZZZZ-ZZZZ-ZZZZ', name: 'Thief' } });
  assert.deepEqual(unknown.json, again.json);
});

test('an expired code is refused', async () => {
  resetThrottle();
  const { code } = devices.issuePairingCode(bob.id, Date.now() - devices.PAIRING_CODE_TTL_MS - 1000);
  const res = await call('POST', '/api/devices/redeem', { body: { code, name: 'Late' } });
  assert.equal(res.status, 401);
});

test('wrong guesses burn the code: even the right one is refused afterwards', async () => {
  resetThrottle();
  const code = (await issue(bobCookie)).replace(/-/g, '');
  const wrong = code.slice(0, 11) + (code[11] === 'Z' ? 'Y' : 'Z');
  for (let i = 0; i < devices.PAIRING_CODE_MAX_ATTEMPTS; i++) {
    const res = await call('POST', '/api/devices/redeem', { body: { code: wrong, name: 'Guess' } });
    assert.equal(res.status, 401);
  }
  const right = await call('POST', '/api/devices/redeem', { body: { code, name: 'Too late' } });
  assert.equal(right.status, 401);
  assert.ok(auditActions().includes('device.code.burnt'));
});

test('redeem is throttled by address', async () => {
  resetThrottle();
  let last: Call | undefined;
  for (let i = 0; i < 9; i++) {
    last = await call('POST', '/api/devices/redeem', { body: { code: 'ZZZZ-ZZZZ-ZZZY', name: 'Spray' } });
  }
  assert.equal(last!.status, 429);
  assert.ok(last!.res.headers.get('retry-after'));
  resetThrottle();
});

test('a malformed redeem body is a 400 and never reaches the store', async () => {
  resetThrottle();
  assert.equal((await call('POST', '/api/devices/redeem', { body: { code: 'ABCD-EFGH-JKMN' } })).status, 400);
  assert.equal((await call('POST', '/api/devices/redeem', { body: { code: 'ABCD-EFGH-JKMN', name: 'x', extra: 1 } })).status, 400);
  assert.equal((await call('POST', '/api/devices/redeem', { body: { code: 'ABCD-EFGH-JKMN', name: 'a\u0007b' } })).status, 400);
});

test('a paired device acts as its owner, and the pairing is audited and notified', async () => {
  resetThrottle();
  const device = await pair(bobCookie, 'Bob laptop');
  assert.ok(device.token.startsWith(devices.DEVICE_TOKEN_PREFIX));
  const me = await call('GET', '/api/auth/me', { bearer: device.token });
  assert.equal((me.json.user as { email: string }).email, 'bob@example.com');
  const list = await call('GET', '/api/devices', { bearer: device.token });
  assert.equal(list.status, 200);
  const rows = list.json.devices as { id: string; current: boolean; status: string; token_hash?: string }[];
  const mine = rows.find((row) => row.id === device.id)!;
  assert.equal(mine.current, true);
  assert.equal(mine.status, 'active');
  assert.equal(mine.token_hash, undefined, 'the hash never leaves the daemon');
  assert.ok(auditActions().includes('device.pair'));
  const notes = dbApi.listNotifications({ limit: 50 }).filter((n) => n.title === 'New device connected');
  assert.ok(notes.some((n) => n.owner_user_id === bob.id));
});

test('a device carries superadmin only when its owner is one', async () => {
  resetThrottle();
  const romDevice = await pair(romCookie, 'Robin desktop');
  assert.equal((await call('GET', '/api/test/superadmin-only', { bearer: romDevice.token })).status, 200);
  const bobDevice = await pair(bobCookie, 'Bob phone');
  assert.equal((await call('GET', '/api/test/superadmin-only', { bearer: bobDevice.token })).status, 403);
});

test("a user neither sees nor touches someone else's device (404)", async () => {
  resetThrottle();
  const romDevice = await pair(romCookie, 'Robin tablet');
  const bobDevice = await pair(bobCookie, 'Bob tablet');
  const list = await call('GET', '/api/devices', { cookie: bobCookie });
  const ids = (list.json.devices as { id: string }[]).map((row) => row.id);
  assert.ok(!ids.includes(romDevice.id));
  assert.equal((await call('PATCH', `/api/devices/${romDevice.id}`, { bearer: bobDevice.token, body: { name: 'mine' } })).status, 404);
  assert.equal((await call('DELETE', `/api/devices/${romDevice.id}`, { cookie: bobCookie })).status, 404);
  // The superadmin sees everyone's.
  const all = await call('GET', '/api/devices', { cookie: romCookie });
  assert.ok((all.json.devices as { id: string }[]).some((row) => row.id === bobDevice.id));
});

test('a device cannot mint another pairing code', async () => {
  resetThrottle();
  const device = await pair(bobCookie, 'Bob spare');
  const res = await call('POST', '/api/devices/pairing-codes', { bearer: device.token, body: {} });
  assert.equal(res.status, 403);
});

test('only a superadmin issues a code for another account', async () => {
  assert.equal((await call('POST', '/api/devices/pairing-codes', { cookie: bobCookie, body: { user_id: dbApi.getActiveSuperadmin()!.id } })).status, 403);
  const forBob = await call('POST', '/api/devices/pairing-codes', { cookie: romCookie, body: { user_id: bob.id } });
  assert.equal(forBob.status, 201);
  assert.equal(forBob.json.user_id, bob.id);
});

test('a revoked device is refused on its very next request, and that is audited', async () => {
  resetThrottle();
  const device = await pair(bobCookie, 'Bob old');
  assert.equal((await call('GET', '/api/auth/me', { bearer: device.token })).status, 200);
  const revoked = await call('DELETE', `/api/devices/${device.id}`, { cookie: bobCookie });
  assert.equal(revoked.status, 200);
  assert.equal((revoked.json.device as { status: string }).status, 'revoked');
  const after = await call('GET', '/api/devices', { bearer: device.token });
  assert.equal(after.status, 401);
  assert.ok(auditActions().includes('device.revoke'));
  assert.ok(auditActions().includes('device.use.denied'));
});

test('a device idle past its lifetime is refused', async () => {
  const past = Date.now() - devices.DEVICE_IDLE_TTL_MS - 60_000;
  const { code } = devices.issuePairingCode(bob.id, past);
  const outcome = devices.redeemPairingCode({ code, name: 'Forgotten', ip: null, userAgent: null, now: past });
  assert.equal(outcome.kind, 'ok');
  if (outcome.kind !== 'ok') return;
  assert.equal((await call('GET', '/api/auth/me', { bearer: outcome.token })).status, 401);
});

test("a disabled owner's devices die with the account", async () => {
  resetThrottle();
  const carol = createTestAccount(dbApi, {
    email: 'carol@example.com', name: 'Carol', passwordHash: await hashPassword(PASSWORD), status: 'active',
  });
  const device = await pair(await login('carol@example.com'), 'Carol laptop');
  assert.equal((await call('GET', '/api/auth/me', { bearer: device.token })).status, 200);
  dbApi.setUserStatus(carol.id, 'disabled');
  assert.equal((await call('GET', '/api/auth/me', { bearer: device.token })).status, 401);
});

test('a device token is never read from a query string', async () => {
  resetThrottle();
  const device = await pair(bobCookie, 'Bob stream');
  const res = await call('GET', `/api/stream?token=${encodeURIComponent(device.token)}`);
  assert.equal(res.status, 401);
});

test('a device token is not the daemon-token nor a session', async () => {
  resetThrottle();
  const device = await pair(romCookie, 'Robin operator?');
  // Operator-only route: the daemon-token, not a superadmin's device.
  assert.equal((await call('POST', '/api/auth/setup-token', { bearer: device.token })).status, 403);
  // Credential change: a signed-in session only.
  const pwd = await call('POST', '/api/auth/password', {
    bearer: device.token, body: { current_password: PASSWORD, password: 'another-secret' },
  });
  assert.equal(pwd.status, 401);
  // A forged token with the prefix is just unknown.
  assert.equal((await call('GET', '/api/auth/me', { bearer: `${devices.DEVICE_TOKEN_PREFIX}forged` })).status, 401);
});

test('a cross-site mutation carried by a device token is refused', async () => {
  resetThrottle();
  const device = await pair(bobCookie, 'Bob csrf');
  const res = await call('PATCH', `/api/devices/${device.id}`, {
    bearer: device.token, body: { name: 'renamed' }, headers: { 'sec-fetch-site': 'cross-site' },
  });
  assert.equal(res.status, 403);
  const ok = await call('PATCH', `/api/devices/${device.id}`, { bearer: device.token, body: { name: 'renamed' } });
  assert.equal(ok.status, 200);
  assert.equal((ok.json.device as { name: string }).name, 'renamed');
});

test('plain HTTP from off the loopback is refused for a device', () => {
  const fake = (remoteAddress: string) => ({ socket: { remoteAddress } }) as unknown as Request;
  assert.equal(deviceTransportAllowed(fake('127.0.0.1')), true);
  assert.equal(deviceTransportAllowed(fake('::ffff:127.0.0.1')), true);
  assert.equal(deviceTransportAllowed(fake('::1')), true);
  assert.equal(deviceTransportAllowed(fake('192.168.1.20')), false);
  assert.equal(deviceTransportAllowed(fake('100.64.0.3')), false);
});

test('codes normalise the way a person types them', () => {
  assert.equal(devices.normalizePairingCode('abcd efgh jkmn'), 'ABCDEFGHJKMN');
  assert.equal(devices.normalizePairingCode('O0IL-0000-0000'), '001100000000');
  assert.equal(devices.normalizePairingCode('ABCD-EFGH-JKMU'), null);
  assert.equal(devices.normalizePairingCode('short'), null);
});

test('a device passes the gestures reserved to a person, a mission token does not', async () => {
  const { decideAccess, upgradeAuth } = await import('../plugins-bundled/terminal-web/access.js');
  const { delegatingAgent } = await import('../delegation-guard.js');
  const { isPersonAuth } = await import('./identity.js');
  resetThrottle();
  const rom = dbApi.getActiveSuperadmin()!;
  const device = await pair(romCookie, 'Robin terminal');
  const auth = { kind: 'device' as const, user: rom, isSuperadmin: true, deviceId: device.id };
  assert.equal(isPersonAuth(auth), true);
  assert.equal(isPersonAuth({ kind: 'api-token', user: rom, isSuperadmin: false }), false);
  assert.notDeepEqual(decideAccess(auth), { denied: 'session_required' });
  // A person never speaks for a mission, whatever header it sends.
  const claimed = { auth, header: (name: string) => (name === 'X-TIMON-Mission' ? 'some-mission' : undefined) } as unknown as Request;
  assert.equal(delegatingAgent(claimed), null);
  // WebSocket upgrade: the device Bearer, over loopback only, live rows only.
  const upgrade = (remoteAddress: string) => ({
    headers: { authorization: `Bearer ${device.token}` }, socket: { remoteAddress },
  }) as unknown as import('node:http').IncomingMessage;
  assert.equal(upgradeAuth(upgrade('127.0.0.1'))?.kind, 'device');
  assert.equal(upgradeAuth(upgrade('192.168.1.20')), undefined);
  devices.revokeDevice(device.id);
  assert.equal(upgradeAuth(upgrade('127.0.0.1')), undefined);
});

test('a terminal upgrade audits a device coming back, and a dead one knocking, like the middleware', async () => {
  const { upgradeAuth } = await import('../plugins-bundled/terminal-web/access.js');
  const { db } = await import('../db.js');
  resetThrottle();
  const device = await pair(romCookie, 'Robin terminal audit');
  const upgrade = () => ({
    headers: { authorization: `Bearer ${device.token}` }, socket: { remoteAddress: '127.0.0.1' },
  }) as unknown as import('node:http').IncomingMessage;
  const rows = (action: string) => dbApi.listAuditLog(1000)
    .filter((row) => row.action === action && row.target === `device:${device.id}`);
  // Back after a silence longer than the audit gap: one `device.use` row.
  db.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`)
    .run(Date.now() - devices.DEVICE_USE_AUDIT_GAP_MS - 1000, device.id);
  const before = rows('device.use').length;
  assert.equal(upgradeAuth(upgrade())?.kind, 'device');
  const used = rows('device.use');
  assert.equal(used.length, before + 1);
  assert.equal(used[0]!.actor, `device:${device.id}`);
  // A second upgrade right after is not a fresh use.
  assert.equal(upgradeAuth(upgrade())?.kind, 'device');
  assert.equal(rows('device.use').length, before + 1);
  // Revoked: refused, and the knock is audited once.
  devices.revokeDevice(device.id);
  assert.equal(upgradeAuth(upgrade()), undefined);
  assert.equal(upgradeAuth(upgrade()), undefined);
  assert.equal(rows('device.use.denied').length, 1);
});

test('behind a TLS proxy, a device token needs the proxy to say HTTPS', async () => {
  const { config, setConfig } = await import('../config/load.js');
  const fake = (remoteAddress: string, proto?: string) => ({
    headers: proto === undefined ? {} : { 'x-forwarded-proto': proto },
    socket: { remoteAddress },
  }) as unknown as Request;
  const saved = config();
  try {
    setConfig({ ...saved, daemon: { ...saved.daemon, behindTlsProxy: true } });
    // The flag alone no longer opens the LAN: the proxy must vouch for TLS.
    assert.equal(deviceTransportAllowed(fake('192.168.1.20')), false);
    assert.equal(deviceTransportAllowed(fake('192.168.1.20', 'http')), false);
    assert.equal(deviceTransportAllowed(fake('192.168.1.20', 'https')), true);
    assert.equal(deviceTransportAllowed(fake('172.17.0.2', 'HTTPS, http')), true);
    // Loopback stays a TLS hop of its own, unless a proxy says it was clear.
    assert.equal(deviceTransportAllowed(fake('127.0.0.1')), true);
    assert.equal(deviceTransportAllowed(fake('127.0.0.1', 'https')), true);
    assert.equal(deviceTransportAllowed(fake('127.0.0.1', 'http')), false);
    setConfig({ ...saved, daemon: { ...saved.daemon, behindTlsProxy: false } });
    // Without the flag the header opens nothing off the loopback.
    assert.equal(deviceTransportAllowed(fake('192.168.1.20', 'https')), false);
    assert.equal(deviceTransportAllowed(fake('127.0.0.1', 'http')), false);
  } finally {
    setConfig(saved);
  }
  // End to end: a live device token relayed as clear HTTP is refused.
  resetThrottle();
  const device = await pair(romCookie, 'Robin proto');
  const clear = await call('GET', '/api/devices', { bearer: device.token, headers: { 'x-forwarded-proto': 'http' } });
  assert.equal(clear.status, 403);
  assert.equal(clear.json.error, 'device_requires_tls');
  const ok = await call('GET', '/api/devices', { bearer: device.token, headers: { 'x-forwarded-proto': 'https' } });
  assert.equal(ok.status, 200);
});

/** Opens the global event stream as a device; resolves once the headers are in. */
async function openStream(token: string): Promise<{ ended: Promise<void> }> {
  const res = await fetch(`${base}/api/stream`, { headers: { authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  const ended = (async () => {
    try {
      for (;;) {
        const { done } = await reader.read();
        if (done) return;
      }
    } catch {
      // Destroyed by the daemon: ended all the same.
    }
  })();
  return { ended };
}

test('an event stream opened by a device closes the moment the device is revoked', async () => {
  resetThrottle();
  const device = await pair(romCookie, 'Robin live stream');
  const stream = await openStream(device.token);
  assert.equal(deviceConnectionCount(device.id), 1);
  const revoked = await call('DELETE', `/api/devices/${device.id}`, { cookie: romCookie });
  assert.equal(revoked.status, 200);
  await stream.ended;
  assert.equal(deviceConnectionCount(device.id), 0);
});

test('the sweep closes the open streams of a device that expired or lost its owner', async () => {
  const { db } = await import('../db.js');
  resetThrottle();
  const dave = createTestAccount(dbApi, {
    email: 'dave@example.com', name: 'Dave', passwordHash: await hashPassword(PASSWORD), status: 'active',
  });
  const daveCookie = await login('dave@example.com');
  const idle = await pair(daveCookie, 'Dave idle');
  const owned = await pair(daveCookie, 'Dave owned');
  const idleStream = await openStream(idle.token);
  const ownedStream = await openStream(owned.token);
  // Nothing to close while both may still act.
  assert.equal(devices.sweepDeviceConnections(), 0);
  db.prepare(`UPDATE devices SET last_seen_at = ? WHERE id = ?`)
    .run(Date.now() - devices.DEVICE_IDLE_TTL_MS - 1000, idle.id);
  assert.equal(devices.sweepDeviceConnections(), 1);
  await idleStream.ended;
  assert.equal(deviceConnectionCount(owned.id), 1);
  dbApi.setUserStatus(dave.id, 'disabled');
  assert.equal(devices.sweepDeviceConnections(), 1);
  await ownedStream.ended;
  assert.equal(deviceConnectionCount(), 0);
});

test('the sweep closes the open streams of an account a lapsed licence falls back to Free, not the superadmin\'s', { timeout: 8000 }, async () => {
  const { setLicenseState } = await import('../license/runtime.js');
  const { unlicensed } = await import('../license/license.js');
  const { paidTestLicense } = await import('../../tests/helpers/paid-license.js');
  resetThrottle();
  createTestAccount(dbApi, {
    email: 'erin@example.com', name: 'Erin', passwordHash: await hashPassword(PASSWORD), status: 'active',
  });
  const erinCookie = await login('erin@example.com');
  const erinDevice = await pair(erinCookie, 'Erin screen');
  const romDevice = await pair(romCookie, 'Robin screen');
  const erinStream = await openStream(erinDevice.token);
  const romStream = await openStream(romDevice.token);
  assert.equal(devices.deviceIsLive(erinDevice.id), true);
  try {
    // The licence lapses: Free only admits the first active superadmin.
    setLicenseState(unlicensed('expired'));
    assert.equal(devices.deviceIsLive(erinDevice.id), false);
    assert.equal(devices.deviceIsLive(romDevice.id), true, 'the recovery superadmin keeps its device');
    assert.ok(devices.sweepDeviceConnections() >= 1);
    await erinStream.ended;
    assert.equal(deviceConnectionCount(erinDevice.id), 0);
    assert.equal(deviceConnectionCount(romDevice.id), 1);
  } finally {
    setLicenseState(paidTestLicense());
  }
  assert.equal(devices.deviceIsLive(erinDevice.id), true, 'a paid licence restores the account');
  devices.revokeDevice(romDevice.id);
  await romStream.ended;
});
