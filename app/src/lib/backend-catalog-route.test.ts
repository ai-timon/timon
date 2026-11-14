/**
 * The catalogue's own route, exercised for real (handler + proxy + a stubbed
 * daemon), because the UI half of TODO #531 5-B lives in the URL it builds: the
 * daemon has filtered on `?project=&agent=` since 5-B, and the proxy dropped them.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { loadRequestScope } from './next-request-scope-test';

type Call = { url: string; init?: RequestInit };

async function withRoute(
  work: (get: (search: string, session?: string) => Promise<Response>, calls: Call[]) => Promise<void>,
  upstream: () => Response = () => Response.json({ backends: [], defaultBackend: 'claude' }),
): Promise<void> {
  const oldAsync = Object.getOwnPropertyDescriptor(globalThis, 'AsyncLocalStorage');
  Object.defineProperty(globalThis, 'AsyncLocalStorage', { value: AsyncLocalStorage, configurable: true });
  const requestAsyncStorage = await loadRequestScope();
  const { GET } = await import('../app/api/ui/backends/catalog/route');
  const previousFetch = globalThis.fetch;
  const oldToken = process.env.TIMON_DAEMON_TOKEN;
  process.env.TIMON_DAEMON_TOKEN = 'must-never-be-forwarded';
  const calls: Call[] = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return upstream(); };
  const get = (search: string, session?: string): Promise<Response> => requestAsyncStorage.run(
    { headers: new Headers(), cookies: { get: (name: string) => (name === 'timon_session' && session ? { value: session } : undefined) } } as never,
    () => GET(new Request(`http://localhost/api/ui/backends/catalog${search}`)),
  );
  try {
    await work(get, calls);
  } finally {
    globalThis.fetch = previousFetch;
    if (oldToken === undefined) delete process.env.TIMON_DAEMON_TOKEN; else process.env.TIMON_DAEMON_TOKEN = oldToken;
    if (oldAsync) Object.defineProperty(globalThis, 'AsyncLocalStorage', oldAsync);
    else delete (globalThis as Record<string, unknown>).AsyncLocalStorage;
  }
}

const path = (call: Call | undefined): string => {
  const url = new URL(call?.url ?? 'http://none/');
  return `${url.pathname}${url.search}`;
};

test('the target reaches the daemon, and nothing else of the query does', async () => {
  await withRoute(async (get, calls) => {
    await get('?project=alpha%20beta&agent=alpha.coder&viewer=root&token=abc', 'session-one');
    assert.equal(path(calls[0]), '/api/backends/catalog?project=alpha+beta&agent=alpha.coder');
  });
});

test('without a target the daemon is asked for the inventory, as before', async () => {
  await withRoute(async (get, calls) => {
    await get('');
    await get('?project=%20%20');
    assert.equal(path(calls[0]), '/api/backends/catalog');
    assert.equal(path(calls[1]), '/api/backends/catalog');
  });
});

test('an anonymous browser gets the refusal of the daemon, with no token of ours behind it', async () => {
  await withRoute(async (get, calls) => {
    const response = await get('?project=alpha');
    assert.equal(response.status, 401);
    const headers = new Headers(calls[0]?.init?.headers);
    assert.equal(headers.get('authorization'), null, 'the daemon token is for the CLI, MCP and agents');
    assert.equal(headers.get('cookie'), null, 'no session to relay');
    assert.doesNotMatch(calls[0]?.url ?? '', /must-never-be-forwarded/);
  }, () => Response.json({ error: 'unauthorized' }, { status: 401 }));
});
