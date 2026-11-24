/**
 * Upstream model discovery: what must stay true whatever happens to the
 * network.
 *
 * The contract tested is not "we can parse JSON", it is the degradation
 * POLICY: an unreachable, mute or inconsistent provider must never
 * empty a menu nor make a model the user could pick disappear.
 * Without these tests, the failure shows in production as an
 * empty picker, a mute symptom.
 *
 * `node --test --import tsx src/backends/model-discovery.test.ts` (or `npm test`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { refreshModels, discoveredModels, discoveryError } from './model-discovery.js';
import type { BackendProfile } from './types.js';

/** A minimal profile, a different id per test: the discovery state is a
 *  module cache indexed by id, two tests sharing the id would share
 *  the cache (and so the TTL already consumed). */
function profileOf(id: string): BackendProfile {
  return {
    id,
    dialect: 'codex',
    label: id,
    defaultModel: 'known-a',
    models: [
      { slug: 'known-a', label: 'Known A', presetLabel: 'A', presetRank: 10, contextWindow: 128_000 },
      { slug: 'known-b', label: 'Known B' },
    ],
    modelsEndpoint: { url: 'https://example.invalid/v1/models', format: 'openai' },
  };
}

/** Replaces `fetch` for the length of a test and restores it afterwards. */
async function withFetch(
  impl: () => Promise<Response>,
  fn: () => Promise<void>,
): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as typeof globalThis.fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

test('the slugs come from upstream, the metadata stays local', async () => {
  const p = profileOf('disco-merge');
  await withFetch(
    async () => jsonResponse({ data: [{ id: 'known-a' }, { id: 'brand-new' }] }),
    async () => {
      await refreshModels(p);
      const models = discoveredModels(p.id);
      assert.ok(models);
      // `known-b` disappeared upstream → it disappears from the menu: that is the whole
      // point, no longer offering a withdrawn model.
      assert.deepEqual(models.map((m) => m.slug), ['known-a', 'brand-new']);
      // What upstream does not know (preset, context window) survives.
      assert.equal(models[0]?.presetLabel, 'A');
      assert.equal(models[0]?.contextWindow, 128_000);
      // A model unknown to the repository invents no metadata.
      assert.equal(models[1]?.label, 'brand-new');
      assert.equal(models[1]?.contextWindow, undefined);
      assert.equal(discoveryError(p.id), null);
    },
  );
});

test('a failing endpoint leaves the static list, never an empty list', async () => {
  const p = profileOf('disco-http-500');
  await withFetch(
    async () => jsonResponse({ error: 'boom' }, 500),
    async () => {
      await refreshModels(p);
      // null = "nothing discovered" → the caller falls back on profile.models.
      assert.equal(discoveredModels(p.id), null);
      assert.match(discoveryError(p.id) ?? '', /500/);
    },
  );
});

test('an empty or unreadable response is treated as a failure', async () => {
  for (const [id, body] of [
    ['disco-empty', { data: [] }],
    ['disco-shape', { models: ['a'] }],
  ] as const) {
    const p = profileOf(id);
    await withFetch(
      async () => jsonResponse(body),
      async () => {
        await refreshModels(p);
        assert.equal(discoveredModels(p.id), null, id);
        assert.ok(discoveryError(p.id), id);
      },
    );
  }
});

test('a successful discovery survives a later failure', async () => {
  const p = profileOf('disco-sticky');
  await withFetch(
    async () => jsonResponse({ data: [{ id: 'known-a' }] }),
    async () => { await refreshModels(p); },
  );
  assert.deepEqual(discoveredModels(p.id)?.map((m) => m.slug), ['known-a']);
  await withFetch(
    async () => { throw new Error('réseau coupé'); }, // french-ok: sample error text
    async () => { await refreshModels(p, true); },
  );
  // The previous state holds: better a list from yesterday than no list.
  assert.deepEqual(discoveredModels(p.id)?.map((m) => m.slug), ['known-a']);
  assert.match(discoveryError(p.id) ?? '', /réseau coupé/); // french-ok: sample error text
});

test('without a declared endpoint, no request is attempted', async () => {
  const p: BackendProfile = { ...profileOf('disco-none'), modelsEndpoint: undefined };
  let called = false;
  await withFetch(
    async () => { called = true; return jsonResponse({ data: [] }); },
    async () => { await refreshModels(p, true); },
  );
  assert.equal(called, false);
  assert.equal(discoveredModels(p.id), null);
});

test('the TTL avoids asking upstream again on each read', async () => {
  const p = profileOf('disco-ttl');
  let calls = 0;
  await withFetch(
    async () => { calls += 1; return jsonResponse({ data: [{ id: 'known-a' }] }); },
    async () => {
      await refreshModels(p);
      await refreshModels(p);
      await refreshModels(p);
      assert.equal(calls, 1);
      // `force` short-circuits the TTL: that is what the boot does.
      await refreshModels(p, true);
      assert.equal(calls, 2);
    },
  );
});

test('a dialect probe feeds the catalogue like an endpoint, and fails the same way', async () => {
  const { modelsEndpoint: _dropped, ...base } = profileOf('disco-probe');
  const p: BackendProfile = base;
  await refreshModels(p, true, async () => ['known-b', 'org-only']);
  assert.deepEqual(discoveredModels('disco-probe')?.map((m) => m.slug), ['known-b', 'org-only']);

  // A probe that cannot tell leaves the last good list in place.
  await refreshModels(p, true, async () => { throw new Error('not logged in'); });
  assert.deepEqual(discoveredModels('disco-probe')?.map((m) => m.slug), ['known-b', 'org-only']);
  assert.equal(discoveryError('disco-probe'), 'not logged in');

  // Neither an endpoint nor a probe: nothing to refresh.
  await refreshModels({ ...p, id: 'disco-none' }, true);
  assert.equal(discoveredModels('disco-none'), null);
});

test('the levels a probe reports reach the catalogue; the profile\'s own levels win', async () => {
  const { modelsEndpoint: _dropped, ...base } = profileOf('disco-levels');
  const p: BackendProfile = {
    ...base,
    models: [
      { slug: 'known-a', label: 'Known A' },
      { slug: 'known-b', label: 'Known B', supportedReasoningLevels: ['low'] },
    ],
  };
  await refreshModels(p, true, async () => [
    { slug: 'known-a', supportedReasoningLevels: ['low', 'high'] },
    { slug: 'known-b', supportedReasoningLevels: ['max'] },
    { slug: 'org-only', supportedReasoningLevels: ['high'] },
    'plain',
  ]);
  const found = discoveredModels('disco-levels');
  assert.deepEqual(found?.map((m) => [m.slug, m.supportedReasoningLevels]), [
    ['known-a', ['low', 'high']],
    ['known-b', ['low']],
    ['org-only', ['high']],
    ['plain', undefined],
  ]);
});
