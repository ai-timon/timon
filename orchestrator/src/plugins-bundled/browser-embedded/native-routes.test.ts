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
import { createBrowserProfile } from '../../browser-profiles.js';
import { issueMissionApiToken } from '../../users/api-tokens.js';
import { hashSessionToken, SESSION_COOKIE } from '../../users/session.js';
import { createDaemonAuthMiddleware } from '../http/auth.js';
import { registerNativeBrowserRoutes } from './native-routes.js';
import { fillRequestedCredential, upsertBrowserCredential } from '../../browser-credentials.js';
import type { callNativeBrowser } from '../../native-browser-provider.js';
import { resolveMasterKey } from '../../secrets/key.js';
import type { ChromeDetection } from '../../host/chrome-binary.js';
import { attachRequestedSecret, getSecretRequest, insertSecretRequest, settleSecretRequest } from '../../secrets/requests.js';
import { createSecret } from '../../secrets/store.js';

resolveMasterKey({ keyring: null });

const alice = createTestAccount(dbApi, { email: 'native-alice@example.test', name: 'Alice', passwordHash: 'unused' });
const bob = createTestAccount(dbApi, { email: 'native-bob@example.test', name: 'Bob', passwordHash: 'unused' });
const cookie = randomUUID();
dbApi.createSession({ tokenHash: hashSessionToken(cookie), userId: alice.id, expiresAt: Date.now() + 60_000 });
const profile = createBrowserProfile({ name: 'Alice browser', owner_user_id: alice.id });
const other = createBrowserProfile({ name: 'Bob browser', owner_user_id: bob.id });
const mission = randomUUID();
dbApi.createMission(mission, 'native-agent', 'test', undefined, alice.id);
dbApi.setMissionBrowserProfile(mission, profile.id);
const missionToken = issueMissionApiToken(mission);
const calls: { id: string; command: Record<string, unknown> }[] = [];
let pageOrigin = 'https://login.example';
let fillRefuses = false;
let chrome: ChromeDetection = { found: true, binary: { path: '/usr/bin/google-chrome', flavour: 'chrome', name: 'Google Chrome' } };
const app = express();
app.use(createDaemonAuthMiddleware({ required: true, token: 'native-test-daemon' }));
app.use(express.json());
registerNativeBrowserRoutes(app, {
  capabilities: async () => ({ available: true }),
  detectChrome: () => chrome,
  call: async (id, command) => {
    calls.push({ id, command });
    if (command.action === 'screenshot') return { data: 'aW1hZ2U=', mimeType: 'image/jpeg', width: 1366, height: 768 };
    if (command.action === 'fillCredential' && fillRefuses) throw new Error(`page said no to ${String(command.password)}`);
    if (command.action === 'fillCredential') return { filled: true, password: command.password };
    if (command.action === 'evaluate' && command.expression === 'location.origin') return { result: pageOrigin };
    if (command.action === 'captureCredential') return { origin: 'https://saved.example', username: 'saved-user', password: 'saved-secret' };
    return { running: true, profileId: id, tabs: [], activeTabId: null, width: 1366, height: 768, mobile: false };
  },
});
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
test.after(() => server.close());
const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/native-browser`;
async function call(path: string, body?: object, auth: 'user' | 'mission' | 'daemon' | 'anonymous' = 'user') {
  const headers: Record<string, string> = {};
  if (auth === 'user') headers.cookie = `${SESSION_COOKIE}=${cookie}`;
  if (auth === 'mission') headers.authorization = `Bearer ${missionToken}`;
  if (auth === 'daemon') headers.authorization = 'Bearer native-test-daemon';
  if (body) headers['content-type'] = 'application/json';
  const res = await fetch(`${origin}/${path}`, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json() as any, cache: res.headers.get('cache-control') };
}

test('native HTTP requires identity, scopes profile ownership and ignores caller-supplied owner', async () => {
  assert.equal((await call('capabilities', undefined, 'anonymous')).status, 401);
  assert.equal((await call('capabilities')).cache, 'no-store');
  const list = await call('profiles');
  assert.deepEqual(list.json.profiles.map((p: { id: string }) => p.id), [profile.id]);
  assert.equal((await call(`${other.id}/command`, { action: 'start' })).status, 404);
  const created = await call('profiles', { name: 'Empty new profile', owner_user_id: bob.id });
  assert.equal(created.status, 200);
  assert.equal(created.json.profile.owner_user_id, alice.id);
  assert.deepEqual(created.json.profile.grants, {});
  const resolved = await call(`resolve?mission=${mission}`);
  assert.equal(resolved.json.profile.id, profile.id);
  const foreignMission = randomUUID();
  dbApi.createMission(foreignMission, 'native-other', 'test', undefined, bob.id);
  dbApi.setMissionBrowserProfile(foreignMission, other.id);
  assert.equal((await call(`resolve?mission=${foreignMission}`)).status, 404);
});

test('mission token cannot select another profile, issue a view ticket, create profiles or impersonate an operator', async () => {
  const count = calls.length;
  assert.equal((await call(`${other.id}/command`, { action: 'start' }, 'mission')).status, 404);
  assert.equal((await call('mission/command', { action: 'presentation' }, 'mission')).status, 403);
  assert.equal((await call('mission/command', { action: 'claimControl' }, 'mission')).status, 403);
  assert.equal((await call('profiles', { name: 'Unrestricted' }, 'mission')).status, 403);
  assert.equal((await call('mission/command', { action: 'start' }, 'daemon')).status, 403);
  assert.equal(calls.length, count, 'denied commands never reach Electron');
  const result = await call('mission/command', { action: 'start', profileId: other.id, missionId: 'other', clientId: 'spoofed-user' }, 'mission');
  assert.equal(result.status, 200);
  assert.equal(calls.at(-1)?.id, profile.id);
  assert.equal(calls.at(-1)?.command.profileId, undefined);
  const list = await call('profiles', undefined, 'mission');
  assert.deepEqual(list.json.profiles.map((p: { id: string }) => p.id), [profile.id]);
});

test('the agent never holds the lease: the user and the agent drive the browser together, only a second human client needs a takeover', async () => {
  const pane = 'human-browser-pane';
  const first = await call('mission/command', { action: 'navigate', url: 'https://example.com' }, 'mission');
  assert.equal(first.status, 200);
  assert.deepEqual(first.json.result.control, { holder: null, kind: null }, 'an agent command takes no control');
  const viewer = await call(`${profile.id}/command`, { action: 'start', clientId: pane });
  assert.deepEqual(viewer.json.result.control, { holder: null, kind: null });
  // The user acts while the agent is mid-session: no 409, no "take control" step.
  assert.equal((await call(`${profile.id}/command`, { action: 'resize', width: 390, height: 844, clientId: pane })).status, 200);
  assert.equal((await call('mission/command', { action: 'input', event: { type: 'key', key: 'Enter' } }, 'mission')).status, 200, 'the agent keeps working while the user holds the lease');
  assert.equal((await call('mission/command', { action: 'navigate', url: 'https://example.com/next' }, 'mission')).status, 200);
  const sameStatus = await call(`${profile.id}/command`, { action: 'status', clientId: pane });
  assert.deepEqual(sameStatus.json.result.control, { holder: 'you', kind: 'human' });
  // Another human client (a phone) is a spectator until it takes over.
  const phone = 'human-phone-pane';
  assert.equal((await call(`${profile.id}/command`, { action: 'resize', width: 300, height: 600, clientId: phone })).status, 409);
  const previous = calls.length;
  assert.equal((await call(`${profile.id}/command`, { action: 'claimControl', clientId: phone })).status, 200);
  assert.equal(calls[previous]?.command.action, 'revokePresentation');
  assert.equal((await call('mission/command', { action: 'screenshot' }, 'mission')).status, 200);
  assert.equal((await call(`${profile.id}/command`, { action: 'releaseControl', clientId: phone })).status, 200);
  assert.equal((await call('mission/command', { action: 'releaseControl' }, 'mission')).status, 403, 'releasing is the user\'s gesture');
});

test('a disabled or missing fixed profile refuses browser access without inheriting General', async () => {
  dbApi.setMissionBrowserProfile(mission, null);
  assert.equal((await call('mission/command', { action: 'start' }, 'mission')).status, 403);
  assert.equal((await call(`resolve?mission=${mission}`)).json.profile, null);
  dbApi.setMissionBrowserProfile(mission, `bp-${randomUUID()}`);
  assert.equal((await call('mission/command', { action: 'start' }, 'mission')).status, 403);
});

test('media viewers are authenticated independently of control and cannot spoof the provider actor', async () => {
  const mediaProfile = createBrowserProfile({ name: 'Stream', owner_user_id: alice.id });
  const command = `${mediaProfile.id}/command`;
  assert.equal((await call(command, { action: 'claimControl', clientId: 'first-controller' })).status, 200);
  assert.equal((await call(command, { action: 'mediaStart', audio: true, clientId: 'other-spectator', mediaActor: 'mission:spoofed' })).status, 200);
  assert.equal(calls.at(-1)?.command.mediaActor, `user:${alice.id}:other-spectator`);
  const status = await call(command, { action: 'status', clientId: 'other-spectator' });
  assert.deepEqual(status.json.result.control, { holder: 'other', kind: 'human' });
  assert.equal((await call(command, { action: 'downloadRead', downloadId: 'completed-download', clientId: 'other-spectator' })).status, 200);
  assert.equal((await call(command, { action: 'mediaRead', mediaActor: 'mission:spoofed' })).status, 400);
  dbApi.setMissionBrowserProfile(mission, profile.id);
  const before = calls.length;
  for (const action of ['mediaStart', 'mediaOffer', 'mediaRead', 'mediaRenew', 'mediaStop', 'permissionRespond', 'audio', 'saveCredentialFromPage']) {
    assert.equal((await call('mission/command', { action, clientId: 'other-spectator' }, 'mission')).status, 403);
  }
  assert.equal(calls.length, before);
});

test('public credential commands bind vault IDs, enforce the lease and never return captured plaintext', async () => {
  const secretsProfile = createBrowserProfile({ name: 'Credentials', owner_user_id: alice.id });
  const row = upsertBrowserCredential(secretsProfile, { origin: 'https://login.example', username: 'real-user', password: 'real-secret' });
  const path = `${secretsProfile.id}/command`;
  const listed = await call(path, { action: 'listCredentials' });
  assert.equal(listed.status, 200);
  assert.equal(listed.json.result.credentials[0].id, row.id);
  assert.equal(JSON.stringify(listed.json).includes('real-secret'), false);
  assert.equal((await call(path, { action: 'fillCredential', credentialId: row.id }, 'daemon')).status, 404);
  assert.equal((await call(path, { action: 'captureCredential', clientId: 'secret-owner' })).status, 400);
  const filled = await call(path, { action: 'fillCredential', credentialId: row.id, clientId: 'secret-owner', origin: 'https://evil.example', username: 'fake', password: 'fake' });
  assert.deepEqual(filled.json.result, { filled: true });
  assert.deepEqual(calls.at(-1)?.command, { action: 'fillCredential', origin: 'https://login.example', credentialId: row.id, username: 'real-user', password: 'real-secret', commandActor: 'human' });
  assert.equal((await call(path, { action: 'fillCredential', credentialId: row.id, clientId: 'other-viewer' })).status, 409);
  const saved = await call(path, { action: 'saveCredentialFromPage', clientId: 'secret-owner', expression: 'arbitrary script' });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.result.credential.origin, 'https://saved.example');
  assert.equal(JSON.stringify(saved.json).includes('saved-secret'), false);
  assert.deepEqual(calls.at(-1)?.command, { action: 'captureCredential', commandActor: 'human' });
  // A credential from another profile is not addressable, with or without control.
  assert.equal((await call(`${profile.id}/command`, { action: 'fillCredential', credentialId: row.id, clientId: 'secret-owner' })).status, 404);
  await call(`${profile.id}/command`, { action: 'claimControl', clientId: 'secret-owner' });
  assert.equal((await call(`${profile.id}/command`, { action: 'fillCredential', credentialId: row.id, clientId: 'secret-owner' })).status, 404);
});

test('debug commands reach only the mission profile; a spectator reads them but cannot throttle the page', async () => {
  dbApi.setMissionBrowserProfile(mission, profile.id);
  assert.equal((await call(`${profile.id}/command`, { action: 'consoleList' }, 'anonymous')).status, 401);
  const before = calls.length;
  for (const action of ['consoleList', 'consoleGet', 'networkList', 'networkGet', 'emulate', 'performanceStart', 'performanceStop']) {
    const result = await call('mission/command', { action, profileId: other.id }, 'mission');
    assert.equal(result.status, 200, action);
    assert.equal(calls.at(-1)?.id, profile.id);
    assert.equal(calls.at(-1)?.command.action, action);
  }
  assert.equal(calls.length, before + 7);
  const debugProfile = createBrowserProfile({ name: 'Debug', owner_user_id: alice.id });
  const command = `${debugProfile.id}/command`;
  assert.equal((await call(command, { action: 'claimControl', clientId: 'debug-controller' })).status, 200);
  assert.equal((await call(command, { action: 'networkList', clientId: 'debug-spectator' })).status, 200);
  assert.equal((await call(command, { action: 'emulate', networkConditions: 'Offline', clientId: 'debug-spectator' })).status, 409);
});

test('signing in with Chrome is the user\'s act, and the daemon alone names the binary', async () => {
  dbApi.setMissionBrowserProfile(mission, profile.id);
  const before = calls.length;
  for (const action of ['chromeSigninStart', 'chromeSigninStatus', 'chromeSigninFinish', 'chromeSigninCancel']) {
    assert.equal((await call('mission/command', { action, clientId: 'agent-spoof' }, 'mission')).status, 403, action);
  }
  assert.equal(calls.length, before, 'an agent never reaches the sign-in window');
  const pane = 'chrome-signin-pane';
  const own = createBrowserProfile({ name: 'Sign-in', owner_user_id: alice.id });
  const started = await call(`${own.id}/command`, { action: 'chromeSigninStart', clientId: pane, executable: '/bin/sh', url: 'https://accounts.google.com/' });
  assert.equal(started.status, 200);
  const sent = calls.at(-1)!;
  assert.equal(sent.command.action, 'chromeSigninStart');
  assert.equal(sent.command.executable, '/usr/bin/google-chrome', 'a path from the caller is replaced by the detected one');
  assert.equal(sent.command.url, 'https://accounts.google.com/');
  // Other commands never carry an executable either.
  await call(`${own.id}/command`, { action: 'navigate', url: 'https://example.com', executable: '/bin/sh', clientId: pane });
  assert.equal(calls.at(-1)?.command.executable, undefined);
  assert.equal((await call(`${own.id}/command`, { action: 'chromeSigninStatus', clientId: pane })).status, 200);
  assert.equal((await call(`${own.id}/command`, { action: 'chromeSigninFinish', clientId: pane })).status, 200);
  // The page becomes an argument of the launched browser: only a web address gets that far.
  const count = calls.length;
  for (const url of ['file:///etc/passwd', '--remote-allow-origins=*', 'javascript:alert(1)', 42, `https://example.com/${'a'.repeat(16_384)}`]) {
    assert.equal((await call(`${own.id}/command`, { action: 'chromeSigninStart', clientId: pane, url })).status, 400, String(url).slice(0, 40));
  }
  assert.equal(calls.length, count, 'no refused page reaches the desktop');
});

test('without an installed Chrome the sign-in says so and launches nothing', async () => {
  const pane = 'chrome-missing-pane';
  const own = createBrowserProfile({ name: 'No Chrome', owner_user_id: alice.id });
  for (const reason of ['none', 'confined'] as const) {
    chrome = { found: false, reason };
    const count = calls.length;
    const refused = await call(`${own.id}/command`, { action: 'chromeSigninStart', clientId: pane });
    assert.equal(refused.status, 409);
    assert.match(refused.json.error, reason === 'none' ? /No Google Chrome/ : /snap or flatpak/);
    assert.equal(calls.length, count);
  }
  chrome = { found: true, binary: { path: '/usr/bin/google-chrome', flavour: 'chrome', name: 'Google Chrome' } };
});

/** A value the user typed for `missionId` (`secret_request` with an origin), as the card's answer leaves it. */
function requestedPageValue(missionId: string, name: string, value: string, lifetime: 'once' | 'mission'): string {
  const id = randomUUID();
  insertSecretRequest({ id, mission_id: missionId, owner_user_id: alice.id, agent: 'native-agent', name, reason: 'sign in',
    lifetime, broker_spec: null, browser_origin: 'https://login.example', project: null, mission_title: 'test',
    created_at: Date.now(), expires_at: Date.now() + 60_000 });
  settleSecretRequest(id, 'provided');
  attachRequestedSecret(id, createSecret({ name, value, mode: 'inject' }).id);
  return id;
}

test('a value requested for a page is listed and filled for its mission only, and a once value is spent by the fill', async () => {
  const VALUE = 'typed-for-the-page-0123456789';
  const requestId = requestedPageValue(mission, 'LOGIN_PASSWORD', VALUE, 'once');
  const credentialId = `sr-${requestId}`;

  const listed = await call('mission/command', { action: 'listCredentials' }, 'mission');
  assert.equal(listed.status, 200);
  const entry = listed.json.result.credentials.find((c: { id: string }) => c.id === credentialId);
  assert.deepEqual(entry, { id: credentialId, origin: 'https://login.example', label: 'LOGIN_PASSWORD', source: 'request', lifetime: 'once' });
  assert.ok(!JSON.stringify(listed.json).includes(VALUE));
  const human = await call(`${profile.id}/command`, { action: 'listCredentials' });
  assert.ok(!human.json.result.credentials.some((c: { id: string }) => c.id === credentialId), 'a human list never shows a mission\'s value');
  assert.equal((await call(`${profile.id}/command`, { action: 'fillCredential', credentialId, clientId: 'secret-owner' })).status, 404);

  const sibling = randomUUID();
  dbApi.createMission(sibling, 'native-agent', 'test', undefined, alice.id);
  dbApi.setMissionBrowserProfile(sibling, profile.id);
  const siblingToken = issueMissionApiToken(sibling);
  const siblingFill = await fetch(`${origin}/mission/command`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${siblingToken}` },
    body: JSON.stringify({ action: 'fillCredential', credentialId }) });
  assert.equal(siblingFill.status, 404, 'another mission of the same agent and profile');

  pageOrigin = 'https://elsewhere.example';
  const before = calls.length;
  assert.equal((await call('mission/command', { action: 'fillCredential', credentialId }, 'mission')).status, 409);
  assert.ok(!calls.slice(before).some((c) => c.command.action === 'fillCredential'), 'the wrong page never receives the value');
  assert.equal(getSecretRequest(requestId)!.spent_at, null, 'a refusal before the hand-off spends nothing');

  pageOrigin = 'https://login.example';
  const filled = await call('mission/command', { action: 'fillCredential', credentialId, username: 'smuggled', password: 'smuggled' }, 'mission');
  assert.equal(filled.status, 200);
  assert.deepEqual(filled.json.result, { filled: true });
  assert.ok(!JSON.stringify(filled.json).includes(VALUE));
  assert.deepEqual(calls.at(-1)?.command, { action: 'fillCredential', origin: 'https://login.example', credentialId, username: null, password: VALUE, commandActor: 'agent' });

  const row = getSecretRequest(requestId)!;
  assert.ok(row.spent_at && row.erased_at, 'once: spent and erased by the fill');
  assert.equal(dbApi.getSecretsByName('LOGIN_PASSWORD').length, 0);
  const journal = dbApi.listSecretAccess(row.secret_id!, 20);
  assert.ok(journal.some((l) => l.kind === 'fill' && l.outcome === 'ok'));
  assert.ok(journal.some((l) => l.kind === 'fill' && l.outcome === 'denied'));
  assert.ok(journal.some((l) => l.kind === 'erase'));
  assert.ok(!JSON.stringify(journal).includes(VALUE));
  assert.equal((await call('mission/command', { action: 'fillCredential', credentialId }, 'mission')).status, 404, 'once: no second fill');
});

test('a mission page value survives a fill, and a refused fill still spends a once value it handed over', async () => {
  const kept = requestedPageValue(mission, 'SITE_PIN', 'mission-page-value-000111', 'mission');
  pageOrigin = 'https://login.example';
  assert.equal((await call('mission/command', { action: 'fillCredential', credentialId: `sr-${kept}` }, 'mission')).status, 200);
  assert.equal((await call('mission/command', { action: 'fillCredential', credentialId: `sr-${kept}` }, 'mission')).status, 200);
  assert.equal(getSecretRequest(kept)!.erased_at, null);

  const VALUE = 'once-refused-by-the-page-000';
  const burnt = requestedPageValue(mission, 'OTP_CODE', VALUE, 'once');
  fillRefuses = true;
  try {
    const refused = await call('mission/command', { action: 'fillCredential', credentialId: `sr-${burnt}` }, 'mission');
    assert.equal(refused.status, 409);
    assert.ok(!JSON.stringify(refused.json).includes(VALUE), 'the provider\'s words never come back');
  } finally {
    fillRefuses = false;
  }
  assert.ok(getSecretRequest(burnt)!.erased_at, 'handed to the page: spent even though the page refused');
  assert.equal(dbApi.getSecretsByName('OTP_CODE').length, 0);
});

test('two fills racing for a once value: one reaches the page, the other is refused', async () => {
  // The route queues a profile's commands, but the fill itself must not rely on
  // that: it awaits the page check between its lookup and the hand-off.
  const VALUE = 'raced-page-value-0000000000';
  const requestId = requestedPageValue(mission, 'RACED_PASSWORD', VALUE, 'once');
  const credentialId = `sr-${requestId}`;
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let originChecks = 0;
  const handed: unknown[] = [];
  const gated: typeof callNativeBrowser = async (_id, command) => {
    if (command.action === 'evaluate') {
      originChecks += 1;
      await gate;
      return { result: 'https://login.example' };
    }
    handed.push(command.password);
    return { filled: true };
  };
  const fills = [fillRequestedCredential(profile, mission, credentialId, gated), fillRequestedCredential(profile, mission, credentialId, gated)]
    .map((p) => p.then(() => 200, (e: Error & { status?: number }) => e.status ?? 500));
  // Both looked the value up and wait on the page check: neither has claimed it yet.
  while (originChecks < 2) await new Promise((resolve) => setImmediate(resolve));
  release();
  assert.deepEqual((await Promise.all(fills)).sort(), [200, 404]);
  assert.deepEqual(handed, [VALUE], 'the value reached the provider once');
  const row = getSecretRequest(requestId)!;
  assert.ok(row.spent_at && row.erased_at);
  const journal = dbApi.listSecretAccess(row.secret_id!, 20);
  assert.ok(journal.some((l) => l.kind === 'fill' && l.outcome === 'denied' && l.detail === 'once: already used'));
  assert.ok(!JSON.stringify(journal).includes(VALUE));
});
