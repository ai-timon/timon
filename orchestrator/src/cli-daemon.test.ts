/**
 * 4.2b — CLI `timon --daemon` / `timon daemon add` et Bearer du MCP.
 *
 * Témoin HTTP sur `127.0.0.1:0`, jamais le :3000 de prod. Chaque test pose
 * son propre TIMON_HOME. On ne `kill` un child que s'il a un pid, jamais `0`.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcess } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PACKAGED_DAEMON_PORT, isLocalDaemonUrl, resolveApiUrl } from '../bin/cli-api.mjs';
import { PACKAGED_PORTS } from './host/service-environment.js';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-cli-daemon-test-'));
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const TIMON = fileURLToPath(new URL('../bin/timon', import.meta.url));
const MCP = fileURLToPath(new URL('../bin/timon-mcp.mjs', import.meta.url));

type Seen = { url: string; auth: string | undefined; method: string };

function freshHome(): string {
  return mkdtempSync(join(tmpdir(), 'timon-cli-daemon-home-'));
}

function baseEnv(home: string, from: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...from, TIMON_HOME: home, TIMON_RESOURCE_GUARD_ENABLED: '0' };
  // Both set (a terminal that forces colour, a runner that refuses it), Node
  // warns on stderr at startup, and the checks below read stderr as empty.
  delete env.FORCE_COLOR;
  delete env.NO_COLOR;
  delete env.TIMON_API_TOKEN;
  // An operator terminal: a mission running this suite must not leak its own id
  // in, or the CLI would (rightly) refuse the daemon-token file.
  delete env.TIMON_MISSION_ID;
  delete env.TIMON_API;
  delete env.TIMON_ORCH_URL;
  return env;
}

function runTimon(args: string[], env: NodeJS.ProcessEnv): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TIMON, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer | string) => { stdout += String(c); });
    child.stderr.on('data', (c: Buffer | string) => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function startMock(host = '127.0.0.1'): Promise<{
  url: string;
  seen: Seen[];
  close: () => Promise<void>;
}> {
  return new Promise((resolve, reject) => {
    const seen: Seen[] = [];
    const server = http.createServer((req, res) => {
      seen.push({
        url: req.url ?? '',
        auth: req.headers.authorization,
        method: req.method ?? '',
      });
      res.writeHead(200, { 'content-type': 'application/json' });
      if ((req.url ?? '').startsWith('/api/tasks')) {
        res.end(JSON.stringify({ tasks: [{ id: 't1', title: 'ok' }] }));
        return;
      }
      if ((req.url ?? '').startsWith('/api/agents')) {
        res.end(JSON.stringify({ agents: [] }));
        return;
      }
      res.end(JSON.stringify({ ok: true }));
    });
    server.on('error', reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('adresse d\'écoute inattendue'));
        return;
      }
      assert.notEqual(addr.port, 3000, 'le témoin ne doit pas prendre le port de prod');
      resolve({
        url: `http://${host}:${addr.port}`,
        seen,
        close: () => new Promise((resClose, rejClose) => {
          server.close((err) => err ? rejClose(err) : resClose());
        }),
      });
    });
  });
}

function killChild(child: ChildProcess): void {
  if (child.pid) child.kill('SIGTERM');
}

test('API resolution respects overrides, config, bootstrap and legacy fallback', () => {
  const home = freshHome();
  assert.equal(resolveApiUrl(home), 'http://localhost:3000');
  writeFileSync(join(home, 'desktop-bootstrap.json'), JSON.stringify({ daemonPort: 3010, appPort: 3110 }));
  assert.equal(resolveApiUrl(home), 'http://127.0.0.1:3010');
  writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ daemon: { listen: { host: 'localhost', port: 3001 } } }));
  assert.equal(resolveApiUrl(home), 'http://localhost:3001');
  assert.equal(resolveApiUrl(home, '', 'https://profile.example'), 'https://profile.example');
  assert.equal(resolveApiUrl(home, 'https://env.example', 'https://profile.example'), 'https://profile.example');
  assert.equal(resolveApiUrl(home, 'https://env.example'), 'https://env.example');
  assert.equal(resolveApiUrl(freshHome()), 'http://localhost:3000');
});

test('a packaged CLI without config or bootstrap reaches the port its service was given', () => {
  // A server installed from a terminal: `timon service install` gave the
  // service the first-launch port, and no desktop ever wrote a bootstrap.
  assert.equal(PACKAGED_DAEMON_PORT, PACKAGED_PORTS.daemon);
  const home = freshHome();
  assert.equal(resolveApiUrl(home, undefined, undefined, { packaged: true }), `http://127.0.0.1:${PACKAGED_PORTS.daemon}`);
  assert.equal(resolveApiUrl(home), 'http://localhost:3000', 'a source checkout keeps the schema default');
  writeFileSync(join(home, 'desktop-bootstrap.json'), JSON.stringify({ daemonPort: 3020, appPort: 3120 }));
  assert.equal(resolveApiUrl(home, undefined, undefined, { packaged: true }), 'http://127.0.0.1:3020');
  const configured = freshHome();
  // Once a config file exists the service no longer gets first-launch ports.
  writeFileSync(join(configured, 'timon.config.json'), JSON.stringify({ edition: 'expert' }));
  assert.equal(resolveApiUrl(configured, undefined, undefined, { packaged: true }), 'http://localhost:3000');
  assert.equal(resolveApiUrl(home, 'https://env.example', undefined, { packaged: true }), 'https://env.example');
  // The daemon token follows: the packaged port is this machine's daemon.
  const fresh = freshHome();
  assert.equal(isLocalDaemonUrl(fresh, `http://127.0.0.1:${PACKAGED_PORTS.daemon}`, { packaged: true }), true);
  assert.equal(isLocalDaemonUrl(fresh, `http://127.0.0.1:${PACKAGED_PORTS.daemon}`), false);
});

test('API resolution silently skips malformed files and invalid ports', () => {
  const home = freshHome();
  for (const raw of ['{', 'null', '[]', '"text"', '{}']) {
    writeFileSync(join(home, 'timon.config.json'), raw);
    writeFileSync(join(home, 'desktop-bootstrap.json'), raw);
    assert.equal(resolveApiUrl(home), 'http://localhost:3000');
  }
  for (const port of [0, -1, 1024, 65536, 3010.5, '3010', null]) {
    writeFileSync(join(home, 'desktop-bootstrap.json'), JSON.stringify({ daemonPort: port }));
    assert.equal(resolveApiUrl(home), 'http://localhost:3000');
  }
  writeFileSync(join(home, 'desktop-bootstrap.json'), '{"daemonPort":3010}');
  for (const listen of [[], 'bad', { port: 65536 }, { port: '3001' }, { host: 'bad/path', port: 3001 }]) {
    writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ daemon: { listen } }));
    assert.equal(resolveApiUrl(home), 'http://127.0.0.1:3010');
  }
  writeFileSync(join(home, 'timon.config.json'), '{');
  assert.equal(resolveApiUrl(home), 'http://127.0.0.1:3010');
});

test('API resolution normalizes wildcard hosts and formats IPv6', () => {
  const home = freshHome();
  for (const [host, expected] of [
    ['0.0.0.0', '127.0.0.1'], ['::', '127.0.0.1'], ['::1', '[::1]'],
    ['[::1]', '[::1]'], ['daemon.example', 'daemon.example'],
  ]) {
    writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ daemon: { listen: { host, port: 3002 } } }));
    assert.equal(resolveApiUrl(home), `http://${expected}:3002`);
  }
  writeFileSync(join(home, 'timon.config.json'), '{"daemon":{"listen":{"port":3001}}}');
  assert.equal(resolveApiUrl(home), 'http://127.0.0.1:3001');
});

test('the CLI\'s stderr stays empty under an environment that sets both FORCE_COLOR and NO_COLOR', async () => {
  const home = freshHome();
  const mock = await startMock();
  try {
    writeFileSync(join(home, 'desktop-bootstrap.json'), JSON.stringify({ daemonPort: Number(new URL(mock.url).port) }));
    const r = await runTimon(['list'], baseEnv(home, { ...process.env, FORCE_COLOR: '1', NO_COLOR: '1' }));
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stderr, '');
  } finally {
    await mock.close();
  }
});

test('real CLI discovers local targets and keeps explicit daemon URLs and tokens ahead of the environment', async () => {
  const home = freshHome();
  const mock = await startMock();
  const envTarget = await startMock();
  try {
    const port = Number(new URL(mock.url).port);
    writeFileSync(join(home, 'desktop-bootstrap.json'), JSON.stringify({ daemonPort: port }));
    const bootstrap = await runTimon(['list'], baseEnv(home));
    assert.equal(bootstrap.code, 0, bootstrap.stderr);
    assert.equal(bootstrap.stderr, '');
    writeFileSync(join(home, 'desktop-bootstrap.json'), '{"daemonPort":1}');
    writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ daemon: { listen: { host: '::', port } } }));
    const config = await runTimon(['list'], baseEnv(home));
    assert.equal(config.code, 0, config.stderr);
    writeFileSync(join(home, 'timon.config.json'), '{"daemon":{"listen":{"port":1}}}');
    writeFileSync(join(home, 'cli-daemons.json'), JSON.stringify({ local: { url: mock.url, token: 'profile-token' } }));
    const profile = await runTimon(['--daemon', 'local', 'list'], baseEnv(home));
    assert.equal(profile.code, 0, profile.stderr);
    const env = { ...baseEnv(home), TIMON_API: envTarget.url, TIMON_API_TOKEN: 'env-token' };
    const override = await runTimon(['--daemon', 'local', 'list'], env);
    assert.equal(override.code, 0, override.stderr);
    assert.equal(mock.seen[3]?.auth, 'Bearer profile-token');
    const explicit = await runTimon(['--daemon', mock.url, 'list'], env);
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.equal(mock.seen[4]?.auth, 'Bearer env-token');
    assert.equal(envTarget.seen.length, 0, 'Explicit targets must not send requests or tokens to TIMON_API');
    const withoutFlag = await runTimon(['list'], env);
    assert.equal(withoutFlag.code, 0, withoutFlag.stderr);
    assert.equal(envTarget.seen.length, 1);
    assert.equal(envTarget.seen[0]?.auth, 'Bearer env-token');
    assert.equal(mock.seen.length, 5);
  } finally {
    await Promise.all([mock.close(), envTarget.close()]);
  }
});

test('daemon add : fichier 0600 sous TIMON_HOME, stdout sans le token', async () => {
  const home = freshHome();
  const r = await runTimon(
    ['daemon', 'add', 'vps', 'https://timon.example.ts.net/', 's3cr3t-token'],
    baseEnv(home),
  );
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /daemon 'vps' registered/);
  assert.doesNotMatch(r.stdout, /s3cr3t-token/);
  assert.doesNotMatch(r.stderr, /s3cr3t-token/);

  const file = join(home, 'cli-daemons.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    vps: { url: string; token: string };
  };
  assert.equal(parsed.vps.url, 'https://timon.example.ts.net');
  assert.equal(parsed.vps.token, 's3cr3t-token');
  assert.equal(statSync(file).mode & 0o777, 0o600);

  const listed = await runTimon(['daemon', 'list'], baseEnv(home));
  assert.equal(listed.code, 0, listed.stderr);
  assert.match(listed.stdout, /vps\s+https:\/\/timon\.example\.ts\.net/);
  assert.doesNotMatch(listed.stdout, /s3cr3t-token/);
});

test('daemon add refuse un nom traversal, une url sans schéma, un token vide', async () => {
  const home = freshHome();
  const env = baseEnv(home);

  const badName = await runTimon(
    ['daemon', 'add', '../x', 'http://127.0.0.1:9', 'tok'],
    env,
  );
  assert.equal(badName.code, 64);

  const dots = await runTimon(
    ['daemon', 'add', '..', 'http://127.0.0.1:9', 'tok'],
    env,
  );
  assert.equal(dots.code, 64);

  const badUrl = await runTimon(
    ['daemon', 'add', 'vps', 'not-a-url', 'tok'],
    env,
  );
  assert.equal(badUrl.code, 64);
});

test('timon --daemon vps task list : Bearer du profil, pas de TIMON_API_TOKEN', async () => {
  const home = freshHome();
  const mock = await startMock();
  try {
    const added = await runTimon(
      ['daemon', 'add', 'vps', mock.url, 'profil-token'],
      baseEnv(home),
    );
    assert.equal(added.code, 0, added.stderr);

    const env = baseEnv(home);
    env.TIMON_API_TOKEN = 'token-env-a-ignorer';
    const r = await runTimon(['--daemon', 'vps', 'task', 'list'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /"id": "t1"/);
    assert.equal(mock.seen.length, 1);
    assert.equal(mock.seen[0]?.url, '/api/tasks?full=1');
    assert.equal(mock.seen[0]?.auth, 'Bearer profil-token');
  } finally {
    await mock.close();
  }
});

test('timon --daemon <url> : Bearer de TIMON_API_TOKEN', async () => {
  const home = freshHome();
  const mock = await startMock();
  try {
    const env = baseEnv(home);
    env.TIMON_API_TOKEN = 'env-token';
    const r = await runTimon(['--daemon', mock.url, 'list'], env);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(mock.seen.length, 1);
    assert.equal(mock.seen[0]?.url, '/api/agents');
    assert.equal(mock.seen[0]?.auth, 'Bearer env-token');
  } finally {
    await mock.close();
  }
});

test('sans --daemon : TIMON_API_TOKEN gagne sur daemon-token ; sinon le fichier', async () => {
  const home = freshHome();
  writeFileSync(join(home, 'daemon-token'), 'fichier-token\n', { mode: 0o600 });
  const mock = await startMock();
  try {
    const port = Number(new URL(mock.url).port);
    writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ daemon: { listen: { host: 'localhost', port } } }));
    const envFile = baseEnv(home);
    envFile.TIMON_API = mock.url;
    const viaFile = await runTimon(['list'], envFile);
    assert.equal(viaFile.code, 0, viaFile.stderr);
    assert.equal(mock.seen[0]?.auth, 'Bearer fichier-token');

    const envTok = baseEnv(home);
    envTok.TIMON_API = mock.url;
    envTok.TIMON_API_TOKEN = 'env-gagne';
    const viaEnv = await runTimon(['list'], envTok);
    assert.equal(viaEnv.code, 0, viaEnv.stderr);
    assert.equal(mock.seen[1]?.auth, 'Bearer env-gagne');
  } finally {
    await mock.close();
  }
});

test('raw remote URL never inherits the local file token, even with a matching port', async (t) => {
  const address = Object.values(networkInterfaces()).flat()
    .find((entry) => entry && !entry.internal && entry.family === 'IPv4')?.address;
  if (!address) { t.skip('No non-loopback IPv4 interface available'); return; }
  const home = freshHome();
  writeFileSync(join(home, 'daemon-token'), 'local-private-token\n');
  const mock = await startMock(address);
  try {
    const port = Number(new URL(mock.url).port);
    writeFileSync(join(home, 'desktop-bootstrap.json'), JSON.stringify({ daemonPort: port }));
    const env = { ...baseEnv(home), TIMON_API: mock.url };
    for (const token of [undefined, '', '   ']) {
      const result = await runTimon(['--daemon', mock.url, 'list'], { ...env, TIMON_API_TOKEN: token });
      assert.equal(result.code, 0, result.stderr);
    }
    assert.equal(mock.seen.length, 3);
    assert.ok(mock.seen.every((request) => request.auth === undefined));
    const explicit = await runTimon(['--daemon', mock.url, 'list'], { ...env, TIMON_API_TOKEN: 'remote-token' });
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.equal(mock.seen[3]?.auth, 'Bearer remote-token');
    writeFileSync(join(home, 'cli-daemons.json'), JSON.stringify({ remote: { url: mock.url, token: 'profile-token' } }));
    const profile = await runTimon(['--daemon', 'remote', 'list'], env);
    assert.equal(profile.code, 0, profile.stderr);
    assert.equal(mock.seen[4]?.auth, 'Bearer profile-token');
  } finally {
    await mock.close();
  }
});

test('TIMON_API without --daemon: a remote URL never receives the local file token, even with a matching port', async (t) => {
  const address = Object.values(networkInterfaces()).flat()
    .find((entry) => entry && !entry.internal && entry.family === 'IPv4')?.address;
  if (!address) { t.skip('No non-loopback IPv4 interface available'); return; }
  const home = freshHome();
  writeFileSync(join(home, 'daemon-token'), 'local-private-token\n');
  const mock = await startMock(address);
  try {
    const port = Number(new URL(mock.url).port);
    writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ daemon: { listen: { host: '127.0.0.1', port } } }));
    for (const token of [undefined, '', '   ']) {
      const result = await runTimon(['list'], { ...baseEnv(home), TIMON_API: mock.url, TIMON_API_TOKEN: token });
      assert.equal(result.code, 0, result.stderr);
    }
    assert.equal(mock.seen.length, 3);
    assert.ok(mock.seen.every((request) => request.auth === undefined), JSON.stringify(mock.seen));
    const explicit = await runTimon(['list'], { ...baseEnv(home), TIMON_API: mock.url, TIMON_API_TOKEN: 'remote-token' });
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.equal(mock.seen[3]?.auth, 'Bearer remote-token');
  } finally {
    await mock.close();
  }
});

test('TIMON_API without --daemon: another loopback port or a path behind the listener get no file token', async () => {
  const home = freshHome();
  writeFileSync(join(home, 'daemon-token'), 'local-private-token\n');
  const mock = await startMock();
  const other = await startMock();
  try {
    const port = Number(new URL(mock.url).port);
    writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ daemon: { listen: { host: '127.0.0.1', port } } }));
    for (const url of [other.url, `${mock.url}/proxy`, `${mock.url}/?via=proxy`]) {
      const result = await runTimon(['list'], { ...baseEnv(home), TIMON_API: url });
      assert.equal(result.code, 0, result.stderr);
    }
    assert.equal(other.seen.length, 1);
    assert.ok([...mock.seen, ...other.seen].every((request) => request.auth === undefined), JSON.stringify([...mock.seen, ...other.seen]));
    const own = await runTimon(['list'], { ...baseEnv(home), TIMON_API: `${mock.url.replace('127.0.0.1', 'localhost')}/` });
    assert.equal(own.code, 0, own.stderr);
    assert.equal(mock.seen.at(-1)?.auth, 'Bearer local-private-token');
  } finally {
    await Promise.all([mock.close(), other.close()]);
  }
});

test('raw loopback URL only inherits the file token for the configured local listener', async () => {
  const home = freshHome();
  writeFileSync(join(home, 'daemon-token'), 'local-private-token\n');
  const mock = await startMock();
  const other = await startMock();
  try {
    const port = Number(new URL(mock.url).port);
    writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ daemon: { listen: { host: 'localhost', port } } }));
    for (const url of [mock.url, other.url, `${mock.url}/other`]) {
      const result = await runTimon(['--daemon', url, 'list'], { ...baseEnv(home), TIMON_API: other.url });
      assert.equal(result.code, 0, result.stderr);
    }
    assert.equal(mock.seen.length, 2);
    assert.equal(mock.seen[0]?.auth, 'Bearer local-private-token');
    assert.equal(mock.seen[1]?.auth, undefined);
    assert.equal(other.seen.length, 1);
    assert.equal(other.seen[0]?.auth, undefined);
  } finally {
    await Promise.all([mock.close(), other.close()]);
  }
});

test('a daemon listening on its own LAN address receives the file token, and only there (TODO #563)', async (t) => {
  const address = Object.values(networkInterfaces()).flat()
    .find((entry) => entry && !entry.internal && entry.family === 'IPv4')?.address;
  if (!address) { t.skip('No non-loopback IPv4 interface available'); return; }
  const home = freshHome();
  writeFileSync(join(home, 'daemon-token'), 'local-private-token\n');
  const mock = await startMock(address);
  const other = await startMock(address);
  const loopback = await startMock();
  try {
    const port = Number(new URL(mock.url).port);
    writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ daemon: { listen: { host: address, port } } }));
    const discovered = await runTimon(['list'], baseEnv(home));
    assert.equal(discovered.code, 0, discovered.stderr);
    assert.equal(mock.seen[0]?.auth, 'Bearer local-private-token');
    const explicit = await runTimon(['--daemon', mock.url, 'list'], baseEnv(home));
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.equal(mock.seen[1]?.auth, 'Bearer local-private-token');
    // Another port on the same address, a path behind it, and the loopback
    // (where this daemon does not listen) are someone else.
    for (const url of [other.url, `${mock.url}/proxy`, loopback.url]) {
      const result = await runTimon(['list'], { ...baseEnv(home), TIMON_API: url });
      assert.equal(result.code, 0, result.stderr);
    }
    for (const url of [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `https://${address}:${port}`]) {
      assert.equal(isLocalDaemonUrl(home, url), false, url);
    }
    assert.equal(other.seen.length, 1);
    assert.ok([...mock.seen.slice(2), ...other.seen, ...loopback.seen].every((request) => request.auth === undefined),
      JSON.stringify([...mock.seen, ...other.seen, ...loopback.seen]));
  } finally {
    await Promise.all([mock.close(), other.close(), loopback.close()]);
  }
});

test('a LAN listener address the machine no longer holds, or a host name, never gets the file token (TODO #563)', () => {
  const home = freshHome();
  // TEST-NET-1 (RFC 5737): never assigned to a real interface, i.e. a lease
  // that moved to another host since the config was written.
  for (const host of ['192.0.2.7', 'daemon.example', '[2001:db8::7]']) {
    writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ daemon: { listen: { host, port: 3005 } } }));
    const url = resolveApiUrl(home);
    assert.equal(isLocalDaemonUrl(home, url), false, url);
    assert.equal(isLocalDaemonUrl(home, 'http://127.0.0.1:3005'), false, host);
  }
});

test('timon --daemon nom-inconnu : exit 64, aucun HTTP', async () => {
  const home = freshHome();
  const r = await runTimon(['--daemon', 'absent', 'task', 'list'], baseEnv(home));
  assert.equal(r.code, 64);
  assert.match(r.stderr, /unknown daemon 'absent'/);
});

test('MCP : Bearer depuis TIMON_API_TOKEN, sinon daemon-token', async () => {
  const home = freshHome();
  writeFileSync(join(home, 'daemon-token'), 'mcp-fichier\n', { mode: 0o600 });
  const mock = await startMock();

  async function callMcp(env: NodeJS.ProcessEnv): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [MCP], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '';
      const timer = setTimeout(() => {
        killChild(child);
        reject(new Error(`mcp timeout: ${stdout}`));
      }, 5000);
      child.stdout.on('data', (c: Buffer | string) => {
        stdout += String(c);
        if (stdout.includes('\n')) killChild(child);
      });
      child.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve();
      });
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'kanban_list', arguments: {} },
      }) + '\n');
      child.stdin.end();
    });
  }

  try {
    const port = Number(new URL(mock.url).port);
    writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ daemon: { listen: { host: '127.0.0.1', port } } }));
    const envTok = baseEnv(home);
    envTok.TIMON_ORCH_URL = mock.url;
    envTok.TIMON_API_TOKEN = 'mcp-env';
    await callMcp(envTok);
    assert.equal(mock.seen[0]?.url, '/api/tasks?full=1');
    assert.equal(mock.seen[0]?.auth, 'Bearer mcp-env');

    const envFile = baseEnv(home);
    envFile.TIMON_ORCH_URL = mock.url;
    await callMcp(envFile);
    assert.equal(mock.seen[1]?.auth, 'Bearer mcp-fichier');

    // TIMON_ORCH_URL naming another daemon: the file token stays home.
    writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ daemon: { listen: { host: '127.0.0.1', port: port === 1 ? 2 : 1 } } }));
    await callMcp(envFile);
    assert.equal(mock.seen.length, 3);
    assert.equal(mock.seen[2]?.auth, undefined);
  } finally {
    await mock.close();
  }
});
