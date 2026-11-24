/**
 * A server can pin the scopes Timon asks for (`oauth_scope`): they go to the
 * client registration and to the authorization URL alike, and a client
 * registered with other scopes is registered again rather than reused.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildAuthorizeUrl, dynamicRegister, planOAuthClient } from './oauth.js';
import type { OAuthMetadata } from './oauth.js';

const bodies: Record<string, unknown>[] = [];
const server = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; });
  req.on('end', () => {
    bodies.push(JSON.parse(raw) as Record<string, unknown>);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ client_id: 'dcr-test' }));
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
test.after(() => { server.close(); });

const metadata: OAuthMetadata = {
  authorization_endpoint: 'https://idp.example/authorize',
  token_endpoint: 'https://idp.example/token',
  registration_endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}/register`,
  scopes_supported: ['a', 'b', 'c'],
};

test('the registration carries the explicit scope, and the client remembers it', async () => {
  const client = await dynamicRegister(metadata, 'http://localhost:3000/cb', undefined, 'a b');
  assert.equal(bodies.at(-1)?.scope, 'a b');
  assert.equal(client.scope, 'a b');
});

test('without a scope the registration body has none', async () => {
  const client = await dynamicRegister(metadata, 'http://localhost:3000/cb');
  assert.equal('scope' in (bodies.at(-1) ?? {}), false);
  assert.equal(client.scope, undefined);
});

test('no explicit scope: every advertised scope, stored client kept', () => {
  const stored = { client_id: 'old' };
  const plan = planOAuthClient(undefined, metadata, stored);
  assert.equal(plan.scope, 'a b c');
  assert.equal(plan.reuse, stored);
  assert.equal(plan.registerScope, undefined);
});

test('an explicit scope replaces the advertised ones', () => {
  const plan = planOAuthClient(' a b ', metadata, { client_id: 'x', scope: 'a b' });
  assert.equal(plan.scope, 'a b');
  assert.equal(plan.reuse?.client_id, 'x');
});

test('a client registered without or with other scopes is not reused', () => {
  assert.equal(planOAuthClient('a b', metadata, { client_id: 'old' }).reuse, undefined);
  assert.equal(planOAuthClient('a b', metadata, { client_id: 'old', scope: 'a b c' }).reuse, undefined);
});

test('an empty explicit scope sends none', () => {
  const plan = planOAuthClient('', metadata, { client_id: 'old', scope: 'a' });
  assert.equal(plan.scope, undefined);
  assert.equal(plan.registerScope, undefined);
  assert.equal(plan.reuse, undefined);
  // A client registered without scope already matches "none".
  assert.equal(planOAuthClient('', metadata, { client_id: 'old' }).reuse?.client_id, 'old');
  const url = new URL(buildAuthorizeUrl(metadata, { client_id: 'c' }, 'http://localhost:3000/cb', 's', 'ch', plan.scope));
  assert.equal(url.searchParams.has('scope'), false);
});

test('the authorization URL carries only the pinned scopes', () => {
  const plan = planOAuthClient('a b', metadata, undefined);
  const url = new URL(buildAuthorizeUrl(metadata, { client_id: 'c' }, 'http://localhost:3000/cb', 's', 'ch', plan.scope));
  assert.equal(url.searchParams.get('scope'), 'a b');
});
