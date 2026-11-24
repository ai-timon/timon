/**
 * Who may list, connect and disconnect an app, and what a connection writes.
 * The refusals are asserted first: an anonymous caller, a mission, a person
 * without `mcp:manage`.
 */
import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { dbApi } from '../../db.js';
import { issueMissionApiToken } from '../../users/api-tokens.js';
import { hashSessionToken, SESSION_COOKIE } from '../../users/session.js';
import { createDaemonAuthMiddleware } from '../http/auth.js';
import { MCP_DIR, deleteMcp, getMcp, mcpRelayUpstream, resolveLaunchServers, upsertMcp } from '../../mcp.js';
import { getSecret } from '../../secrets/store.js';
import { resolveMasterKey } from '../../secrets/key.js';
import { registerMcpAppsRoutes } from './routes.js';

resolveMasterKey({ keyring: null });
const admin = createTestAccount(dbApi, { email: 'apps-admin@example.test', name: 'Admin', passwordHash: 'unused', isSuperadmin: true });
const viewer = createTestAccount(dbApi, { email: 'apps-viewer@example.test', name: 'Viewer', passwordHash: 'unused' });
const cookies = { admin: randomUUID(), viewer: randomUUID() };
dbApi.createSession({ tokenHash: hashSessionToken(cookies.admin), userId: admin.id, expiresAt: Date.now() + 60_000 });
dbApi.createSession({ tokenHash: hashSessionToken(cookies.viewer), userId: viewer.id, expiresAt: Date.now() + 60_000 });
const missionId = randomUUID();
dbApi.createMission(missionId, 'apps-agent', 'test', undefined, admin.id);
const missionToken = issueMissionApiToken(missionId);

const app = express();
app.use(createDaemonAuthMiddleware({ required: true, token: 'apps-daemon' }));
app.use(express.json());
registerMcpAppsRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.close(); });

type Who = 'anonymous' | 'admin' | 'viewer' | 'mission';
async function call(who: Who, method: string, path: string, body?: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (who === 'admin' || who === 'viewer') headers.cookie = `${SESSION_COOKIE}=${cookies[who]}`;
  if (who === 'mission') headers.authorization = `Bearer ${missionToken}`;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

test('an anonymous caller is refused everywhere', async () => {
  assert.equal((await call('anonymous', 'GET', '/api/mcp-apps')).status, 401);
  assert.equal((await call('anonymous', 'POST', '/api/mcp-apps/linear/connect', {})).status, 401);
  assert.equal((await call('anonymous', 'DELETE', '/api/mcp-apps/linear')).status, 401);
  assert.equal(getMcp('app-linear'), null);
});

test('a mission may not connect nor disconnect an app', async () => {
  assert.equal((await call('mission', 'POST', '/api/mcp-apps/linear/connect', {})).status, 403);
  assert.equal((await call('mission', 'DELETE', '/api/mcp-apps/linear')).status, 403);
  assert.equal(getMcp('app-linear'), null);
});

test('a person without mcp:manage reads the catalogue but cannot connect', async () => {
  const list = await call('viewer', 'GET', '/api/mcp-apps');
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json.apps) && list.json.apps.length >= 15);
  assert.equal((await call('viewer', 'POST', '/api/mcp-apps/linear/connect', {})).status, 403);
});

test('oauth: the server is created on the reviewed url, the consent comes next', async () => {
  const r = await call('admin', 'POST', '/api/mcp-apps/linear/connect', {});
  assert.equal(r.status, 200);
  assert.equal(r.json.next, 'oauth');
  const s = getMcp('app-linear');
  assert.equal(s?.app_slug, 'linear');
  assert.deepEqual(s?.transport, { type: 'http', url: 'https://mcp.linear.app/mcp' });
  const listed = (await call('admin', 'GET', '/api/mcp-apps')).json.apps as Array<{ slug: string; state: { connected: boolean } }>;
  assert.equal(listed.find((a) => a.slug === 'linear')?.state.connected, true);
});

test('the body cannot carry a url', async () => {
  const r = await call('admin', 'POST', '/api/mcp-apps/sentry/connect', { url: 'https://attacker.example/mcp' });
  assert.equal(r.status, 400);
  assert.equal(getMcp('app-sentry'), null);
});

test('key: required, kept in the vault, added by the relay', async () => {
  assert.equal((await call('admin', 'POST', '/api/mcp-apps/github/connect', {})).json.code, 'mcp_app_key_required');
  assert.equal((await call('admin', 'POST', '/api/mcp-apps/github/connect', { key: 'two words here' })).status, 400);
  const key = 'github_pat_' + 'A'.repeat(30);
  assert.equal((await call('admin', 'POST', '/api/mcp-apps/github/connect', { key })).status, 200);
  assert.ok(!readFileSync(join(MCP_DIR, 'app-github.json'), 'utf8').includes(key), 'the key is not in the server file');
  // The CLI is handed the daemon's relay; the relay adds the key from the vault.
  const launched = await resolveLaunchServers(['app-github'], () => ({ url: 'http://127.0.0.1:3001/mcp-relay/r/a', headers: { 'x-timon-mcp-relay': 't' } }));
  assert.ok(launched.length === 1 && !JSON.stringify(launched).includes(key), 'the key is in no launch entry');
  assert.equal((await mcpRelayUpstream('app-github'))?.headers.Authorization, `Bearer ${key}`);

  // A new key replaces the old one, which leaves the vault.
  const first = getMcp('app-github');
  const firstId = first?.transport.type === 'http' ? first.transport.header_secrets?.Authorization?.secret_id : undefined;
  assert.ok(firstId);
  assert.equal((await call('admin', 'POST', '/api/mcp-apps/github/connect', { key: key + 'B' })).status, 200);
  assert.equal(getSecret(firstId!), undefined);

  const now = getMcp('app-github');
  const nowId = now?.transport.type === 'http' ? now.transport.header_secrets?.Authorization?.secret_id : undefined;
  assert.equal((await call('admin', 'DELETE', '/api/mcp-apps/github')).status, 200);
  assert.equal(getMcp('app-github'), null);
  assert.equal(getSecret(nowId!), undefined, 'disconnecting removes the key');
});

test('an app saved on another url from the MCP page is no longer an Apps connection', async () => {
  const key = 'test_key_' + 'C'.repeat(30);
  const entry = (await call('admin', 'GET', '/api/mcp-apps')).json.apps as Array<{ slug: string; auth: { type: string } }>;
  const keyed = entry.find((app) => app.auth.type === 'key');
  assert.ok(keyed, 'the catalogue has an app connected by key');
  const slug = keyed!.slug;
  const id = `app-${slug}`;
  assert.equal((await call('admin', 'POST', `/api/mcp-apps/${slug}/connect`, { key })).status, 200);
  const before = getMcp(id);
  const secretId = before?.transport.type === 'http' ? before.transport.header_secrets && Object.values(before.transport.header_secrets)[0]?.secret_id : undefined;
  assert.ok(secretId && getSecret(secretId));

  // The generic editor writes the same id on a url of the user's choosing.
  upsertMcp({ id, transport: { type: 'http', url: 'https://self-hosted.example/mcp' } });
  const after = getMcp(id);
  assert.equal(after?.app_slug, undefined);
  assert.equal(after?.transport.type === 'http' ? after.transport.header_secrets : 'wrong', undefined);
  assert.equal(getSecret(secretId!), undefined, 'the key the server no longer names leaves the vault');

  const view = ((await call('admin', 'GET', '/api/mcp-apps')).json.apps as Array<{ slug: string; state: { connected: boolean; blocked: boolean } }>)
    .find((app) => app.slug === slug);
  assert.deepEqual(view?.state && { connected: view.state.connected, blocked: view.state.blocked }, { connected: false, blocked: true });
  assert.equal((await call('admin', 'DELETE', `/api/mcp-apps/${slug}`)).status, 404, 'Apps does not remove a server it no longer vouches for');
  assert.equal((await call('admin', 'POST', `/api/mcp-apps/${slug}/connect`, { key })).status, 409);
  assert.ok(getMcp(id), 'the user\'s server stays');
  deleteMcp(id);
});

test('a server the user added under the same id is left alone', async () => {
  upsertMcp({ id: 'app-notion', transport: { type: 'http', url: 'https://notion.internal.example/mcp' } });
  const taken = await call('admin', 'POST', '/api/mcp-apps/notion/connect', {});
  assert.equal(taken.status, 409);
  // The webview names the server from the param; `reason` stays for older readers.
  assert.equal(taken.json.code, 'mcp_app_id_taken');
  assert.deepEqual(taken.json.params, { id: 'app-notion' });
  assert.equal(taken.json.reason, taken.json.error);
  assert.equal((await call('admin', 'DELETE', '/api/mcp-apps/notion')).status, 404);
  assert.equal(getMcp('app-notion')?.transport.type === 'http' ? (getMcp('app-notion')!.transport as { url: string }).url : null, 'https://notion.internal.example/mcp');
  const listed = (await call('admin', 'GET', '/api/mcp-apps')).json.apps as Array<{ slug: string; state: { blocked: boolean } }>;
  assert.equal(listed.find((a) => a.slug === 'notion')?.state.blocked, true);
});

test('an unknown app is a 404', async () => {
  assert.equal((await call('admin', 'POST', '/api/mcp-apps/nope/connect', {})).status, 404);
});
