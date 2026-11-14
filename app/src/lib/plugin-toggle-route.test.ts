/**
 * The gallery toggle's own route, exercised for real (handler + proxy + a
 * stubbed daemon), because the bug it fixes lives exactly in the URL it builds.
 *
 * Proven with curl, unauthenticated, against the running instance:
 *   /api/ui/plugins/%40timon%2Fkanban/enabled → 400, empty body
 *   /api/ui/plugins/kanban/enabled            → 401, JSON
 * The ingress rejects `%2F` in a path segment before Next and before auth, so
 * every bundled module — all of them scoped `@timon/…` — had a switch that did
 * nothing. The id now travels in the body; only the Next→daemon hop, which is
 * internal, still carries the encoded slash.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { loadRequestScope } from './next-request-scope-test';

type Call = { url: string; init?: RequestInit };

async function withRoute(
  work: (
    post: (body: unknown, session?: string) => Promise<Response>,
    calls: Call[],
    setUpstream: (fn: (init?: RequestInit) => Response) => void,
  ) => Promise<void>,
): Promise<void> {
  const oldAsync = Object.getOwnPropertyDescriptor(globalThis, 'AsyncLocalStorage');
  Object.defineProperty(globalThis, 'AsyncLocalStorage', { value: AsyncLocalStorage, configurable: true });
  const requestAsyncStorage = await loadRequestScope();
  const { POST } = await import('../app/api/ui/plugins/enabled/route');
  const previousFetch = globalThis.fetch;
  const oldToken = process.env.TIMON_DAEMON_TOKEN;
  process.env.TIMON_DAEMON_TOKEN = 'must-never-be-forwarded';
  const calls: Call[] = [];
  let upstream: (init?: RequestInit) => Response = () => Response.json({ ok: true });
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return upstream(init); };
  const post = (body: unknown, session?: string): Promise<Response> => requestAsyncStorage.run(
    { headers: new Headers(), cookies: { get: (name: string) => (name === 'timon_session' && session ? { value: session } : undefined) } } as never,
    () => POST(new Request('http://localhost/api/ui/plugins/enabled', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    })),
  );
  try {
    await work(post, calls, (fn) => { upstream = fn; });
  } finally {
    globalThis.fetch = previousFetch;
    if (oldToken === undefined) delete process.env.TIMON_DAEMON_TOKEN; else process.env.TIMON_DAEMON_TOKEN = oldToken;
    if (oldAsync) Object.defineProperty(globalThis, 'AsyncLocalStorage', oldAsync);
    else delete (globalThis as Record<string, unknown>).AsyncLocalStorage;
  }
}

test('a scoped id reaches the daemon re-encoded, with the session cookie and nothing else', async () => {
  await withRoute(async (post, calls) => {
    const response = await post({ id: '@timon/kanban', enabled: false }, 'session-one');
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1, 'exactly one hop to the daemon');
    assert.ok(calls[0]!.url.endsWith('/api/plugins/%40timon%2Fkanban/enabled'), calls[0]!.url);
    assert.deepEqual(JSON.parse(String(calls[0]!.init?.body)), { enabled: false }, 'the id does not leak into the daemon body');
    const headers = new Headers(calls[0]!.init?.headers);
    assert.equal(headers.get('cookie'), 'timon_session=session-one');
    assert.equal(headers.get('authorization'), null, 'the daemon token is never forwarded by the proxy');
  });
});

test('no session means no cookie: the daemon still decides, the route never substitutes itself', async () => {
  await withRoute(async (post, calls, setUpstream) => {
    setUpstream(() => Response.json({ error: 'unauthorized' }, { status: 401 }));
    const response = await post({ id: '@timon/kanban', enabled: true });
    assert.equal(response.status, 401, 'the daemon refusal is passed through verbatim');
    assert.equal(await response.text(), '{"error":"unauthorized"}');
    assert.equal(new Headers(calls[0]!.init?.headers).get('cookie'), null);
  });
});

test('the daemon refusals keep their status and their message', async () => {
  await withRoute(async (post, _calls, setUpstream) => {
    setUpstream(() => Response.json({ error: '@timon/db est un module core : il ne se désactive pas' }, { status: 403 }));
    const response = await post({ id: '@timon/db', enabled: false }, 'session-one');
    assert.equal(response.status, 403);
    assert.match(await response.text(), /module core/);
  });
});

test('an unusable payload is refused before any hop to the daemon', async () => {
  await withRoute(async (post, calls) => {
    for (const body of [{ enabled: true }, { id: '', enabled: true }, { id: '   ', enabled: true }, { id: 42, enabled: true }]) {
      const response = await post(body, 'session-one');
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.match((await response.json() as { error: string }).error, /id/);
    }
    for (const body of [{ id: '@timon/kanban' }, { id: '@timon/kanban', enabled: 'true' }, { id: '@timon/kanban', enabled: 1 }]) {
      const response = await post(body, 'session-one');
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.match((await response.json() as { error: string }).error, /enabled/);
    }
    const broken = await post('{not json', 'session-one');
    assert.equal(broken.status, 400);
    assert.equal(calls.length, 0, 'nothing invalid ever reached the daemon');
  });
});

test('an id with surrounding spaces is trimmed, not passed through', async () => {
  await withRoute(async (post, calls) => {
    await post({ id: '  @timon/kanban  ', enabled: true }, 'session-one');
    assert.ok(calls[0]!.url.endsWith('/api/plugins/%40timon%2Fkanban/enabled'), calls[0]!.url);
  });
});

test('the gallery no longer puts the plugin id in the URL', () => {
  const page = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'app', '(main)', 'plugins', 'plugins-client.tsx'),
    'utf8',
  );
  assert.match(page, /fetch\('\/api\/ui\/plugins\/enabled'/);
  assert.match(page, /body: JSON\.stringify\(\{ id, enabled \}\)/);
  // The exact shape the ingress answers 400 to, empty-bodied.
  assert.doesNotMatch(page, /\/api\/ui\/plugins\/\$\{encodeURIComponent\(id\)\}\/enabled/);
});
