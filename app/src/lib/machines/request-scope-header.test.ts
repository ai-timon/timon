/**
 * `X-Timon-Machine` on the paths that resolve their target from the Next
 * request scope — the server render and every proxied route, which call
 * `targetFor(path)` without their request. A window pinned to one machine
 * (desktop, V1 of the multi-window work) must be served by that machine,
 * whatever the cookie says, and only if it is one of the local session's.
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadRequestScope, type RequestScopeRunner } from '../next-request-scope-test';

const LOCAL = 'http://local-daemon.test';
const REMOTE = 'https://vps.example';
const SESSION = 'local-session-of-alice';
const DEVICE_TOKEN = 'tdev_device-token-of-alice-for-vps';

type Call = { url: string; headers: Headers };

let home = '';
let storage!: RequestScopeRunner;
let proxy!: typeof import('../ui/proxy');
let target!: typeof import('./target');
let credential!: typeof import('./credential');
const calls: Call[] = [];
const previousFetch = globalThis.fetch;

test.before(async () => {
  home = mkdtempSync(join(tmpdir(), 'timon-scope-header-'));
  writeFileSync(join(home, 'daemon-token'), 'daemon-token');
  process.env.TIMON_HOME = home;
  process.env.ORCHESTRATOR_URL = LOCAL;
  (globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = AsyncLocalStorage;
  storage = await loadRequestScope();
  proxy = await import('../ui/proxy');
  target = await import('./target');
  credential = await import('./credential');
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    const found = /\/api\/machines\/([^/]+)\/credential$/.exec(url);
    if (found) {
      const id = decodeURIComponent(found[1]!);
      // Owner-filtered, as the daemon answers: another account's machine is a 404.
      if (id !== 'vps') return Response.json({ error: 'machine not found' }, { status: 404 });
      return Response.json({ id, url: REMOTE, token: DEVICE_TOKEN });
    }
    return Response.json({ ok: true });
  };
});

test.after(() => {
  globalThis.fetch = previousFetch;
  rmSync(home, { recursive: true, force: true });
});

test.beforeEach(() => {
  calls.length = 0;
  credential.forgetMachineCredentials();
});

/** Runs `fn` in a Next request scope. `headers: false` leaves the headers out
 *  of the store, as a scope that only knows its cookies. */
function inScope<T>(headers: Record<string, string>, cookies: Record<string, string>, fn: () => Promise<T>, withHeaders = true): Promise<T> {
  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  const all = new Headers({ 'sec-fetch-site': 'same-origin', host: 'app.test', ...headers, ...(cookieHeader ? { cookie: cookieHeader } : {}) });
  return storage.run(
    {
      ...(withHeaders ? { headers: all } : {}),
      cookies: { get: (name: string) => (name in cookies ? { name, value: cookies[name] } : undefined) },
    },
    fn,
  );
}

const agents = (): Call[] => calls.filter((c) => c.url.endsWith('/api/agents'));

test('the header names the machine the proxy relays to, ahead of the cookie', async () => {
  const res = await inScope({ 'x-timon-machine': 'vps' }, { timon_session: SESSION, timon_machine: 'local' }, () => proxy.proxyJson('GET', '/api/agents'));
  assert.equal(res.status, 200);
  assert.deepEqual(agents().map((c) => c.url), [`${REMOTE}/api/agents`]);
  assert.equal(agents()[0]?.headers.get('authorization'), `Bearer ${DEVICE_TOKEN}`);
  assert.equal(agents()[0]?.headers.get('x-timon-machine'), null);
});

test('X-Timon-Machine: local is served here while the cookie names a remote machine', async () => {
  await inScope({ 'x-timon-machine': 'local' }, { timon_session: SESSION, timon_machine: 'vps' }, () => proxy.proxyJson('GET', '/api/agents'));
  assert.deepEqual(calls.map((c) => c.url), [`${LOCAL}/api/agents`]);
});

test('without the header, the cookie decides, as before', async () => {
  await inScope({}, { timon_session: SESSION, timon_machine: 'vps' }, () => proxy.proxyJson('GET', '/api/agents'));
  assert.deepEqual(agents().map((c) => c.url), [`${REMOTE}/api/agents`]);
  calls.length = 0;
  await inScope({ 'x-timon-machine': '' }, { timon_session: SESSION }, () => proxy.proxyJson('GET', '/api/agents'));
  assert.deepEqual(calls.map((c) => c.url), [`${LOCAL}/api/agents`]);
});

test('a scope without headers: the cookie alone decides', async () => {
  const t = await inScope({}, { timon_session: SESSION, timon_machine: 'vps' }, () => target.resolveTarget(), false);
  assert.equal(t.kind, 'remote');
});

test('another account\'s machine named by the header: refused, nothing relayed', async () => {
  const res = await inScope({ 'x-timon-machine': 'bobs-machine' }, { timon_session: SESSION, timon_machine: 'vps' }, () => proxy.proxyJson('DELETE', '/api/agents'));
  assert.equal(res.status, 404);
  assert.equal(agents().length, 0);
});

test('anonymous: the header names a machine, nothing is asked nor relayed', async () => {
  const res = await inScope({ 'x-timon-machine': 'vps' }, {}, () => proxy.proxyJson('GET', '/api/agents'));
  assert.equal(res.status, 401);
  assert.equal(calls.length, 0);
});

test('a malformed header is refused, never served by the cookie\'s machine nor locally', async () => {
  const res = await inScope({ 'x-timon-machine': '../vps' }, { timon_session: SESSION, timon_machine: 'vps' }, () => proxy.proxyJson('POST', '/api/agents', {}));
  assert.equal(res.status, 404);
  assert.equal(calls.length, 0);
  const t = await inScope({ 'x-timon-machine': 'https://evil.example' }, { timon_session: SESSION }, () => target.resolveTarget());
  assert.equal(t.kind, 'unavailable');
});

test('the header loosens nothing: a cross-site mutation to the pinned machine is refused', async () => {
  const res = await inScope({ 'x-timon-machine': 'vps', 'sec-fetch-site': 'cross-site' }, { timon_session: SESSION }, () => proxy.proxyJson('POST', '/api/agents', {}));
  assert.equal(res.status, 403);
  assert.equal(agents().length, 0);
});

test('the account and the fleet stay on this computer for a pinned request', async () => {
  await inScope({ 'x-timon-machine': 'vps' }, { timon_session: SESSION }, () => proxy.proxyJson('GET', '/api/machines'));
  assert.deepEqual(calls.map((c) => c.url), [`${LOCAL}/api/machines`]);
});
