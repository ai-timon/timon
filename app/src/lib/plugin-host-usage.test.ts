/**
 * `clientCtx.usage` — the browser capability a widget-only plugin uses
 * (§10.15). It must hit the plugin's OWN platform segment (the daemon checks
 * `usage:read` against that id) and surface a refusal as an error, never as an
 * empty list: an empty list reads as "no quota anywhere", which is exactly the
 * lie the whole three-state contract exists to prevent.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { clientContext } from './plugin-host/loader';

function withFetch<T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = impl;
  return run().finally(() => { globalThis.fetch = previous; });
}

test('usage.list queries the platform segment of the plugin', async () => {
  const calls: string[] = [];
  const entries = [{ backend: 'claude', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic', available: true, usage: { windows: {}, extra: null } }];
  const ctx = clientContext('quota-monitor', ['cockpit.widget']);
  const got = await withFetch((async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ entries }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch, () => ctx.usage.list());

  assert.deepEqual(calls, ['/api/ui/plugins/quota-monitor/-/usage']);
  assert.deepEqual(got, entries);
});

test('a ↻ asks the daemon to skip the probes\' cache; polling never does (TODO #632)', async () => {
  const calls: string[] = [];
  const ctx = clientContext('quota-monitor', ['cockpit.widget']);
  await withFetch((async (url: string) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ entries: [] }), { headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch, async () => {
    await ctx.usage.list({ force: true });
    await ctx.usage.list({ force: false });
    await ctx.usage.list({ force: 'yes' } as never);
  });
  assert.deepEqual(calls, [
    '/api/ui/plugins/quota-monitor/-/usage?refresh=1',
    '/api/ui/plugins/quota-monitor/-/usage',
    '/api/ui/plugins/quota-monitor/-/usage',
  ]);
});

test('a permission refusal comes up as an error, not as an empty list', async () => {
  const ctx = clientContext('no-permission', ['cockpit.widget']);
  await withFetch((async () => new Response('{"error":"nope"}', { status: 403 })) as unknown as typeof fetch,
    () => assert.rejects(() => ctx.usage.list(), /403/));
});

test('a missing session passes through as is, without being an empty list', async () => {
  const entries = [{
    backend: 'claude', label: 'Claude', vendor: 'Anthropic', brand: 'anthropic',
    available: false, usage: null, connected: false, reason: 'not_signed_in',
  }];
  const ctx = clientContext('quota-monitor', ['cockpit.widget']);
  const got = await withFetch((async () => new Response(JSON.stringify({ entries }), {
    headers: { 'content-type': 'application/json' },
  })) as unknown as typeof fetch, () => ctx.usage.list());
  assert.deepEqual(got, entries);
  assert.equal(got[0]?.connected, false);
  assert.ok(got[0] && !('error' in got[0]));
});
