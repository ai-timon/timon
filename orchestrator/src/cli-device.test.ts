/**
 * `timon device …` end to end: the real CLI against a witness daemon with the
 * real auth middleware and device routes. Refusals first — anonymous, a
 * mission's token, a paired device, no account yet — then the paths that
 * must pass. Witness on 127.0.0.1:0, never the daemon of this machine.
 */
import { createTestAccount } from '../tests/helpers/accounts.js';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';

const HOME = mkdtempSync(join(tmpdir(), 'timon-cli-device-'));
process.env.TIMON_HOME = HOME;
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
writeFileSync(join(HOME, 'timon.config.json'), JSON.stringify({ version: 1 }));

await import('../tests/helpers/paid-license.js');
const { createDaemonAuthMiddleware } = await import('./plugins-bundled/http/auth.js');
const { registerRoutes } = await import('./plugins-bundled/users/routes.js');
const { registerDeviceRoutes } = await import('./users/devices-http.js');
const devices = await import('./users/devices.js');
const { dbApi } = await import('./db.js');
const { hashPassword } = await import('./users/password.js');
const { pairingAddress, pairingText } = await import('../bin/cli-device.mjs');

const TIMON = fileURLToPath(new URL('../bin/timon', import.meta.url));
const TOKEN = 'witness-daemon-token-cli-device';
const PASSWORD = 'super-secret';
const DAEMON_PORT = 3000;

let webUiAccess: unknown = {
  security: { daemon: { port: DAEMON_PORT } },
  tailscale: { serve: [{ host: 'srv.tail1234.ts.net:8443', target: `http://127.0.0.1:${DAEMON_PORT}` }] },
};

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app, { setupPolicy: 'free' });
registerDeviceRoutes(app, {
  publishDaemon: async () => { throw new Error('never published from these tests'); },
});
app.get('/api/webui-access', (_req, res) => { res.json(webUiAccess); });

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;
test.after(() => { server.close(); });

/** A CLI home of its own, with no daemon-token file: the token is exactly the one given. */
const CLI_HOME = mkdtempSync(join(tmpdir(), 'timon-cli-device-home-'));

function timon(args: string[], token: string | null): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env, TIMON_HOME: CLI_HOME, TIMON_API: base, TIMON_RESOURCE_GUARD_ENABLED: '0' };
  // A test run from a mission inherits its identity: the CLI must speak as a terminal here.
  delete env.TIMON_MISSION_ID;
  delete env.TIMON_AGENT;
  delete env.TIMON_API_TOKEN;
  if (token) env.TIMON_API_TOKEN = token;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TIMON, 'device', ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer | string) => { stdout += String(c); });
    child.stderr.on('data', (c: Buffer | string) => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

async function redeem(code: string, name: string): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${base}/api/devices/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, name }),
  });
  return { status: res.status, json: await res.json() as Record<string, unknown> };
}

function issuedCodes(): number {
  return dbApi.listAuditLog(1000).filter((row) => row.action === 'device.code.issue').length;
}

const CODE_RE = /\b[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}\b/;

test('before any account exists, the daemon-token issues no code', async () => {
  const r = await timon(['pair'], TOKEN);
  assert.equal(r.code, 2, r.stderr);
  assert.match(r.stderr, /403/);
  assert.equal(issuedCodes(), 0);
});

let bobId = '';

test('accounts', async () => {
  const setup = await fetch(`${base}/api/auth/setup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'robin@example.com', name: 'Robin', password: PASSWORD }),
  });
  assert.equal(setup.status, 201);
  bobId = createTestAccount(dbApi, { email: 'bob@example.com', name: 'Bob', passwordHash: await hashPassword(PASSWORD), status: 'active' }).id;
});

test('an anonymous caller gets no code', async () => {
  const r = await timon(['pair'], null);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /401/);
  assert.doesNotMatch(r.stdout, CODE_RE);
  assert.equal(issuedCodes(), 0);
});

test("a mission's token gets no code and cannot list devices", async () => {
  const raw = 'mission-token-for-cli-device-test';
  dbApi.createApiToken({ tokenHash: devices.hashDeviceToken(raw), userId: dbApi.getActiveSuperadmin()!.id, scope: 'mission', label: 'test' });
  const pair = await timon(['pair'], raw);
  assert.equal(pair.code, 2);
  assert.match(pair.stderr, /403/);
  assert.doesNotMatch(pair.stdout, CODE_RE);
  const list = await timon(['list'], raw);
  assert.equal(list.code, 2);
  assert.match(list.stderr, /403/);
  assert.equal(issuedCodes(), 0);
});

test('a bare --user is refused rather than read as « my own account »', async () => {
  const r = await timon(['pair', '--user'], TOKEN);
  assert.equal(r.code, 64);
  assert.equal(issuedCodes(), 0);
});

let deviceId = '';
let deviceToken = '';

test('the operator gets a code for the active superadmin, with the daemon address to type', async () => {
  const r = await timon(['pair'], TOKEN);
  assert.equal(r.code, 0, r.stderr);
  const code = CODE_RE.exec(r.stdout)?.[0];
  assert.ok(code, r.stdout);
  assert.match(r.stdout, /Machine address: https:\/\/srv\.tail1234\.ts\.net:8443\n/);
  const paired = await redeem(code, 'laptop');
  assert.equal(paired.status, 200, JSON.stringify(paired.json));
  assert.equal((paired.json.user as { email: string }).email, 'robin@example.com');
  deviceId = (paired.json.device as { id: string }).id;
  deviceToken = String(paired.json.token);
  // Single use, as from the settings screen.
  assert.equal((await redeem(code, 'again')).status, 401);
});

test('a paired device cannot mint a code for another', async () => {
  const before = issuedCodes();
  const r = await timon(['pair'], deviceToken);
  assert.equal(r.code, 2);
  assert.match(r.stderr, /403/);
  assert.equal(issuedCodes(), before);
});

test('--user issues the code for that account, --json gives the fields', async () => {
  const r = await timon(['pair', '--user', 'bob@example.com', '--json'], TOKEN);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout) as { code: string; user_id: string; expires_at: number; address: string | null };
  assert.equal(out.user_id, bobId);
  assert.equal(out.address, 'https://srv.tail1234.ts.net:8443');
  assert.ok(out.expires_at > Date.now());
  const paired = await redeem(out.code, 'bob laptop');
  assert.equal(paired.status, 200);
  assert.equal((paired.json.user as { email: string }).email, 'bob@example.com');
});

test('an unpublished daemon still gets its code, and the command that publishes it', async () => {
  webUiAccess = { security: { daemon: { port: DAEMON_PORT } }, tailscale: { serve: [] } };
  const r = await timon(['pair'], TOKEN);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, CODE_RE);
  assert.ok(r.stdout.includes(`tailscale serve --bg --https=8443 http://127.0.0.1:${DAEMON_PORT}`), r.stdout);
});

test('list, rename, then revoke: the device is refused on its next request', async () => {
  const list = await timon(['list', '--json'], TOKEN);
  assert.equal(list.code, 0, list.stderr);
  const rows = JSON.parse(list.stdout) as Array<{ id: string; name: string; status: string }>;
  assert.equal(rows.find((d) => d.id === deviceId)?.status, 'active');
  const renamed = await timon(['rename', deviceId, 'work', 'laptop'], TOKEN);
  assert.equal(renamed.code, 0, renamed.stderr);
  assert.equal(devices.getDevice(deviceId)?.name, 'work laptop');
  const revoked = await timon(['revoke', deviceId], TOKEN);
  assert.equal(revoked.code, 0, revoked.stderr);
  const after = await fetch(`${base}/api/devices`, { headers: { authorization: `Bearer ${deviceToken}` } });
  assert.equal(after.status, 401);
});

test('the address is the handler that forwards to THIS daemon, never the web interface', () => {
  const report = {
    security: { daemon: { port: 3000 } },
    tailscale: {
      serve: [
        { host: 'srv.ts.net', target: 'http://127.0.0.1:3100' },
        { host: 'srv.ts.net/docs', target: 'http://127.0.0.1:3000' },
        { host: 'srv.ts.net:443', target: 'http://localhost:3000' },
      ],
    },
  };
  assert.equal(pairingAddress(report), 'https://srv.ts.net');
  assert.equal(pairingAddress({ security: { daemon: { port: 3000 } } }), null);
  assert.equal(pairingAddress(null), null);
  const hint = (platform: string) => pairingText({ code: 'AAAA-BBBB-CCCC', expiresAt: Date.now(), email: null, address: null, daemonPort: 3000, platform });
  assert.ok(hint('linux').includes('  sudo tailscale serve --bg --https=8443 http://127.0.0.1:3000'));
  assert.ok(hint('darwin').includes('  tailscale serve --bg --https=8443 http://127.0.0.1:3000'));
  assert.ok(hint('win32').includes('as administrator'));
  assert.ok(!hint('win32').includes('sudo'));
  assert.ok(pairingText({ code: 'AAAA-BBBB-CCCC', expiresAt: Date.now(), email: null, address: null, daemonPort: undefined })
    .includes('http://127.0.0.1:<daemon port>'));
});
