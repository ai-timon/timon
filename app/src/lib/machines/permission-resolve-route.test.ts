/**
 * A push notification's Approve/Deny answers for the machine that notified
 * (P4b), whatever the machine the interface is switched to. The route honours
 * `X-Timon-Machine`, and nothing else does.
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
const DAEMON_TOKEN = 'daemon-token-must-never-leave';

type Call = { url: string; headers: Headers; body: string | null };
type RouteModule = typeof import('../../app/api/ui/permissions/[id]/resolve/route');

let home = '';
let route!: RouteModule;
let storage!: RequestScopeRunner;
const calls: Call[] = [];
const previousFetch = globalThis.fetch;

test.before(async () => {
  home = mkdtempSync(join(tmpdir(), 'timon-resolve-'));
  writeFileSync(join(home, 'daemon-token'), DAEMON_TOKEN);
  process.env.TIMON_HOME = home;
  process.env.ORCHESTRATOR_URL = LOCAL;
  (globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = AsyncLocalStorage;
  storage = await loadRequestScope();
  route = await import('../../app/api/ui/permissions/[id]/resolve/route');
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers), body: typeof init?.body === 'string' ? init.body : null });
    const credential = /\/api\/machines\/([^/]+)\/credential$/.exec(url);
    if (credential) {
      const id = decodeURIComponent(credential[1]!);
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
});

function resolve(headers: Record<string, string>, cookies: Record<string, string>): Promise<Response> {
  const all = { 'content-type': 'application/json', 'sec-fetch-site': 'same-origin', host: 'app.test', ...headers };
  const cookieHeader = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ');
  return storage.run(
    {
      headers: new Headers({ ...all, ...(cookieHeader ? { cookie: cookieHeader } : {}) }),
      cookies: { get: (name: string) => (name in cookies ? { name, value: cookies[name] } : undefined) },
    },
    () => route.POST(
      new Request('http://app.test/api/ui/permissions/perm-1/resolve', {
        method: 'POST',
        headers: all,
        body: JSON.stringify({ behavior: 'allow', origin: 'push_action' }),
      }),
      { params: { id: 'perm-1' } },
    ),
  );
}

const relayed = (): Call[] => calls.filter((c) => c.url.endsWith('/api/permissions/perm-1/resolve'));

test('a card of a remote machine is answered there, with its device token only', async () => {
  const res = await resolve({ 'x-timon-machine': 'vps' }, { timon_session: SESSION });
  assert.equal(res.status, 200);
  const [call] = relayed();
  assert.equal(call?.url, `${REMOTE}/api/permissions/perm-1/resolve`);
  assert.equal(call?.headers.get('authorization'), `Bearer ${DEVICE_TOKEN}`);
  assert.equal(call?.headers.get('cookie'), null);
  const sent: string[] = [];
  call?.headers.forEach((value) => { sent.push(value); });
  assert.ok(!sent.some((value) => value.includes(DAEMON_TOKEN)));
});

test('a card of this computer is answered here even while switched to a remote machine', async () => {
  const res = await resolve({ 'x-timon-machine': 'local' }, { timon_session: SESSION, timon_machine: 'vps' });
  assert.equal(res.status, 200);
  assert.deepEqual(relayed().map((c) => c.url), [`${LOCAL}/api/permissions/perm-1/resolve`]);
  // No credential was even looked up for the active machine.
  assert.equal(calls.filter((c) => c.url.includes('/credential')).length, 0);
});

test('without the header, the active machine answers, as the interface cards do', async () => {
  await resolve({}, { timon_session: SESSION, timon_machine: 'vps' });
  assert.deepEqual(relayed().map((c) => c.url), [`${REMOTE}/api/permissions/perm-1/resolve`]);
});

test('a malformed machine is refused before anything is sent', async () => {
  const res = await resolve({ 'x-timon-machine': '../vps' }, { timon_session: SESSION });
  assert.equal(res.status, 400);
  assert.equal(calls.length, 0);
});

test('a machine of nobody here, or no local session, sends nothing anywhere', async () => {
  const unknown = await resolve({ 'x-timon-machine': 'other' }, { timon_session: SESSION });
  assert.equal(unknown.status, 404);
  const anonymous = await resolve({ 'x-timon-machine': 'vps' }, {});
  assert.equal(anonymous.status, 401);
  assert.equal(relayed().length, 0);
});

test('a cross-site request naming a remote machine is refused by the relay', async () => {
  const res = await resolve({ 'x-timon-machine': 'vps', 'sec-fetch-site': 'cross-site' }, { timon_session: SESSION });
  assert.equal(res.status, 403);
  assert.equal(relayed().length, 0);
});
