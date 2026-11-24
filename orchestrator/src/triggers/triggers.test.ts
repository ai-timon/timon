/**
 * Native triggers end to end (TODO #216): the public webhook behind the real
 * daemon auth, the management API and its permission model, and the three
 * sources. The security cases come first: anonymous, wrong secret, replay.
 */
import { createTestAccount, grantTestPermissions } from '../../tests/helpers/accounts.js';
import '../test-home.js';
import '../../tests/helpers/paid-license.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createHmac, randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { RequestAuth } from '../users/identity.js';

const { db, dbApi } = await import('../db.js');
// Trigger secrets are sealed: the key goes to this test home's file, never to the OS keyring.
const { resolveMasterKey } = await import('../secrets/key.js');
resolveMasterKey({ keyring: null });
await import('../../tests/helpers/claude-provider.js');

const { AGENTS_DIR } = await import('../paths.js');
const { createDaemonAuthMiddleware } = await import('../plugins-bundled/http/auth.js');
const { registerRoutes } = await import('../plugins-bundled/triggers/routes.js');
const { registerRoutes: registerRoutineRoutes } = await import('../plugins-bundled/routines/routes.js');
const { registerTriggerWebhook, unauthenticatedHooksPossible } = await import('./webhook.js');
const { config, setConfig } = await import('../config/load.js');
const { insertTrigger } = await import('./store.js');
const { createEventDispatcher, eventFromBus } = await import('./events.js');
const { deferredEventListener, switchOffUnapprovedAgentTriggers } = await import('../plugins-bundled/triggers/index.js');
const { flushAllCoalesced, SCHEDULE_PROVIDER_GRACE_MS, tickSchedules } = await import('./engine.js');
const { ACTION_UNAVAILABLE, registerActionProvider } = await import('./actions.js');
const { signGeneric } = await import('./signature.js');
const { patchTodo } = await import('../plugins-bundled/kanban/todo-api.js');
const { registerTodoExtension } = await import('../project-todo-extensions.js');
const { outcomeExtension } = await import('../plugins-bundled/todo-outcomes/outcome.js');
const { ensureOutcomeTable } = await import('../plugins-bundled/todo-outcomes/store.js');
process.env.TIMON_TODO_OUTCOME_ENABLED = '1';
ensureOutcomeTable();
registerTodoExtension(outcomeExtension);
/** An outcome, written the way `PATCH /api/project-todo/:id` writes it. */
const setOutcome = (id: number, body: Record<string, unknown>) => patchTodo(dbApi.getProjectTodo(id)!, {}, body);
const { createRoutine } = await import('../routines.js');
const { createBodyParser } = await import('../kernel/body-parser.js');

const DAEMON = 'daemon-test-token';
const admin = createTestAccount(dbApi, { email: 'trig-admin@example.com', name: 'Admin', passwordHash: 'x', isSuperadmin: true });
const bob = createTestAccount(dbApi, { email: 'trig-bob@example.com', name: 'Bob', passwordHash: 'x', isSuperadmin: false });
const bobMission = randomUUID();
dbApi.createMission(bobMission, 'helper', 'test', undefined, bob.id);
mkdirSync(join(AGENTS_DIR, 'helper'), { recursive: true });
/** Delegation roster: `lead` may hand work to `worker` only, `narrow` to nobody. */
const orchestrates = (agent: string, list: string[]) =>
  writeFileSync(join(AGENTS_DIR, agent, 'config.json'), JSON.stringify({ orchestrates: list }));
for (const name of ['lead', 'narrow', 'worker', 'outsider']) mkdirSync(join(AGENTS_DIR, name), { recursive: true });
orchestrates('lead', ['worker']);
orchestrates('narrow', []);
const leadMission = randomUUID();
dbApi.createMission(leadMission, 'lead', 'test', undefined, bob.id);
const narrowMission = randomUUID();
dbApi.createMission(narrowMission, 'narrow', 'test', undefined, bob.id);
const FULL = ['triggers:manage', 'notify', 'kanban:write'];

/** Identities a real login would produce, injected to test the route logic. */
const IDENTITIES: Record<string, RequestAuth> = {
  admin: { kind: 'session', user: admin, isSuperadmin: true },
  bob: { kind: 'session', user: bob, isSuperadmin: false },
  'agent-notify': { kind: 'api-token', user: bob, isSuperadmin: false, permissions: ['triggers:manage', 'notify'], missionId: bobMission },
  'agent-full': { kind: 'api-token', user: bob, isSuperadmin: false, permissions: FULL, missionId: bobMission },
  'agent-lead': { kind: 'api-token', user: bob, isSuperadmin: false, permissions: FULL, missionId: leadMission },
  'agent-narrow': { kind: 'api-token', user: bob, isSuperadmin: false, permissions: FULL, missionId: narrowMission },
  'agent-gone': { kind: 'api-token', user: bob, isSuperadmin: false, permissions: FULL, missionId: randomUUID() },
};

let listensOnLoopback = true;
let behindTlsProxy = false;
const app = express();
app.use((req, _res, next) => {
  const as = req.header('x-test-as');
  if (as && IDENTITIES[as]) { req.auth = IDENTITIES[as]; next(); return; }
  createDaemonAuthMiddleware({ token: DAEMON, required: true })(req, _res, next);
});
// The daemon's own body parser, mounted before every route as in
// kernel-boot: the hook only gets its raw bytes if that parser lets it.
app.use(createBodyParser());
registerTriggerWebhook(app, { listensOnLoopback: () => listensOnLoopback, behindTlsProxy: () => behindTlsProxy });
registerRoutes(app, { listensOnLoopback: () => listensOnLoopback });
registerRoutineRoutes(app);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
test.after(() => { server.closeAllConnections(); server.close(); });

type Json = Record<string, unknown>;
async function api(method: string, path: string, body?: unknown, as: string | null = 'admin') {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (as) headers['x-test-as'] = as;
  const res = await fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() as Json };
}
async function hook(slug: string, raw: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}/api/triggers/hooks/${slug}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: raw });
  return { status: res.status, body: await res.json() as Json };
}
/** The user switching an agent's trigger on: an agent's is born off (TODO #529). */
async function switchOn(id: string) {
  const res = await api('PATCH', `/api/triggers/${id}`, { enabled: true });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal((res.body.trigger as Json).enabled, true);
}
const githubSig = (secret: string, raw: string) => `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
const todosBy = (author: string) => (db.prepare(`SELECT * FROM project_todo WHERE author = ?`).all(author) as Array<{ text: string; project: string | null; urgency: string | null; owner_user_id: string | null; notes: string | null }>);

const ISSUE_TODO = {
  type: 'todo', text: 'Bug: {issue.title}', notes: 'From {sender.login}: {issue.body}', project: '{repository.name}', urgency: '{label}',
};

test('management routes: anonymous 401, no permission 403, secret shown once only', async () => {
  assert.equal((await api('GET', '/api/triggers', undefined, null)).status, 401);
  assert.equal((await api('POST', '/api/triggers', { source: 'event' }, null)).status, 401);
  assert.equal((await api('GET', '/api/triggers', undefined, 'bob')).status, 403);
  const created = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'GitHub issues', slug: 'gh-issues', config: { auth: 'github' },
    filter: { op: 'equals', path: 'action', value: 'opened' }, actions: [ISSUE_TODO],
  });
  assert.equal(created.status, 201);
  assert.match(String(created.body.secret), /^[a-f0-9]{64}$/);
  const trigger = created.body.trigger as Json;
  assert.equal(trigger.url, '/api/triggers/hooks/gh-issues');
  assert.equal(trigger.has_secret, true);
  assert.equal('secret' in trigger, false);
  const read = await api('GET', `/api/triggers/${String(trigger.id)}`);
  assert.equal(JSON.stringify(read.body).includes(String(created.body.secret)), false);
  const list = await api('GET', '/api/triggers');
  assert.equal(JSON.stringify(list.body).includes(String(created.body.secret)), false);
  const duplicate = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'dup', slug: 'gh-issues', config: { auth: 'github' }, actions: [ISSUE_TODO],
  });
  assert.equal(duplicate.status, 409);
  // The English stays for the CLI; the code and its param are what the Triggers page translates.
  assert.deepEqual(duplicate.body, { error: 'slug already used: gh-issues', code: 'trigger_slug_taken', params: { slug: 'gh-issues' } });
  assert.equal((await api('POST', '/api/triggers', {
    source: 'webhook', name: 'bad', slug: 'x', config: { auth: 'github' }, actions: [{ type: 'script', run: 'rm -rf /' }],
  })).status, 400);
});

test('webhook: anonymous, wrong secret and unknown route all get the same 401', async () => {
  const created = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'Signed', slug: 'signed', config: { auth: 'github' }, actions: [ISSUE_TODO],
  });
  const secret = String(created.body.secret);
  const raw = JSON.stringify({ action: 'opened', issue: { title: 'x' } });
  const anonymous = await hook('signed', raw);
  const wrong = await hook('signed', raw, { 'x-hub-signature-256': githubSig('not-the-secret', raw) });
  const unknown = await hook('no-such-route', raw, { 'x-hub-signature-256': githubSig(secret, raw) });
  for (const res of [anonymous, wrong, unknown]) assert.deepEqual(res, { status: 401, body: { error: 'authentication failed' } });
  // Not a management route in disguise: the daemon auth still guards the rest.
  assert.equal((await fetch(`${base}/api/triggers`)).status, 401);
  const journal = await api('GET', `/api/triggers/${String((created.body.trigger as Json).id)}/deliveries`);
  const statuses = (journal.body.deliveries as Array<{ status: string; reason: string }>).map((d) => `${d.status}:${d.reason}`);
  assert.deepEqual(statuses, ['rejected:bad_signature', 'rejected:missing_signature']);
});

test('webhook: a valid GitHub delivery creates the TO DO, a replay is a duplicate, a non-match is ignored', async () => {
  const created = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'Discord bugs', slug: 'discord-bugs', config: { auth: 'github' },
    filter: { all: [{ op: 'equals', path: 'action', value: 'opened' }, { op: 'equals', path: 'headers.X-GitHub-Event', value: 'issues' }] },
    actions: [ISSUE_TODO],
  });
  const secret = String(created.body.secret);
  const payload = { action: 'opened', label: 'BUG', issue: { title: 'Crash on start', body: 'steps {secret}' }, sender: { login: 'ana' }, repository: { name: 'timon' } };
  const raw = JSON.stringify(payload);
  const headers = { 'x-hub-signature-256': githubSig(secret, raw), 'x-github-delivery': 'delivery-1', 'x-github-event': 'issues' };
  const first = await hook('discord-bugs', raw, headers);
  assert.equal(first.status, 200);
  assert.equal(first.body.status, 'received');
  const todos = todosBy('trigger:discord-bugs');
  assert.equal(todos.length, 1);
  assert.deepEqual(
    { text: todos[0]!.text, project: todos[0]!.project, urgency: todos[0]!.urgency, owner: todos[0]!.owner_user_id, notes: todos[0]!.notes },
    { text: 'Bug: Crash on start', project: 'timon', urgency: 'bug', owner: admin.id, notes: 'From ana: steps {secret}' },
  );
  // Replay of the very same signed request: refused as a duplicate.
  assert.deepEqual(await hook('discord-bugs', raw, headers), { status: 200, body: { status: 'duplicate' } });
  assert.equal(todosBy('trigger:discord-bugs').length, 1);
  const closed = JSON.stringify({ ...payload, action: 'closed' });
  const ignored = await hook('discord-bugs', closed, { ...headers, 'x-hub-signature-256': githubSig(secret, closed), 'x-github-delivery': 'delivery-2' });
  assert.deepEqual(ignored, { status: 200, body: { status: 'ignored', reason: 'filter' } });
  assert.equal(todosBy('trigger:discord-bugs').length, 1);
  // The journal never holds the credential header.
  const journal = await api('GET', `/api/triggers/${String((created.body.trigger as Json).id)}/deliveries`);
  assert.deepEqual((journal.body.deliveries as Array<{ status: string }>).map((d) => d.status), ['ignored', 'duplicate', 'received']);
  assert.equal(JSON.stringify(journal.body).includes(headers['x-hub-signature-256']), false);
});

test('webhook: generic V2 refuses a stale timestamp and a replay inside the window', async () => {
  const created = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'Relay', slug: 'relay', config: { auth: 'generic' },
    actions: [{ type: 'notify', title: 'Relay: {text}' }],
  });
  const secret = String(created.body.secret);
  const raw = JSON.stringify({ text: 'hello' });
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await hook('relay', raw, signGeneric(secret, raw, now - 3600))).status, 401);
  const fresh = signGeneric(secret, raw, now);
  assert.equal((await hook('relay', raw, fresh)).body.status, 'received');
  assert.equal((await hook('relay', raw, fresh)).body.status, 'duplicate');
  const big = JSON.stringify({ text: 'x'.repeat(300 * 1024) });
  assert.equal((await hook('relay', big, signGeneric(secret, big, now))).status, 413);
});

test('replay with a changed, added or dropped delivery id is still a duplicate', async () => {
  const notes = (id: string) => (db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE source = ?`).get(`trigger:${id}`) as { n: number }).n;
  const generic = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'Replay generic', slug: 'replay-generic', config: { auth: 'generic' }, actions: [{ type: 'notify', title: 'g {n}' }],
  });
  const gId = String((generic.body.trigger as Json).id);
  const raw = JSON.stringify({ n: 1 });
  const signed = signGeneric(String(generic.body.secret), raw, Math.floor(Date.now() / 1000));
  assert.equal((await hook('replay-generic', raw, { ...signed, 'x-timon-delivery': 'a' })).body.status, 'received');
  for (const variant of [{ ...signed, 'x-timon-delivery': 'b' }, signed, { ...signed, 'x-timon-delivery': 'c' }]) {
    assert.deepEqual(await hook('replay-generic', raw, variant), { status: 200, body: { status: 'duplicate' } });
  }
  assert.equal(notes(gId), 1);
  // A replay carrying a fresh id does not burn it: the real sender's call with
  // that id and a new signature still goes through.
  const next = signGeneric(String(generic.body.secret), JSON.stringify({ n: 2 }), Math.floor(Date.now() / 1000));
  assert.equal((await hook('replay-generic', JSON.stringify({ n: 2 }), { ...next, 'x-timon-delivery': 'b' })).body.status, 'received');
  assert.equal(notes(gId), 2);

  const github = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'Replay github', slug: 'replay-github', config: { auth: 'github' }, actions: [{ type: 'notify', title: 'h {n}' }],
  });
  const hId = String((github.body.trigger as Json).id);
  const sig = { 'x-hub-signature-256': githubSig(String(github.body.secret), raw) };
  assert.equal((await hook('replay-github', raw, { ...sig, 'x-github-delivery': 'one' })).body.status, 'received');
  for (const variant of [{ ...sig, 'x-github-delivery': 'two' }, sig]) {
    assert.deepEqual(await hook('replay-github', raw, variant), { status: 200, body: { status: 'duplicate' } });
  }
  assert.equal(notes(hId), 1);
  // First call WITHOUT an id, replayed with one added: still the same proof.
  const bare = JSON.stringify({ n: 3 });
  const bareSig = { 'x-hub-signature-256': githubSig(String(github.body.secret), bare) };
  assert.equal((await hook('replay-github', bare, bareSig)).body.status, 'received');
  assert.deepEqual(await hook('replay-github', bare, { ...bareSig, 'x-github-delivery': 'added' }), { status: 200, body: { status: 'duplicate' } });
  const genericBare = signGeneric(String(generic.body.secret), bare, Math.floor(Date.now() / 1000));
  assert.equal((await hook('replay-generic', bare, genericBare)).body.status, 'received');
  assert.deepEqual(await hook('replay-generic', bare, { ...genericBare, 'x-timon-delivery': 'added' }), { status: 200, body: { status: 'duplicate' } });
  assert.equal(notes(hId), 2);
  assert.equal(notes(gId), 3);
});

test('forged calls do not spend a route budget; signed ones do', async () => {
  const created = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'Tight', slug: 'tight', config: { auth: 'github', rate_limit: 2 }, actions: [{ type: 'notify', title: 'tight {n}' }],
  });
  const secret = String(created.body.secret);
  const call = (n: number, key = secret) => {
    const raw = JSON.stringify({ n });
    return hook('tight', raw, { 'x-hub-signature-256': githubSig(key, raw), 'x-github-delivery': `t-${n}-${key.length}` });
  };
  for (let n = 0; n < 5; n++) assert.equal((await call(n, 'forged-secret')).status, 401);
  assert.equal((await call(1)).status, 200);
  assert.equal((await call(2)).status, 200);
  assert.equal((await call(3)).status, 429);
});

test('webhook without auth: loopback only, never chosen by an agent', async () => {
  assert.equal((await api('POST', '/api/triggers', {
    source: 'webhook', name: 'Open', slug: 'open-agent', config: { auth: 'none' }, actions: [{ type: 'notify', title: 'x' }],
  }, 'agent-full')).status, 403);
  const created = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'Open', slug: 'open-local', config: { auth: 'none' }, actions: [{ type: 'notify', title: 'local {n}' }],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.secret, undefined);
  assert.equal((await hook('open-local', '{"n":1}')).body.status, 'received');
  // Through the app relay, the loopback peer is the app, not the sender.
  assert.equal((await hook('open-local', '{"n":3}', { 'x-timon-relayed-by': 'app' })).status, 401);
  listensOnLoopback = false;
  try {
    assert.equal((await hook('open-local', '{"n":2}')).status, 401);
    assert.equal((await api('POST', '/api/triggers', {
      source: 'webhook', name: 'Open2', slug: 'open-2', config: { auth: 'none' }, actions: [{ type: 'notify', title: 'x' }],
    })).status, 400);
  } finally { listensOnLoopback = true; }
});

test('webhook without auth: a proxy on this host is not a sender on this machine', async () => {
  const created = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'Proxied', slug: 'open-proxied', config: { auth: 'none' }, actions: [{ type: 'notify', title: 'proxied {n}' }],
  });
  assert.equal(created.status, 201);
  const id = String((created.body.trigger as Json).id);
  // `tailscale serve` in front of a loopback daemon: the peer is 127.0.0.1 for every tailnet device.
  const proxied: Array<Record<string, string>> = [
    { forwarded: 'for=100.64.0.7;proto=https' },
    { 'x-forwarded-for': '100.64.0.7' },
    { 'x-forwarded-host': 'server.tailnet.ts.net' },
    { 'x-forwarded-proto': 'https' },
    { 'x-real-ip': '100.64.0.7' },
    { 'tailscale-user-login': 'someone@example.com' },
    { 'tailscale-headers-info': 'https://tailscale.com/s/serve-headers' },
  ];
  for (const headers of proxied) {
    assert.equal((await hook('open-proxied', '{"n":1}', headers)).status, 401, JSON.stringify(headers));
  }
  behindTlsProxy = true;
  try {
    // A proxy that writes no header is still a proxy once the operator says one stands in front.
    assert.equal((await hook('open-proxied', '{"n":2}')).status, 401);
  } finally { behindTlsProxy = false; }
  // A script on this machine calling the daemon directly still gets through.
  assert.equal((await hook('open-proxied', '{"n":3}')).body.status, 'received');
  const journal = await api('GET', `/api/triggers/${id}/deliveries`);
  const reasons = (journal.body.deliveries as Array<{ status: string; reason: string | null }>)
    .filter((d) => d.status === 'rejected').map((d) => d.reason ?? '');
  assert.equal(reasons.length, proxied.length + 1);
  for (const headers of proxied) {
    const name = Object.keys(headers)[0]!;
    assert.ok(reasons.includes(`unauthenticated route called through a proxy (${name} header)`), name);
  }
  assert.ok(reasons.includes('unauthenticated route refused while the daemon is declared behind a proxy (daemon.behindTlsProxy)'));
});

test('webhook without auth: a browser page on this machine is not a local sender', async () => {
  const created = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'Paged', slug: 'open-paged', config: { auth: 'none' }, actions: [{ type: 'notify', title: 'paged {n}' }],
  });
  assert.equal(created.status, 201);
  const id = String((created.body.trigger as Json).id);
  const self = new URL(base).host;
  // What a page's `fetch` to 127.0.0.1 carries, from another site or another port of localhost.
  const pages: Array<Record<string, string>> = [
    { origin: 'https://evil.example' },
    { 'sec-fetch-site': 'cross-site' },
    { 'sec-fetch-site': 'same-site', origin: 'http://localhost:5173' },
    { 'sec-fetch-site': 'none' },
    { origin: 'null' },
    { origin: 'not a url' },
    { 'sec-fetch-site': 'same-origin', origin: 'https://evil.example' },
  ];
  for (const headers of pages) {
    const res = await hook('open-paged', '{"n":1}', headers);
    assert.equal(res.status, 401, JSON.stringify(headers));
    // The same neutral answer as an unknown route: no oracle on which slugs exist.
    assert.deepEqual(res.body, { error: 'authentication failed' });
  }
  // A script or `curl` on this machine, and the daemon's own origin, still get through.
  assert.equal((await hook('open-paged', '{"n":2}')).body.status, 'received');
  assert.equal((await hook('open-paged', '{"n":3}', { origin: `http://${self}`, 'sec-fetch-site': 'same-origin' })).body.status, 'received');
  const journal = await api('GET', `/api/triggers/${id}/deliveries`);
  const rejected = (journal.body.deliveries as Array<{ status: string; reason: string | null }>).filter((d) => d.status === 'rejected');
  assert.equal(rejected.length, pages.length);
  for (const d of rejected) assert.match(d.reason ?? '', /^unauthenticated route called by a page of another origin/);
});

test('a signed webhook still answers a browser that holds its signature', async () => {
  const created = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'Signed paged', slug: 'signed-paged', config: { auth: 'github' }, actions: [{ type: 'notify', title: 'signed {n}' }],
  });
  assert.equal(created.status, 201);
  const secret = String(created.body.secret);
  const raw = '{"n":1}';
  const res = await hook('signed-paged', raw, {
    origin: 'https://evil.example', 'sec-fetch-site': 'cross-site',
    'x-hub-signature-256': githubSig(secret, raw), 'x-github-delivery': randomUUID(),
  });
  assert.equal(res.body.status, 'received');
});

test('no unauthenticated webhook can be created on a daemon declared behind a proxy', () => {
  const saved = config();
  try {
    setConfig({ ...saved, daemon: { ...saved.daemon, listen: { ...saved.daemon.listen, host: '127.0.0.1' }, behindTlsProxy: false } });
    assert.equal(unauthenticatedHooksPossible(), true);
    setConfig({ ...saved, daemon: { ...saved.daemon, listen: { ...saved.daemon.listen, host: '127.0.0.1' }, behindTlsProxy: true } });
    assert.equal(unauthenticatedHooksPossible(), false);
    setConfig({ ...saved, daemon: { ...saved.daemon, listen: { ...saved.daemon.listen, host: '0.0.0.0' }, behindTlsProxy: false } });
    assert.equal(unauthenticatedHooksPossible(), false);
  } finally { setConfig(saved); }
});

test('a webhook moving from no auth to a signed scheme gets its secret, shown once', async () => {
  const created = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'Grows up', slug: 'grows-up', config: { auth: 'none' }, actions: [{ type: 'notify', title: 'x' }],
  });
  const id = String((created.body.trigger as Json).id);
  const signed = await api('PATCH', `/api/triggers/${id}`, { config: { auth: 'github' } });
  assert.equal(signed.status, 200);
  assert.match(String(signed.body.secret), /^[a-f0-9]{64}$/);
  assert.equal((signed.body.trigger as Json).has_secret, true);
  const again = await api('PATCH', `/api/triggers/${id}`, { name: 'Grown' });
  assert.equal(again.body.secret, undefined);
});

test('a human edit never widens a trigger a plugin owns, not even a superadmin\'s', async () => {
  const row = insertTrigger({
    name: 'plugin trigger', slug: null, source: 'event', enabled: true, config: { event: 'task_done' }, filter: null,
    actions: [{ type: 'notify', title: 'x' }], secret: null, ownerUserId: 'plugin:acme-bridge', createdBy: 'user',
    creatorAgent: null, actingAgent: null, grants: ['notify'], nextRunAt: null,
  });
  const renamed = await api('PATCH', `/api/triggers/${row.id}`, { name: 'renamed', enabled: false });
  assert.equal(renamed.status, 200);
  assert.deepEqual((renamed.body.trigger as Json).grants, ['notify'], 'a superadmin\'s `*` is not stored');
  const widened = await api('PATCH', `/api/triggers/${row.id}`, { actions: [{ type: 'todo', text: 'x' }] });
  assert.equal(widened.status, 403);
  const kept = await api('GET', `/api/triggers/${row.id}`);
  assert.deepEqual((kept.body.trigger as Json).grants, ['notify']);
});

test('an agent cannot widen a trigger beyond its own token', async () => {
  const refused = await api('POST', '/api/triggers', {
    source: 'event', name: 'todo on done', config: { event: 'task_done' }, actions: [{ type: 'todo', text: 'x' }],
  }, 'agent-notify');
  assert.equal(refused.status, 403);
  const made = await api('POST', '/api/triggers', {
    source: 'event', name: 'notify on done', config: { event: 'task_done' }, actions: [{ type: 'notify', title: 'done {task.title}' }],
  }, 'agent-notify');
  assert.equal(made.status, 201);
  const trigger = made.body.trigger as Json;
  assert.deepEqual(trigger.grants, ['notify']);
  assert.equal(trigger.created_by, 'agent');
  assert.equal(trigger.creator_agent, 'helper');
  // A broader agent editing it keeps the narrower grants.
  const widened = await api('PATCH', `/api/triggers/${String(trigger.id)}`, { actions: [{ type: 'todo', text: 'x' }] }, 'agent-full');
  assert.equal(widened.status, 403);
  // An agent task needs an existing agent.
  assert.equal((await api('POST', '/api/triggers', {
    source: 'event', name: 't', config: { event: 'task_done' }, actions: [{ type: 'task', agent: 'ghost', prompt: 'p' }],
  }, 'agent-full')).status, 400);
  // Someone else's trigger does not exist for an account that is not superadmin.
  const adminOwned = await api('POST', '/api/triggers', { source: 'event', name: 'a', config: { event: 'task_done' }, actions: [{ type: 'notify', title: 'a' }] });
  assert.equal((await api('GET', `/api/triggers/${String((adminOwned.body.trigger as Json).id)}`, undefined, 'agent-full')).status, 404);
});

test('triggers:manage alone never borrows a stronger trigger of the same account', async () => {
  const created = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'Strong', slug: 'strong', config: { auth: 'github' },
    actions: [{ type: 'task', agent: 'helper', prompt: 'Look at {n}' }],
  }, 'agent-full');
  assert.equal(created.status, 201);
  const id = String((created.body.trigger as Json).id);
  await switchOn(id);
  const tasks = () => (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE trigger_id = ?`).get(id) as { n: number }).n;
  // Same account, a token without kanban:write: it may look, not fire.
  assert.equal((await api('POST', `/api/triggers/${id}/test`, { payload: { n: 1 } }, 'agent-notify')).body.status, 'dry_run');
  const fired = await api('POST', `/api/triggers/${id}/test`, { payload: { n: 1 }, execute: true }, 'agent-notify');
  assert.equal(fired.status, 403);
  assert.equal(tasks(), 0);
  // Nor take over the webhook: the old secret keeps working.
  for (const body of [{}, { secret: 'a-secret-of-my-own-choice' }]) {
    assert.equal((await api('POST', `/api/triggers/${id}/secret`, body, 'agent-notify')).status, 403);
  }
  const raw = JSON.stringify({ n: 2 });
  assert.equal((await hook('strong', raw, { 'x-hub-signature-256': githubSig(String(created.body.secret), raw) })).body.status, 'received');
  assert.equal(tasks(), 1);
  // The token that holds the rights still may.
  assert.equal((await api('POST', `/api/triggers/${id}/test`, { payload: { n: 3 }, execute: true }, 'agent-full')).body.status, 'received');
  assert.equal(tasks(), 2);
});

test('an agent\'s trigger never runs before a person switches it on, whatever outlives its mission', async () => {
  const notes = (id: string) => (db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE source = ?`).get(`trigger:${id}`) as { n: number }).n;
  const created = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'Agent hook', slug: 'agent-born', config: { auth: 'github' }, enabled: true,
    actions: [{ type: 'notify', title: 'hook {n}' }],
  }, 'agent-full');
  assert.equal(created.status, 201);
  const trigger = created.body.trigger as Json;
  const id = String(trigger.id);
  assert.equal(trigger.enabled, false, 'born off, even when asked on');
  assert.equal(created.body.needs_activation, true);
  assert.match(String(created.body.message), /only runs once the user switches it on/);
  const raw = JSON.stringify({ n: 1 });
  const signed = { 'x-hub-signature-256': githubSig(String(created.body.secret), raw) };
  assert.equal((await hook('agent-born', raw, signed)).status, 401, 'a switched-off webhook answers like an unknown one');
  assert.equal(notes(id), 0);

  // The agent cannot switch it on, alone or with an edit.
  for (const body of [{ enabled: true }, { enabled: true, name: 'on please' }]) {
    const refused = await api('PATCH', `/api/triggers/${id}`, body, 'agent-full');
    assert.equal(refused.status, 403);
    assert.match(String(refused.body.error), /cannot switch a trigger on/);
  }
  assert.equal(((await api('GET', `/api/triggers/${id}`)).body.trigger as Json).enabled, false);

  await switchOn(id);
  assert.equal((await hook('agent-born', raw, signed)).body.status, 'received');
  assert.equal(notes(id), 1);

  // Renaming it changes nothing it does: it stays on.
  const renamed = await api('PATCH', `/api/triggers/${id}`, { name: 'Agent hook, renamed' }, 'agent-full');
  assert.equal((renamed.body.trigger as Json).enabled, true);
  assert.equal(renamed.body.needs_activation, undefined);
  // Changing what it does is setting up another one: off until the user looks.
  const reshaped = await api('PATCH', `/api/triggers/${id}`, { actions: [{ type: 'notify', title: 'other {n}' }] }, 'agent-full');
  assert.equal(reshaped.status, 200);
  assert.equal((reshaped.body.trigger as Json).enabled, false);
  assert.equal(reshaped.body.needs_activation, true);
  assert.equal((await hook('agent-born', JSON.stringify({ n: 2 }), { 'x-hub-signature-256': githubSig(String(created.body.secret), JSON.stringify({ n: 2 })) })).status, 401);
  // Switching it off is always allowed.
  await switchOn(id);
  const off = await api('PATCH', `/api/triggers/${id}`, { enabled: false }, 'agent-notify');
  assert.equal(off.status, 200);
  assert.equal((off.body.trigger as Json).enabled, false);
  await api('DELETE', `/api/triggers/${id}`);

  // A schedule is not even armed, an event does not fire.
  const schedule = await api('POST', '/api/triggers', {
    source: 'schedule', name: 'Agent cron', config: { cron: '* * * * *' }, actions: [{ type: 'notify', title: 'tick' }],
  }, 'agent-full');
  assert.equal((schedule.body.trigger as Json).next_run_at, null);
  tickSchedules(Date.now() + 3_600_000);
  assert.equal(notes(String((schedule.body.trigger as Json).id)), 0);
  const event = await api('POST', '/api/triggers', {
    source: 'event', name: 'Agent event', config: { event: 'task_done' }, actions: [{ type: 'notify', title: 'done' }],
  }, 'agent-full');
  const done = randomUUID();
  dbApi.createTask(done, 'agent-born probe', 'helper', { ownerUserId: bob.id });
  createEventDispatcher()({ kind: 'task_done', taskId: done });
  assert.equal(notes(String((event.body.trigger as Json).id)), 0);
  for (const made of [schedule, event]) await api('DELETE', `/api/triggers/${String((made.body.trigger as Json).id)}`);
});

test('an agent\'s trigger made before #529 is switched off at boot and its owner told; a person\'s consent survives (TODO #572)', async () => {
  const stored = (id: string) => db.prepare(`SELECT enabled, next_run_at, approved_at, acting_agent FROM triggers WHERE id = ?`)
    .get(id) as { enabled: number; next_run_at: number | null; approved_at: number | null; acting_agent: string | null };
  // What a mission token wrote before #529: on, its agent acting, nobody looked.
  const legacy = (name: string, extra: Partial<Parameters<typeof insertTrigger>[0]> = {}) => insertTrigger({
    name, slug: null, source: 'schedule', enabled: true, config: { cron: '* * * * *' }, filter: null,
    actions: [{ type: 'notify', title: name }], secret: null, ownerUserId: bob.id, createdBy: 'agent',
    creatorAgent: 'helper', actingAgent: 'helper', grants: ['notify'], nextRunAt: Date.now() - 1_000, ...extra,
  }).id;
  const stale = legacy('Legacy agent cron');
  const human = legacy('Bob\'s own cron', { createdBy: 'user', creatorAgent: null, actingAgent: null });
  // Saved by a person before #529: every human save cleared the acting agent.
  const humanSaved = legacy('Agent cron Bob saved', { actingAgent: null });
  const alreadyOff = legacy('Agent cron already off', { enabled: false, nextRunAt: null });
  // Since #529: born off, then switched on by the user.
  const born = await api('POST', '/api/triggers', {
    source: 'event', name: 'Agent event, consented', config: { event: 'task_done' }, actions: [{ type: 'notify', title: 'ok' }],
  }, 'agent-full');
  const consented = String((born.body.trigger as Json).id);
  await switchOn(consented);
  assert.equal(stored(consented).acting_agent, 'helper', 'flipping the switch keeps the acting agent');
  assert.ok(stored(consented).approved_at, 'a person switching it on is a consent');

  const off = switchOffUnapprovedAgentTriggers().map((t) => t.id);
  assert.deepEqual(off.filter((id) => [stale, human, humanSaved, alreadyOff, consented].includes(id)), [stale]);
  assert.equal(stored(stale).enabled, 0);
  assert.equal(stored(stale).next_run_at, null, 'its schedule is disarmed');
  for (const id of [human, humanSaved, consented]) assert.equal(stored(id).enabled, 1);
  tickSchedules(Date.now() + 3_600_000);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE title = 'Legacy agent cron'`).get() as { n: number }).n, 0, 'it never fires');

  // The owner is told, by name, once: never cut in silence.
  // (the two crons left on did fire their own notify actions on that tick)
  const told = db.prepare(`SELECT title, body, type FROM notifications WHERE owner_user_id = ? AND title LIKE '%switched off%'`)
    .all(bob.id) as Array<{ title: string; body: string; type: string }>;
  assert.equal(told.length, 1);
  assert.equal(told[0].type, 'alert');
  assert.match(told[0].title, /switched off/);
  assert.match(told[0].body, /Legacy agent cron \(schedule, set up by helper\)/);
  assert.doesNotMatch(told[0].body, /consented|Bob's own|Bob saved/);
  assert.equal(switchOffUnapprovedAgentTriggers().some((t) => t.id === stale), false, 'idempotent');
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE owner_user_id = ? AND title LIKE '%switched off%'`).get(bob.id) as { n: number }).n, 1);

  // The agent cannot give the consent itself, by any field.
  const forged = await api('PATCH', `/api/triggers/${stale}`, { enabled: true, approved_at: Date.now() }, 'agent-full');
  assert.equal(forged.status, 400);
  assert.equal((await api('PATCH', `/api/triggers/${stale}`, { enabled: true }, 'agent-full')).status, 403);
  assert.equal(stored(stale).approved_at, null);
  // The user switching it back on is final: the next boot leaves it on.
  await switchOn(stale);
  assert.equal(switchOffUnapprovedAgentTriggers().some((t) => t.id === stale), false);
  assert.equal(stored(stale).enabled, 1);

  // An agent renaming a consented trigger keeps the consent; reshaping it withdraws it.
  assert.equal((await api('PATCH', `/api/triggers/${consented}`, { name: 'Agent event, renamed' }, 'agent-full')).status, 200);
  assert.ok(stored(consented).approved_at);
  const reshaped = await api('PATCH', `/api/triggers/${consented}`, { actions: [{ type: 'notify', title: 'other' }] }, 'agent-full');
  assert.equal((reshaped.body.trigger as Json).enabled, false);
  assert.equal(stored(consented).approved_at, null);
  // Switched off by a person: no consent left over for a later run.
  assert.equal((await api('PATCH', `/api/triggers/${human}`, { enabled: false })).status, 200);
  assert.equal(stored(human).approved_at, null);

  for (const id of [stale, human, humanSaved, alreadyOff, consented]) await api('DELETE', `/api/triggers/${id}`);
});

test('an agent\'s routine is born off too: it cannot switch one on, and reshaping one switches it off', async () => {
  const created = await api('POST', '/api/routines', {
    name: 'Agent routine', agent_name: 'helper', prompt: 'nightly', cron_expr: '0 3 * * *', enabled: true,
  }, 'agent-full');
  assert.equal(created.status, 201);
  const routine = created.body.routine as Json;
  const id = String(routine.id);
  assert.equal(routine.enabled, 0);
  assert.equal(routine.next_run_at, null);
  assert.equal(created.body.needs_activation, true);

  assert.equal((await api('PUT', `/api/routines/${id}`, { enabled: true }, 'agent-full')).status, 403);
  // The same row through the triggers API.
  assert.equal((await api('PATCH', `/api/triggers/${id}`, { enabled: true }, 'agent-full')).status, 403);
  assert.equal(dbApi.getRoutine(id)!.enabled, 0);

  const on = await api('PUT', `/api/routines/${id}`, { enabled: true });
  assert.equal((on.body.routine as Json).enabled, 1);
  const renamed = await api('PUT', `/api/routines/${id}`, { name: 'Agent routine, renamed', prompt: 'nightly' }, 'agent-full');
  assert.equal((renamed.body.routine as Json).enabled, 1, 'same prompt, new name: still on');
  const reshaped = await api('PUT', `/api/routines/${id}`, { prompt: 'do something else' }, 'agent-full');
  assert.equal((reshaped.body.routine as Json).enabled, 0);
  assert.equal(dbApi.listDueRoutines(Date.now() + 2 * 86_400_000).some((r) => r.id === id), false, 'off: never due');
  assert.equal(reshaped.body.needs_activation, true);
  await api('DELETE', `/api/routines/${id}`);
});

test('routines are walled per account: anonymous 401, no permission 403, someone else\'s routine 404 (TODO #573)', async () => {
  // A second human account allowed to manage triggers: the cross-account case.
  const carol = createTestAccount(dbApi, { email: 'trig-carol@example.com', name: 'Carol', passwordHash: 'x', isSuperadmin: false });
  grantTestPermissions(dbApi, carol.id, ['triggers:manage', 'kanban:write']);
  IDENTITIES.carol = { kind: 'session', user: carol, isSuperadmin: false };
  const def = { name: 'Walled', agent_name: 'helper', prompt: 'nightly', cron_expr: '0 3 * * *' };
  const admins = await api('POST', '/api/routines', def);
  assert.equal(admins.status, 201);
  const adminsId = String((admins.body.routine as Json).id);
  const daemons = createRoutine({ ...def, name: 'Ownerless' });
  const carols = await api('POST', '/api/routines', { ...def, name: 'Carol\'s' }, 'carol');
  assert.equal(carols.status, 201);
  const carolsId = String((carols.body.routine as Json).id);
  assert.equal((carols.body.routine as Json).owner_user_id, carol.id);

  for (const [method, path, body] of [
    ['GET', '/api/routines'], ['GET', `/api/routines/${adminsId}`], ['POST', '/api/routines', def],
    ['PUT', `/api/routines/${adminsId}`, { enabled: false }], ['DELETE', `/api/routines/${adminsId}`],
  ] as Array<[string, string, unknown?]>) {
    assert.equal((await api(method, path, body, null)).status, 401, `anonymous ${method} ${path}`);
    assert.equal((await api(method, path, body, 'bob')).status, 403, `no triggers:manage ${method} ${path}`);
  }

  const ids = (res: { body: Json }) => (res.body.routines as Json[]).map((r) => String(r.id));
  const listed = ids(await api('GET', '/api/routines', undefined, 'carol'));
  assert.ok(listed.includes(carolsId));
  assert.ok(!listed.includes(adminsId) && !listed.includes(daemons.id), 'only her own rows');
  assert.ok(!ids(await api('GET', '/api/routines', undefined, 'agent-full')).includes(carolsId), 'nor another account\'s');
  const all = ids(await api('GET', '/api/routines'));
  assert.ok([adminsId, carolsId, daemons.id].every((id) => all.includes(id)), 'the superadmin sees every row');

  for (const id of [adminsId, daemons.id]) {
    assert.equal((await api('GET', `/api/routines/${id}`, undefined, 'carol')).status, 404);
    assert.equal((await api('PUT', `/api/routines/${id}`, { prompt: 'rm -rf', enabled: false }, 'carol')).status, 404);
    assert.equal((await api('DELETE', `/api/routines/${id}`, undefined, 'carol')).status, 404);
    assert.equal((await api('PUT', `/api/routines/${id}`, { enabled: false }, 'agent-full')).status, 404);
    assert.equal((await api('DELETE', `/api/routines/${id}`, undefined, 'agent-full')).status, 404);
  }
  assert.equal((await api('DELETE', `/api/routines/${carolsId}`, undefined, 'agent-full')).status, 404);
  assert.equal(dbApi.getRoutine(adminsId)?.prompt, 'nightly', 'untouched');
  assert.ok(dbApi.getRoutine(daemons.id) && dbApi.getRoutine(carolsId), 'not deleted');

  assert.equal((await api('PUT', `/api/routines/${carolsId}`, { enabled: false }, 'carol')).status, 200);
  assert.equal((await api('DELETE', `/api/routines/${carolsId}`, undefined, 'carol')).status, 200);
  for (const id of [adminsId, daemons.id]) assert.equal((await api('DELETE', `/api/routines/${id}`)).status, 200);
  delete IDENTITIES.carol;
});

test('a routine opens tasks: its save is bounded by delegation and kanban:write, switching off is not', async () => {
  const def = (agent: string) => ({ name: `to ${agent}`, agent_name: agent, prompt: 'go', cron_expr: '0 3 * * *' });
  assert.equal((await api('POST', '/api/routines', def('outsider'), 'agent-lead')).status, 403, 'not orchestrated');
  assert.equal((await api('POST', '/api/routines', def('worker'), 'agent-narrow')).status, 403, 'orchestrates nobody');
  assert.equal((await api('POST', '/api/routines', def('worker'), 'agent-notify')).status, 403, 'no kanban:write');
  const made = await api('POST', '/api/routines', def('worker'), 'agent-lead');
  assert.equal(made.status, 201);
  const id = String((made.body.routine as Json).id);
  assert.equal((await api('PUT', `/api/routines/${id}`, { agent_name: 'outsider' }, 'agent-lead')).status, 403);
  assert.equal(dbApi.getRoutine(id)?.agent_name, 'worker');
  // Same owner, but a token without the task permission may still rename it or switch it off.
  assert.equal((await api('PUT', `/api/routines/${id}`, { prompt: 'more' }, 'agent-notify')).status, 403);
  assert.equal((await api('PUT', `/api/routines/${id}`, { name: 'renamed', enabled: false }, 'agent-notify')).status, 200);
  assert.equal((await api('DELETE', `/api/routines/${id}`, undefined, 'agent-lead')).status, 200);
});

test('a task action is a delegation: refused on create, edit, manual run and at every later run', async () => {
  const taskTo = (agent: string) => ({ type: 'task', agent, prompt: 'go' });
  const event = (agent: string) => ({ source: 'event', name: `to ${agent}`, config: { event: 'task_done' },
    filter: { op: 'equals', path: 'task.title', value: 'delegation-probe' }, actions: [taskTo(agent)] });
  const refused = await api('POST', '/api/triggers', event('outsider'), 'agent-lead');
  assert.equal(refused.status, 403, 'create');
  assert.match(String(refused.body.error), /does not orchestrate "outsider"/);
  assert.equal((await api('POST', '/api/triggers', event('worker'), 'agent-gone')).status, 403, 'unknown mission');
  const made = await api('POST', '/api/triggers', event('worker'), 'agent-lead');
  assert.equal(made.status, 201);
  const trigger = made.body.trigger as Json;
  assert.equal(trigger.acting_agent, 'lead');
  const id = String(trigger.id);
  await switchOn(id);
  const consented = (await api('GET', `/api/triggers/${id}`)).body.trigger as Json;
  assert.equal(consented.acting_agent, 'lead', 'switching it on is a consent, not a takeover: the agent still bounds it');
  assert.deepEqual(consented.grants, trigger.grants);
  assert.equal((await api('PATCH', `/api/triggers/${id}`, { actions: [taskTo('outsider')] }, 'agent-lead')).status, 403, 'patch');
  // Same account, an agent that may not delegate to `worker`.
  assert.equal((await api('POST', `/api/triggers/${id}/test`, { payload: { task: { title: 'delegation-probe' } }, execute: true }, 'agent-narrow')).status, 403, 'manual run');
  assert.equal((await api('POST', `/api/triggers/${id}/secret`, {}, 'agent-narrow')).status, 400, 'an event trigger has no secret anyway');

  const born = () => (db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE trigger_id = ?`).get(id) as { n: number }).n;
  const dispatch = createEventDispatcher();
  const finish = () => {
    const done = randomUUID();
    dbApi.createTask(done, 'delegation-probe', 'worker', { ownerUserId: bob.id });
    dispatch({ kind: 'task_done', taskId: done });
  };
  finish();
  assert.equal(born(), 1);
  // The operator narrows `lead` afterwards: its trigger narrows with it.
  orchestrates('lead', []);
  try {
    finish();
    assert.equal(born(), 1);
    const journal = await api('GET', `/api/triggers/${id}/deliveries`);
    assert.match(String((journal.body.deliveries as Array<{ reason: string }>)[0]!.reason), /"lead" does not orchestrate "worker"/);
  } finally { orchestrates('lead', ['worker']); }
  // An agent removed from the roster delegates to nobody.
  rmSync(join(AGENTS_DIR, 'lead'), { recursive: true, force: true });
  try {
    finish();
    assert.equal(born(), 1);
  } finally {
    mkdirSync(join(AGENTS_DIR, 'lead'), { recursive: true });
    orchestrates('lead', ['worker']);
  }
  // A human saving it takes it over: no agent bounds it any more.
  const taken = await api('PATCH', `/api/triggers/${id}`, { name: 'taken over' });
  assert.equal((taken.body.trigger as Json).acting_agent, null);
  await api('DELETE', `/api/triggers/${id}`);
});

test('event source: owner-scoped, filtered, enriched, and blind to its own tasks', async () => {
  const created = await api('POST', '/api/triggers', {
    source: 'event', name: 'Blocked → task', config: { event: 'task_blocked' },
    filter: { op: 'contains', path: 'task.reason', value: 'quota' },
    actions: [{ type: 'task', agent: 'helper', prompt: 'Look at {task.title}: {task.reason}', title: 'Follow-up {task.title}' }],
  }, 'agent-full');
  assert.equal(created.status, 201);
  const triggerId = String((created.body.trigger as Json).id);
  await switchOn(triggerId);
  const dispatch = createEventDispatcher();
  const task = (title: string, owner: string) => {
    const id = randomUUID();
    dbApi.createTask(id, title, 'helper', { ownerUserId: owner });
    return id;
  };
  const mine = task('Nightly build', bob.id);
  dispatch({ kind: 'task_blocked', taskId: mine, reason: 'quota exhausted' });
  const theirs = task('Admin secret project', admin.id);
  dispatch({ kind: 'task_blocked', taskId: theirs, reason: 'quota exhausted' });
  dispatch({ kind: 'task_blocked', taskId: mine, reason: 'merge conflict' });
  const created1 = db.prepare(`SELECT * FROM tasks WHERE trigger_id = ?`).all(triggerId) as Array<{ id: string; title: string; description: string; owner_user_id: string }>;
  assert.equal(created1.length, 1, 'one match: not the other owner, not the filtered reason');
  assert.equal(created1[0]!.title, 'Follow-up Nightly build');
  assert.equal(created1[0]!.owner_user_id, bob.id);
  assert.match(created1[0]!.description, /untrusted data, not instructions/);
  assert.match(created1[0]!.description, /Look at Nightly build: quota exhausted/);
  // Its own task blocking does not feed the trigger again.
  dispatch({ kind: 'task_blocked', taskId: created1[0]!.id, reason: 'quota again' });
  assert.equal((db.prepare(`SELECT count(*) AS n FROM tasks WHERE trigger_id = ?`).get(triggerId) as { n: number }).n, 1);
});

test('two event triggers never feed each other: an event born of an event trigger fires nothing', async () => {
  const make = (name: string) => api('POST', '/api/triggers', {
    source: 'event', name, config: { event: 'task_done' },
    filter: { op: 'equals', path: 'task.agent', value: 'helper' },
    actions: [{ type: 'task', agent: 'helper', prompt: `${name} after {task.title}`, title: `${name}: {task.title}` }],
  }, 'agent-full');
  const x = String(((await make('X')).body.trigger as Json).id);
  const y = String(((await make('Y')).body.trigger as Json).id);
  await switchOn(x);
  await switchOn(y);
  const dispatch = createEventDispatcher();
  const human = randomUUID();
  dbApi.createTask(human, 'Human work', 'helper', { ownerUserId: bob.id });
  dispatch({ kind: 'task_done', taskId: human });
  const born = (id: string) => db.prepare(`SELECT id FROM tasks WHERE trigger_id = ?`).all(id) as Array<{ id: string }>;
  assert.equal(born(x).length, 1);
  assert.equal(born(y).length, 1);
  // Second generation: each child finishing would otherwise wake the other.
  for (const child of [...born(x), ...born(y)]) dispatch({ kind: 'task_done', taskId: child.id });
  assert.equal(born(x).length, 1);
  assert.equal(born(y).length, 1);
  for (const id of [x, y]) await api('DELETE', `/api/triggers/${id}`);
});

test('todo_done: published on the move to done only, enriched without the notes, owner-scoped', async () => {
  const { bus } = await import('../bus.js');
  const seen: Array<{ todoId: number; previousProgress: string | null }> = [];
  const listen = (ev: { kind: string }) => { if (ev.kind === 'todo_done') seen.push(ev as never); };
  bus.on('event', listen);
  const todo = dbApi.insertProjectTodo({ text: 'TIM-0057 · Canvas freezes', notes: 'private notes', project: 'timon', author: 'rom', ownerUserId: bob.id });
  dbApi.updateProjectTodo(todo.id, { progress: 'analyzed' });
  dbApi.updateProjectTodo(todo.id, { status: 'done' });
  dbApi.updateProjectTodo(todo.id, { text: 'TIM-0057 · Canvas freezes (edited)' });
  dbApi.updateProjectTodo(todo.id, { status: 'done', progress: 'done' });
  bus.off('event', listen);
  assert.deepEqual(seen, [{ kind: 'todo_done', todoId: todo.id, previousProgress: 'analyzed' }], 'once, on the transition');

  const created = await api('POST', '/api/triggers', {
    source: 'event', name: 'Closed idea', config: { event: 'todo_done' },
    filter: { op: 'regex', path: 'todo.text', pattern: '^(TIM|SUG)-[0-9]{4}' },
    actions: [{ type: 'notify', title: 'Done: {todo.text} ({todo.previous_progress})', body: '[{todo.notes}]' }],
  }, 'agent-full');
  assert.equal(created.status, 201);
  const triggerId = String((created.body.trigger as Json).id);
  await switchOn(triggerId);
  const dispatch = createEventDispatcher();
  dispatch({ kind: 'todo_done', todoId: todo.id, previousProgress: 'analyzed' });
  const other = dbApi.insertProjectTodo({ text: 'Refactor the canvas', project: 'timon', author: 'rom', ownerUserId: bob.id });
  dispatch({ kind: 'todo_done', todoId: other.id, previousProgress: 'todo' });
  const foreign = dbApi.insertProjectTodo({ text: 'SUG-0001 · admin only', project: 'timon', author: 'rom', ownerUserId: admin.id });
  dispatch({ kind: 'todo_done', todoId: foreign.id, previousProgress: 'todo' });
  const notes = db.prepare(`SELECT title, body FROM notifications WHERE source = ?`).all(`trigger:${triggerId}`) as Array<{ title: string; body: string }>;
  assert.deepEqual(notes, [{ title: 'Done: TIM-0057 · Canvas freezes (edited) (analyzed)', body: '[]' }]);
  await api('DELETE', `/api/triggers/${triggerId}`);
});

test('todo_resolved: published on each new outcome, before todo_done, never on a re-save or a clearing', async () => {
  const { bus } = await import('../bus.js');
  const seen: Array<{ kind: string; previousResolution?: string | null }> = [];
  const listen = (ev: { kind: string }) => { if (ev.kind === 'todo_resolved' || ev.kind === 'todo_done') seen.push(ev as never); };
  bus.on('event', listen);
  const todo = dbApi.insertProjectTodo({ text: 'TIM-0060 · Sidebar flickers', notes: 'private notes', project: 'timon', author: 'rom', ownerUserId: bob.id });
  const opened = setOutcome(todo.id, { resolution: 'in_progress' });
  assert.equal(opened?.status, 'open', 'in_progress keeps the idea open');
  setOutcome(todo.id, { resolution: 'in_progress', public_note: 'On it.' });
  setOutcome(todo.id, { resolution: 'planned' });
  assert.equal(dbApi.getProjectTodo(todo.id)?.status, 'open', 'planned keeps the idea open');
  setOutcome(todo.id, { resolution: null });
  setOutcome(todo.id, { resolution: 'fixed' });
  setOutcome(todo.id, { resolution: 'fixed', public_note: 'Fixed in 0.1.4.' });
  bus.off('event', listen);
  assert.deepEqual(seen.map((e) => [e.kind, e.previousResolution]), [
    ['todo_resolved', null], ['todo_resolved', 'in_progress'], ['todo_resolved', null], ['todo_done', undefined],
  ]);
});

test('todo_resolved: two outcomes given in one tick reach the deferred listener as two distinct payloads', async () => {
  const { bus } = await import('../bus.js');
  const bodies: unknown[] = [];
  const listen = deferredEventListener((ev) => {
    if (ev.kind === 'todo_resolved') bodies.push(eventFromBus(ev)?.body);
  });
  bus.on('event', listen);
  const todo = dbApi.insertProjectTodo({ text: 'TIM-0061 · Canvas lags', notes: 'private lead', project: 'timon', author: 'rom', ownerUserId: bob.id });
  setOutcome(todo.id, { resolution: 'needs_info', public_note: 'Which OS?' });
  setOutcome(todo.id, { resolution: 'duplicate', duplicate_of: 'TIM-0057', public_note: 'Same as TIM-0057.' });
  assert.equal(bodies.length, 0, 'the listener is deferred');
  await new Promise((r) => setImmediate(r));
  bus.off('event', listen);
  const base = { id: todo.id, text: 'TIM-0061 · Canvas lags', project: 'timon' };
  assert.deepEqual(bodies, [
    { event: 'todo_resolved', todo: { ...base, resolution: 'needs_info', public_note: 'Which OS?', duplicate_of: null } },
    { event: 'todo_resolved', todo: { ...base, resolution: 'duplicate', public_note: 'Same as TIM-0057.', duplicate_of: 'TIM-0057' } },
  ]);
  assert.doesNotMatch(JSON.stringify(bodies), /private lead/);
});

test('todo_resolved: the body carries the outcome and the public note, never the private notes', async () => {
  const { outboxTransport } = await import('./outbound.js');
  const calls: string[] = [];
  const original = outboxTransport.fetch;
  outboxTransport.fetch = (async (_url: string, init: RequestInit) => {
    calls.push(String(init.body));
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  try {
    const created = await api('POST', '/api/triggers', {
      source: 'event', name: 'Outcomes', config: { event: 'todo_resolved' },
      filter: { all: [
        { op: 'regex', path: 'todo.text', pattern: '^(TIM|SUG)-[0-9]{4}' },
        { op: 'in', path: 'todo.resolution', values: ['duplicate', 'declined'] },
      ] },
      actions: [{ type: 'webhook', url: 'https://bot.example/timon/events' }],
    });
    assert.equal(created.status, 201);
    const triggerId = String((created.body.trigger as Json).id);
    // Through the production listener, as the daemon wires it.
    const { bus } = await import('../bus.js');
    const listen = deferredEventListener(createEventDispatcher());
    bus.on('event', listen);
    const todo = dbApi.insertProjectTodo({ text: 'SUG-0031 · Dark mode', notes: 'secret roadmap', project: 'timon', author: 'rom', ownerUserId: admin.id });
    setOutcome(todo.id, { resolution: 'duplicate', duplicate_of: 'SUG-0003', public_note: 'Already asked in SUG-0003.' });
    const planned = dbApi.insertProjectTodo({ text: 'SUG-0032 · Planned', project: 'timon', author: 'rom', ownerUserId: admin.id });
    setOutcome(planned.id, { resolution: 'planned' });
    await new Promise((r) => setImmediate(r));
    bus.off('event', listen);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1, 'the filter on todo.resolution holds');
    const sent = JSON.parse(calls[0]!) as { type: string; data: Json };
    assert.equal(sent.type, 'todo_resolved');
    assert.deepEqual(sent.data, {
      event: 'todo_resolved',
      todo: {
        id: todo.id, text: 'SUG-0031 · Dark mode', project: 'timon', resolution: 'duplicate',
        public_note: 'Already asked in SUG-0003.', duplicate_of: 'SUG-0003',
      },
    });
    assert.doesNotMatch(calls[0]!, /secret roadmap/);
    await api('DELETE', `/api/triggers/${triggerId}`);
  } finally {
    outboxTransport.fetch = original;
  }
});

test('schedule source: due trigger runs once with its time variables, next run moves on', async () => {
  const created = await api('POST', '/api/triggers', {
    source: 'schedule', name: 'Morning', config: { cron: '0 8 * * *' }, actions: [{ type: 'notify', title: 'Tick at {timestamp}' }],
  });
  const id = String((created.body.trigger as Json).id);
  assert.ok(Number((created.body.trigger as Json).next_run_at) > Date.now());
  assert.equal((await api('POST', '/api/triggers', {
    source: 'schedule', name: 'filtered', config: { cron: '0 8 * * *' }, filter: { op: 'exists', path: 'a' }, actions: [{ type: 'notify', title: 'x' }],
  })).status, 400, 'a schedule has no payload to filter');
  db.prepare(`UPDATE triggers SET next_run_at = 1 WHERE id = ?`).run(id);
  const now = Date.now();
  tickSchedules(now);
  tickSchedules(now);
  const notes = db.prepare(`SELECT title FROM notifications WHERE source = ?`).all(`trigger:${id}`) as Array<{ title: string }>;
  assert.deepEqual(notes.map((n) => n.title), [`Tick at ${now}`]);
  assert.ok(Number((db.prepare(`SELECT next_run_at FROM triggers WHERE id = ?`).get(id) as { next_run_at: number }).next_run_at) > now);
});

/** A schedule that needs Workflows, saved straight in the store: the API refuses it while nobody serves the action. */
function workflowSchedule(name: string, nextRunAt: number): string {
  return insertTrigger({
    name, slug: null, source: 'schedule', enabled: true, config: { cron: '0 8 1 1 *' }, filter: null,
    actions: [{ type: 'notify', title: `${name} notify` }, { type: 'workflow', workflow: 'wf', node: 'start' }],
    secret: null, ownerUserId: bob.id, createdBy: 'user', creatorAgent: null, actingAgent: null, grants: ['*'], nextRunAt,
  }).id;
}
const scheduleRow = (id: string) => db.prepare(`SELECT last_run_at, next_run_at FROM triggers WHERE id = ?`)
  .get(id) as { last_run_at: number | null; next_run_at: number | null };
const scheduleDeliveries = (id: string) => db.prepare(`SELECT status, reason FROM trigger_deliveries WHERE trigger_id = ? ORDER BY id`)
  .all(id) as Array<{ status: string; reason: string | null }>;
const scheduleNotes = (id: string) => db.prepare(`SELECT type, title, body FROM notifications WHERE source = ?`)
  .all(`trigger:${id}`) as Array<{ type: string; title: string; body: string | null }>;
const workflowStub = (runs: string[], check: () => string | null = () => null) => ({
  check, run: (trigger: { id: string }) => { runs.push(trigger.id); return `run-${runs.length}`; }, originOfMission: () => null,
});

test('schedule waiting for Workflows at boot: the occurrence is kept, then runs exactly once when the module is there', async (t) => {
  const t0 = Date.now();
  const id = workflowSchedule('Missed while off', t0 - 30 * 60_000);
  const before = scheduleRow(id);
  tickSchedules(t0);
  tickSchedules(t0 + 30_000);
  assert.deepEqual(scheduleRow(id), before, 'not claimed while the module is not running');
  assert.deepEqual(scheduleDeliveries(id), [], 'no journal row per waiting tick');
  assert.deepEqual(scheduleNotes(id), [], 'its other actions wait too');

  const runs: string[] = [];
  t.after(registerActionProvider('workflow', workflowStub(runs)));
  const ranAt = t0 + 60_000;
  tickSchedules(ranAt);
  tickSchedules(ranAt);
  tickSchedules(ranAt + 30_000);
  assert.deepEqual(runs, [id], 'one run, no catch-up');
  const row = scheduleRow(id);
  assert.equal(row.last_run_at, ranAt);
  assert.ok(Number(row.next_run_at) > ranAt, 'the next occurrence is computed from the run');
  assert.deepEqual(scheduleDeliveries(id).map((d) => d.status), ['received']);
  assert.deepEqual(scheduleNotes(id).map((n) => n.title), ['Missed while off notify'], 'no failure alert');
});

test('schedule whose module never starts: it runs once after the grace, journals the failure and alerts its owner once', () => {
  const t0 = Date.now();
  const id = workflowSchedule('Never served', t0 - 60_000);
  tickSchedules(t0);
  tickSchedules(t0 + SCHEDULE_PROVIDER_GRACE_MS - 1);
  assert.equal(scheduleRow(id).last_run_at, null, 'still waiting within the grace');
  const gaveUpAt = t0 + SCHEDULE_PROVIDER_GRACE_MS;
  tickSchedules(gaveUpAt);
  for (let i = 1; i <= 5; i++) tickSchedules(gaveUpAt + i * 30_000);
  assert.equal(scheduleRow(id).last_run_at, gaveUpAt);
  assert.ok(Number(scheduleRow(id).next_run_at) > gaveUpAt);
  const journal = scheduleDeliveries(id);
  assert.equal(journal.length, 1);
  assert.equal(journal[0]!.status, 'error');
  assert.match(String(journal[0]!.reason), new RegExp(`workflow: ${ACTION_UNAVAILABLE}`));
  const notes = scheduleNotes(id);
  assert.deepEqual(notes.map((n) => n.title).sort(), ['Never served notify', 'Scheduled trigger failed: Never served'],
    'the other actions run, and one alert, never one per tick');
  const alert = notes.find((n) => n.title.startsWith('Scheduled trigger failed'))!;
  assert.equal(alert.type, 'alert');
  assert.match(String(alert.body), /Workflows module is not running/);
});

test('schedule whose target fails for real: no waiting, the owner is alerted at once', (t) => {
  const runs: string[] = [];
  t.after(registerActionProvider('workflow', workflowStub(runs, () => 'unknown workflow: wf')));
  const now = Date.now();
  const id = workflowSchedule('Broken target', now - 60_000);
  tickSchedules(now);
  tickSchedules(now + 30_000);
  assert.deepEqual(runs, []);
  assert.equal(scheduleRow(id).last_run_at, now);
  assert.deepEqual(scheduleDeliveries(id).map((d) => d.status), ['error']);
  const alerts = scheduleNotes(id).filter((n) => n.type === 'alert');
  assert.equal(alerts.length, 1);
  assert.match(String(alerts[0]!.body), /workflow: unknown workflow: wf/);
});

test('schedule failing occurrence after occurrence: one alert per streak, a success starts a new one', (t) => {
  let broken = true;
  const runs: string[] = [];
  t.after(registerActionProvider('workflow', workflowStub(runs, () => (broken ? 'unknown workflow: wf' : null))));
  const t0 = Date.now();
  const id = workflowSchedule('Flaky target', t0 - 60_000);
  const occurrence = (at: number) => {
    db.prepare(`UPDATE triggers SET next_run_at = ? WHERE id = ?`).run(at - 1, id);
    tickSchedules(at);
  };
  const alerts = () => scheduleNotes(id).filter((n) => n.type === 'alert').length;
  occurrence(t0);
  occurrence(t0 + 60_000);
  occurrence(t0 + 120_000);
  assert.equal(scheduleDeliveries(id).length, 3);
  assert.equal(alerts(), 1, 'the owner is told once, not at every occurrence');
  broken = false;
  occurrence(t0 + 180_000);
  assert.deepEqual(runs, [id]);
  broken = true;
  occurrence(t0 + 240_000);
  assert.equal(alerts(), 2, 'a failure after a success is a new streak');
});

test('schedule floor: once a minute at most on every write, a schedule saved before it stays renamable and switchable off', async () => {
  const everyTenSeconds = { source: 'schedule', name: 'Too often', config: { cron: '*/10 * * * * *' }, actions: [{ type: 'notify', title: 'x' }] };
  const refused = await api('POST', '/api/triggers', everyTenSeconds);
  assert.equal(refused.status, 400);
  assert.match(String(refused.body.error), /at most once a minute/);
  assert.equal((await api('POST', '/api/triggers', { ...everyTenSeconds, enabled: false })).status, 400, 'not even switched off');
  assert.equal((await api('POST', '/api/triggers', everyTenSeconds, 'agent-full')).status, 400, 'nor proposed by an agent');
  const created = await api('POST', '/api/triggers', { ...everyTenSeconds, name: 'Minutely', config: { cron: '30 * * * * *' } });
  assert.equal(created.status, 201, 'a single second value is once a minute');
  const id = String((created.body.trigger as Json).id);
  assert.equal((await api('PATCH', `/api/triggers/${id}`, { config: { cron: '0,30 * * * * *' } })).status, 400);

  // A row saved before the floor.
  db.prepare(`UPDATE triggers SET config = ? WHERE id = ?`).run(JSON.stringify({ cron: '*/10 * * * * *' }), id);
  assert.equal((await api('PATCH', `/api/triggers/${id}`, { name: 'Legacy, renamed' })).status, 200);
  assert.equal((await api('PATCH', `/api/triggers/${id}`, { enabled: false })).status, 200);
  const back = await api('PATCH', `/api/triggers/${id}`, { enabled: true });
  assert.equal(back.status, 400, 'switching it back on is a new consent to that cadence');
  assert.match(String(back.body.error), /at most once a minute/);
  assert.equal((await api('PATCH', `/api/triggers/${id}`, { enabled: true, config: { cron: '* * * * *' } })).status, 200);
  await api('DELETE', `/api/triggers/${id}`);

  const routine = { name: 'Fast routine', agent_name: 'helper', prompt: 'p', cron_expr: '*/5 * * * * *' };
  const routineRefused = await api('POST', '/api/routines', routine);
  assert.equal(routineRefused.status, 400);
  assert.match(String(routineRefused.body.error), /at most once a minute/);
  const kept = await api('POST', '/api/routines', { ...routine, cron_expr: '* * * * *' });
  assert.equal(kept.status, 201);
  const routineId = String((kept.body.routine as Json).id);
  assert.equal((await api('PUT', `/api/routines/${routineId}`, { cron_expr: '*/5 * * * * *' })).status, 400);
  db.prepare(`UPDATE triggers SET config = ? WHERE id = ?`).run(JSON.stringify({ cron: '*/5 * * * * *' }), routineId);
  const renamed = await api('PUT', `/api/routines/${routineId}`, { name: 'Fast routine, renamed', cron_expr: '*/5 * * * * *' });
  assert.equal(renamed.status, 200, 'the form sends the cron back as it was');
  assert.equal((await api('PUT', `/api/routines/${routineId}`, { enabled: false })).status, 200);
  assert.equal((await api('PUT', `/api/routines/${routineId}`, { enabled: true })).status, 400);
  await api('DELETE', `/api/routines/${routineId}`);
});

test('coalescing: a burst on the same entity runs once, with the last payload', async () => {
  const created = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'Burst', slug: 'burst', config: { auth: 'none', coalesce: { key: 'pr', quiet_ms: 60_000 } },
    actions: [{ type: 'notify', title: 'PR {pr} at {rev}' }],
  });
  const id = String((created.body.trigger as Json).id);
  for (const rev of [1, 2, 3]) assert.equal((await hook('burst', JSON.stringify({ pr: 7, rev }))).status, 202);
  flushAllCoalesced();
  const notes = db.prepare(`SELECT title FROM notifications WHERE source = ?`).all(`trigger:${id}`) as Array<{ title: string }>;
  assert.deepEqual(notes.map((n) => n.title), ['PR 7 at 3']);
});

test('test route: dry run by default, execution on request, journal marked test', async () => {
  const created = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'Try', slug: 'try-me', config: { auth: 'github' }, actions: [{ type: 'todo', text: 'Try {x}' }],
  });
  const id = String((created.body.trigger as Json).id);
  const dry = await api('POST', `/api/triggers/${id}/test`, { payload: { x: 'one' } });
  assert.equal(dry.body.status, 'dry_run');
  assert.equal(((dry.body.outcomes as Array<{ preview: { text: string } }>)[0]!).preview.text, 'Try one');
  assert.equal(todosBy('trigger:try-me').length, 0);
  const run = await api('POST', `/api/triggers/${id}/test`, { payload: { x: 'two' }, execute: true });
  assert.equal(run.body.status, 'received');
  assert.deepEqual(todosBy('trigger:try-me').map((t) => t.text), ['Try two']);
  const journal = await api('GET', `/api/triggers/${id}/deliveries`);
  assert.equal((journal.body.deliveries as Array<{ status: string }>)[0]!.status, 'test');
  const rotated = await api('POST', `/api/triggers/${id}/secret`, {});
  assert.notEqual(rotated.body.secret, created.body.secret);
});

test('routines are schedule triggers: listed, editable within their shape', async () => {
  const routine = createRoutine({ name: 'Daily', agent_name: 'helper', prompt: 'Report {not a template}', cron_expr: '0 9 * * *' });
  const list = await api('GET', '/api/triggers?source=schedule');
  const row = (list.body.triggers as Json[]).find((t) => t.id === routine.id)!;
  assert.equal(row.created_by, 'routine');
  assert.equal((await api('PATCH', `/api/triggers/${routine.id}`, { actions: [{ type: 'notify', title: 'x' }] })).status, 400);
  const action = { type: 'task', agent: 'helper', prompt: 'Report {not a template}' };
  for (const bad of [{ ...action, title: 't' }, { ...action, priority: 5 }, { ...action, raw: false }]) {
    assert.equal((await api('PATCH', `/api/triggers/${routine.id}`, { actions: [bad] })).status, 400);
  }
  assert.equal((await api('PATCH', `/api/triggers/${routine.id}`, { config: { cron: '0 9 * * *', tz: 'Europe/Paris' } })).status, 400);
  assert.equal((await api('PATCH', `/api/triggers/${routine.id}`, { enabled: false })).status, 200);
  assert.equal(dbApi.getRoutine(routine.id)?.enabled, 0);
  assert.equal(dbApi.getRoutine(routine.id)?.prompt, 'Report {not a template}');
});

test('webhook action: https only, http:outbound needed, outbound secret apart and shown once', async () => {
  const def = (url: string) => ({
    source: 'event', name: `Out ${url}`, config: { event: 'todo_done' },
    actions: [{ type: 'webhook', url }],
  });
  // An agent token never holds http:outbound: no exfiltration channel.
  const agent = await api('POST', '/api/triggers', def('https://receiver.example/hook'), 'agent-full');
  assert.equal(agent.status, 403);
  for (const bad of ['http://receiver.example/hook', 'https://user:pw@receiver.example/hook', 'file:///etc/passwd', 'not a url']) {
    assert.equal((await api('POST', '/api/triggers', def(bad))).status, 400, bad);
  }
  assert.equal((await api('POST', '/api/triggers', def('https://receiver.example/hook'), null)).status, 401);
  const created = await api('POST', '/api/triggers', def('https://receiver.example/hook'));
  assert.equal(created.status, 201);
  assert.match(String(created.body.outbound_secret), /^whsec_/);
  assert.equal(created.body.secret, undefined, 'an event trigger receives nothing: no inbound secret');
  const id = String((created.body.trigger as Json).id);
  const read = await api('GET', `/api/triggers/${id}`);
  assert.equal((read.body.trigger as Json).has_outbound_secret, true);
  assert.doesNotMatch(JSON.stringify(read.body), /whsec_/);
  assert.equal((await api('POST', `/api/triggers/${id}/outbound-secret`, {}, null)).status, 401);
  assert.equal((await api('POST', `/api/triggers/${id}/outbound-secret`, {}, 'agent-full')).status, 404, 'not theirs');
  const rotated = await api('POST', `/api/triggers/${id}/outbound-secret`, {});
  assert.match(String(rotated.body.outbound_secret), /^whsec_/);
  assert.notEqual(rotated.body.outbound_secret, created.body.outbound_secret);
  // A webhook trigger forwarding elsewhere gets two different secrets.
  const relay = await api('POST', '/api/triggers', {
    source: 'webhook', name: 'Relay', slug: 'relay-out', config: { auth: 'standard' }, actions: [{ type: 'webhook', url: 'https://receiver.example/relay' }],
  });
  assert.ok(relay.body.secret && relay.body.outbound_secret);
  assert.notEqual(relay.body.secret, relay.body.outbound_secret);
  // A first webhook action added by an edit: the secret is born then.
  const plain = await api('POST', '/api/triggers', { source: 'event', name: 'Later', config: { event: 'todo_done' }, actions: [{ type: 'notify', title: 'x' }] });
  assert.equal(plain.body.outbound_secret, undefined);
  const plainId = String((plain.body.trigger as Json).id);
  assert.equal((await api('POST', `/api/triggers/${plainId}/outbound-secret`, {})).status, 400);
  const edited = await api('PATCH', `/api/triggers/${plainId}`, { actions: [{ type: 'webhook', url: 'https://receiver.example/later' }] });
  assert.match(String(edited.body.outbound_secret), /^whsec_/);
  const again = await api('PATCH', `/api/triggers/${plainId}`, { name: 'Later, renamed' });
  assert.equal(again.body.outbound_secret, undefined);
  for (const t of [id, String((relay.body.trigger as Json).id), plainId]) await api('DELETE', `/api/triggers/${t}`);
});

test('webhook action: a closed TIM idea is posted signed, retried with the same id, given up after 10 attempts', async () => {
  const { outboxTransport, deliverDueWebhooks, OUTBOX_MAX_ATTEMPTS } = await import('./outbound.js');
  const { verifySignature } = await import('./signature.js');
  const calls: Array<{ url: string; headers: Record<string, string>; body: string; redirect?: string }> = [];
  let status = 200;
  const original = outboxTransport.fetch;
  outboxTransport.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body), redirect: init.redirect });
    return new Response(null, { status });
  }) as typeof fetch;
  try {
    const created = await api('POST', '/api/triggers', {
      source: 'event', name: 'Discord', config: { event: 'todo_done' },
      filter: { op: 'regex', path: 'todo.text', pattern: '^(TIM|SUG)-[0-9]{4}' },
      actions: [{ type: 'webhook', url: 'https://bot.example/timon/events' }],
    });
    const secret = String(created.body.outbound_secret);
    const triggerId = String((created.body.trigger as Json).id);
    const dispatch = createEventDispatcher();
    const todo = dbApi.insertProjectTodo({ text: 'TIM-0057 · Canvas freezes', notes: 'internal notes', project: 'timon', author: 'rom', ownerUserId: admin.id });
    dispatch({ kind: 'todo_done', todoId: todo.id, previousProgress: 'todo' });
    const other = dbApi.insertProjectTodo({ text: 'Private idea', project: 'timon', author: 'rom', ownerUserId: admin.id });
    dispatch({ kind: 'todo_done', todoId: other.id, previousProgress: 'todo' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(calls.length, 1, 'sent at once, the filtered idea never leaves');
    const call = calls[0]!;
    assert.equal(call.url, 'https://bot.example/timon/events');
    assert.equal(call.redirect, 'error');
    const verified = verifySignature('standard', secret, Buffer.from(call.body), call.headers);
    assert.equal(verified.ok, true);
    const sent = JSON.parse(call.body) as { type: string; data: { todo: Json } };
    assert.equal(sent.type, 'todo_done');
    assert.equal(sent.data.todo.text, 'TIM-0057 · Canvas freezes');
    assert.doesNotMatch(call.body, /internal notes/);

    status = 503;
    dispatch({ kind: 'todo_done', todoId: dbApi.insertProjectTodo({ text: 'SUG-0003 · Dark mode', project: 'timon', author: 'rom', ownerUserId: admin.id }).id, previousProgress: 'todo' });
    await new Promise((r) => setTimeout(r, 50));
    const failing = calls.at(-1)!;
    const row = () => db.prepare(`SELECT attempts, delivered_at, failed_at, last_error FROM trigger_outbox WHERE id = ?`).get(failing.headers['webhook-id']) as Json;
    assert.deepEqual(row(), { attempts: 1, delivered_at: null, failed_at: null, last_error: 'HTTP 503' });
    // Not due yet: nothing is sent.
    const before = calls.length;
    await deliverDueWebhooks();
    assert.equal(calls.length, before);
    let clock = Date.now();
    for (let i = 1; i < OUTBOX_MAX_ATTEMPTS; i++) { clock += 7 * 3600_000; await deliverDueWebhooks(() => clock); }
    assert.equal(row().attempts, OUTBOX_MAX_ATTEMPTS);
    assert.ok(row().failed_at);
    assert.ok(calls.slice(before).every((c) => c.headers['webhook-id'] === failing.headers['webhook-id'] && c.body === failing.body));
    const journal = await api('GET', `/api/triggers/${triggerId}/deliveries`);
    assert.match(JSON.stringify(journal.body), /gave up after 10 attempts \(HTTP 503\)/);
    assert.doesNotMatch(JSON.stringify(journal.body), new RegExp(secret.slice(6, 20).replace(/[+/]/g, '.')));
    await api('DELETE', `/api/triggers/${triggerId}`);
  } finally {
    outboxTransport.fetch = original;
  }
});

test('webhook action: no SSRF — private, loopback and metadata destinations refused at creation and at delivery (TODO #687)', async () => {
  const { outboxTransport, deliverDueWebhooks } = await import('./outbound.js');
  const def = (url: string, name = `SSRF ${url}`) => ({
    source: 'event', name, config: { event: 'todo_done' },
    filter: { op: 'regex', path: 'todo.text', pattern: '^SSRF-687' },
    actions: [{ type: 'webhook', url }],
  });
  // An address typed as such never gets saved.
  for (const bad of [
    'https://169.254.169.254/latest/meta-data/', 'https://[fd00:ec2::254]/', 'https://100.100.100.200/',
    'https://[::ffff:169.254.169.254]/', 'https://10.0.0.5/hook', 'https://192.168.1.10/hook',
    'https://127.0.0.1:3001/api/tasks', 'https://[::1]/', 'https://localhost/hook', 'https://api.localhost/hook',
  ]) {
    const refused = await api('POST', '/api/triggers', def(bad));
    assert.equal(refused.status, 400, bad);
    assert.match(String(refused.body.error), /cannot target/, bad);
  }

  // A NAME that resolves to such an address is caught by the guard, before any socket opens.
  const resolved = new Map<string, string[]>([
    ['metadata.attacker.example', ['169.254.169.254']],
    ['lan.attacker.example', ['10.0.0.5']],
    ['loop.attacker.example', ['127.0.0.1']],
    // One bad answer is enough: the socket must not get to pick it.
    ['mixed.attacker.example', ['93.184.216.34', '169.254.169.254']],
  ]);
  const asked: string[] = [];
  outboxTransport.lookup = async (hostname) => {
    asked.push(hostname);
    return (resolved.get(hostname) ?? []).map((address) => ({ address, family: 4 as const }));
  };
  const ids: string[] = [];
  try {
    for (const host of resolved.keys()) {
      const created = await api('POST', '/api/triggers', def(`https://${host}/hook`, `SSRF ${host}`));
      assert.equal(created.status, 201, host);
      ids.push(String((created.body.trigger as Json).id));
    }
    const dispatch = createEventDispatcher();
    const todo = dbApi.insertProjectTodo({ text: 'SSRF-687 · probe', project: 'timon', author: 'rom', ownerUserId: admin.id });
    dispatch({ kind: 'todo_done', todoId: todo.id, previousProgress: 'todo' });
    await new Promise((r) => setTimeout(r, 50));
    await deliverDueWebhooks();
    const rows = db.prepare(`SELECT trigger_id, url, attempts, delivered_at, last_error FROM trigger_outbox WHERE trigger_id IN (${ids.map(() => '?').join(',')})`)
      .all(...ids) as Array<{ trigger_id: string; url: string; attempts: number; delivered_at: number | null; last_error: string }>;
    assert.equal(rows.length, resolved.size);
    for (const row of rows) {
      assert.equal(row.delivered_at, null, row.url);
      assert.ok(row.attempts >= 1, row.url);
      assert.match(row.last_error, /^refused: address .* (never reachable|is (private|loopback))/, row.url);
    }
    assert.deepEqual([...new Set(asked)].sort(), [...resolved.keys()].sort(), 'each destination judged after its own lookup');

    // A row saved before the guard (or written by hand) fails at once, visibly, and never reaches the outbox.
    const legacyId = ids[0]!;
    db.prepare(`UPDATE triggers SET actions = ? WHERE id = ?`)
      .run(JSON.stringify([{ type: 'webhook', url: 'https://169.254.169.254/latest/meta-data/iam/' }]), legacyId);
    const queued = () => (db.prepare(`SELECT COUNT(*) AS n FROM trigger_outbox WHERE trigger_id = ?`).get(legacyId) as { n: number }).n;
    const before = queued();
    dispatch({ kind: 'todo_done', todoId: dbApi.insertProjectTodo({ text: 'SSRF-687 · again', project: 'timon', author: 'rom', ownerUserId: admin.id }).id, previousProgress: 'todo' });
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(queued(), before);
    const journal = await api('GET', `/api/triggers/${legacyId}/deliveries`);
    assert.match(JSON.stringify(journal.body), /webhook: a webhook cannot target 169\.254\.169\.254/);
    // Kept as it was, the row can still be renamed and switched off.
    assert.equal((await api('PATCH', `/api/triggers/${legacyId}`, { name: 'SSRF legacy', enabled: false })).status, 200);
  } finally {
    outboxTransport.lookup = undefined;
    for (const id of ids) await api('DELETE', `/api/triggers/${id}`);
  }
});

test('the nightly backup is the superadmin\'s: anonymous 401, an ordinary account or mission 403 (TODO #611)', async () => {
  const { BACKUP_ROUTINE_ID } = await import('../routines.js');
  // An account holding settings:write and triggers:manage is still not the operator.
  const dave = createTestAccount(dbApi, { email: 'trig-dave@example.com', name: 'Dave', passwordHash: 'x', isSuperadmin: false });
  grantTestPermissions(dbApi, dave.id, ['settings:write', 'triggers:manage']);
  IDENTITIES.dave = { kind: 'session', user: dave, isSuperadmin: false };
  // A developer-owned mission inherits its owner's authority (`getLiveApiToken`).
  IDENTITIES['agent-developer'] = { kind: 'api-token', user: admin, isSuperadmin: true, permissions: ['*'], missionId: bobMission };
  assert.equal(dbApi.getRoutine(BACKUP_ROUTINE_ID), undefined);

  for (const [method, path, body] of [['GET', '/api/backup/status'], ['POST', '/api/backup/enable', {}]] as Array<[string, string, unknown?]>) {
    assert.equal((await api(method, path, body, null)).status, 401, `anonymous ${method} ${path}`);
    for (const as of ['bob', 'dave', 'agent-full']) {
      const refused = await api(method, path, body, as);
      assert.equal(refused.status, 403, `${as} ${method} ${path}`);
      assert.equal(refused.body.archives, undefined, 'no archive path leaks');
      assert.equal(refused.body.dir, undefined, 'nor the backups directory');
    }
  }
  assert.equal(dbApi.getRoutine(BACKUP_ROUTINE_ID), undefined, 'no refused caller switched the backup on');

  const status = await api('GET', '/api/backup/status');
  assert.equal(status.status, 200);
  assert.equal(status.body.enabled, false);
  const enabled = await api('POST', '/api/backup/enable', {}, 'agent-developer');
  assert.equal(enabled.status, 200);
  assert.equal(enabled.body.enabled, true);
  assert.equal(dbApi.getRoutine(BACKUP_ROUTINE_ID)?.enabled, 1);
  // The CLI (`timon backup status|enable`) carries the daemon token.
  const cli = await fetch(`${base}/api/backup/status`, { headers: { authorization: `Bearer ${DAEMON}` } });
  assert.equal(cli.status, 200);

  dbApi.deleteRoutine(BACKUP_ROUTINE_ID);
  delete IDENTITIES.dave;
  delete IDENTITIES['agent-developer'];
});
