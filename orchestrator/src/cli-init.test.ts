/**
 * `timon init` against a fake daemon: what it sends, with which credential,
 * and what it tells the person. The route itself (`POST /api/auth/setup`,
 * daemon token only on an exposed listener) is tested in
 * `plugins-bundled/users/setup-exposed.test.ts`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aiToolLines } from '../bin/cli-guide.mjs';

const TIMON = fileURLToPath(new URL('../bin/timon', import.meta.url));
const TOKEN = 'init-test-daemon-token';

type Seen = { method: string; path: string; auth: string | undefined; cookie: string | undefined; body: string };

async function fakeDaemon(opts: { needsSetup: boolean; setupStatus?: number; setupError?: string }) {
  const seen: Seen[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen.push({ method: req.method ?? '', path: req.url ?? '', auth: req.headers.authorization, cookie: req.headers.cookie, body });
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(value));
      };
      if (req.url === '/api/health') return json(200, { ok: true, service: 'timon' });
      if (req.url === '/api/auth/me') {
        if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(401, { error: 'unauthorized' });
        return json(200, { needsSetup: opts.needsSetup, setupRequiresLicense: false });
      }
      if (req.url === '/api/auth/setup') {
        if (opts.setupStatus) return json(opts.setupStatus, { error: opts.setupError });
        return json(201, { user: { id: 'u1' } }, { 'set-cookie': 'timon_session=s3ss10n; Path=/; HttpOnly; SameSite=Strict' });
      }
      if (req.url === '/api/host/provider-clis') {
        if (req.headers.cookie !== 'timon_session=s3ss10n') return json(401, { error: 'unauthorized' });
        return json(200, { backends: [
          { name: 'claude', label: 'Claude Code', path: '/usr/bin/claude', signedIn: true, signInCommand: 'claude', signInThen: '/login', seedsMainAgent: true },
          { name: 'codex', label: 'Codex', path: null, signedIn: null, signInCommand: 'codex login', seedsMainAgent: true, installCommand: 'npm i -g @openai/codex' },
        ] });
      }
      if (req.url === '/api/auth/logout') return json(200, { ok: true });
      return json(404, { error: 'not_found' });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, seen, port: (server.address() as AddressInfo).port };
}

function homeFor(port: number): string {
  const home = mkdtempSync(join(tmpdir(), 'timon-init-'));
  writeFileSync(join(home, 'timon.config.json'), JSON.stringify({ daemon: { listen: { host: '127.0.0.1', port } } }));
  writeFileSync(join(home, 'daemon-token'), TOKEN, { mode: 0o600 });
  return home;
}

function runInit(home: string, args: string[], stdin: string): Promise<{ code: number | null; out: string; err: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [TIMON, 'init', ...args], {
      env: { PATH: process.env.PATH, HOME: home, TIMON_HOME: home, NODE_ENV: 'test' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
    child.stdin.end(stdin);
  });
}

test('timon init creates the first account with the daemon token, then reads the AI tools with its session', async () => {
  const daemon = await fakeDaemon({ needsSetup: true });
  try {
    const home = homeFor(daemon.port);
    const r = await runInit(home, ['--email', 'Robin@Example.com', '--name', 'Robin', '--password-stdin'], 'correct horse\n');
    assert.equal(r.code, 0, r.err);
    const setup = daemon.seen.find((s) => s.path === '/api/auth/setup');
    assert.ok(setup, 'the account was asked for');
    assert.equal(setup.auth, `Bearer ${TOKEN}`, 'the operator path of the route: the daemon token');
    assert.deepEqual(JSON.parse(setup.body), { email: 'robin@example.com', name: 'Robin', password: 'correct horse' });
    const tools = daemon.seen.find((s) => s.path === '/api/host/provider-clis');
    assert.ok(tools, 'the AI tools were read');
    assert.equal(tools.auth, undefined, 'with the new session only, never the daemon token');
    assert.ok(daemon.seen.some((s) => s.path === '/api/auth/logout' && s.cookie === 'timon_session=s3ss10n'), 'the session is closed');
    assert.match(r.out, /Account created for robin@example\.com/);
    assert.match(r.out, /Claude Code +ready/);
    assert.doesNotMatch(r.out + r.err, /correct horse/, 'the password is never printed');
  } finally {
    daemon.server.close();
  }
});

test('timon init leaves an existing account alone', async () => {
  const daemon = await fakeDaemon({ needsSetup: false });
  try {
    const r = await runInit(homeFor(daemon.port), ['--email', 'robin@example.com', '--password-stdin'], 'correct horse\n');
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /already has an account/);
    assert.ok(!daemon.seen.some((s) => s.path === '/api/auth/setup'));
  } finally {
    daemon.server.close();
  }
});

test('timon init refuses what it cannot ask safely, and reports a refused account', async () => {
  const daemon = await fakeDaemon({ needsSetup: true, setupStatus: 409, setupError: 'already_set_up' });
  try {
    const home = homeFor(daemon.port);
    const noEmail = await runInit(home, ['--password-stdin'], 'correct horse\n');
    assert.equal(noEmail.code, 64);
    assert.match(noEmail.err, /needs --email/);

    const noTerminal = await runInit(home, ['--email', 'robin@example.com'], '');
    assert.equal(noTerminal.code, 64);
    assert.match(noTerminal.err, /--password-stdin/);

    const short = await runInit(home, ['--email', 'robin@example.com', '--password-stdin'], 'short\n');
    assert.equal(short.code, 64);
    assert.match(short.err, /at least 8 characters/);

    const argvPassword = await runInit(home, ['--email', 'robin@example.com', '--password', 'x'], '');
    assert.equal(argvPassword.code, 64, 'no password flag: it would be readable by any process');

    const refused = await runInit(home, ['--email', 'robin@example.com', '--password-stdin'], 'correct horse\n');
    assert.equal(refused.code, 1);
    assert.match(refused.err, /an account was created meanwhile/);
  } finally {
    daemon.server.close();
  }
});

test('timon init without a daemon, and without --yes, installs nothing', async () => {
  const home = homeFor(9);
  const r = await runInit(home, ['--email', 'robin@example.com', '--password-stdin'], 'correct horse\n');
  assert.equal(r.code, 1);
  assert.match(r.err, /timon service install/);
  assert.match(r.err, /timon init --yes/);
});

test('AI tools: ready, to sign in, or to install', () => {
  const lines = aiToolLines([
    { name: 'claude', label: 'Claude Code', path: '/x/claude', signedIn: false, signInCommand: 'claude', signInThen: '/login' },
    { name: 'codex', label: 'Codex', path: '/x/codex', signedIn: null, signInCommand: 'codex login', signInThen: null },
  ]).join('\n');
  assert.match(lines, /Claude Code +not signed in: claude, then \/login/);
  assert.match(lines, /Codex +found; to sign in: codex login/);
  const none = aiToolLines([
    { name: 'claude', label: 'Claude Code', path: null, seedsMainAgent: true, installCommand: 'curl -fsSL https://claude.ai/install.sh | bash' },
    { name: 'grok', label: 'Grok', path: null, seedsMainAgent: false, installCommand: 'x' },
  ]).join('\n');
  assert.match(none, /None found/);
  assert.match(none, /Claude Code +curl -fsSL/);
  assert.doesNotMatch(none, /Grok/);
});
