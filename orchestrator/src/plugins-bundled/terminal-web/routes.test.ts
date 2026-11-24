/**
 * Web terminal access control. A web terminal is a shell on the host: the
 * refusals matter more than the happy path. Anonymous, daemon-token, a user
 * without `terminal:open`, the setting off, a cross-site WebSocket — all
 * refused, and nobody reaches another user's session.
 */
import { createTestAccount, grantTestPermissions } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { WebSocket } from 'ws';

await import('../../../tests/helpers/paid-license.js');
delete process.env.TIMON_TERMINAL_WEB_ENABLED;

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes, createUpgradeHandler, matchTerminalWsPath } = await import('./routes.js');
const { upgradeAuth } = await import('./access.js');
const { createHttpPlugin } = await import('../../kernel/http-service.js');
const { Context } = await import('@deepseek-ai/cordis');
const { TerminalSessions } = await import('../../terminal-host/sessions.js');
const { localStore } = await import('./store.js');
const { dbApi } = await import('../../db.js');
const { hashSessionToken } = await import('../../users/session.js');
const { setSetting } = await import('../../settings.js');
const { createProject } = await import('../../projects.js');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const TOKEN = 'terminal-web-test';
const written: string[] = [];
let emit: (data: string) => void = () => {};
const inProcess = new TerminalSessions({
  idleMs: () => 60_000,
  spawn: () => ({
    pid: 1,
    onData: (l) => { emit = l; },
    onExit: () => {},
    write: (d) => { written.push(d); },
    resize: () => {},
    kill: () => {},
  }),
});
const sessions = localStore(inProcess);

function makeUser(email: string, isSuperadmin: boolean, permissions: string[] = []): string {
  const user = createTestAccount(dbApi, { email, name: email, passwordHash: 'x', isSuperadmin });
  if (permissions.length) {
    grantTestPermissions(dbApi, user.id, permissions);
  }
  const raw = `cookie-${email}`;
  dbApi.createSession({ tokenHash: hashSessionToken(raw), userId: user.id, expiresAt: Date.now() + 3_600_000 });
  return `timon_session=${raw}`;
}

const admin = makeUser('admin@example.com', true);
const plain = makeUser('plain@example.com', false, ['missions:read']);
const granted = makeUser('granted@example.com', false, ['terminal:open']);

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app, sessions);
const upgrade = createUpgradeHandler(sessions);
// Through the kernel, as in the daemon: it resolves the identity the route receives.
const kernel = new Context();
await kernel.plugin(createHttpPlugin(app, { upgradeAuth }));
kernel.http.upgrade(upgrade);
const server = createServer(app);
server.on('upgrade', (req, socket, head) => kernel.http.handleUpgrade(req, socket, head, () => ({ open: true })));
server.listen(0, '127.0.0.1');
await once(server, 'listening');
test.after(() => { upgrade.close(); inProcess.disposeAll(); server.closeAllConnections(); server.close(); });
const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
const origin = `http://${host}`;

async function create(cookie: string): Promise<Response> {
  return fetch(`${origin}/api/terminal/web/sessions`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json', origin },
    body: JSON.stringify({ cols: 100, rows: 30 }),
  });
}

/**
 * Resolves with the handshake status: 101 when the socket opened. Messages
 * are buffered from the start: the replayed scrollback can arrive in the same
 * chunk as the handshake, before an `await` resumes.
 */
function connect(id: string, headers: Record<string, string>): Promise<{ status: number; ws?: WebSocket; messages: string[] }> {
  return new Promise((resolve) => {
    const messages: string[] = [];
    const ws = new WebSocket(`ws://${host}/api/terminal/web/sessions/${id}/ws`, { headers });
    ws.on('message', (m) => messages.push(m.toString()));
    ws.on('open', () => resolve({ status: 101, ws, messages }));
    ws.on('unexpected-response', (req, res) => { req.destroy(); resolve({ status: res.statusCode ?? 0, messages }); });
    ws.on('error', () => resolve({ status: 0, messages }));
  });
}

test.describe('terminal-web access', { concurrency: false }, () => {
  test('the stream path only matches a UUID', () => {
    assert.equal(matchTerminalWsPath('/api/terminal/web/sessions/../../x/ws'), null);
    assert.equal(matchTerminalWsPath('/api/terminal/web/sessions/0f8fad5b-d9cb-469f-a165-70867728950e/ws'), '0f8fad5b-d9cb-469f-a165-70867728950e');
  });

  test('anonymous is refused everywhere', async () => {
    assert.equal((await fetch(`${origin}/api/terminal/web`)).status, 401);
    assert.equal((await create('')).status, 401);
  });

  test('the daemon-token never opens a shell (human sessions only)', async () => {
    const res = await fetch(`${origin}/api/terminal/web/sessions`, {
      method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: '{}',
    });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'the terminal opens from a signed-in browser', code: 'terminal_session_required' });
  });

  test('a user without terminal:open is refused, and told why', async () => {
    assert.equal((await create(plain)).status, 403);
    const status = await (await fetch(`${origin}/api/terminal/web`, { headers: { cookie: plain } })).json();
    assert.deepEqual(status, { enabled: false, reason: 'forbidden', sessions: [] });
  });

  test('naming a project scope opens nothing for a caller without the right', async () => {
    for (const cookie of ['', plain]) {
      const res = await fetch(`${origin}/api/terminal/web/sessions`, {
        method: 'POST',
        headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json', origin },
        body: JSON.stringify({ scope: { kind: 'project', slug: 'globex' } }),
      });
      assert.equal(res.status, cookie ? 403 : 401);
    }
    assert.deepEqual(inProcess.list(dbApi.getUserByEmail('plain@example.com')!.id), []);
  });

  test('a cwd unknown to Timon is refused', async () => {
    const res = await fetch(`${origin}/api/terminal/web/sessions`, {
      method: 'POST', headers: { cookie: admin, 'content-type': 'application/json', origin }, body: JSON.stringify({ cwd: '/etc' }),
    });
    assert.equal(res.status, 400);
  });

  test('a scoped shell starts in its project folder, and carries its scope', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'globex-'));
    createProject('globex', { cwd: dir });
    const post = (body: object) => fetch(`${origin}/api/terminal/web/sessions`, {
      method: 'POST', headers: { cookie: admin, 'content-type': 'application/json', origin }, body: JSON.stringify(body),
    });
    const res = await post({ scope: { kind: 'project', slug: 'globex' } });
    assert.equal(res.status, 201);
    const { session } = await res.json() as { session: { id: string; cwd: string; scope: string } };
    assert.equal(session.cwd, dir);
    assert.equal(session.scope, 'project:globex');
    const unknown = await (await post({ scope: { kind: 'agent', name: 'nobody' } })).json() as { session: { cwd: string; scope: string } };
    assert.equal(unknown.session.scope, 'agent:nobody', 'an unknown agent still scopes the shell');
    assert.notEqual(unknown.session.cwd, dir, 'and starts it in the home folder');
    assert.equal((await post({ scope: { kind: 'project', slug: '../etc' } })).status, 400);
    for (const s of inProcess.list(dbApi.getUserByEmail('admin@example.com')!.id)) {
      inProcess.kill(dbApi.getUserByEmail('admin@example.com')!.id, s.id);
    }
  });

  test('the setting off refuses creation', async (t) => {
    setSetting('TIMON_TERMINAL_WEB_ENABLED', 'false');
    t.after(() => setSetting('TIMON_TERMINAL_WEB_ENABLED', 'true'));
    const res = await create(admin);
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'the web terminal is turned off', code: 'terminal_disabled' });
  });

  test('WebSocket: owner on the same origin streams; every other caller is refused', { timeout: 8000 }, async () => {
    const res = await create(granted);
    assert.equal(res.status, 201);
    const { session } = await res.json() as { session: { id: string } };
    emit('prompt$ ');

    assert.equal((await connect(session.id, { origin })).status, 401, 'no cookie');
    assert.equal((await connect(session.id, { cookie: granted, origin: 'https://evil.example' })).status, 403, 'cross-site');
    assert.equal((await connect(session.id, { cookie: granted })).status, 403, 'no Origin');
    assert.equal((await connect(session.id, { cookie: plain, origin })).status, 403, 'no permission');
    assert.equal((await connect(session.id, { cookie: admin, origin })).status, 404, "even a superadmin cannot attach to another user's shell");

    // Docker app behind `tailscale serve`: the daemon is reached as
    // host.docker.internal, the browser was on the tailnet name, which the
    // proxies carry in X-Forwarded-Host.
    const tailnet = await connect(session.id, {
      cookie: granted,
      origin: 'https://pc.tailnet.ts.net',
      host: 'host.docker.internal:3001',
      'x-forwarded-host': 'pc.tailnet.ts.net',
    });
    assert.equal(tailnet.status, 101, 'PWA through tailscale serve and the Docker app');
    tailnet.ws!.close();
    assert.equal((await connect(session.id, {
      cookie: granted, origin: 'https://evil.example', 'x-forwarded-host': 'pc.tailnet.ts.net',
    })).status, 403, 'a foreign Origin is refused whatever the forwarded host');

    const ok = await connect(session.id, { cookie: granted, origin });
    assert.equal(ok.status, 101);
    const ws = ok.ws!;
    while (ok.messages.length === 0) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(JSON.parse(ok.messages[0]!), { type: 'output', data: 'prompt$ ' });
    ws.send(JSON.stringify({ type: 'input', data: 'whoami\r' }));
    ws.send('not json');
    ws.send(JSON.stringify({ type: 'unknown' }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(written, ['whoami\r']);

    const list = await (await fetch(`${origin}/api/terminal/web`, { headers: { cookie: granted } })).json() as { sessions: Array<{ id: string; clients: number }>; persistence: unknown };
    assert.equal(list.sessions.length, 1);
    assert.deepEqual(list.persistence, { mode: 'in-process', reason: 'no_detached_launch' }, 'the status says whether shells survive a restart');
    assert.equal(list.sessions[0]!.clients, 1);

    const killedByOther = await fetch(`${origin}/api/terminal/web/sessions/${session.id}`, { method: 'DELETE', headers: { cookie: admin, origin } });
    assert.equal(killedByOther.status, 404);
    const closed = once(ws, 'close');
    const killed = await fetch(`${origin}/api/terminal/web/sessions/${session.id}`, { method: 'DELETE', headers: { cookie: granted, origin } });
    assert.equal(killed.status, 200);
    await closed;
  });

  test('WebSocket: a shell a paired device opened closes when the device is revoked', { timeout: 8000 }, async () => {
    const devices = await import('../../users/devices.js');
    const { deviceConnectionCount } = await import('../../users/device-connections.js');
    const owner = dbApi.getUserByEmail('granted@example.com')!;
    const { code } = devices.issuePairingCode(owner.id);
    const paired = devices.redeemPairingCode({ code, name: 'Relay', ip: null, userAgent: null });
    assert.equal(paired.kind, 'ok');
    if (paired.kind !== 'ok') return;
    const res = await create(granted);
    const { session } = await res.json() as { session: { id: string } };

    const open = await connect(session.id, { authorization: `Bearer ${paired.token}`, origin });
    assert.equal(open.status, 101, 'a live device opens the shell');
    assert.equal(deviceConnectionCount(paired.device.id), 1);
    const closed = once(open.ws!, 'close') as Promise<[number, Buffer]>;
    devices.revokeDevice(paired.device.id);
    const [code1008, reason] = await closed;
    assert.equal(code1008, 1008);
    assert.equal(reason.toString(), 'device revoked');
    assert.equal(deviceConnectionCount(paired.device.id), 0);
    assert.equal((await connect(session.id, { authorization: `Bearer ${paired.token}`, origin })).status, 401, 'and cannot open it again');
    await fetch(`${origin}/api/terminal/web/sessions/${session.id}`, { method: 'DELETE', headers: { cookie: granted, origin } });
  });
});
