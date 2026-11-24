/**
 * The provider screen's routes: a superadmin signed in to the app lists the
 * installed providers with their resolved binaries and accepts them; anonymous,
 * a plain session, the daemon token and a mission token are all refused.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import express from 'express';
import type { RequestAuth } from '../../users/identity.js';

const { dbApi } = await import('../../db.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { createBodyParser } = await import('../../kernel/body-parser.js');
const { registerRoutes } = await import('./routes.js');
const { attachPluginLoader } = await import('../../plugins/runtime.js');
const { CONFIG_FILE } = await import('../../config/load.js');
const { launchCardAnchor, launchCardsSettled, raiseLaunchCard, resetLaunchCards } = await import('../../backends/launch-card.js');
const { resetBinaryIdentityCache } = await import('../../backends/binary-identity.js');

const posix = process.platform !== 'win32';
const DAEMON = 'daemon-provider-token';
function user(name: string, superadmin: boolean) {
  const id = randomUUID();
  return createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'x', isSuperadmin: superadmin });
}
const admin = user('admin', true);
const bob = user('bob', false);
const IDENTITIES: Record<string, RequestAuth> = {
  admin: { kind: 'session', user: admin, isSuperadmin: true },
  bob: { kind: 'session', user: bob, isSuperadmin: false, permissions: ['plugins:manage'] },
  mission: { kind: 'api-token', user: admin, isSuperadmin: true, missionId: 'm-1' },
};

// Canonical: the host resolves a program to its real path (`/private/var/...` on macOS).
const BIN_DIR = realpathSync.native(mkdtempSync(join(tmpdir(), 'timon-provider-routes-')));
const AGENT = join(BIN_DIR, 'acme-route-agent');
if (posix) {
  writeFileSync(AGENT, '#!/bin/sh\nexit 0\n');
  chmodSync(AGENT, 0o755);
}
const PATH_BEFORE = process.env.PATH;
process.env.PATH = `${BIN_DIR}${delimiter}${PATH_BEFORE ?? ''}`;

let updates = 0;
const binary: { name: string; aliases: string[]; identity?: { pattern: string; expected?: string } } = { name: 'acme-route-agent', aliases: [] };
const manifest = {
  id: 'acme-route', kind: ['provider' as const], label: 'Acme',
  provider: { binaries: [binary] },
};
const loader = {
  list: () => [
    { id: 'acme-route', pkg: '@acme/route', version: '1.0.0', state: 'failed', reason: 'failed', error: 'not allowed', signed: true, manifest },
    { id: 'plain-widget', pkg: '@acme/w', version: '1.0.0', state: 'active', reason: null, error: null, signed: true, manifest: { id: 'plain-widget', kind: ['widget' as const] } },
    // Shipped in the release: its CLI is one the plugin policy refuses to any third party.
    {
      id: 'provider-shipped', pkg: '@timon/provider-shipped', version: '1.0.0', state: 'active', reason: null, error: null, signed: true, builtin: true,
      manifest: { id: 'provider-shipped', kind: ['provider' as const], label: 'Shipped', provider: { binaries: [{ name: 'claude', aliases: [] }] } },
    },
  ],
  update: async () => { updates += 1; return []; },
};

const app = express();
attachPluginLoader(app, loader as never);
app.use((req, res, next) => {
  const as = req.header('x-test-as');
  if (as && IDENTITIES[as]) { req.auth = IDENTITIES[as]; next(); return; }
  createDaemonAuthMiddleware({ token: DAEMON, required: true })(req, res, next);
});
app.use(createBodyParser());
registerRoutes(app);
const server: Server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); process.env.PATH = PATH_BEFORE; });

type Caller = 'admin' | 'bob' | 'mission' | 'daemon' | null;
async function call(method: string, path: string, body?: unknown, as: Caller = 'admin') {
  const headers: Record<string, string> = {};
  if (as === 'daemon') headers.authorization = `Bearer ${DAEMON}`;
  else if (as) headers['x-test-as'] = as;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/api/plugins/-/providers${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* empty */ }
  return { status: res.status, json, text };
}

/** Whether the card is open once every write asked so far has landed. */
async function cardOpen(): Promise<boolean> {
  await launchCardsSettled();
  return dbApi.listNotifications({ limit: 200 }).some((n) => n.anchor === launchCardAnchor('acme-route'));
}

// A launch of this provider was refused (TODO #598): the card the authorization below must answer.
resetLaunchCards();
raiseLaunchCard('acme-route', 'acme-route-profile', 'The program moved.');
assert.equal(await cardOpen(), true, 'the refusal card is open');

const ROUTES: Array<[string, string, unknown]> = [
  ['GET', '', undefined],
  ['POST', '/acme-route/authorize', { paths: [AGENT] }],
];

test('anonymous is refused on every provider route (401)', async () => {
  for (const [method, path, body] of ROUTES) assert.equal((await call(method, path, body, null)).status, 401, `${method} ${path}`);
});

test('a non-superadmin session is refused (403), even with plugins:manage', async () => {
  for (const [method, path, body] of ROUTES) assert.equal((await call(method, path, body, 'bob')).status, 403, `${method} ${path}`);
});

test('neither the daemon token nor a superadmin mission token may widen the allowlist (403)', async () => {
  for (const as of ['daemon', 'mission'] as const) {
    for (const [method, path, body] of ROUTES) assert.equal((await call(method, path, body, as)).status, 403, `${as} ${method} ${path}`);
  }
  const allow = (): string[] => {
    try { return (JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { pluginPolicy?: { exec?: { allow?: string[] } } }).pluginPolicy?.exec?.allow ?? []; } catch { return []; }
  };
  assert.deepEqual(allow(), [], 'nothing was written by a refused caller');
  assert.equal(await cardOpen(), true, 'a refused caller does not close the launch card either');
});

test('the list shows providers only, with the path this host resolves', { skip: !posix }, async () => {
  const res = await call('GET', '');
  assert.equal(res.status, 200, res.text);
  const providers = res.json.providers as Array<{ id: string; binaries: Array<{ resolved: string | null; allowed: boolean }> }>;
  assert.deepEqual(providers.map((p) => p.id), ['acme-route', 'provider-shipped']);
  assert.equal(providers[0]!.binaries[0]!.resolved, AGENT);
  assert.equal(providers[0]!.binaries[0]!.allowed, false);
});

test('a provider shipped in the release lists no program to authorize, never a refused one', async () => {
  const res = await call('GET', '');
  assert.equal(res.status, 200, res.text);
  const providers = res.json.providers as Array<{ id: string; binaries: Array<{ refused: string | null }> }>;
  assert.deepEqual(providers.find((p) => p.id === 'provider-shipped')?.binaries, []);
});

test('authorize: a program without the declared identity is a 409 saying why; nothing written, no remount, the card stays', { skip: !posix }, async () => {
  const witness = `${AGENT}.runs`;
  const runs = (): string => { try { return readFileSync(witness, 'utf8'); } catch { return ''; } };
  const original = readFileSync(AGENT, 'utf8');
  writeFileSync(AGENT, `#!/bin/sh\necho x >> "${witness}"\necho "grok-cli 0.9.1"\n`);
  binary.identity = { pattern: '^acme \\d+', expected: "Acme's CLI" };
  resetBinaryIdentityCache();
  try {
    assert.equal((await call('POST', '/acme-route/authorize', { paths: [AGENT] }, null)).status, 401);
    assert.equal((await call('POST', '/acme-route/authorize', { paths: [AGENT] }, 'bob')).status, 403);
    assert.equal((await call('GET', '')).status, 200);
    assert.equal(runs(), '', 'neither a refused caller nor the list starts the program');

    const res = await call('POST', '/acme-route/authorize', { paths: [AGENT] });
    assert.equal(res.status, 409, res.text);
    assert.equal(res.json.error, 'binary-identity');
    assert.match(String(res.json.message), /grok-cli 0\.9\.1/);
    assert.match(String(res.json.message), /Acme's CLI/);
    assert.equal(updates, 0);
    let written: string[] = [];
    try { written = (JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { pluginPolicy?: { exec?: { allow?: string[] } } }).pluginPolicy?.exec?.allow ?? []; } catch { /* no file */ }
    assert.deepEqual(written, []);
    assert.equal(await cardOpen(), true, 'the launch stays refused: its card is not answered');

  } finally {
    delete binary.identity;
    writeFileSync(AGENT, original);
    resetBinaryIdentityCache();
  }
});

test('authorize: a path that is not the resolved one is a 409; the resolved one is written and the plugin remounts', { skip: !posix }, async () => {
  const wrong = await call('POST', '/acme-route/authorize', { paths: ['/usr/bin/ls'] });
  assert.equal(wrong.status, 409, wrong.text);
  assert.equal(updates, 0);

  const ok = await call('POST', '/acme-route/authorize', { paths: [AGENT] });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.json.granted, [AGENT]);
  assert.equal(updates, 1, 'the loader reconciles so the failed provider mounts without a restart');
  assert.deepEqual(
    (JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { pluginPolicy: { exec: { allow: string[] } } }).pluginPolicy.exec.allow,
    [AGENT],
  );
  const after = (await call('GET', '')).json.providers as Array<{ binaries: Array<{ allowed: boolean }> }>;
  assert.equal(after[0]!.binaries[0]!.allowed, true);
  assert.equal(await cardOpen(), false, 'the authorization answers the refused launch\'s card');
});

test('authorize rejects unknown plugins, non-providers and malformed bodies', async () => {
  assert.equal((await call('POST', '/nobody-here/authorize', { paths: [] })).status, 404);
  assert.equal((await call('POST', '/plain-widget/authorize', { paths: [] })).status, 404);
  assert.equal((await call('POST', '/acme-route/authorize', { paths: 'nope' })).status, 400);
  assert.equal((await call('POST', '/acme-route/authorize', { paths: [AGENT], extra: 1 })).status, 400);
  assert.equal((await call('POST', '/Not%20An%20Id/authorize', { paths: [] })).status, 400);
});
