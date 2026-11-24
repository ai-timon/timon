import { createTestAccount } from '../../../tests/helpers/accounts.js';
import '../../test-home.js';
import '../../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { dbApi } from '../../db.js';
import { createBrowserProfile, getBrowserProfile, resolveMissionBrowserProfile } from '../../browser-profiles.js';
import { NativeBrowserError } from '../../native-browser-provider.js';
import { resolveMasterKey } from '../../secrets/key.js';
import { issueMissionApiToken } from '../../users/api-tokens.js';
import { hashSessionToken, SESSION_COOKIE } from '../../users/session.js';
import { createDaemonAuthMiddleware } from '../http/auth.js';
import { registerBrowserCredentialRoutes } from './credential-routes.js';

resolveMasterKey({ keyring: null });
const alice = createTestAccount(dbApi, { email: 'credential-alice@example.test', name: 'Alice', passwordHash: 'unused' });
const bob = createTestAccount(dbApi, { email: 'credential-bob@example.test', name: 'Bob', passwordHash: 'unused' });
const admin = createTestAccount(dbApi, { email: 'credential-admin@example.test', name: 'Admin', passwordHash: 'unused', isSuperadmin: true });
const cookies: Record<string, string> = {};
for (const user of [alice, bob, admin]) {
  cookies[user.id] = randomUUID();
  dbApi.createSession({ tokenHash: hashSessionToken(cookies[user.id]), userId: user.id, expiresAt: Date.now() + 60_000 });
}
const profile = createBrowserProfile({ name: 'Alice browser', owner_user_id: alice.id });
const other = createBrowserProfile({ name: 'Alice other browser', owner_user_id: alice.id });
const unowned = createBrowserProfile({ name: 'Unowned browser', owner_user_id: null });
const mission = randomUUID();
dbApi.createMission(mission, 'credential-agent', 'test', undefined, alice.id);
dbApi.setMissionBrowserProfile(mission, profile.id);
const missionToken = issueMissionApiToken(mission);
const app = express();
app.use(createDaemonAuthMiddleware({ required: true, token: 'credential-daemon' }));
app.use(express.json());
registerBrowserCredentialRoutes(app, { profileForRequest(req, id) {
  if (req.auth?.kind === 'api-token') {
    const row = req.auth.missionId ? dbApi.getMission(req.auth.missionId) : undefined;
    const allowed = row ? resolveMissionBrowserProfile(row) : null;
    if (!allowed || allowed.id !== id) throw new NativeBrowserError('Browser profile not found.', 404);
    return allowed;
  }
  // Deliberately grant broad admin visibility here: the credentials facade
  // itself must still require the real owner's signed-in session.
  const resolved = getBrowserProfile(id);
  if (!resolved) throw new NativeBrowserError('Browser profile not found.', 404);
  return resolved;
} });
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
test.after(() => server.close());
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/native-browser`;
async function call(id: string, method = 'GET', body?: object, auth = alice.id, suffix = '') {
  const headers: Record<string, string> = {};
  if (cookies[auth]) headers.cookie = `${SESSION_COOKIE}=${cookies[auth]}`;
  if (auth === 'mission') headers.authorization = `Bearer ${missionToken}`;
  if (auth === 'daemon') headers.authorization = 'Bearer credential-daemon';
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${origin}/${id}/credentials${suffix}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, text: await res.text(), cache: res.headers.get('cache-control') };
}

test('credential HTTP CRUD is write-only, no-store and exact-owner even for administrators', async () => {
  const input = { origin: 'https://client.example/login', username: 'alice-private-username', password: 'alice-private-password' };
  const saved = await call(profile.id, 'POST', input);
  assert.equal(saved.status, 200); assert.equal(saved.cache, 'no-store');
  assert.ok(!saved.text.includes(input.username)); assert.ok(!saved.text.includes(input.password));
  const id = JSON.parse(saved.text).credential.id;
  const listed = await call(profile.id);
  assert.equal(JSON.parse(listed.text).credentials[0].id, id);
  assert.ok(!listed.text.includes(input.password)); assert.ok(!listed.text.includes(input.username));
  for (const user of [bob.id, admin.id]) {
    assert.equal((await call(profile.id, 'GET', undefined, user)).status, 404);
    assert.equal((await call(profile.id, 'POST', input, user)).status, 404);
    assert.equal((await call(profile.id, 'DELETE', undefined, user, `/${id}`)).status, 404);
  }
  assert.equal((await call(profile.id, 'GET', undefined, 'anonymous')).status, 401);
  assert.equal((await call(unowned.id, 'POST', input, 'daemon')).status, 403);
  assert.equal((await call(unowned.id, 'GET', undefined, 'daemon')).status, 403);
  assert.equal((await call(profile.id, 'GET', undefined, alice.id, `/${id}`)).status, 404, 'no plaintext read endpoint exists');
  assert.equal((await call(profile.id, 'DELETE', undefined, alice.id, `/${id}`)).status, 200);
  assert.deepEqual(JSON.parse((await call(profile.id)).text).credentials, []);
});

test('mission tokens can list only their fixed allowed profile and cannot save or delete passwords', async () => {
  const input = { origin: 'https://client.example', username: 'agent-account', password: 'never-in-response' };
  const saved = JSON.parse((await call(profile.id, 'POST', input)).text).credential;
  const listed = await call(profile.id, 'GET', undefined, 'mission');
  assert.equal(listed.status, 200); assert.equal(JSON.parse(listed.text).credentials[0].id, saved.id);
  assert.ok(!listed.text.includes(input.password));
  assert.equal((await call(other.id, 'GET', undefined, 'mission')).status, 404);
  const refused = await call(profile.id, 'POST', input, 'mission');
  assert.equal(refused.status, 403);
  // A coded refusal the webview translates, not English prose quoted as a detail.
  assert.deepEqual(JSON.parse(refused.text), { error: 'Only a signed-in owner can save or delete browser credentials.', code: 'browser_credential_owner_only' });
  assert.equal((await call(profile.id, 'DELETE', undefined, 'mission', `/${saved.id}`)).status, 403);
  assert.equal(JSON.parse((await call(profile.id)).text).credentials.length, 1);
  dbApi.setMissionBrowserProfile(mission, null);
  assert.equal((await call(profile.id, 'GET', undefined, 'mission')).status, 404);
});
