/**
 * `secret_request` (SECRETS-VAULT.md §9.5): an agent asks its user for a value
 * and never sees it. Who may raise, who may answer, where the value may go,
 * and how long it lives. Isolated TIMON_HOME, witness on 127.0.0.1:0.
 *
 * The leak checks read EVERYTHING the daemon wrote — every row of every table —
 * not just the route's answer: an event, a notification, a journal line or a
 * span holding the value would each be a second copy of it.
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

process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-secret-requests-'));
await import('../../../tests/helpers/paid-license.js');
process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes: registerUserRoutes } = await import('../users/routes.js');
const { registerRoutes: registerSecretRoutes } = await import('./routes.js');
const { db, dbApi } = await import('../../db.js');
const { SESSION_COOKIE } = await import('../../users/session.js');
const { issueMissionApiToken } = await import('../../users/api-tokens.js');
const { brokerHttpCall } = await import('../../secrets/broker.js');
const { requestedSecretsFor, getSecretRequest, boundRequestedSecret, requestedBrowserCredentials } = await import('../../secrets/requests.js');
const { endSecretRequestsOfMission, provideSecretRequest, sweepSecretRequests, SECRET_REQUEST_TTL_MS } = await import('./requests.js');

const TOKEN = 'witness-daemon-token';
const delivered: Array<{ missionId: string; text: string }> = [];

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerUserRoutes(app, { setupPolicy: 'free' });
registerSecretRoutes(app, { deliver: (missionId, text) => { delivered.push({ missionId, text }); } });

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
  return { status: res.status, json: json as Record<string, unknown>, text, res };
}

/** Every row of every table, as text: where a copy of the value would show. */
function wholeDatabase(): string {
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[];
  return tables.map(({ name }) => JSON.stringify(db.prepare(`SELECT * FROM "${name}"`).all())).join('\n');
}

const setup = await call('POST', '/api/auth/setup', { body: { email: 'owner@example.com', name: 'Owner', password: 'owner-secret' } });
assert.equal(setup.status, 201);
const ownerCookie = sessionCookie(setup.res)!;
const ownerId = dbApi.getUserByEmail('owner@example.com')!.id;

await postTestAccount(dbApi, { email: 'other@example.com', name: 'Other', password: 'other-secret' });
const otherLogin = await call('POST', '/api/auth/login', { body: { email: 'other@example.com', password: 'other-secret' } });
const otherCookie = sessionCookie(otherLogin.res)!;
assert.ok(otherCookie);

dbApi.createMission('m-ask', 'asker.agent', 'title', undefined, ownerId);
dbApi.createMission('m-sibling', 'asker.agent', 'title', undefined, ownerId);
dbApi.createMission('m-task', 'coder.agent', 'title', { channel: 'dispatcher' }, ownerId);
const askBearer = issueMissionApiToken('m-ask');
const siblingBearer = issueMissionApiToken('m-sibling');
const taskBearer = issueMissionApiToken('m-task');

const API_VALUE = 'typed-api-key-0123456789-abcdef';
const ENV_VALUE = 'typed-db-password-9876543210';

async function raise(bearer: string, body: Record<string, unknown>) {
  return call('POST', '/api/secrets/requests', { bearer, body });
}

test('only a mission token raises a request', async () => {
  const body = { name: 'DENIED_KEY', reason: 'x', lifetime: 'once' };
  assert.equal((await call('POST', '/api/secrets/requests', { body })).status, 401);
  assert.equal((await call('POST', '/api/secrets/requests', { bearer: TOKEN, body })).status, 403);
  assert.equal((await call('POST', '/api/secrets/requests', { cookie: ownerCookie, body })).status, 403);
});

test('a malformed request is refused before any card', async () => {
  assert.equal((await raise(askBearer, { name: 'lower_case', reason: 'x', lifetime: 'once' })).status, 400);
  assert.equal((await raise(askBearer, { name: 'OK_NAME', reason: 'x'.repeat(201), lifetime: 'once' })).status, 400);
  assert.equal((await raise(askBearer, { name: 'OK_NAME', reason: 'x', lifetime: 'forever' })).status, 400);
  assert.equal((await raise(askBearer, { name: 'OK_NAME', reason: 'x', lifetime: 'once', value: 'smuggled' })).status, 400);
  assert.equal((await raise(askBearer, { name: 'OK_NAME', reason: 'x', lifetime: 'once', header: 'X-Key' })).status, 400);
  assert.equal((await raise(askBearer, { name: 'OK_NAME', reason: 'x', lifetime: 'once', hosts: ['https://evil.example/'] })).status, 400);
});

test('an unattended mission is refused at once, with no card', async () => {
  const before = dbApi.listEvents('m-task').length;
  const r = await raise(taskBearer, { name: 'TASK_KEY', reason: 'deploy', lifetime: 'once' });
  assert.equal(r.status, 409);
  assert.equal(r.json.status, 'refused');
  assert.match(String(r.json.message), /unattended/);
  assert.equal(dbApi.listEvents('m-task').length, before);
});

let apiRequestId = '';

test('a request shows a card and answers pending, twice the same card', async () => {
  const r = await raise(askBearer, { name: 'SHOP_API_KEY', reason: 'read the orders', lifetime: 'once', hosts: ['api.shop.example'], header: 'X-Api-Key', template: '{{value}}' });
  assert.equal(r.status, 202);
  assert.equal(r.json.status, 'pending');
  apiRequestId = String(r.json.id);
  const card = dbApi.listEvents('m-ask').find((e) => e.type === 'secret_request');
  assert.ok(card);
  const view = JSON.parse(card.payload) as { name: string; hosts: string[]; header: string; agent: string; lifetime: string };
  assert.deepEqual([view.name, view.hosts, view.header, view.agent, view.lifetime], ['SHOP_API_KEY', ['api.shop.example'], 'X-Api-Key', 'asker.agent', 'once']);
  const again = await raise(askBearer, { name: 'SHOP_API_KEY', reason: 'read the orders', lifetime: 'once', hosts: ['api.shop.example'] });
  assert.equal(again.json.id, apiRequestId);
});

test('nobody but the owner\'s session answers', async () => {
  const path = `/api/secrets/requests/${apiRequestId}/provide`;
  const body = { value: API_VALUE };
  const anon = await call('POST', path, { body });
  assert.equal(anon.status, 401);
  const daemon = await call('POST', path, { bearer: TOKEN, body });
  assert.equal(daemon.status, 403);
  const own = await call('POST', path, { bearer: askBearer, body });
  assert.equal(own.status, 403);
  const sibling = await call('POST', path, { bearer: siblingBearer, body });
  assert.equal(sibling.status, 403);
  const other = await call('POST', path, { cookie: otherCookie, body });
  assert.equal(other.status, 404);
  // The card words each refusal from its code.
  assert.equal(daemon.json.code, 'secret_request_session_required');
  assert.equal(other.json.code, 'secret_request_not_found');
  for (const r of [anon, daemon, own, sibling, other]) assert.ok(!r.text.includes(API_VALUE));
  assert.equal(getSecretRequest(apiRequestId)!.status, 'pending');
  assert.equal(dbApi.getSecretsByName('SHOP_API_KEY').length, 0);
});

test('the answer accepts only { value }, never echoed', async () => {
  const path = `/api/secrets/requests/${apiRequestId}/provide`;
  const extra = await call('POST', path, { cookie: ownerCookie, body: { value: API_VALUE, note: 'x' } });
  assert.equal(extra.status, 400);
  assert.ok(!extra.text.includes(API_VALUE));
  const inQuery = await call('POST', `${path}?value=${API_VALUE}`, { cookie: ownerCookie, body: {} });
  assert.equal(inQuery.status, 400);
  assert.equal(getSecretRequest(apiRequestId)!.status, 'pending');
});

test('the owner provides: the agent learns the name and the status, never the value', async () => {
  delivered.length = 0;
  const r = await call('POST', `/api/secrets/requests/${apiRequestId}/provide`, { cookie: ownerCookie, body: { value: API_VALUE } });
  assert.equal(r.status, 200);
  assert.equal(r.res.headers.get('cache-control'), 'no-store');
  assert.ok(!r.text.includes(API_VALUE));
  assert.equal((r.json.request as { status: string }).status, 'provided');
  assert.equal(delivered.length, 1);
  assert.match(delivered[0]!.text, /"name":"SHOP_API_KEY","status":"provided"/);
  assert.ok(!delivered[0]!.text.includes(API_VALUE));
  const [secret] = dbApi.getSecretsByName('SHOP_API_KEY');
  assert.ok(secret);
  assert.equal(secret.mode, 'broker');
  assert.deepEqual(secret.grants, [], 'no audience of the vault reaches it');
  assert.ok(dbApi.listSecretAccess(secret.id, 10).some((l) => l.kind === 'request'));
  assert.ok(!wholeDatabase().includes(API_VALUE), 'the value is nowhere in the database but sealed');
  const twice = await call('POST', `/api/secrets/requests/${apiRequestId}/provide`, { cookie: ownerCookie, body: { value: 'second-value-000000' } });
  assert.equal(twice.status, 409);
  assert.equal(twice.json.code, 'secret_request_decided');
});

test('the broker serves it to the requesting mission only, once', async () => {
  let sentHeader: string | null = null;
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sentHeader = new Headers(init?.headers).get('x-api-key');
    return new Response(`echo ${sentHeader}`, { status: 200 });
  }) as typeof fetch;

  await assert.rejects(
    brokerHttpCall({ identity: 'SHOP_API_KEY', path: '/orders' }, { missionId: 'm-sibling', agent: 'asker.agent', project: null }, { fetchImpl }),
    (e: Error & { code?: string }) => e.code === 'no-grant',
  );
  assert.equal(sentHeader, null, 'a sibling mission of the same agent sends nothing');

  const ok = await brokerHttpCall({ identity: 'SHOP_API_KEY', path: '/orders' }, { missionId: 'm-ask', agent: 'asker.agent', project: null }, { fetchImpl });
  assert.equal(sentHeader, API_VALUE);
  assert.equal(ok.status, 200);
  assert.ok(!ok.body.includes(API_VALUE), 'an echoed value is scrubbed');

  assert.equal(dbApi.getSecretsByName('SHOP_API_KEY').length, 0, 'once: destroyed after its first use');
  assert.ok(getSecretRequest(apiRequestId)!.erased_at);
  await assert.rejects(
    brokerHttpCall({ identity: 'SHOP_API_KEY', path: '/orders' }, { missionId: 'm-ask', agent: 'asker.agent', project: null }, { fetchImpl }),
    (e: Error & { code?: string }) => e.code === 'unknown-identity',
  );
  const lines = dbApi.listSecretAccess(getSecretRequest(apiRequestId)!.secret_id!, 20);
  assert.ok(lines.some((l) => l.kind === 'broker' && l.outcome === 'ok'));
  assert.ok(lines.some((l) => l.kind === 'erase'));
  assert.ok(!JSON.stringify(lines).includes(API_VALUE));
});

test('a mission value without hosts enters that mission\'s next launch, then dies with it', async () => {
  const r = await raise(askBearer, { name: 'SHOP_DB_PASSWORD', reason: 'run the migration', lifetime: 'mission' });
  const id = String(r.json.id);
  const p = await call('POST', `/api/secrets/requests/${id}/provide`, { cookie: ownerCookie, body: { value: ENV_VALUE } });
  assert.equal(p.status, 200);
  assert.ok(!p.text.includes(ENV_VALUE));

  const mine = requestedSecretsFor('m-ask');
  assert.equal(mine.env['SHOP_DB_PASSWORD'], ENV_VALUE);
  mine.consume();
  assert.equal(requestedSecretsFor('m-ask').env['SHOP_DB_PASSWORD'], ENV_VALUE, 'mission: not consumed by a launch');
  assert.equal(requestedSecretsFor('m-sibling').env['SHOP_DB_PASSWORD'], undefined);

  await assert.rejects(
    brokerHttpCall({ identity: 'SHOP_DB_PASSWORD', path: '/' }, { missionId: 'm-ask', agent: 'asker.agent', project: null }),
    (e: Error & { code?: string }) => e.code === 'wrong-type',
  );

  endSecretRequestsOfMission('m-ask');
  assert.equal(dbApi.getSecretsByName('SHOP_DB_PASSWORD').length, 0);
  assert.equal(requestedSecretsFor('m-ask').env['SHOP_DB_PASSWORD'], undefined);
});

test('a once value without hosts is consumed by the launch it entered', async () => {
  dbApi.createMission('m-once', 'asker.agent', 'title', undefined, ownerId);
  const r = await raise(issueMissionApiToken('m-once'), { name: 'ONE_TIME_CODE', reason: 'sign in', lifetime: 'once' });
  await call('POST', `/api/secrets/requests/${String(r.json.id)}/provide`, { cookie: ownerCookie, body: { value: '000111222333444' } });
  const launch = requestedSecretsFor('m-once');
  assert.equal(launch.env['ONE_TIME_CODE'], '000111222333444');
  launch.consume();
  assert.equal(dbApi.getSecretsByName('ONE_TIME_CODE').length, 0);
});

test('a once value is spent as soon as the call went out, even when the answer cannot be read', async () => {
  dbApi.createMission('m-unread', 'asker.agent', 'title', undefined, ownerId);
  const r = await raise(issueMissionApiToken('m-unread'), { name: 'UNREAD_KEY', reason: 'x', lifetime: 'once', hosts: ['api.unread.example'] });
  const id = String(r.json.id);
  await call('POST', `/api/secrets/requests/${id}/provide`, { cookie: ownerCookie, body: { value: 'unread-body-value-000000' } });
  let sent = 0;
  const fetchImpl = (async () => {
    sent += 1;
    return { status: 200, text: async () => { throw new Error('stream reset'); } } as unknown as Response;
  }) as typeof fetch;
  const caller = { missionId: 'm-unread', agent: 'asker.agent', project: null };
  await assert.rejects(brokerHttpCall({ identity: 'UNREAD_KEY', path: '/' }, caller, { fetchImpl }));
  assert.equal(sent, 1);
  assert.ok(getSecretRequest(id)!.spent_at, 'spent when fetch answered, before the body');
  assert.equal(dbApi.getSecretsByName('UNREAD_KEY').length, 0);
  await assert.rejects(brokerHttpCall({ identity: 'UNREAD_KEY', path: '/' }, caller, { fetchImpl }),
    (e: Error & { code?: string }) => e.code === 'unknown-identity');
  assert.equal(sent, 1, 'never sent twice');
});

test('two broker calls racing for a once value: one claim wins, the other sends nothing', async () => {
  dbApi.createMission('m-race', 'asker.agent', 'title', undefined, ownerId);
  const r = await raise(issueMissionApiToken('m-race'), { name: 'RACE_KEY', reason: 'x', lifetime: 'once', hosts: ['api.race.example'] });
  const id = String(r.json.id);
  const VALUE = 'race-once-value-00000000';
  await call('POST', `/api/secrets/requests/${id}/provide`, { cookie: ownerCookie, body: { value: VALUE } });
  // Both callers read the binding before either claimed it: the window a read-then-write would leave open.
  const firstRead = boundRequestedSecret('m-race', 'RACE_KEY');
  const secondRead = boundRequestedSecret('m-race', 'RACE_KEY');
  assert.ok(firstRead && secondRead);
  const sent: string[] = [];
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    sent.push(new Headers(init?.headers).get('authorization') ?? '');
    await gate;
    return { status: 200, text: async () => 'ok' } as unknown as Response;
  }) as typeof fetch;
  const caller = { missionId: 'm-race', agent: 'asker.agent', project: null };
  const first = brokerHttpCall({ identity: 'RACE_KEY', path: '/' }, caller, { fetchImpl, boundSecret: () => firstRead });
  // The first call is now awaiting its fetch: the value is out, the erase has not run.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(sent.length, 1);
  await assert.rejects(brokerHttpCall({ identity: 'RACE_KEY', path: '/' }, caller, { fetchImpl, boundSecret: () => secondRead }),
    (e: Error & { code?: string; message: string }) => e.code === 'unknown-identity' && /already spent/.test(e.message) && !e.message.includes(VALUE));
  await assert.rejects(brokerHttpCall({ identity: 'RACE_KEY', path: '/' }, caller, { fetchImpl }), 'a fresh read finds no binding either');
  assert.equal(sent.length, 1, 'the loser never reached the network');
  release();
  assert.equal((await first).status, 200);
  assert.equal(sent.length, 1);
  const row = getSecretRequest(id)!;
  assert.ok(row.spent_at && row.erased_at);
  const journal = dbApi.listSecretAccess(row.secret_id!, 20);
  assert.ok(journal.some((l) => l.outcome === 'denied' && l.detail === 'once: already used'));
  assert.equal(journal.filter((l) => l.kind === 'broker' && l.outcome === 'ok').length, 1);
  assert.ok(!JSON.stringify(journal).includes(VALUE));
});

test('a once value claimed by one launch enters no other', async () => {
  dbApi.createMission('m-twice', 'asker.agent', 'title', undefined, ownerId);
  const r = await raise(issueMissionApiToken('m-twice'), { name: 'TWICE_CODE', reason: 'x', lifetime: 'once' });
  await call('POST', `/api/secrets/requests/${String(r.json.id)}/provide`, { cookie: ownerCookie, body: { value: 'twice-value-000000000' } });
  const first = requestedSecretsFor('m-twice');
  const second = requestedSecretsFor('m-twice');
  assert.equal(first.env['TWICE_CODE'], 'twice-value-000000000');
  assert.equal(second.env['TWICE_CODE'], undefined, 'claimed by the first launch before its consume');
  first.consume();
  second.consume();
  assert.equal(dbApi.getSecretsByName('TWICE_CODE').length, 0);
});

test('an erase that fails leaves the value unusable and the sweep finishes it', async () => {
  dbApi.createMission('m-stuck', 'asker.agent', 'title', undefined, ownerId);
  const r = await raise(issueMissionApiToken('m-stuck'), { name: 'STUCK_CODE', reason: 'x', lifetime: 'once' });
  const id = String(r.json.id);
  await call('POST', `/api/secrets/requests/${id}/provide`, { cookie: ownerCookie, body: { value: 'stuck-value-0000000000' } });
  const launch = requestedSecretsFor('m-stuck');
  assert.equal(launch.env['STUCK_CODE'], 'stuck-value-0000000000');
  const realDelete = dbApi.deleteSecret;
  dbApi.deleteSecret = () => { throw new Error('disk full'); };
  try {
    launch.consume();
  } finally {
    dbApi.deleteSecret = realDelete;
  }
  const stuck = getSecretRequest(id)!;
  assert.ok(stuck.spent_at, 'spent');
  assert.equal(stuck.erased_at, null, 'the claim rolled back with the failed deletion');
  assert.equal(dbApi.getSecretsByName('STUCK_CODE').length, 1, 'still sealed in the vault');
  assert.ok(!dbApi.listSecretAccess(stuck.secret_id!, 10).some((l) => l.kind === 'erase'), 'no journal line for an erase that did not happen');
  assert.equal(requestedSecretsFor('m-stuck').env['STUCK_CODE'], undefined, 'a spent value enters no launch');
  assert.equal(boundRequestedSecret('m-stuck', 'STUCK_CODE'), null, 'nor any broker call');

  sweepSecretRequests();
  assert.ok(getSecretRequest(id)!.erased_at, 'the sweep replays the erase while the mission still runs');
  assert.equal(dbApi.getSecretsByName('STUCK_CODE').length, 0);
});

test('a value for a page: origin checked at the request, shown on the card, kept out of the environment', async () => {
  dbApi.createMission('m-page', 'asker.agent', 'title', undefined, ownerId);
  const bearer = issueMissionApiToken('m-page');
  assert.equal((await raise(bearer, { name: 'PAGE_PASSWORD', reason: 'x', lifetime: 'once', origin: 'file:///etc/passwd' })).status, 400);
  assert.equal((await raise(bearer, { name: 'PAGE_PASSWORD', reason: 'x', lifetime: 'once', origin: 'https://u:p@app.example' })).status, 400);
  assert.equal((await raise(bearer, { name: 'PAGE_PASSWORD', reason: 'x', lifetime: 'once', origin: 'https://app.example', hosts: ['app.example'] })).status, 400);
  const r = await raise(bearer, { name: 'PAGE_PASSWORD', reason: 'sign in', lifetime: 'once', origin: 'https://app.example/login?next=1' });
  assert.equal(r.status, 202);
  const id = String(r.json.id);
  const card = dbApi.listEvents('m-page').find((e) => e.type === 'secret_request');
  assert.equal((JSON.parse(card!.payload) as { origin: string }).origin, 'https://app.example', 'only the origin is kept');
  delivered.length = 0;
  await call('POST', `/api/secrets/requests/${id}/provide`, { cookie: ownerCookie, body: { value: 'page-password-value-0000' } });
  assert.match(delivered[0]!.text, new RegExp(`fill_credential.*sr-${id}`));
  assert.ok(!delivered[0]!.text.includes('page-password-value-0000'));
  assert.equal(requestedSecretsFor('m-page').env['PAGE_PASSWORD'], undefined, 'never in the environment');
  assert.deepEqual(requestedBrowserCredentials('m-page').map((c) => [c.id, c.origin]), [[`sr-${id}`, 'https://app.example']]);
  assert.deepEqual(requestedBrowserCredentials('m-sibling'), []);
  await assert.rejects(
    brokerHttpCall({ identity: 'PAGE_PASSWORD', path: '/' }, { missionId: 'm-page', agent: 'asker.agent', project: null }),
    (e: Error & { code?: string; message: string }) => e.code === 'wrong-type' && /browser at https:\/\/app\.example/.test(e.message),
  );
});

test('a persistent value outlives its mission, daemon-only, and never shadows a name', async () => {
  dbApi.createMission('m-keep', 'asker.agent', 'title', undefined, ownerId);
  const bearer = issueMissionApiToken('m-keep');
  const r = await raise(bearer, { name: 'KEPT_TOKEN', reason: 'nightly sync', lifetime: 'persistent', hosts: ['api.sync.example'] });
  await call('POST', `/api/secrets/requests/${String(r.json.id)}/provide`, { cookie: ownerCookie, body: { value: 'kept-token-value-0000' } });
  endSecretRequestsOfMission('m-keep');
  const [kept] = dbApi.getSecretsByName('KEPT_TOKEN');
  assert.ok(kept);
  assert.deepEqual(kept.grants, []);
  const dup = await raise(bearer, { name: 'KEPT_TOKEN', reason: 'again', lifetime: 'persistent' });
  assert.equal(dup.status, 409);
});

test('refuse, expiry and the end of the mission close the card and tell the agent', async () => {
  dbApi.createMission('m-close', 'asker.agent', 'title', undefined, ownerId);
  const bearer = issueMissionApiToken('m-close');
  delivered.length = 0;

  const refused = await raise(bearer, { name: 'REFUSED_KEY', reason: 'x', lifetime: 'once' });
  assert.equal((await call('POST', `/api/secrets/requests/${String(refused.json.id)}/refuse`, { cookie: otherCookie })).status, 404);
  assert.equal((await call('POST', `/api/secrets/requests/${String(refused.json.id)}/refuse`, { bearer })).status, 403);
  assert.equal((await call('POST', `/api/secrets/requests/${String(refused.json.id)}/refuse`, { cookie: ownerCookie })).status, 200);
  assert.match(delivered.at(-1)!.text, /"name":"REFUSED_KEY","status":"refused"/);

  const late = await raise(bearer, { name: 'LATE_KEY', reason: 'x', lifetime: 'once' });
  const after = Date.now() + SECRET_REQUEST_TTL_MS + 1;
  const out = provideSecretRequest(String(late.json.id), ownerId, 'late-value-000000000', (m, t) => delivered.push({ missionId: m, text: t }), after);
  assert.deepEqual(out, { ok: false, status: 410, error: 'expired' });
  assert.equal(dbApi.getSecretsByName('LATE_KEY').length, 0);
  assert.match(delivered.at(-1)!.text, /"name":"LATE_KEY","status":"refused"/);

  const open = await raise(bearer, { name: 'OPEN_KEY', reason: 'x', lifetime: 'once' });
  endSecretRequestsOfMission('m-close', Date.now(), (m, t) => delivered.push({ missionId: m, text: t }));
  assert.equal(getSecretRequest(String(open.json.id))!.status, 'expired');
  const resolved = dbApi.listEvents('m-close').filter((e) => e.type === 'secret_request_resolved').map((e) => JSON.parse(e.payload) as { status: string });
  assert.deepEqual(resolved.map((e) => e.status), ['refused', 'expired', 'expired']);
});

test('at the end, no value ever typed is anywhere in the database', () => {
  const all = wholeDatabase();
  for (const value of [API_VALUE, ENV_VALUE, '000111222333444', 'kept-token-value-0000', 'late-value-000000000',
    'unread-body-value-000000', 'stuck-value-0000000000', 'page-password-value-0000']) {
    assert.ok(!all.includes(value), `${value.slice(0, 6)}… leaked`);
  }
});
