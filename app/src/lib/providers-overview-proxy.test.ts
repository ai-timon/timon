/**
 * `/api/ui/providers/overview[/<id>]`, exercised for real (handler + proxy + a
 * stubbed daemon). The route is an allow-list: only the two overview shapes
 * reach the daemon's `/api/providers/overview`, with the session cookie and
 * never the daemon token; anything else under `overview` stops at a 404,
 * before any hop.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { loadRequestScope } from './next-request-scope-test';

type Call = { url: string; init?: RequestInit };
type Handlers = typeof import('../app/api/ui/providers/[...path]/route');

async function withRoute(work: (handlers: Handlers, call: <T>(fn: () => Promise<T>, session?: string) => Promise<T>, calls: Call[]) => Promise<void>): Promise<void> {
  const oldAsync = Object.getOwnPropertyDescriptor(globalThis, 'AsyncLocalStorage');
  Object.defineProperty(globalThis, 'AsyncLocalStorage', { value: AsyncLocalStorage, configurable: true });
  const requestScope = await loadRequestScope();
  const handlers = await import('../app/api/ui/providers/[...path]/route');
  const previousFetch = globalThis.fetch;
  const oldToken = process.env.TIMON_DAEMON_TOKEN;
  process.env.TIMON_DAEMON_TOKEN = 'must-never-be-forwarded';
  const calls: Call[] = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ providers: [] }); };
  const call = <T,>(fn: () => Promise<T>, session?: string): Promise<T> => requestScope.run(
    { headers: new Headers(), cookies: { get: (name: string) => (name === 'timon_session' && session ? { value: session } : undefined) } },
    fn,
  );
  try {
    await work(handlers, call, calls);
  } finally {
    globalThis.fetch = previousFetch;
    if (oldToken === undefined) delete process.env.TIMON_DAEMON_TOKEN; else process.env.TIMON_DAEMON_TOKEN = oldToken;
    if (oldAsync) Object.defineProperty(globalThis, 'AsyncLocalStorage', oldAsync);
    else delete (globalThis as Record<string, unknown>).AsyncLocalStorage;
  }
}

const get = (handlers: Handlers, path: string[]): Promise<Response> =>
  handlers.GET(new Request(`http://localhost/api/ui/providers/${path.join('/')}`), { params: { path } });

test('the overview and one provider reach the daemon with the session cookie, never the daemon token', async () => {
  await withRoute(async (handlers, call, calls) => {
    assert.equal((await call(() => get(handlers, ['overview']), 'session-one')).status, 200);
    assert.equal((await call(() => get(handlers, ['overview', 'provider-acp.opencode']), 'session-one')).status, 200);
    assert.equal((await call(() => get(handlers, ['overview', 'user:my-endpoint']), 'session-one')).status, 200);
    assert.deepEqual(calls.map((entry) => new URL(entry.url).pathname), [
      '/api/providers/overview',
      '/api/providers/overview/provider-acp.opencode',
      '/api/providers/overview/user%3Amy-endpoint',
    ]);
    for (const entry of calls) {
      const headers = new Headers(entry.init?.headers);
      assert.equal(headers.get('cookie'), 'timon_session=session-one');
      assert.equal(headers.get('authorization'), null, 'the daemon token is never forwarded by the proxy');
    }
  });
});

test('no session: the daemon decides, with no cookie and no token', async () => {
  await withRoute(async (handlers, call, calls) => {
    await call(() => get(handlers, ['overview']));
    assert.equal(calls.length, 1);
    const headers = new Headers(calls[0]!.init?.headers);
    assert.equal(headers.get('cookie'), null);
    assert.equal(headers.get('authorization'), null);
  });
});

test('anything else under overview stops at a 404, before any hop', async () => {
  await withRoute(async (handlers, call, calls) => {
    for (const path of [
      ['overview', 'claude', 'programs'],
      ['overview', '..'],
      ['overview', '-leading-dash'],
      ['overview', 'a b'],
      ['overview', 'x'.repeat(202)],
    ]) {
      assert.equal((await call(() => get(handlers, path), 'session-one')).status, 404, path.join('/'));
    }
    const post = await call(() => handlers.POST(new Request('http://localhost/api/ui/providers/overview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }), { params: { path: ['overview'] } }), 'session-one');
    assert.equal(post.status, 404, 'the overview is read-only');
    const remove = await call(() => handlers.DELETE(new Request('http://localhost/api/ui/providers/overview/claude', { method: 'DELETE' }),
      { params: { path: ['overview', 'claude'] } }), 'session-one');
    assert.equal(remove.status, 404);
    assert.equal(calls.length, 0, 'no call reached the daemon');
  });
});
