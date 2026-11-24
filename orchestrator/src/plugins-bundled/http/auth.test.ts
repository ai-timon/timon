/**
 * 4.1 + 4.3: daemon token and auth middleware.
 *
 * No bind on the production :3000: the witness servers listen on
 * `127.0.0.1:0`. The child that checks exit code 2 has `PORT=0` and a
 * throwaway `TIMON_HOME`; it is only `kill`ed if it has a pid, never `0`.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { request as httpRequest } from 'node:http';
import express from 'express';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-daemon-auth-test-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { authIsRequired, createDaemonAuthMiddleware, ensureDaemonToken, DAEMON_TOKEN_FILE } =
  await import('./auth.js');
const { loadConfig, ConfigError, setConfig, resetConfig } = await import('../../config/load.js');
const { ZONES } = await import('../../paths.js');
const { dbApi } = await import('../../db.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { daemonHostPolicy } = await import('../../http-host.js');
type HostPolicy = import('../../http-host.js').HostPolicy;

/** `fetch` will not let a test choose `Host`: a raw request does. */
function requestWithHost(port: number, method: string, path: string, host: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { ...headers, host } }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

const LOOPBACK_POLICY = (): HostPolicy => daemonHostPolicy({
  daemon: { listen: { host: '127.0.0.1' }, behindTlsProxy: false },
  app: { listen: { host: '127.0.0.1' }, publicUrl: 'http://timon.localhost' },
});

function writeConfig(obj: unknown): string {
  const file = join(process.env.TIMON_HOME!, `cfg-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(file, JSON.stringify(obj));
  return file;
}

async function listenApp(app: express.Express): Promise<{ port: number; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr === 'string') throw new Error('unexpected listen address');
  assert.notEqual(addr.port, 3000, 'the witness must not take the production port');
  return {
    port: addr.port,
    close: () => new Promise((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}

function appWithAuth(opts: { token: string; required: boolean; hostPolicy?: () => HostPolicy }): express.Express {
  const app = express();
  app.use(createDaemonAuthMiddleware(opts));
  app.post('/api/auth/setup', (_req, res) => { res.status(201).json({ created: true }); });
  app.use(express.json({ limit: '25mb' }));
  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/health/resources', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/stats', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/stream', (_req, res) => { res.json({ ok: true }); });
  app.get('/api/missions/:id/stream', (_req, res) => { res.json({ ok: true }); });
  return app;
}

test('missing file: 64-hex token, mode 0600, under TIMON_HOME', () => {
  const token = ensureDaemonToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.equal(readFileSync(DAEMON_TOKEN_FILE, 'utf8').trim(), token);
  // Windows reports 0o666 for any writable file: owner-only there is an ACL, not mode bits.
  if (process.platform !== 'win32') assert.equal(statSync(DAEMON_TOKEN_FILE).mode & 0o777, 0o600);
  assert.equal(DAEMON_TOKEN_FILE, join(process.env.TIMON_HOME!, 'daemon-token'));
  assert.ok(ZONES.secrets.includes('daemon-token'));
});

test('file already there: the existing token is kept', () => {
  const dir = mkdtempSync(join(tmpdir(), 'timon-daemon-token-reuse-'));
  const file = join(dir, 'daemon-token');
  writeFileSync(file, 'jeton-impose-par-l-operateur\n', { mode: 0o600 });
  assert.equal(ensureDaemonToken(file), 'jeton-impose-par-l-operateur');
  assert.equal(readFileSync(file, 'utf8').trim(), 'jeton-impose-par-l-operateur');
});

test('authIsRequired: auto + 0.0.0.0 = yes; auto + 127.0.0.1 = no; required = yes', () => {
  const at = (auth: 'auto' | 'required' | 'off', host: string, appHost = '127.0.0.1', behindTlsProxy = false) =>
    authIsRequired({ daemon: { auth, listen: { host }, behindTlsProxy }, app: { listen: { host: appHost } } });
  assert.equal(at('auto', '0.0.0.0'), true);
  assert.equal(at('auto', '127.0.0.1'), false);
  assert.equal(at('required', '127.0.0.1'), true);
  assert.equal(at('off', '127.0.0.1'), false);
  assert.equal(at('off', '127.0.0.1', '0.0.0.0'), true);
  // TODO #346: the Next proxy and a TLS reverse proxy reach a loopback daemon
  // on behalf of remote visitors.
  assert.equal(at('auto', '127.0.0.1', '0.0.0.0'), true);
  assert.equal(at('auto', '127.0.0.1', '10.0.0.5'), true);
  assert.equal(at('auto', '127.0.0.1', '127.0.0.1', true), true);
  assert.equal(at('auto', '127.0.0.1', 'localhost'), false);
});

test('WebUI exposed, daemon on loopback: an anonymous caller is refused even before the first account', async () => {
  const cfg = loadConfig(writeConfig({
    daemon: { listen: { host: '127.0.0.1' }, auth: 'auto' },
    app: { listen: { host: '0.0.0.0' } },
  }));
  const token = ensureDaemonToken();
  const { port, close } = await listenApp(appWithAuth({ token, required: authIsRequired(cfg) }));
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/api/stats`)).status, 401);
    assert.equal((await fetch(`${base}/api/stats`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
    assert.equal((await fetch(`${base}/api/health`)).status, 200);
  } finally {
    await close();
  }
});

test('listen 0.0.0.0: no token = 401, with Bearer = 200, health public', async () => {
  const cfg = loadConfig(writeConfig({ daemon: { listen: { host: '0.0.0.0' }, auth: 'auto' } }));
  const token = ensureDaemonToken();
  const { port, close } = await listenApp(appWithAuth({ token, required: authIsRequired(cfg) }));
  try {
    const base = `http://127.0.0.1:${port}`;

    const noTok = await fetch(`${base}/api/stats`);
    assert.equal(noTok.status, 401);
    assert.deepEqual(await noTok.json(), { error: 'unauthorized' });

    const withTok = await fetch(`${base}/api/stats`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(withTok.status, 200);
    assert.deepEqual(await withTok.json(), { ok: true });

    const viaQuery = await fetch(`${base}/api/stats?token=${encodeURIComponent(token)}`);
    assert.equal(viaQuery.status, 401, '?token= must not authenticate outside SSE');

    const wrong = await fetch(`${base}/api/stats`, {
      headers: { authorization: 'Bearer deadbeef' },
    });
    assert.equal(wrong.status, 401);

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true });

    const resources = await fetch(`${base}/api/health/resources`);
    assert.equal(resources.status, 401);
  } finally {
    await close();
  }
});

test('auth auto + 127.0.0.1: no token required while the users table is empty', async () => {
  const cfg = loadConfig(writeConfig({ daemon: { listen: { host: '127.0.0.1' }, auth: 'auto' } }));
  const token = ensureDaemonToken();
  const { port, close } = await listenApp(appWithAuth({ token, required: authIsRequired(cfg) }));
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/stats`);
    assert.equal(r.status, 200);
  } finally {
    await close();
  }
});

test('first run on the loopback: a foreign Host is refused, account creation included', async () => {
  const { dbApi } = await import('../../db.js');
  assert.equal(dbApi.countUsers(), 0);
  const token = ensureDaemonToken();
  const { port, close } = await listenApp(appWithAuth({ token, required: false, hostPolicy: LOOPBACK_POLICY }));
  try {
    const evil = `evil.example:${port}`;
    assert.equal(await requestWithHost(port, 'POST', '/api/auth/setup', evil), 421);
    assert.equal(await requestWithHost(port, 'GET', '/api/stats', evil), 421);
    assert.equal(await requestWithHost(port, 'GET', '/api/health', evil), 421);
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      assert.equal(await requestWithHost(port, 'POST', '/api/auth/setup', host), 201, host);
      assert.equal(await requestWithHost(port, 'GET', '/api/stats', host), 200, host);
    }
    // A bearer credential is its own proof: the CLI behind any name keeps working.
    assert.equal(await requestWithHost(port, 'GET', '/api/stats', evil, { authorization: `Bearer ${token}` }), 200);
    assert.equal(await requestWithHost(port, 'GET', '/api/stats', evil, { authorization: 'Bearer deadbeef' }), 421);
  } finally {
    await close();
  }
});

test('first run behind a TLS proxy or an exposed listener: the configured public name is served', async () => {
  const token = ensureDaemonToken();
  const proxied = (): HostPolicy => daemonHostPolicy({
    daemon: { listen: { host: '127.0.0.1' }, behindTlsProxy: true },
    app: { listen: { host: '127.0.0.1' }, publicUrl: 'https://timon.example.com' },
  });
  const named = (): HostPolicy => daemonHostPolicy({
    daemon: { listen: { host: '127.0.0.1' }, behindTlsProxy: false },
    app: { listen: { host: '127.0.0.1' }, publicUrl: 'https://timon.example.com' },
  });
  for (const hostPolicy of [proxied, named]) {
    const { port, close } = await listenApp(appWithAuth({ token, required: true, hostPolicy }));
    try {
      assert.equal(await requestWithHost(port, 'GET', '/api/health', 'timon.example.com'), 200);
      // Still behind the account: a served name opens nothing by itself.
      assert.equal(await requestWithHost(port, 'GET', '/api/stats', 'timon.example.com'), 401);
    } finally {
      await close();
    }
  }
});

test('the daemon reads its policy from the config: a loopback listener refuses a foreign Host', async () => {
  setConfig(loadConfig(writeConfig({ daemon: { listen: { host: '127.0.0.1' }, auth: 'auto' } })));
  const token = ensureDaemonToken();
  const { port, close } = await listenApp(appWithAuth({ token, required: false }));
  try {
    assert.equal(await requestWithHost(port, 'GET', '/api/health', `evil.example:${port}`), 421);
    assert.equal(await requestWithHost(port, 'GET', '/api/health', 'timon.localhost'), 200);
  } finally {
    await close();
    resetConfig();
  }
});

test('loopback with users: anonymous is 401, daemon-token Bearer still works, health stays public', async () => {
  const { dbApi } = await import('../../db.js');
  const { hashPassword } = await import('../../users/password.js');
  assert.equal(dbApi.countUsers(), 0);
  createTestAccount(dbApi, {
    email: 'admin@example.com',
    name: 'Admin',
    passwordHash: await hashPassword('admin-secret'),
    isSuperadmin: true,
  });
  const token = ensureDaemonToken();
  const { port, close } = await listenApp(appWithAuth({ token, required: false }));
  try {
    const base = `http://127.0.0.1:${port}`;

    const noTok = await fetch(`${base}/api/stats`);
    assert.equal(noTok.status, 401);
    assert.deepEqual(await noTok.json(), { error: 'unauthorized' });

    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);

    assert.equal(await requestWithHost(port, 'GET', '/api/stats', `localhost:${port}`), 401);
    assert.equal(await requestWithHost(port, 'GET', '/api/stats', `evil.example:${port}`), 421);

    // CLI / operator still send this header (`TIMON_API_TOKEN` = daemon-token).
    const agent = await fetch(`${base}/api/stats`, {
      headers: { authorization: `Bearer ${token}` },
    });
    assert.equal(agent.status, 200);
  } finally {
    await close();
  }
});

// `setsid` is a util-linux command: macOS and Windows have none, so the half of
// these tests that boots a real daemon runs on Linux only. The config checks
// before it still run everywhere.
const CAN_BOOT_IN_OWN_SESSION = process.platform === 'linux';

/** Boots a real daemon on a throwaway home and returns its exit code and stderr. */
async function bootWith(userConfig: unknown): Promise<{ code: number | null; stderr: string }> {
  const home = mkdtempSync(join(tmpdir(), 'timon-auth-off-boot-'));
  writeFileSync(join(home, 'timon.config.json'), JSON.stringify(userConfig));

  const bootTs = fileURLToPath(new URL('../../boot.ts', import.meta.url));
  const orchDir = fileURLToPath(new URL('../../../', import.meta.url));
  const child = spawn('setsid', [process.execPath, '--import', 'tsx', bootTs], {
    cwd: orchDir,
    env: {
      ...process.env,
      TIMON_HOME: home,
      TIMON_RESOURCE_GUARD_ENABLED: '0',
      PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const pid = child.pid;
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer | string) => { stderr += String(chunk); });
  let stdout = '';
  child.stdout.on('data', (chunk: Buffer | string) => { stdout += String(chunk); });

  // Only a boot that never returns trips this: compiling the whole daemon through tsx took more than 25 s on a
  // loaded machine (TODO #605). Under the runner's 120 s per-test limit, so the failure still says why.
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    if (typeof pid === 'number' && pid > 0) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* already dead */ }
    }
  }, 90_000);

  const [code] = await once(child, 'exit') as [number | null, NodeJS.Signals | null];
  clearTimeout(timer);

  assert.equal(timedOut, false, `the boot did not return: stdout=${stdout} stderr=${stderr}`);
  return { code, stderr };
}

test('auth off + 0.0.0.0: loadConfig refuses, the daemon exits with code 2', async (t) => {
  assert.throws(
    () => loadConfig(writeConfig({ daemon: { listen: { host: '0.0.0.0' }, auth: 'off' } })),
    (e: unknown) => e instanceof ConfigError
      && /auth disabled on a non-loopback interface/.test((e as Error).message),
  );

  if (!CAN_BOOT_IN_OWN_SESSION) { t.diagnostic('daemon boot skipped: no setsid on this system'); return; }
  const { code, stderr } = await bootWith({ daemon: { listen: { host: '0.0.0.0' }, auth: 'off' } });
  assert.equal(code, 2, `code=${code} stderr=${stderr}`);
  assert.match(stderr, /auth disabled on a non-loopback interface/);
});

// TODO #528: a loopback daemon behind an exposed WebUI or a TLS proxy is
// reached on behalf of remote visitors; `off` would hand them the whole API.
test('auth off + exposed WebUI or TLS proxy: loadConfig refuses, the daemon exits with code 2', async (t) => {
  for (const appHost of ['0.0.0.0', '10.0.0.5', '::']) {
    assert.throws(
      () => loadConfig(writeConfig({
        daemon: { listen: { host: '127.0.0.1' }, auth: 'off' },
        app: { listen: { host: appHost } },
      })),
      (e: unknown) => e instanceof ConfigError
        && /web interface listens beyond the loopback/.test((e as Error).message),
      appHost,
    );
  }
  assert.throws(
    () => loadConfig(writeConfig({ daemon: { listen: { host: '127.0.0.1' }, auth: 'off', behindTlsProxy: true } })),
    (e: unknown) => e instanceof ConfigError && /behindTlsProxy/.test((e as Error).message),
  );
  // Loopback everywhere: `off` stays the operator's call.
  for (const appHost of ['127.0.0.1', 'localhost', '::1']) {
    const ok = loadConfig(writeConfig({ daemon: { auth: 'off' }, app: { listen: { host: appHost } } }));
    assert.equal(ok.daemon.auth, 'off');
  }

  if (!CAN_BOOT_IN_OWN_SESSION) { t.diagnostic('daemon boot skipped: no setsid on this system'); return; }
  const { code, stderr } = await bootWith({
    daemon: { listen: { host: '127.0.0.1' }, auth: 'off' },
    app: { listen: { host: '0.0.0.0' } },
  });
  assert.equal(code, 2, `code=${code} stderr=${stderr}`);
  assert.match(stderr, /web interface listens beyond the loopback/);
});

test('auth off forced in memory (without loadConfig) + exposed WebUI: an anonymous caller stays refused', async () => {
  const off = (appHost: string, behindTlsProxy = false) => authIsRequired({
    daemon: { auth: 'off', listen: { host: '127.0.0.1' }, behindTlsProxy },
    app: { listen: { host: appHost } },
  });
  assert.equal(off('0.0.0.0'), true);
  assert.equal(off('127.0.0.1', true), true);
  assert.equal(authIsRequired({
    daemon: { auth: 'off', listen: { host: '0.0.0.0' }, behindTlsProxy: false },
    app: { listen: { host: '127.0.0.1' } },
  }), true);

  const token = ensureDaemonToken();
  const { port, close } = await listenApp(appWithAuth({ token, required: off('0.0.0.0') }));
  try {
    const base = `http://127.0.0.1:${port}`;
    assert.equal((await fetch(`${base}/api/stats`)).status, 401);
    assert.equal((await fetch(`${base}/api/stats`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  } finally {
    await close();
  }
});

test('?token= is read nowhere: the daemon-token and a mission token in the address get 401, the same token as a Bearer passes', async () => {
  const cfg = loadConfig(writeConfig({ daemon: { listen: { host: '0.0.0.0' }, auth: 'auto' } }));
  const token = ensureDaemonToken();
  const missionId = randomUUID();
  dbApi.createMission(missionId, 'witness', 'work');
  const missionToken = issueMissionApiToken(missionId);
  const { port, close } = await listenApp(appWithAuth({ token, required: authIsRequired(cfg) }));
  try {
    const base = `http://127.0.0.1:${port}`;
    for (const [label, secret] of [['daemon-token', token], ['mission token', missionToken]] as const) {
      const q = `token=${encodeURIComponent(secret)}`;
      for (const path of ['/api/stream', '/api/missions/m1/stream', '/api/stats']) {
        assert.equal((await fetch(`${base}${path}?${q}`)).status, 401, `${label} in the address of ${path}`);
        const bearer = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${secret}` } });
        assert.equal(bearer.status, 200, `${label} as a Bearer on ${path}`);
      }
    }
  } finally {
    await close();
  }
});
