/**
 * `/remote/sessions` lists this computer's remote API tokens: only a
 * superadmin of this computer reads it, as its own daemon says — a cookie
 * that is merely present is not enough.
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import { loadRequestScope } from '../next-request-scope-test';

const LOCAL = 'http://local-daemon.test';
process.env.ORCHESTRATOR_URL = LOCAL;
(globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = AsyncLocalStorage;

type Me = { status: number; body: unknown };

async function allowed(cookies: Record<string, string>, me: Me | 'down'): Promise<{ ok: boolean; urls: string[] }> {
  const requestAsyncStorage = await loadRequestScope();
  const { localSuperadmin } = await import('./sessions-access');
  const previousFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = async (input, init) => {
    urls.push(`${String(input)} ${new Headers(init?.headers).get('cookie') ?? ''}`);
    if (me === 'down') throw new Error('ECONNREFUSED');
    return Response.json(me.body, { status: me.status });
  };
  try {
    const ok = await requestAsyncStorage.run(
      { headers: new Headers(), cookies: { get: (name: string) => (name in cookies ? { name, value: cookies[name] } : undefined) } } as never,
      () => localSuperadmin(),
    );
    return { ok, urls };
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test('a superadmin of this computer reads it, asked of the local daemon even when switched away', async () => {
  const { ok, urls } = await allowed({ timon_session: 'root', timon_machine: 'vps' }, { status: 200, body: { user: { id: 'u1', is_superadmin: true } } });
  assert.equal(ok, true);
  assert.deepEqual(urls, [`${LOCAL}/api/auth/me timon_session=root`]);
});

test('anybody else is refused: no cookie, a cookie the daemon does not know, a member, a daemon down', async () => {
  assert.equal((await allowed({}, { status: 200, body: { user: { is_superadmin: true } } })).ok, false);
  assert.equal((await allowed({}, { status: 200, body: {} })).urls.length, 0);
  assert.equal((await allowed({ timon_session: 'forged' }, { status: 200, body: { user: null, needsSetup: false } })).ok, false);
  assert.equal((await allowed({ timon_session: 'forged' }, { status: 401, body: { error: 'unauthorized' } })).ok, false);
  assert.equal((await allowed({ timon_session: 'member' }, { status: 200, body: { user: { id: 'u2', is_superadmin: false } } })).ok, false);
  assert.equal((await allowed({ timon_session: 'root' }, 'down')).ok, false);
});
