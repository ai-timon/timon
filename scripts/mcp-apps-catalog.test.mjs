// The registry tool of the Apps catalogue, without the network: the
// "official" rule, the drafts it proposes, the drift it reports, the cursor it
// follows. The live calls (check, probe) are a maintainer's gesture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  driftOf, githubNamespace, hostedByNamespace, httpRemotes, namespaceDomain, proposalFrom,
  readCatalog, registryServers, usableEndpoint,
} from './mcp-apps-catalog.mjs';

test('a namespace reads as its domain; a GitHub namespace has none', () => {
  assert.equal(namespaceDomain('com.figma.mcp/mcp'), 'mcp.figma.com');
  assert.equal(namespaceDomain('app.linear/linear'), 'linear.app');
  assert.equal(namespaceDomain('io.github.getsentry/sentry-mcp'), null);
  assert.equal(githubNamespace('io.github.getsentry/sentry-mcp'), 'getsentry');
  assert.equal(namespaceDomain('no-slash'), null);
});

test('official by domain: the endpoint is on the proven domain, never on a shared host', () => {
  assert.equal(hostedByNamespace('app.linear/linear', 'https://mcp.linear.app/mcp'), true);
  assert.equal(hostedByNamespace('com.figma.mcp/mcp', 'https://mcp.figma.com/mcp'), true);
  // `app.vercel.x` proves x.vercel.app — someone's app, not Vercel.
  assert.equal(hostedByNamespace('app.vercel.stripecheckup/stripecheckup', 'https://stripecheckup.vercel.app/api/mcp'), false);
  assert.equal(hostedByNamespace('com.trycloudflare.foo/bar', 'https://foo.trycloudflare.com/mcp'), false);
  // A proven domain does not vouch for a third party's host.
  assert.equal(hostedByNamespace('com.example/mcp', 'https://gateway.other.example/mcp'), false);
  assert.equal(hostedByNamespace('com.example/mcp', 'http://mcp.example.com/mcp'), false);
  assert.equal(hostedByNamespace('com.neon/mcp', 'https://mcp.neon.tech/mcp'), false, 'another domain of the publisher needs a documented proof');
});

test('an endpoint that is a template or carries a secret in its query is not usable', () => {
  assert.equal(usableEndpoint('https://mcp.example.com/mcp'), true);
  assert.equal(usableEndpoint('https://huggingface.co/mcp?login'), true);
  assert.equal(usableEndpoint('https://nordic.example/mcp/stripe/{token}'), false);
  assert.equal(usableEndpoint('https://mcp.example.com/mcp?api_key=x'), false);
});

test('streamable-http comes before sse', () => {
  const remotes = httpRemotes({ remotes: [{ type: 'sse', url: 'https://a/sse' }, { type: 'streamable-http', url: 'https://a/mcp' }, { type: 'stdio' }] });
  assert.deepEqual(remotes.map((r) => r.url), ['https://a/mcp', 'https://a/sse']);
});

test('a proposal is a draft to complete, only for an official server', () => {
  assert.equal(proposalFrom({ name: 'app.vercel.x/x', remotes: [{ type: 'streamable-http', url: 'https://x.vercel.app/mcp' }] }), null);
  const draft = proposalFrom({
    name: 'com.acme/mcp', title: 'Acme', description: 'Acme tools',
    remotes: [{ type: 'streamable-http', url: 'https://mcp.acme.com/mcp', headers: [{ name: 'X-Api-Key' }] }],
  }, '2026-11-04');
  assert.equal(draft.slug, 'acme');
  assert.equal(draft.category, 'TODO');
  assert.equal(draft.auth.type, 'key');
  assert.equal(draft.auth.header, 'X-Api-Key');
  assert.deepEqual(draft.registry, { name: 'com.acme/mcp', proof: 'domain' });
});

test('drift: a server gone, an endpoint removed, a proof that no longer holds', () => {
  const entry = { mcp: { url: 'https://mcp.acme.com/mcp' }, registry: { name: 'com.acme/mcp', proof: 'domain' } };
  const record = (urls, status = 'active') => ({
    server: { name: 'com.acme/mcp', remotes: urls.map((url) => ({ type: 'streamable-http', url })) },
    _meta: { 'io.modelcontextprotocol.registry/official': { status } },
  });
  assert.deepEqual(driftOf(entry, record(['https://mcp.acme.com/mcp'])), []);
  assert.equal(driftOf(entry, null).length, 1);
  assert.match(driftOf(entry, record(['https://mcp.acme.com/v2'])).join(), /not among its remotes/);
  assert.match(driftOf(entry, record(['https://mcp.acme.com/mcp'], 'deprecated')).join(), /deprecated/);
  const moved = { ...entry, mcp: { url: 'https://acme.vercel.app/mcp' } };
  assert.match(driftOf(moved, record(['https://acme.vercel.app/mcp'])).join(), /not hosted on the namespace domain/);
  const documented = { ...entry, registry: { name: 'io.github.acme/mcp', proof: 'documented', evidence: 'https://acme.com/docs/mcp' } };
  assert.deepEqual(driftOf(documented, record(['https://mcp.acme.com/mcp'])), []);
  assert.deepEqual(driftOf(documented, record(['https://legacy.acme.com/mcp'])), [], 'the evidence, not a stale registry remote, pins a documented endpoint');
});

test('the registry is read to the end of its cursor', async () => {
  const pages = {
    '': { servers: [{ server: { name: 'a/1' } }], metadata: { nextCursor: 'c1' } },
    c1: { servers: [{ server: { name: 'b/2' } }], metadata: {} },
  };
  const asked = [];
  const fetcher = async (url) => {
    const cursor = new URL(url).searchParams.get('cursor') ?? '';
    asked.push(new URL(url).searchParams.get('version'));
    return pages[cursor];
  };
  const names = [];
  for await (const item of registryServers({ fetcher })) names.push(item.server.name);
  assert.deepEqual(names, ['a/1', 'b/2']);
  assert.deepEqual(asked, ['latest', 'latest']);
});

test('every reviewed entry holds its own proof', () => {
  const catalog = readCatalog();
  assert.ok(catalog.length >= 15);
  for (const { file, entry } of catalog) {
    const self = { server: { name: entry.registry.name, remotes: [{ type: 'streamable-http', url: entry.mcp.url }] } };
    assert.deepEqual(driftOf(entry, self), [], file);
  }
});
