/**
 * The ACP-registry routes: a superadmin signed in to the app only. Anonymous,
 * a plain session, the daemon token and a mission token are refused on every
 * route — and a refused caller downloads nothing.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import type { RequestAuth } from '../../users/identity.js';
import { buildTarGzWithModes } from '../../providers/acp-registry/archive-fixtures.js';

const { dbApi } = await import('../../db.js');
const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { createBodyParser } = await import('../../kernel/body-parser.js');
const { registerRoutes } = await import('./routes.js');
const { AcpRegistryService } = await import('../../providers/acp-registry/service.js');
const { setAcpRegistryService } = await import('../../providers/acp-registry/index.js');
const { REGISTRY_URL } = await import('../../providers/acp-registry/schema.js');

const DAEMON = 'daemon-acp-token';
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

const archive = buildTarGzWithModes([{ path: 'agent', data: '#!/bin/sh\n', mode: 0o755 }]);
const requested: string[] = [];
let inspected = 0;
const home = mkdtempSync(join(tmpdir(), 'timon-acp-routes-'));
const service = new AcpRegistryService({
  home, platform: 'linux', arch: 'x64', register: () => () => {},
  inspect: async () => { inspected += 1; return [{ id: 'oauth', name: 'Log in' }, { id: 'acme-api-key', name: 'API key' }]; },
  fetchFn: async (url) => {
    requested.push(url);
    if (url === REGISTRY_URL) {
      return new Response(JSON.stringify({ version: '1', agents: [{
        id: 'route-agent', name: 'Route Agent', version: '1.0.0',
        distribution: { binary: { 'linux-x86_64': { archive: 'https://dl.example.com/a.tar.gz', cmd: './agent', args: ['acp'] } } },
      }, {
        id: 'hashed', name: 'Hashed', version: '1.0.0',
        distribution: { binary: { 'linux-x86_64': { archive: 'https://dl.example.com/a.tar.gz', cmd: './agent', sha256: createHash('sha256').update(archive).digest('hex') } } },
      }] }));
    }
    return url === 'https://dl.example.com/a.tar.gz' ? new Response(new Uint8Array(archive)) : new Response('', { status: 404 });
  },
});
setAcpRegistryService(service);

const app = express();
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
test.after(() => { server.closeAllConnections(); server.close(); service.dispose(); setAcpRegistryService(null); });

type Caller = 'admin' | 'bob' | 'mission' | 'daemon' | null;
async function call(method: string, path: string, body?: unknown, as: Caller = 'admin') {
  const headers: Record<string, string> = {};
  if (as === 'daemon') headers.authorization = `Bearer ${DAEMON}`;
  else if (as) headers['x-test-as'] = as;
  if (body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}/api/plugins/-/providers/acp-registry${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* 204 */ }
  return { status: res.status, json, text };
}

const ROUTES: Array<[string, string, unknown]> = [
  ['GET', '', undefined],
  ['POST', '/install', { agentId: 'hashed' }],
  ['POST', '/hashed/auth-methods', {}],
  ['DELETE', '/hashed', undefined],
];

test('anonymous (401), a plain session (403), the daemon token (403) and a mission token (403) are refused, and nothing is fetched', async () => {
  for (const [as, expected] of [[null, 401], ['bob', 403], ['daemon', 403], ['mission', 403]] as const) {
    for (const [method, path, body] of ROUTES) {
      assert.equal((await call(method, path, body, as)).status, expected, `${as} ${method} ${path}`);
    }
  }
  assert.deepEqual(requested, [], 'not even the registry was contacted');
  assert.equal(inspected, 0, 'no agent was started');
});

test('list shows the agents, each with how it will be verified', { skip: process.platform === 'win32' }, async () => {
  const res = await call('GET', '');
  assert.equal(res.status, 200, res.text);
  const agents = res.json.agents as Array<{ id: string; integrity: string | null; supported: boolean }>;
  assert.equal(agents.find((a) => a.id === 'hashed')?.integrity, 'sha256');
  assert.equal(agents.find((a) => a.id === 'route-agent')?.integrity, 'none');
  assert.ok(!res.text.includes(home), 'no path of this machine in the answer');
});

test('install: unverified needs the acknowledgement; verified installs; delete removes', { skip: process.platform === 'win32' }, async () => {
  const refusal = await call('POST', '/install', { agentId: 'route-agent' });
  assert.equal(refusal.status, 409);
  assert.equal(refusal.json.error, 'unverified');
  assert.equal(requested.includes('https://dl.example.com/a.tar.gz'), false, 'refused before any download');

  const ok = await call('POST', '/install', { agentId: 'route-agent', acceptUnverified: true });
  assert.equal(ok.status, 200, ok.text);
  assert.equal((ok.json.agent as { installed: { integrity: string } }).installed.integrity, 'unverified');

  const verified = await call('POST', '/install', { agentId: 'hashed' });
  assert.equal(verified.status, 200, verified.text);
  assert.equal((await call('POST', '/install', { agentId: 'hashed' })).status, 409, 'already installed and intact');

  assert.equal((await call('DELETE', '/hashed')).status, 204);
  assert.equal(existsSync(join(home, 'providers', 'acp-registry', 'agents', 'hashed')), false);
  assert.equal((await call('DELETE', '/hashed')).status, 404);
});

test('bodies and ids are validated; unknown agents are 404', async () => {
  assert.equal((await call('POST', '/install', {})).status, 400);
  assert.equal((await call('POST', '/install', { agentId: '../x' })).status, 400);
  assert.equal((await call('POST', '/install', { agentId: 'hashed', extra: true })).status, 400);
  assert.equal((await call('POST', '/install', { agentId: 'nobody-here' })).status, 404);
  assert.equal((await call('DELETE', '/Bad%20Id')).status, 400);
});

test('auth-methods: an installed agent says how it signs in, billed methods marked; ids and bodies are validated', { skip: process.platform === 'win32' }, async () => {
  const ok = await call('POST', '/route-agent/auth-methods', {});
  assert.equal(ok.status, 200, ok.text);
  const methods = ok.json.methods as Array<{ id: string; billedPerToken: boolean; recommended: boolean }>;
  assert.deepEqual(methods.map((m) => [m.id, m.billedPerToken, m.recommended]), [['oauth', false, true], ['acme-api-key', true, false]]);
  assert.equal((await call('POST', '/route-agent/auth-methods', { extra: 1 })).status, 400);
  assert.equal((await call('POST', '/Bad%20Id/auth-methods', {})).status, 400);
  assert.equal((await call('POST', '/nobody-here/auth-methods', {})).status, 404);
});
