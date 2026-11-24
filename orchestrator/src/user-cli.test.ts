/**
 * `timon user reset-password` — prints a one-shot password, never as an
 * argument. `timon user create-admin` — the first account, its password piped
 * or typed hidden, never an argument. Witness HTTP on 127.0.0.1:0.
 */
import { mkdtempSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-user-cli-'));

const TIMON = fileURLToPath(new URL('../bin/timon', import.meta.url));

function runTimon(args: string[], env: NodeJS.ProcessEnv, input?: string): Promise<{
  code: number | null; stdout: string; stderr: string;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [TIMON, ...args], {
      env,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
    });
    if (input !== undefined) child.stdin?.end(input);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => { stdout += String(c); });
    child.stderr.on('data', (c: Buffer) => { stderr += String(c); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

type Seen = { method: string; url: string; body: string };

function startMock(opts: { needsSetup?: boolean } = {}): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const users = [
    { id: 'u-ada', email: 'ada@example.com', name: 'Ada', status: 'active', is_superadmin: false },
  ];
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = req.url ?? '';
      let body = '';
      for await (const chunk of req) body += String(chunk);
      seen.push({ method: req.method ?? '', url, body });
      if (url === '/api/auth/me' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ user: null, needsSetup: opts.needsSetup ?? false }));
      }
      if (url === '/api/users/first-admin' && req.method === 'POST') {
        const sent = JSON.parse(body) as { email: string; name: string };
        res.writeHead(201, { 'content-type': 'application/json' });
        return void res.end(JSON.stringify({ user: { id: 'u-first', email: sent.email, name: sent.name, is_superadmin: true }, emailUnverified: true }));
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      if (url === '/api/users' && req.method === 'GET') {
        return void res.end(JSON.stringify({ users }));
      }
      if (url === '/api/users/u-ada/reset-password' && req.method === 'POST') {
        return void res.end(JSON.stringify({ user: users[0], password: 'temp-password-once' }));
      }
      res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') return void reject(new Error('unexpected listen address'));
      assert.notEqual(addr.port, 3000, 'the witness must not take the production port');
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        seen,
        close: () => new Promise((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

test('timon user reset-password looks up by email and prints the password once', async () => {
  const mock = await startMock();
  try {
    const env = {
      ...process.env,
      TIMON_API: mock.url,
      TIMON_API_TOKEN: 'cli-token',
      TIMON_HOME: process.env.TIMON_HOME,
    };
    const result = await runTimon(['user', 'reset-password', 'ada@example.com'], env);
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /temp-password-once/);
    assert.match(result.stdout, /out of band/);
    assert.ok(mock.seen.some((s) => s.method === 'GET' && s.url === '/api/users'));
    assert.ok(mock.seen.some((s) => s.method === 'POST' && s.url === '/api/users/u-ada/reset-password'));
  } finally {
    await mock.close();
  }
});

test('the account administration commands left with the routes', async () => {
  const mock = await startMock();
  try {
    const env = {
      ...process.env,
      TIMON_API: mock.url,
      TIMON_API_TOKEN: 'cli-token',
      TIMON_HOME: process.env.TIMON_HOME,
    };
    for (const argv of [['user', 'disable', 'ada@example.com'], ['user', 'invite', '--email', 'eve@example.com', '--name', 'Eve'], ['role', 'list'], ['group', 'list']]) {
      const result = await runTimon(argv, env);
      assert.notEqual(result.code, 0, argv.join(' '));
    }
    assert.ok(!mock.seen.some((s) => s.method === 'PATCH' || s.url === '/api/invitations' || s.url === '/api/roles' || s.url === '/api/groups'));
  } finally {
    await mock.close();
  }
});

function cliEnv(url: string): NodeJS.ProcessEnv {
  return { ...process.env, TIMON_API: url, TIMON_API_TOKEN: 'cli-token', TIMON_HOME: process.env.TIMON_HOME };
}

test('timon user create-admin takes the password from stdin, never from an argument', async () => {
  const mock = await startMock({ needsSetup: true });
  try {
    const refused = await runTimon(['user', 'create-admin', '--email', 'ada@example.com', '--password', 'in-the-history'], cliEnv(mock.url));
    assert.equal(refused.code, 64);
    assert.match(refused.stderr, /never an argument/);
    assert.ok(!mock.seen.some((s) => s.url === '/api/users/first-admin'), 'nothing sent');

    const noTerminal = await runTimon(['user', 'create-admin', '--email', 'ada@example.com'], cliEnv(mock.url));
    assert.equal(noTerminal.code, 64);
    assert.match(noTerminal.stderr, /--password-stdin/);

    const result = await runTimon(['user', 'create-admin', '--email', 'Ada@Example.com', '--password-stdin'], cliEnv(mock.url), 'offline-password\n');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /Account created for ada@example\.com/);
    assert.match(result.stdout, /not confirmed yet/);
    assert.ok(!result.stdout.includes('offline-password'));
    const sent = mock.seen.find((s) => s.method === 'POST' && s.url === '/api/users/first-admin');
    assert.ok(sent);
    assert.deepEqual(JSON.parse(sent.body), { email: 'ada@example.com', name: 'ada', password: 'offline-password' });
  } finally {
    await mock.close();
  }
});

test('timon user create-admin refuses once an account exists, and points at reset-password', async () => {
  const mock = await startMock({ needsSetup: false });
  try {
    const result = await runTimon(['user', 'create-admin', '--email', 'ada@example.com', '--password-stdin'], cliEnv(mock.url), 'offline-password\n');
    assert.equal(result.code, 1);
    assert.match(result.stderr, /already has an account/);
    assert.match(result.stderr, /timon user reset-password/);
    assert.ok(!mock.seen.some((s) => s.url === '/api/users/first-admin'));
  } finally {
    await mock.close();
  }
});
