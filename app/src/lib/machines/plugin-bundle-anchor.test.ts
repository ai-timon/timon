/**
 * P4d — a plugin's browser half and the list it is compared with come from
 * THIS computer's daemon, even when the browser is switched to a remote one.
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadRequestScope, type RequestScopeRunner } from '../next-request-scope-test';

const LOCAL = 'http://local-daemon.test';
const SESSION = 'local-session-of-alice';

let home = '';
let storage!: RequestScopeRunner;
const urls: string[] = [];
const previousFetch = globalThis.fetch;

test.before(async () => {
  home = mkdtempSync(join(tmpdir(), 'timon-bundle-'));
  writeFileSync(join(home, 'daemon-token'), 'daemon-token');
  process.env.TIMON_HOME = home;
  process.env.ORCHESTRATOR_URL = LOCAL;
  (globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = AsyncLocalStorage;
  storage = await loadRequestScope();
  globalThis.fetch = async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/credential')) return Response.json({ id: 'vps', url: 'https://vps.example', token: 'tdev_device-token-of-alice-for-vps' });
    if (url.endsWith('/client.js?rev=r1')) return new Response('export function apply() {}', { headers: { 'content-type': 'text/javascript' } });
    return Response.json({ plugins: [] });
  };
});

test.after(() => {
  globalThis.fetch = previousFetch;
  rmSync(home, { recursive: true, force: true });
});

function onRemote<T>(fn: () => Promise<T>): Promise<T> {
  urls.length = 0;
  const cookies: Record<string, string> = { timon_session: SESSION, timon_machine: 'vps' };
  return storage.run(
    {
      headers: new Headers({ cookie: `timon_session=${SESSION}; timon_machine=vps`, 'sec-fetch-site': 'same-origin' }),
      cookies: { get: (name: string) => (name in cookies ? { name, value: cookies[name] } : undefined) },
    },
    fn,
  );
}

test('the bundle of a plugin is the local daemon’s, whatever the active machine', async () => {
  const { GET } = await import('../../app/api/ui/plugin-bundles/[id]/route');
  const res = await onRemote(() => GET(new Request('http://app.test/api/ui/plugin-bundles/hello?rev=r1'), { params: { id: 'hello' } }));
  assert.equal(res.status, 200);
  assert.deepEqual(urls, [`${LOCAL}/plugins/hello/client.js?rev=r1`]);
});

test('the local plugin list is the local daemon’s; the plain list follows the active machine', async () => {
  const local = await import('../../app/api/ui/plugins/local/route');
  await onRemote(() => local.GET());
  assert.deepEqual(urls, [`${LOCAL}/api/plugins`]);
  const active = await import('../../app/api/ui/plugins/route');
  await onRemote(() => active.GET());
  assert.ok(urls.includes('https://vps.example/api/plugins'));
});
