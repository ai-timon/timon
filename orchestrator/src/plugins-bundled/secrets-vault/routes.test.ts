/**
 * `/api/secrets` — the write-only promise, the broker, and the access journal,
 * checked from the wire (SECRETS-VAULT.md §9.1, §6.2, §8).
 *
 * The interesting assertion on the CRUD is not that each route answers, it is
 * that NO response body ever contains the value that was posted, in any form.
 * The test therefore searches the raw text of every response for the plaintext
 * and for the `enc:1:` envelope, rather than checking field by field: a leak
 * added later would arrive under a field name this test does not know about.
 *
 * The broker tests cover the other boundary: what a client can send, what it
 * gets back, and above all what it never gets back (invariant §12.1). The git
 * credential route is the documented exception — it answers git's protocol.
 *
 * No bind on the production port: witness servers listen on 127.0.0.1:0.
 */
import '../../test-home.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';

const { createDaemonAuthMiddleware } = await import('../http/auth.js');
const { registerRoutes } = await import('./routes.js');
const { dbApi } = await import('../../db.js');

const TOKEN = 'witness-daemon-token';
const VALUE = 'plaintext-value-that-must-never-come-back';
const BROKER_VALUE = 'ghp_a_long_enough_token_value';

const app = express();
app.use(createDaemonAuthMiddleware({ token: TOKEN, required: true }));
app.use(express.json());
registerRoutes(app);

const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
assert.notEqual(port, 3000, 'the witness must not take the production port');
const base = `http://127.0.0.1:${port}`;

test.after(() => { server.close(); });

async function call(method: string, path: string, payload?: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
  return { status: res.status, text: await res.text() };
}

function assertNoValue(text: string, where: string): void {
  assert.ok(!text.includes(VALUE), `${where} returned the plaintext value`);
  assert.ok(!text.includes('enc:1:'), `${where} returned the sealed envelope`);
}

function brokered(name: string, hosts = ['api.github.com']) {
  const secret = dbApi.createSecret({
    name,
    // Not sealed: a legacy plaintext row (§10) is usable as-is, which keeps this
    // test free of a master key while exercising the very same path.
    value_enc: BROKER_VALUE,
    mode: 'broker',
    broker_spec: JSON.stringify({
      type: 'http',
      hosts,
      inject: { kind: 'header', name: 'Authorization', template: 'Bearer {{value}}' },
    }),
  });
  dbApi.addSecretGrant(secret.id, 'global');
  return secret;
}

let id = '';

test('a request without the daemon token is refused, on every verb', async () => {
  for (const [method, path] of [
    ['GET', '/api/secrets'],
    ['POST', '/api/secrets'],
    ['PUT', '/api/secrets/whatever'],
    ['DELETE', '/api/secrets/whatever'],
    ['GET', '/api/secrets/whatever/access'],
    ['POST', '/api/secrets/rekey'],
    ['POST', '/api/secrets/import-env'],
    ['POST', '/api/secrets/broker/http'],
    ['POST', '/api/secrets/broker/git'],
  ] as const) {
    const res = await fetch(`${base}${path}`, { method });
    assert.equal(res.status, 401, `${method} ${path} answered ${res.status}`);
  }
});

test('POST creates and answers without the value', async () => {
  const res = await call('POST', '/api/secrets', {
    name: 'ROUTE_TOKEN',
    value: VALUE,
    grants: ['global', { scope_kind: 'project', scope_ref: 'initech' }],
  });
  assert.equal(res.status, 201);
  assertNoValue(res.text, 'POST /api/secrets');
  const created = JSON.parse(res.text) as { id: string; configured: boolean; grants: unknown[] };
  assert.equal(created.configured, true);
  assert.equal(created.grants.length, 2);
  id = created.id;
});

test('neither the listing nor the detail nor the journal carries a value', async () => {
  for (const path of ['/api/secrets', `/api/secrets/${id}`, `/api/secrets/${id}/access`]) {
    const res = await call('GET', path);
    assert.equal(res.status, 200, path);
    assertNoValue(res.text, `GET ${path}`);
  }
  const journal = JSON.parse((await call('GET', `/api/secrets/${id}/access`)).text) as { access: unknown[] };
  assert.deepEqual(journal.access, [], 'the journal of a never-used secret is empty, not absent');
});

test('PUT replaces the value and still answers without it', async () => {
  const res = await call('PUT', `/api/secrets/${id}`, { value: VALUE, note: 'rotated by hand' });
  assert.equal(res.status, 200);
  assertNoValue(res.text, `PUT /api/secrets/${id}`);
  assert.equal((JSON.parse(res.text) as { note: string }).note, 'rotated by hand');
});

test('grants can be added and revoked one at a time', async () => {
  const added = await call('POST', `/api/secrets/${id}/grants`, { scope: 'agent:initech.coder' });
  assert.equal(added.status, 200);
  assert.equal((JSON.parse(added.text) as { grants: unknown[] }).grants.length, 3);

  const revoked = await call('DELETE', `/api/secrets/${id}/grants?scope=${encodeURIComponent('agent:initech.coder')}`);
  assert.equal(revoked.status, 200);
  assert.equal((JSON.parse(revoked.text) as { grants: unknown[] }).grants.length, 2);
});

test('an invalid name, mode or scope is a 400, not a stored row', async () => {
  assert.equal((await call('POST', '/api/secrets', { name: 'lower', value: 'v' })).status, 400);
  assert.equal((await call('POST', '/api/secrets', { name: 'NO_VALUE' })).status, 400);
  assert.equal((await call('POST', '/api/secrets', { name: 'BROKER_X', value: 'v', mode: 'broker' })).status, 400);
  assert.equal((await call('POST', `/api/secrets/${id}/grants`, { scope: 'project:' })).status, 400);
  assert.equal((await call('GET', '/api/secrets/does-not-exist')).status, 404);
});

test('a name+scope duplicate is a 409 that names the conflicting secret', async () => {
  const first = await call('POST', '/api/secrets', { name: 'DUP_ROUTE', value: VALUE, grants: ['global'] });
  assert.equal(first.status, 201);
  const { id: dupId } = JSON.parse(first.text) as { id: string };

  const dup = await call('POST', '/api/secrets', { name: 'DUP_ROUTE', value: VALUE, grants: ['global'] });
  assert.equal(dup.status, 409);
  assert.equal(JSON.parse(dup.text).code, 'secret_duplicate');
  assert.match(dup.text, /DUP_ROUTE/);
  assert.match(dup.text, new RegExp(dupId));
  assertNoValue(dup.text, 'POST duplicate');

  const otherScope = await call('POST', '/api/secrets', { name: 'DUP_ROUTE', value: VALUE, grants: ['project:other'] });
  assert.equal(otherScope.status, 201, 'the same name at another scope must still be accepted');

  const grantCollide = await call(
    'POST',
    `/api/secrets/${JSON.parse(otherScope.text).id}/grants`,
    { scope: 'global' },
  );
  assert.equal(grantCollide.status, 409);
  assert.match(grantCollide.text, /DUP_ROUTE/);

  const self = await call('PUT', `/api/secrets/${dupId}`, { note: 'still me' });
  assert.equal(self.status, 200);
  assertNoValue(self.text, 'PUT self');
});

test('the listing narrows to what a mission would see', async () => {
  const scoped = JSON.parse((await call('GET', '/api/secrets?project=other-project&agent=other.agent')).text) as
    { secrets: { name: string }[] };
  // ROUTE_TOKEN holds a `global` grant, so it does show; a daemon-only secret
  // must not.
  await call('POST', '/api/secrets', { name: 'DAEMON_ONLY', value: 'daemon-only-value' });
  const again = JSON.parse((await call('GET', '/api/secrets?project=other-project')).text) as
    { secrets: { name: string }[] };
  assert.ok(scoped.secrets.some((s) => s.name === 'ROUTE_TOKEN'));
  assert.equal(again.secrets.some((s) => s.name === 'DAEMON_ONLY'), false);
});

test('rekey keeps the vault readable and returns no value', async () => {
  const res = await call('POST', '/api/secrets/rekey');
  assert.equal(res.status, 200);
  assertNoValue(res.text, 'POST /api/secrets/rekey');
  const { readSecretValue } = await import('../../secrets/store.js');
  assert.equal(readSecretValue(id), VALUE);
});

test('boot finishes a rotation the previous process did not survive', async () => {
  // The unit test proves the recovery works; this one proves it is WIRED. The
  // boot path reaches `vaultKey()` only if `secrets.env` exists, so relying on
  // the lazy guard would leave a real daemon serving a vault it never opened.
  const { PENDING_SECRET_KEY_FILE } = await import('../../paths.js');
  const { readSecretValue, rekeyVault, resetRotationCheck } = await import('../../secrets/store.js');
  const { resetMasterKeyCache } = await import('../../secrets/key.js');
  const { existsSync } = await import('node:fs');
  const { apply } = await import('./index.js');

  assert.throws(
    () => rekeyVault({ afterCommit: () => { throw new Error('process killed'); } }),
    /process killed/,
  );
  assert.ok(existsSync(PENDING_SECRET_KEY_FILE), 'the candidate key was not staged');
  // What a restart looks like, minus the process boundary.
  resetMasterKeyCache();
  resetRotationCheck();

  apply({ http: { router: () => express() }, effect: () => undefined } as never);

  assert.equal(existsSync(PENDING_SECRET_KEY_FILE), false, 'boot left the candidate behind');
  assert.equal(readSecretValue(id), VALUE, 'boot did not reopen the vault');
});

test('a call missing identity or path is a 400', async () => {
  const r = await call('POST', '/api/secrets/broker/http', { identity: 'X' });
  assert.equal(r.status, 400);
});

test('an unknown identity is a 404, a denied host a 403 — and neither leaks a value', async () => {
  brokered('ROUTE_DENIED');
  const unknown = await call('POST', '/api/secrets/broker/http', { identity: 'NOT_A_SECRET', path: '/x' });
  assert.equal(unknown.status, 404);

  const denied = await call('POST', '/api/secrets/broker/http', { identity: 'ROUTE_DENIED', host: 'evil.example', path: '/x' });
  assert.equal(denied.status, 403);
  assert.equal(denied.text.includes(BROKER_VALUE), false);
  assert.equal(JSON.parse(denied.text).code, 'host-denied');
});

test('the journal route serves the facts of use, never a value', async () => {
  const secret = brokered('ROUTE_JOURNAL');
  dbApi.recordSecretAccess({ secret_id: secret.id, name: secret.name, mission_id: 'm-1', agent: 'a.coder', kind: 'broker', outcome: 'ok' });
  dbApi.recordSecretAccess({ secret_id: secret.id, name: secret.name, kind: 'inject', outcome: 'denied', detail: 'no grant for this mission' });

  const r = await call('GET', `/api/secrets/${secret.id}/access`);
  assert.equal(r.status, 200);
  assert.equal(r.text.includes(BROKER_VALUE), false);
  const { access } = JSON.parse(r.text) as { access: { outcome: string; kind: string }[] };
  assert.equal(access.length, 2);
  assert.deepEqual(access.map((a) => a.outcome).sort(), ['denied', 'ok']);
});

test('the journal of an unknown id is an empty list, not a 500', async () => {
  const r = await call('GET', '/api/secrets/no-such-id/access');
  assert.equal(r.status, 200);
  assert.deepEqual(JSON.parse(r.text), { access: [] });
});

test('the git credential route answers only for a covered host', async () => {
  const secret = dbApi.createSecret({
    name: 'ROUTE_GIT',
    value_enc: BROKER_VALUE,
    mode: 'broker',
    broker_spec: JSON.stringify({ type: 'git', hosts: ['forge-route.example'], username: 'x-access-token' }),
  });
  dbApi.addSecretGrant(secret.id, 'global');

  assert.equal((await call('POST', '/api/secrets/broker/git', {})).status, 400);
  assert.equal((await call('POST', '/api/secrets/broker/git', { host: 'nobody-covers-this.example' })).status, 404);

  const ok = await call('POST', '/api/secrets/broker/git', { host: 'forge-route.example' });
  assert.equal(ok.status, 200);
  // This route DOES hand the value over — to git, and only for a covered
  // host. See the honesty note on `brokerGitCredential`.
  assert.deepEqual(JSON.parse(ok.text), { username: 'x-access-token', password: BROKER_VALUE });
  assert.equal(dbApi.listSecretAccess(secret.id).length, 1);
});

test('the vault is an optional module, so its switch is live in the gallery', async () => {
  const { CATALOG } = await import('../../kernel/catalog.js');
  const { SECRETS_MODULE_ID } = await import('../../secrets/availability.js');
  const entry = CATALOG.find((m) => m.id === SECRETS_MODULE_ID);
  assert.ok(entry, 'the vault must be in the catalog');
  // `opt`, not `core`: the gallery locks a switch on `tier === 'core'` alone
  // (`app/src/lib/plugin-gallery.ts`), so any other tier would show a switch
  // that cannot be flipped — a module claiming to be optional and refusing to
  // go off.
  assert.equal(entry?.tier, 'opt');
});

test('DELETE removes the row', async () => {
  assert.equal((await call('DELETE', `/api/secrets/${id}`)).status, 200);
  assert.equal((await call('GET', `/api/secrets/${id}`)).status, 404);
});
