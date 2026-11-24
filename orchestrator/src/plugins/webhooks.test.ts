/**
 * Incoming webhooks of plugins: the host verifies, the plugin only handles.
 *
 * What these tests protect: an unsigned, forged, stale or replayed call never
 * reaches a plugin's code; an unknown, disabled or unsubscribed webhook answers
 * exactly like a wrong signature; the secret is shown once and then appears in
 * no response and no log; the replay guard outlives a restart; the handler
 * acts as an account, never as an anonymous caller.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';
import { Context } from '@deepseek-ai/cordis';
import type { RequestAuth } from '../users/identity.js';
import type { PluginHost } from './context.js';
import type { PluginLoader, PluginStatus } from './loader.js';
import type { PluginWebhookRequest } from './webhooks.js';

const { resolveMasterKey } = await import('../secrets/key.js');
const { dbApi } = await import('../db.js');
const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { createBodyParser } = await import('../kernel/body-parser.js');
const { registerRoutes } = await import('../plugins-bundled/plugins/routes.js');
const { attachPluginLoader } = await import('./runtime.js');
const { readManifest, PLUGIN_API_VERSION } = await import('./manifest.js');
const { createPluginContext, PluginPermissionError } = await import('./context.js');
const { currentPluginOwnerUserId, currentPluginViewer, pluginCallUnattended, runPluginRequest } = await import('./als.js');
const {
  PLUGIN_WEBHOOK_STORE, ROTATION_GRACE_MS, PluginWebhookOwnerError, pluginWebhookStatus, purgePluginWebhookSecrets,
  registerPluginWebhook, registerPluginWebhookRoute, rotatePluginWebhookSecret, runAsPluginWebhookOwner, webhookPublisherOf,
} = await import('./webhooks.js');
const { signStandard } = await import('../triggers/signature.js');
const { PLUGIN_HOOK_PATH, pluginHookPath, pluginHookSlug } = await import('./webhook-path.js');
const { currentTodoOrigin } = await import('../todo-origin.js');
const { pluginKvIdentity, sealWithVault } = await import('../secrets/store.js');

resolveMasterKey({ keyring: null });

const PLUGIN_ID = 'hook-probe';
const DAEMON = 'daemon-test-token';

function member(name: string, opts: { superadmin?: boolean; plugin?: boolean }) {
  const id = randomUUID();
  const user = createTestAccount(dbApi, { id, email: `${name}-${id}@example.test`, name, passwordHash: 'x', isSuperadmin: opts.superadmin ?? false });
  if (opts.plugin) {
    grantTestPermissions(dbApi, id, [`plugin:${PLUGIN_ID}`]);
  }
  return user;
}
const admin = member('admin', { superadmin: true });
const bob = member('bob', { plugin: true });
const carol = member('carol', {});

const IDENTITIES: Record<string, RequestAuth> = {
  admin: { kind: 'session', user: admin, isSuperadmin: true },
  bob: { kind: 'session', user: bob, isSuperadmin: false, permissions: [`plugin:${PLUGIN_ID}`] },
  carol: { kind: 'session', user: carol, isSuperadmin: false, permissions: [] },
};

function manifestOf(id: string, raw: Record<string, unknown>) {
  const res = readManifest({ timon: { id, apiVersion: PLUGIN_API_VERSION, ...raw } });
  if (!res.ok) throw new Error(res.message);
  return res.manifest;
}

const probeManifest = manifestOf(PLUGIN_ID, {
  permissions: ['webhooks:receive', 'todos:read'],
  webhooks: [{ name: 'issues', auth: 'standard' }, { name: 'quiet' }],
});

function statusOf(id: string, manifest: ReturnType<typeof manifestOf>): PluginStatus {
  return { id, pkg: `@acme/${id}`, dir: '/nonexistent', version: '1.0.0', state: 'active', reason: null, error: null, manifest, client: false, signed: true, signature: { hash: 'a'.repeat(64), keyId: 'test' } };
}
/** The package the fake loader lists under an id: the one its secrets are bound to. */
const publisherOf = (id: string) => webhookPublisherOf(statusOf(id, probeManifest));

const fakeLoader = {
  list: () => [statusOf(PLUGIN_ID, probeManifest)],
  bundles: { get: () => null },
  covers: { get: () => null },
} as unknown as PluginLoader;

let clock = Date.now();
const logs: string[] = [];
for (const level of ['log', 'info', 'warn', 'error'] as const) {
  const original = console[level];
  console[level] = (...args: unknown[]) => { logs.push(args.map(String).join(' ')); original(...args); };
}

async function daemonApp(): Promise<{ base: string; server: Server }> {
  const app = express();
  attachPluginLoader(app, fakeLoader);
  app.use((req, res, next) => {
    const as = req.header('x-test-as');
    if (as && IDENTITIES[as]) { req.auth = IDENTITIES[as]; next(); return; }
    createDaemonAuthMiddleware({ token: DAEMON, required: true })(req, res, next);
  });
  // The daemon's own parser: the hook only gets raw bytes if it lets it.
  app.use(createBodyParser());
  registerPluginWebhookRoute(app, { now: () => clock, handlerTimeoutMs: 300 });
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, server };
}
const first = await daemonApp();
let base = first.base;
const servers = [first.server];
test.after(() => { for (const s of servers) { s.closeAllConnections(); s.close(); } });

type Json = Record<string, unknown>;
async function api(method: string, path: string, body?: unknown, as: string | null = 'admin') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (as) headers['x-test-as'] = as;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, text: await res.text() };
}

/** A Standard Webhooks call, the way a remote service sends it. */
async function deliver(name: string, secret: string | null, payload: unknown, opts: {
  id?: string; at?: number; plugin?: string; headers?: Record<string, string>;
} = {}) {
  const raw = JSON.stringify(payload);
  const id = opts.id ?? `msg_${randomUUID()}`;
  const ts = Math.floor((opts.at ?? clock) / 1000);
  const headers: Record<string, string> = { 'content-type': 'application/json', ...opts.headers };
  if (secret) {
    headers['webhook-id'] = id;
    headers['webhook-timestamp'] = String(ts);
    headers['webhook-signature'] = signStandard(secret, id, ts, raw);
  }
  const res = await fetch(`${base}/api/plugins/hooks/${opts.plugin ?? PLUGIN_ID}/${name}`, { method: 'POST', headers, body: raw });
  return { status: res.status, text: await res.text(), id };
}

/** The plugin, as the loader would mount it. */
async function plugin(manifest = probeManifest, publisher: ReturnType<typeof publisherOf> | null = publisherOf(manifest.id)) {
  const root = new Context();
  let inner!: Context;
  const fiber = await root.plugin({ name: 'plugin-holder', apply(ctx: Context) { inner = ctx; } });
  const host = { webhooks: { register: registerPluginWebhook, asOwner: runAsPluginWebhookOwner } } as unknown as PluginHost;
  return { ctx: createPluginContext(inner, { manifest, version: '1.0.0', ...(publisher ? { publisher } : {}) }, host), dispose: () => fiber.dispose() };
}

const received: Array<{ req: PluginWebhookRequest; user: string | undefined; owner: string | null; origin: string }> = [];
let failNext = 0;
const probe = await plugin();
probe.ctx.webhooks.on('issues', async (req) => {
  if (failNext > 0) { failNext--; throw new Error('upstream down'); }
  const origin = currentTodoOrigin();
  received.push({ req, user: probe.ctx.user()?.id, owner: currentPluginOwnerUserId(PLUGIN_ID), origin: `${origin.kind}:${origin.id}` });
});

let secret = '';
/** Every secret this file was ever shown, checked against the logs at the end. */
const issued: string[] = [];
const remember = (value: string): string => { issued.push(value); return value; };

test('manifest: webhooks need their permission, a slug name, unique names; `hooks` is a reserved id', () => {
  const ok = readManifest({ timon: { id: 'hook-ok', apiVersion: PLUGIN_API_VERSION, permissions: ['webhooks:receive'], webhooks: [{ name: 'gh' }] } });
  assert.equal(ok.ok, true);
  if (ok.ok) assert.deepEqual(ok.manifest.webhooks, [{ name: 'gh', auth: 'standard' }]);
  const refuse = (raw: Record<string, unknown>) => {
    const res = readManifest({ timon: { id: 'hook-ko', apiVersion: PLUGIN_API_VERSION, ...raw } });
    assert.equal(res.ok, false, JSON.stringify(raw));
  };
  refuse({ webhooks: [{ name: 'gh' }] });
  refuse({ permissions: ['webhooks:receive'], webhooks: [{ name: 'Bad Name' }] });
  refuse({ permissions: ['webhooks:receive'], webhooks: [{ name: 'gh' }, { name: 'gh' }] });
  refuse({ permissions: ['webhooks:receive'], webhooks: [{ name: 'gh', auth: 'none' }] });
  assert.equal(readManifest({ timon: { id: 'hooks', apiVersion: PLUGIN_API_VERSION } }).ok, false);
});

test('facade: permission required, name must be declared, one handler per name', async () => {
  const bare = await plugin(manifestOf('hook-bare', {}));
  assert.throws(() => bare.ctx.webhooks.on('issues', () => undefined), PluginPermissionError);
  assert.throws(() => probe.ctx.webhooks.on('nope', () => undefined), /not declared/);
  assert.throws(() => probe.ctx.webhooks.on('issues', () => undefined), /already has a handler/);
});

test('management: status visible to plugin users without secret; generating is a superadmin gesture', async () => {
  assert.equal((await api('GET', `/api/plugins/${PLUGIN_ID}/-/webhooks`, undefined, null)).status, 401);
  assert.equal((await api('GET', `/api/plugins/${PLUGIN_ID}/-/webhooks`, undefined, 'carol')).status, 404);
  const before = JSON.parse((await api('GET', `/api/plugins/${PLUGIN_ID}/-/webhooks`, undefined, 'bob')).text) as { webhooks: Json[] };
  assert.deepEqual(before.webhooks.map((w) => [w.name, w.configured, w.listening, w.path]), [
    ['issues', false, true, `/api/plugins/hooks/${PLUGIN_ID}/issues`],
    ['quiet', false, false, `/api/plugins/hooks/${PLUGIN_ID}/quiet`],
  ]);
  assert.equal((await api('POST', `/api/plugins/${PLUGIN_ID}/-/webhooks/issues/secret`, {}, 'bob')).status, 403);
  assert.equal((await api('POST', `/api/plugins/${PLUGIN_ID}/-/webhooks/issues/secret`, {}, null)).status, 401);
  assert.equal((await api('POST', `/api/plugins/${PLUGIN_ID}/-/webhooks/nope/secret`, {})).status, 404);
  assert.equal((await api('POST', `/api/plugins/${PLUGIN_ID}/-/webhooks/issues/secret`, { keepPrevious: 'yes' })).status, 400);

  // Declared but no secret yet: answers like an unknown webhook.
  assert.equal((await deliver('issues', 'whsec_c2VjcmV0LXNpZ25pbmcta2V5LXZhbHVlLTEyMzQ=', { a: 1 })).status, 401);

  const created = await api('POST', `/api/plugins/${PLUGIN_ID}/-/webhooks/issues/secret`, {});
  assert.equal(created.status, 201);
  const body = JSON.parse(created.text) as { secret: string; webhook: Json };
  secret = remember(body.secret);
  assert.match(secret, /^whsec_[A-Za-z0-9+/=]{32}$/);
  assert.equal(body.webhook.configured, true);
  assert.deepEqual(body.webhook.owner, { id: admin.id, name: 'admin' });

  const stored = dbApi.pluginKvGet(PLUGIN_WEBHOOK_STORE, `@settings/${PLUGIN_ID}/issues`)!;
  assert.ok(stored.startsWith('enc:1:'));
  assert.ok(!stored.includes(secret) && !stored.includes(secret.slice('whsec_'.length)));
  for (const as of ['admin', 'bob']) {
    const read = await api('GET', `/api/plugins/${PLUGIN_ID}/-/webhooks`, undefined, as);
    assert.equal(read.status, 200);
    assert.ok(!read.text.includes(secret.slice('whsec_'.length)));
  }
});

test('a signed call reaches the handler once, as the owner account, with plugin origin', async () => {
  const sent = await deliver('issues', secret, { action: 'closed', number: 7 });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(received.length, 1);
  const got = received[0]!;
  assert.equal(got.req.id, sent.id);
  assert.deepEqual(got.req.json(), { action: 'closed', number: 7 });
  assert.equal(got.req.headers['webhook-signature'], undefined);
  assert.equal(got.req.headers['webhook-id'], sent.id);
  assert.equal(got.user, admin.id);
  assert.equal(got.owner, admin.id);
  assert.equal(got.origin, `plugin:${PLUGIN_ID}`);

  const replay = await deliver('issues', secret, { action: 'closed', number: 7 }, { id: sent.id });
  assert.equal(replay.status, 200);
  assert.match(replay.text, /duplicate/);
  assert.equal(received.length, 1);
});

test('missing, forged and stale signatures get 401; unknown, unsubscribed and unloaded webhooks answer the same', async () => {
  const count = received.length;
  const refused = [
    await deliver('issues', null, { x: 1 }),
    await deliver('issues', 'whsec_d3JvbmctZ3Vlc3Mtc2VjcmV0LWtleS0wMDAwMDA=', { x: 1 }),
    await deliver('issues', secret, { x: 1 }, { at: clock - 10 * 60_000 }),
    await deliver('issues', secret, { x: 1 }, { at: clock + 10 * 60_000 }),
    await deliver('quiet', secret, { x: 1 }),
    await deliver('nope', secret, { x: 1 }),
    await deliver('issues', secret, { x: 1 }, { plugin: 'not-installed' }),
  ];
  for (const r of refused) {
    assert.equal(r.status, 401);
    assert.equal(r.text, JSON.stringify({ error: 'authentication failed' }));
  }
  // A path no plugin can have never reaches the route: the auth gate refuses it.
  assert.equal((await deliver('issues', secret, { x: 1 }, { plugin: 'Bad%20Id' })).status, 401);
  // A signature over other bytes than the body sent.
  const raw = JSON.stringify({ x: 1 });
  const id = `msg_${randomUUID()}`;
  const ts = Math.floor(clock / 1000);
  const tampered = await fetch(`${base}/api/plugins/hooks/${PLUGIN_ID}/issues`, {
    method: 'POST', body: JSON.stringify({ x: 2 }),
    headers: { 'webhook-id': id, 'webhook-timestamp': String(ts), 'webhook-signature': signStandard(secret, id, ts, raw) },
  });
  assert.equal(tampered.status, 401);
  assert.equal(received.length, count);

  // An unloaded plugin answers like one that never existed.
  const gone = await plugin(manifestOf('hook-gone', { permissions: ['webhooks:receive'], webhooks: [{ name: 'issues' }] }));
  let calls = 0;
  gone.ctx.webhooks.on('issues', () => { calls++; });
  const goneSecret = remember(rotatePluginWebhookSecret('hook-gone', 'issues', carol.id, publisherOf('hook-gone')));
  assert.equal((await deliver('issues', goneSecret, {}, { plugin: 'hook-gone' })).status, 401, 'its owner may not use the plugin');
  const goneOwned = remember(rotatePluginWebhookSecret('hook-gone', 'issues', null, publisherOf('hook-gone')));
  assert.equal((await deliver('issues', goneOwned, {}, { plugin: 'hook-gone' })).status, 200);
  assert.equal(calls, 1);
  // Unloading the plugin removes its registration.
  await gone.dispose();
  const after = await deliver('issues', goneOwned, {}, { plugin: 'hook-gone' });
  assert.equal(after.status, 401);
  assert.equal(after.text, JSON.stringify({ error: 'authentication failed' }));
  assert.equal(calls, 1);
});

test('path format: /api/plugins/hooks/<slug>/<name>, never `@` nor `%`, scoped ids turned into slugs', () => {
  assert.equal(pluginHookSlug('@timon/todo-connector-discord'), 'timon-todo-connector-discord');
  assert.equal(pluginHookPath('@timon/todo-connector-discord', 'todo'), '/api/plugins/hooks/timon-todo-connector-discord/todo');
  assert.equal(pluginHookPath(PLUGIN_ID, 'issues'), `/api/plugins/hooks/${PLUGIN_ID}/issues`);
  for (const id of ['@timon/todo-connector-discord', PLUGIN_ID, '@a/b']) {
    const path = pluginHookPath(id, 'todo');
    assert.ok(!/[@%]/.test(path), path);
    assert.match(path, /^\/api\/plugins\/hooks\/[a-z0-9-]+\/[a-z0-9-]+$/);
    assert.ok(PLUGIN_HOOK_PATH.test(path), path);
  }
  for (const id of ['@Acme/X', '@acme/x y', '@acme/é', '']) assert.equal(pluginHookSlug(id), null, id); // french-ok: an accented id the slug refuses
  assert.equal(PLUGIN_HOOK_PATH.test('/api/plugins/hooks/%40timon%2Ftodo/todo'), false);
});

test('a scoped plugin is reached through its slug; another id giving the same slug is refused', async () => {
  const scoped = await plugin({ ...manifestOf('placeholder', { permissions: ['webhooks:receive'], webhooks: [{ name: 'todo' }] }), id: '@timon/todo-connector-discord' });
  let calls = 0;
  scoped.ctx.webhooks.on('todo', () => { calls++; });
  const scopedSecret = remember(rotatePluginWebhookSecret('@timon/todo-connector-discord', 'todo', null, publisherOf('@timon/todo-connector-discord')));
  const sent = await deliver('todo', scopedSecret, { ok: true }, { plugin: 'timon-todo-connector-discord' });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(calls, 1);
  const again = await deliver('todo', scopedSecret, { ok: true }, { plugin: 'timon-todo-connector-discord', id: sent.id });
  assert.equal(again.status, 200);
  assert.equal(calls, 1);

  const twin = await plugin(manifestOf('timon-todo-connector-discord', { permissions: ['webhooks:receive'], webhooks: [{ name: 'other' }] }));
  assert.throws(() => twin.ctx.webhooks.on('other', () => undefined), /already used by plugin `@timon\/todo-connector-discord`/);
  await scoped.dispose();
  // Freed with the first plugin.
  twin.ctx.webhooks.on('other', () => undefined);
  await twin.dispose();
});

test('without an owner account the handler runs as the plugin job, never anonymous', async () => {
  const job = await plugin(manifestOf('hook-job', { permissions: ['webhooks:receive'], webhooks: [{ name: 'ping' }] }));
  let seen: { owner: string | null; user: string | undefined } | null = null;
  job.ctx.webhooks.on('ping', () => { seen = { owner: currentPluginOwnerUserId('hook-job'), user: job.ctx.user()?.id }; });
  const jobSecret = remember(rotatePluginWebhookSecret('hook-job', 'ping', null, publisherOf('hook-job')));
  assert.equal((await deliver('ping', jobSecret, {}, { plugin: 'hook-job' })).status, 200);
  assert.deepEqual(seen, { owner: 'plugin:hook-job', user: undefined });
});

test('asOwner: the scope of a delivery without one; never from inside a request; nothing runs without a usable owner', async () => {
  const owned = await plugin(manifestOf('hook-owned', { permissions: ['webhooks:receive'], webhooks: [{ name: 'ping' }, { name: 'idle' }] }));
  const scope = () => {
    const origin = currentTodoOrigin();
    return { owner: currentPluginOwnerUserId('hook-owned'), user: owned.ctx.user()?.id, viewer: currentPluginViewer('hook-owned')?.id,
      unattended: pluginCallUnattended(), origin: `${origin.kind}:${origin.id}` };
  };
  // Refusals first: a user's route never borrows the owner's identity.
  assert.throws(() => owned.ctx.webhooks.asOwner('nope', scope), /not declared/);
  const bare = await plugin(manifestOf('hook-owned-bare', {}));
  assert.throws(() => bare.ctx.webhooks.asOwner('ping', scope), PluginPermissionError);
  assert.deepEqual(await owned.ctx.webhooks.asOwner('ping', scope), { ran: false, reason: 'not_listening' });
  owned.ctx.webhooks.on('ping', () => undefined);
  assert.deepEqual(await owned.ctx.webhooks.asOwner('ping', scope), { ran: false, reason: 'no_secret' });

  // Dana may use this plugin; bob and carol may not.
  const dana = member('dana', {});
  grantTestPermissions(dbApi, dana.id, ['plugin:hook-owned']);
  remember(rotatePluginWebhookSecret('hook-owned', 'ping', dana.id, publisherOf('hook-owned')));
  const bobAuth = { viewer: { id: bob.id, isSuperadmin: false, permissions: [] }, user: undefined, ownerUserId: bob.id };
  await assert.rejects(runPluginRequest(bobAuth, () => owned.ctx.webhooks.asOwner('ping', scope)), PluginWebhookOwnerError);
  const carolAuth = { viewer: { id: carol.id, isSuperadmin: false, permissions: [] }, user: undefined, ownerUserId: carol.id };
  await assert.rejects(runPluginRequest(carolAuth, () => owned.ctx.webhooks.asOwner('ping', scope)), PluginWebhookOwnerError);

  // As the account that generated the secret, unattended, with the plugin's origin — like a delivery.
  assert.deepEqual(await owned.ctx.webhooks.asOwner('ping', scope), {
    ran: true, value: { owner: dana.id, user: dana.id, viewer: dana.id, unattended: true, origin: 'plugin:hook-owned' },
  });
  // The scope ends with `fn`: the caller is a job again.
  assert.equal(currentPluginOwnerUserId('hook-owned'), 'plugin:hook-owned');

  // The owner lost the plugin: nothing runs.
  let ran = false;
  grantTestPermissions(dbApi, dana.id, []);
  assert.deepEqual(await owned.ctx.webhooks.asOwner('ping', () => { ran = true; }), { ran: false, reason: 'owner_unavailable' });
  assert.equal(ran, false);
  await owned.dispose();
  await bare.dispose();
  assert.deepEqual(await owned.ctx.webhooks.asOwner('ping', scope), { ran: false, reason: 'not_listening' });
});

test('a failing handler answers 5xx and the retry of the same id runs again', async () => {
  const count = received.length;
  failNext = 1;
  const failed = await deliver('issues', secret, { n: 1 });
  assert.equal(failed.status, 502);
  assert.equal(failed.text, JSON.stringify({ status: 'error' }));
  const retried = await deliver('issues', secret, { n: 1 }, { id: failed.id });
  assert.equal(retried.status, 200);
  assert.equal(received.length, count + 1);
});

test('a handler past the time limit answers 5xx', async () => {
  const slow = await plugin(manifestOf('hook-slow', { permissions: ['webhooks:receive'], webhooks: [{ name: 'slow' }] }));
  slow.ctx.webhooks.on('slow', () => new Promise((resolve) => setTimeout(resolve, 1_000)));
  const slowSecret = remember(rotatePluginWebhookSecret('hook-slow', 'slow', null, publisherOf('hook-slow')));
  assert.equal((await deliver('slow', slowSecret, {}, { plugin: 'hook-slow' })).status, 502);
});

test('a retry while the first call still runs gets 409, never a 2xx that would lose a failing delivery', async () => {
  const gated = await plugin(manifestOf('hook-gated', { permissions: ['webhooks:receive'], webhooks: [{ name: 'gate' }] }));
  let open!: (fail: boolean) => void;
  let calls = 0;
  gated.ctx.webhooks.on('gate', () => {
    calls++;
    if (calls > 1) return undefined;
    return new Promise<void>((resolve, reject) => { open = (fail) => (fail ? reject(new Error('upstream down')) : resolve()); });
  });
  const gateSecret = remember(rotatePluginWebhookSecret('hook-gated', 'gate', null, publisherOf('hook-gated')));
  const id = `msg_${randomUUID()}`;
  const firstCall = deliver('gate', gateSecret, {}, { plugin: 'hook-gated', id });
  while (!open) await new Promise((resolve) => setTimeout(resolve, 5));
  const meanwhile = await deliver('gate', gateSecret, {}, { plugin: 'hook-gated', id });
  assert.equal(meanwhile.status, 409);
  assert.equal(calls, 1);
  open(true);
  assert.equal((await firstCall).status, 502);
  const retried = await deliver('gate', gateSecret, {}, { plugin: 'hook-gated', id });
  assert.equal(retried.status, 200);
  assert.equal(calls, 2);
  assert.equal((await deliver('gate', gateSecret, {}, { plugin: 'hook-gated', id })).text, JSON.stringify({ status: 'duplicate' }));
  await gated.dispose();
});

test('rotation: both secrets verify during the grace, the old one stops after it or on revocation', async () => {
  const old = secret;
  const rotated = JSON.parse((await api('POST', `/api/plugins/${PLUGIN_ID}/-/webhooks/issues/secret`, {})).text) as { secret: string; webhook: Json };
  secret = remember(rotated.secret);
  assert.notEqual(secret, old);
  assert.equal(typeof rotated.webhook.previousUntil, 'number');
  assert.equal((await deliver('issues', old, { r: 1 })).status, 200);
  assert.equal((await deliver('issues', secret, { r: 2 })).status, 200);

  const saved = clock;
  // The routes stamp the rotation with the real clock.
  clock = Date.now() + ROTATION_GRACE_MS + 60_000;
  assert.equal((await deliver('issues', old, { r: 3 })).status, 401);
  assert.equal((await deliver('issues', secret, { r: 4 })).status, 200);
  clock = saved;

  assert.equal((await deliver('issues', old, { r: 5 })).status, 200);
  assert.equal((await api('POST', `/api/plugins/${PLUGIN_ID}/-/webhooks/issues/revoke-previous`, {}, 'bob')).status, 403);
  const revoked = await api('POST', `/api/plugins/${PLUGIN_ID}/-/webhooks/issues/revoke-previous`, {});
  assert.equal(revoked.status, 200);
  assert.equal((await deliver('issues', old, { r: 6 })).status, 401);

  const leaked = secret;
  secret = remember((JSON.parse((await api('POST', `/api/plugins/${PLUGIN_ID}/-/webhooks/issues/secret`, { keepPrevious: false })).text) as { secret: string }).secret);
  assert.equal((await deliver('issues', leaked, { r: 7 })).status, 401);
  assert.equal((await deliver('issues', secret, { r: 8 })).status, 200);
});

test('an owner who lost the plugin stops the webhook', async () => {
  const bobSecret = remember(rotatePluginWebhookSecret(PLUGIN_ID, 'issues', bob.id, publisherOf(PLUGIN_ID)));
  assert.equal((await deliver('issues', bobSecret, {})).status, 200);
  grantTestPermissions(dbApi, bob.id, []);
  assert.equal((await deliver('issues', bobSecret, {})).status, 401);
  secret = remember(rotatePluginWebhookSecret(PLUGIN_ID, 'issues', admin.id, publisherOf(PLUGIN_ID), { keepPrevious: false }));
});

test('body over the limit is refused before verification', async () => {
  const res = await fetch(`${base}/api/plugins/hooks/${PLUGIN_ID}/issues`, { method: 'POST', body: 'x'.repeat(300 * 1024) });
  assert.equal(res.status, 413);
});

test('the replay guard survives a restart', async () => {
  const sent = await deliver('issues', secret, { restart: true });
  assert.equal(sent.status, 200);
  const count = received.length;
  const second = await daemonApp();
  servers.push(second.server);
  base = second.base;
  const replay = await deliver('issues', secret, { restart: true }, { id: sent.id });
  assert.equal(replay.status, 200);
  assert.match(replay.text, /duplicate/);
  assert.equal(received.length, count);
});

test('an uninstalled plugin forgets its secrets: the same id installed again refuses the old sender', async () => {
  const old = remember(rotatePluginWebhookSecret(PLUGIN_ID, 'issues', admin.id, publisherOf(PLUGIN_ID), { keepPrevious: false }));
  const before = await deliver('issues', old, { reborn: 1 });
  assert.equal(before.status, 200, before.text);
  // A neighbour id is not this plugin's: its record survives the purge.
  const neighbour = `${PLUGIN_ID}-other`;
  remember(rotatePluginWebhookSecret(neighbour, 'issues', admin.id, publisherOf(neighbour)));

  assert.deepEqual(purgePluginWebhookSecrets(PLUGIN_ID).sort(), ['issues']);
  assert.equal(dbApi.pluginKvList(PLUGIN_WEBHOOK_STORE, `@settings/${PLUGIN_ID}/`).length, 0);
  assert.equal(pluginWebhookStatus(neighbour, 'issues').configured, true);
  assert.equal(pluginWebhookStatus(PLUGIN_ID, 'issues').configured, false);

  // The handler is still registered, as for a package republished under the
  // same id: the old secret, the old previous one, nothing verifies any more.
  const count = received.length;
  const after = await deliver('issues', old, { reborn: 2 });
  assert.equal(after.status, 401);
  assert.equal(after.text, JSON.stringify({ error: 'authentication failed' }));
  assert.equal(received.length, count);
  assert.deepEqual(purgePluginWebhookSecrets(PLUGIN_ID), [], 'nothing left to forget');
  purgePluginWebhookSecrets(neighbour);
});

test('a plugin removed by hand: another package under its id never verifies with the old secret', async () => {
  const id = 'hook-reborn';
  const decl = manifestOf(id, { permissions: ['webhooks:receive'], webhooks: [{ name: 'events' }] });
  const original = { pkg: `@acme/${id}`, trust: 'signed' } as const;
  let calls = 0;
  const first = await plugin(decl, original);
  first.ctx.webhooks.on('events', () => { calls++; });
  const old = remember(rotatePluginWebhookSecret(id, 'events', admin.id, original));
  assert.equal((await deliver('events', old, { n: 1 }, { plugin: id })).status, 200);
  // Folder deleted, `npm uninstall`: no purge, the record is still there.
  await first.dispose();
  assert.equal(pluginWebhookStatus(id, 'events', 'standard', original).configured, true);

  for (const intruder of [
    { pkg: `@mallory/${id}`, trust: 'signed' },
    { pkg: original.pkg, trust: 'unsigned' },
  ] as const) {
    const next = await plugin(decl, intruder);
    next.ctx.webhooks.on('events', () => { calls++; });
    const refused = await deliver('events', old, { n: 2 }, { plugin: id });
    assert.equal(refused.status, 401, JSON.stringify(intruder));
    assert.equal(refused.text, JSON.stringify({ error: 'authentication failed' }));
    const status = pluginWebhookStatus(id, 'events', 'standard', intruder);
    assert.deepEqual([status.configured, status.needsRegeneration, status.regenerationReason], [true, true, 'publisher']);
    await next.dispose();
  }
  assert.equal(calls, 1, 'no other package ever ran on the old sender\'s call');
  // A host that does not say which package loaded is not trusted with a bound secret.
  const anonymous = await plugin(decl, null);
  assert.equal((await deliver('events', old, { n: 3 }, { plugin: id })).status, 401);
  await anonymous.dispose();

  // The same package loading again keeps working, without a new secret.
  const back = await plugin(decl, original);
  back.ctx.webhooks.on('events', () => { calls++; });
  assert.equal((await deliver('events', old, { n: 4 }, { plugin: id })).status, 200);
  await back.dispose();

  // A new secret set for the newcomer drops the old one at once, grace or not.
  const intruder = { pkg: `@mallory/${id}`, trust: 'signed' } as const;
  const theirs = await plugin(decl, intruder);
  theirs.ctx.webhooks.on('events', () => { calls++; });
  const fresh = remember(rotatePluginWebhookSecret(id, 'events', admin.id, intruder, { keepPrevious: true }));
  assert.equal(pluginWebhookStatus(id, 'events', 'standard', intruder).previousUntil, null);
  assert.equal((await deliver('events', old, { n: 5 }, { plugin: id })).status, 401);
  assert.equal((await deliver('events', fresh, { n: 6 }, { plugin: id })).status, 200);
  await theirs.dispose();
  purgePluginWebhookSecrets(id);
});

test('the signed release of an unsigned copy keeps its secret; an unsigned copy coming back does not', async () => {
  const id = 'hook-signed-release';
  const decl = manifestOf(id, { permissions: ['webhooks:receive'], webhooks: [{ name: 'events' }] });
  const candidate = { pkg: `@acme/${id}`, trust: 'unsigned' } as const;
  const release = { pkg: `@acme/${id}`, trust: 'signed' } as const;
  const first = await plugin(decl, candidate);
  first.ctx.webhooks.on('events', () => undefined);
  const secret = remember(rotatePluginWebhookSecret(id, 'events', admin.id, candidate));
  assert.equal((await deliver('events', secret, { n: 1 }, { plugin: id })).status, 200);
  await first.dispose();

  const signed = await plugin(decl, release);
  signed.ctx.webhooks.on('events', () => undefined);
  assert.equal((await deliver('events', secret, { n: 2 }, { plugin: id })).status, 200, 'an update, not another package');
  assert.equal(pluginWebhookStatus(id, 'events', 'standard', release).needsRegeneration, false);
  await signed.dispose();

  // Bound to the signed release now: the way back is refused, like any takeover.
  assert.equal(pluginWebhookStatus(id, 'events', 'standard', candidate).regenerationReason, 'publisher');
  const back = await plugin(decl, candidate);
  back.ctx.webhooks.on('events', () => undefined);
  assert.equal((await deliver('events', secret, { n: 3 }, { plugin: id })).status, 401);
  await back.dispose();
  // Another npm name, signed or not, never takes it.
  assert.equal(pluginWebhookStatus(id, 'events', 'standard', { pkg: `@mallory/${id}`, trust: 'signed' }).regenerationReason, 'publisher');
  purgePluginWebhookSecrets(id);
});

test('a secret stored before packages were recorded is bound to the first plugin that loads it', async () => {
  const id = 'hook-legacy';
  const decl = manifestOf(id, { permissions: ['webhooks:receive'], webhooks: [{ name: 'events' }] });
  const legacy = remember('whsec_' + Buffer.from('legacy-secret-made-before-0.1.6').toString('base64'));
  const key = `@settings/${id}/events`;
  dbApi.pluginKvSet(PLUGIN_WEBHOOK_STORE, key, sealWithVault(JSON.stringify({
    scheme: 'standard', source: 'generated', current: legacy, previous: null, previousUntil: null,
    ownerUserId: admin.id, createdAt: clock, rotatedAt: clock,
  }), pluginKvIdentity(PLUGIN_WEBHOOK_STORE, key)));
  const owner = { pkg: `@acme/${id}`, trust: 'signed' } as const;
  // Unbound, it would verify for anyone: the status cannot tell yet.
  assert.equal(pluginWebhookStatus(id, 'events', 'standard', { pkg: '@x/y', trust: 'unsigned' }).needsRegeneration, false);

  const first = await plugin(decl, owner);
  first.ctx.webhooks.on('events', () => undefined);
  assert.equal((await deliver('events', legacy, { n: 1 }, { plugin: id })).status, 200);
  await first.dispose();
  assert.equal(pluginWebhookStatus(id, 'events', 'standard', owner).needsRegeneration, false);
  assert.equal(pluginWebhookStatus(id, 'events', 'standard', { pkg: `@mallory/${id}`, trust: 'signed' }).regenerationReason, 'publisher');

  const other = await plugin(decl, { pkg: `@mallory/${id}`, trust: 'signed' });
  other.ctx.webhooks.on('events', () => undefined);
  assert.equal((await deliver('events', legacy, { n: 2 }, { plugin: id })).status, 401, 'adopted once, never rebound');
  await other.dispose();
  purgePluginWebhookSecrets(id);
});

test('no secret ever reached a log line', () => {
  const all = logs.join('\n');
  assert.ok(issued.length >= 8);
  for (const value of issued) {
    assert.ok(!all.includes(value.slice('whsec_'.length)), 'secret found in logs');
  }
});
