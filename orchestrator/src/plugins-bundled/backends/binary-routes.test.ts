/**
 * `/api/host/binaries` — pinning a backend CLI from Settings (TODO #413).
 *
 * Refusals first: the pinned path is the program every mission of a backend
 * executes. Then the promise of the feature: the file is rewritten without
 * losing anything, and the RUNNING daemon — host adapter included — uses the
 * new path at once. Isolated TIMON_HOME, witness on 127.0.0.1:0.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { postTestAccount } from '../../../tests/helpers/accounts.js';

const HOME = mkdtempSync(join(tmpdir(), 'timon-binary-pins-'));
process.env.TIMON_HOME = HOME;
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerBinaryRoutes } = await import('./binary-routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { CONFIG_FILE, config } = await import('../../config/load.js');
const { checkBackendBinaries } = await import('../../backends/binary-check.js');
const { assertExecutablePin, normalizePinPath, runnableOnWindows } = await import('../../backends/binary-pins.js');
const { getHost } = await import('../../host/index.js');
{
  const { mountOfficialProviders } = await import('../../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

const TOKEN = 'witness-daemon-token';
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerBinaryRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

function sessionCookie(res: Response): string | undefined {
  const lines = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const line of lines) {
    const match = new RegExp(`(?:^|,\\s*)${SESSION_COOKIE}=([^;]+)`).exec(line);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }
  return undefined;
}

async function call(method: string, path: string, opts: { body?: unknown; cookie?: string; bearer?: string } = {}) {
  const headers: Record<string, string> = {};
  if (opts.body !== undefined) headers['content-type'] = 'application/json';
  if (opts.cookie) headers.cookie = `${SESSION_COOKIE}=${encodeURIComponent(opts.cookie)}`;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${base}${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, text };
}

const setup = await call('POST', '/api/auth/setup', { body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' } });
assert.equal(setup.status, 201);
const adminCookie = sessionCookie((await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'admin@example.com', password: 'admin-secret' }),
})))!;
const created = await postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'ada-secret' });
const adaId = (created.json as { user: { id: string } }).user.id;
const adaCookie = sessionCookie((await fetch(`${base}/api/auth/login`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: 'ada@example.com', password: 'ada-secret' }),
})))!;
assert.ok(adminCookie && adaCookie);
const admin = dbApi.listUsers().find((u) => u.email === 'admin@example.com')!;
dbApi.createMission('mission-binary-pins', 'admin.agent', 'work', undefined, admin.id);
const missionToken = issueMissionApiToken('mission-binary-pins');
assert.ok(adaId);

// What a configured install looks like: a file the person wrote, four-space
// indent, keys this feature must not touch.
const ORIGINAL = { version: 1, edition: 'expert', daemon: { listen: { port: 3999 } }, host: { gui: 'disabled' }, modules: { '@timon/video-factory': false } };
writeFileSync(CONFIG_FILE, `${JSON.stringify(ORIGINAL, null, 4)}\n`);

const CMD = checkBackendBinaries()[0]!.cmd;
// Beside the Timon home, not in it: no binary is ever resolved from there.
const BIN_DIR = join(`${HOME}-pins`, 'bin dir');
mkdirSync(BIN_DIR, { recursive: true });
// Windows runs a program by its extension: the witness there is a batch file.
const RUNNABLE = process.platform === 'win32' ? '.cmd' : '';
const SCRIPT = process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n';
/** Runnable on Linux, refused on Windows for want of an extension. */
const POSIX_EXECUTABLE = join(BIN_DIR, CMD);
writeFileSync(POSIX_EXECUTABLE, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const EXECUTABLE = join(BIN_DIR, `${CMD}${RUNNABLE}`);
writeFileSync(EXECUTABLE, SCRIPT, { mode: 0o755 });
const NOT_EXECUTABLE = join(BIN_DIR, `${CMD}-plain`);
writeFileSync(NOT_EXECUTABLE, 'not a program\n', { mode: 0o644 });
chmodSync(NOT_EXECUTABLE, 0o644);

const ROUTES: [string, string, unknown?][] = [
  ['GET', '/api/host/binaries'],
  ['POST', '/api/host/binaries/recheck'],
  ['PUT', `/api/host/binaries/${CMD}`, { path: EXECUTABLE }],
  ['DELETE', `/api/host/binaries/${CMD}`],
];

function fileNow(): Record<string, unknown> {
  return JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as Record<string, unknown>;
}

test('anonymous: 401 on every route, and the file is untouched', async () => {
  const before = readFileSync(CONFIG_FILE, 'utf8');
  for (const [method, path, body] of ROUTES) {
    assert.equal((await call(method, path, { body })).status, 401, `${method} ${path}`);
  }
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before);
});

test('daemon token, mission token, non-superadmin session: 403, nothing written', async () => {
  const before = readFileSync(CONFIG_FILE, 'utf8');
  for (const [method, path, body] of ROUTES) {
    assert.equal((await call(method, path, { body, bearer: TOKEN })).status, 403, `daemon token ${method} ${path}`);
    assert.equal((await call(method, path, { body, bearer: missionToken })).status, 403, `mission token ${method} ${path}`);
    assert.equal((await call(method, path, { body, cookie: adaCookie })).status, 403, `session ${method} ${path}`);
  }
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before);
  assert.equal(config().host.binaries[CMD], undefined);
});

test('refusals: unknown name, relative, missing, folder, not executable — none echoes the input', async () => {
  const cases: [string, unknown, number, string][] = [
    ['node', { path: process.execPath }, 404, 'unknown_binary'],
    ['__proto__', { path: EXECUTABLE }, 404, 'unknown_binary'],
    [CMD, { path: `bin/${CMD}` }, 400, 'path_not_absolute'],
    [CMD, { path: join(HOME, 'nowhere-secret-name', CMD) }, 400, 'path_missing'],
    [CMD, { path: BIN_DIR }, 400, 'path_not_file'],
    [CMD, { path: EXECUTABLE, extra: true }, 400, 'invalid_body'],
    [CMD, {}, 400, 'invalid_body'],
  ];
  if (process.platform !== 'win32') cases.push([CMD, { path: NOT_EXECUTABLE }, 400, 'path_not_executable']);
  const before = readFileSync(CONFIG_FILE, 'utf8');
  for (const [name, body, status, code] of cases) {
    const out = await call('PUT', `/api/host/binaries/${encodeURIComponent(name)}`, { cookie: adminCookie, body });
    assert.equal(out.status, status, `${name} ${JSON.stringify(body)}: ${out.text}`);
    assert.equal((out.json as { error: string }).error, code);
    assert.doesNotMatch(out.text, /nowhere-secret-name/);
  }
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before);
});

test('PUT: the file keeps every other key and its indent, and the running daemon uses the pin at once', async () => {
  // The adapter exists BEFORE the pin, as in a running daemon: it must not
  // keep the paths it was built with.
  const host = getHost();
  const out = await call('PUT', `/api/host/binaries/${CMD}`, { cookie: adminCookie, body: { path: `  "${EXECUTABLE}"  ` } });
  assert.equal(out.status, 200, out.text);

  const raw = readFileSync(CONFIG_FILE, 'utf8');
  assert.match(raw, /^ {4}"version": 1,$/m, 'four-space indent kept');
  const written = fileNow();
  assert.deepEqual(written, { ...ORIGINAL, host: { gui: 'disabled', binaries: { [CMD]: EXECUTABLE } } });
  assert.deepEqual(readdirSync(HOME).filter((f) => f.endsWith('.tmp')), [], 'no temporary file left');

  assert.equal(config().host.binaries[CMD], EXECUTABLE);
  const status = checkBackendBinaries().find((s) => s.cmd === CMD)!;
  assert.deepEqual([status.path, status.pinned], [EXECUTABLE, true]);
  assert.equal(host.bin(CMD), EXECUTABLE, 'the host adapter resolves the new pin without a restart');

  const listed = (out.json as { binaries: { cmd: string; pin: string | null; path: string | null }[] }).binaries.find((b) => b.cmd === CMD)!;
  assert.deepEqual([listed.pin, listed.path], [EXECUTABLE, EXECUTABLE]);
});

test('recheck re-reads a hand edit without writing', async () => {
  const other = join(BIN_DIR, `${CMD}-other${RUNNABLE}`);
  writeFileSync(other, SCRIPT, { mode: 0o755 });
  const edited = { ...fileNow(), host: { gui: 'disabled', binaries: { [CMD]: other } } };
  writeFileSync(CONFIG_FILE, `${JSON.stringify(edited, null, 4)}\n`);
  const before = readFileSync(CONFIG_FILE, 'utf8');

  const out = await call('POST', '/api/host/binaries/recheck', { cookie: adminCookie });
  assert.equal(out.status, 200, out.text);
  assert.equal((out.json as { configError: string | null }).configError, null);
  assert.equal(config().host.binaries[CMD], other);
  assert.equal(getHost().bin(CMD), other);
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before, 'recheck writes nothing');

  // A broken file leaves the live pins alone and says so.
  writeFileSync(CONFIG_FILE, '{ not json');
  const broken = await call('POST', '/api/host/binaries/recheck', { cookie: adminCookie });
  assert.equal(broken.status, 200);
  assert.equal((broken.json as { configError: string | null }).configError, 'config_unreadable');
  assert.equal(config().host.binaries[CMD], other);
  const refused = await call('PUT', `/api/host/binaries/${CMD}`, { cookie: adminCookie, body: { path: EXECUTABLE } });
  assert.equal(refused.status, 409, 'an unreadable file is never overwritten');
  assert.equal(readFileSync(CONFIG_FILE, 'utf8'), '{ not json');
  writeFileSync(CONFIG_FILE, before);
});

test('DELETE removes the key and goes back to detection', async () => {
  await call('POST', '/api/host/binaries/recheck', { cookie: adminCookie });
  const out = await call('DELETE', `/api/host/binaries/${CMD}`, { cookie: adminCookie });
  assert.equal(out.status, 200, out.text);
  assert.deepEqual(fileNow(), ORIGINAL, 'the file is back to what the person wrote');
  assert.equal(CMD in config().host.binaries, false);
  assert.equal(checkBackendBinaries().find((s) => s.cmd === CMD)!.pinned, false);
});

test('no config file yet: the pin is refused rather than ending the first run', async () => {
  const saved = readFileSync(CONFIG_FILE, 'utf8');
  const { rmSync } = await import('node:fs');
  rmSync(CONFIG_FILE);
  try {
    const out = await call('PUT', `/api/host/binaries/${CMD}`, { cookie: adminCookie, body: { path: EXECUTABLE } });
    assert.equal(out.status, 409);
    assert.equal((out.json as { error: string }).error, 'no_config');
    assert.equal(existsSync(CONFIG_FILE), false);
  } finally {
    writeFileSync(CONFIG_FILE, saved);
  }
});

test('normalizePinPath: quotes, tilde and Windows paths', () => {
  assert.equal(normalizePinPath('"/opt/x/claude"', 'linux', '/home/u'), '/opt/x/claude');
  assert.equal(normalizePinPath('~/bin/claude', 'linux', '/home/u'), join('/home/u', 'bin', 'claude'));
  assert.equal(normalizePinPath('claude', 'linux', '/home/u'), null);
  assert.equal(normalizePinPath('~', 'linux', '/home/u'), null);
  assert.equal(normalizePinPath('"C:\\Program Files\\Claude\\claude.exe"', 'win32', 'C:\\Users\\u'), 'C:\\Program Files\\Claude\\claude.exe');
  assert.equal(normalizePinPath('~\\AppData\\Roaming\\npm\\claude.cmd', 'win32', 'C:\\Users\\u'), 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd');
  assert.equal(normalizePinPath('\\\\server\\share\\claude.exe', 'win32', 'C:\\Users\\u'), '\\\\server\\share\\claude.exe');
  assert.equal(normalizePinPath('C:claude.exe', 'win32', 'C:\\Users\\u'), null, 'drive-relative is not absolute');
  assert.equal(normalizePinPath('\\claude.exe', 'win32', 'C:\\Users\\u'), null, 'root-relative depends on the current drive');
});

test('Windows: only what the adapter can start is accepted, whatever the execute bit says', () => {
  for (const ok of ['C:\\npm\\claude.cmd', 'C:\\npm\\CLAUDE.CMD', 'C:\\x\\codex.exe', 'C:\\x\\run.bat', 'C:\\x\\tool.com']) {
    assert.equal(runnableOnWindows(ok), true, ok);
  }
  for (const refused of ['C:\\npm\\claude', 'C:\\npm\\claude.ps1', 'C:\\x\\claude.js']) {
    assert.equal(runnableOnWindows(refused), false, refused);
  }
  // An existing, runnable-on-Linux file without a Windows extension: refused
  // as soon as the daemon runs on Windows.
  assert.throws(() => assertExecutablePin(POSIX_EXECUTABLE, 'win32'), (err: Error & { code?: string }) => err.code === 'path_not_executable');
  assert.doesNotThrow(() => assertExecutablePin(POSIX_EXECUTABLE, 'linux'));
});
