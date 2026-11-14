/**
 * Signing out forgets the active machine (relecture de V9). With the
 * `timon_machine` cookie left behind, the next page load named a remote
 * machine nobody had a session for, and the "machine blocked" screen took the
 * place of the login page.
 */
import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import { loadRequestScope } from '../next-request-scope-test';

type Call = { url: string; init?: RequestInit };

async function logout(cookies: Record<string, string>, url = 'http://localhost/api/ui/auth/logout', headers: Record<string, string> = {}): Promise<{ response: Response; calls: Call[] }> {
  const oldAsync = Object.getOwnPropertyDescriptor(globalThis, 'AsyncLocalStorage');
  Object.defineProperty(globalThis, 'AsyncLocalStorage', { value: AsyncLocalStorage, configurable: true });
  const requestAsyncStorage = await loadRequestScope();
  const { POST } = await import('../../app/api/ui/auth/logout/route');
  const previousFetch = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'set-cookie': 'timon_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax' },
    });
  };
  try {
    const response = await requestAsyncStorage.run(
      { headers: new Headers(headers), cookies: { get: (name: string) => (name in cookies ? { value: cookies[name] } : undefined) } } as never,
      () => POST(new Request(url, { method: 'POST', headers })),
    );
    return { response, calls };
  } finally {
    globalThis.fetch = previousFetch;
    if (oldAsync) Object.defineProperty(globalThis, 'AsyncLocalStorage', oldAsync);
    else delete (globalThis as Record<string, unknown>).AsyncLocalStorage;
  }
}

function setCookies(response: Response): string[] {
  return response.headers.getSetCookie();
}

test('logout clears the machine cookie next to the session one', async () => {
  const { response, calls } = await logout({ timon_session: 'alice', timon_machine: 'vps' });
  assert.equal(response.status, 200);
  const cookies = setCookies(response);
  assert.ok(cookies.some((line) => line.startsWith('timon_session=;')), 'the daemon’s own Set-Cookie is kept');
  const machine = cookies.find((line) => line.startsWith('timon_machine='));
  assert.ok(machine, 'timon_machine is cleared');
  assert.match(machine, /^timon_machine=; Max-Age=0; Path=\/; SameSite=Lax; HttpOnly$/);
  // Anchored on the local daemon, whatever the cookie named: one call, no
  // credential lookup for the remote machine.
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.url, /\/api\/auth\/logout$/);
});

test('the cleared cookie is Secure when the browser came over HTTPS', async () => {
  const { response } = await logout({ timon_session: 'alice', timon_machine: 'vps' }, 'http://localhost/api/ui/auth/logout', { 'x-forwarded-proto': 'https' });
  const machine = setCookies(response).find((line) => line.startsWith('timon_machine='));
  assert.ok(machine?.endsWith('; Secure'));
});

test('a failed logout still forgets the machine', async () => {
  const oldAsync = Object.getOwnPropertyDescriptor(globalThis, 'AsyncLocalStorage');
  Object.defineProperty(globalThis, 'AsyncLocalStorage', { value: AsyncLocalStorage, configurable: true });
  const requestAsyncStorage = await loadRequestScope();
  const { POST } = await import('../../app/api/ui/auth/logout/route');
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ error: 'unauthorized' }, { status: 401 });
  try {
    const response = await requestAsyncStorage.run(
      { headers: new Headers(), cookies: { get: () => undefined } } as never,
      () => POST(new Request('http://localhost/api/ui/auth/logout', { method: 'POST' })),
    );
    assert.equal(response.status, 401);
    assert.ok(setCookies(response).some((line) => line.startsWith('timon_machine=; Max-Age=0')));
  } finally {
    globalThis.fetch = previousFetch;
    if (oldAsync) Object.defineProperty(globalThis, 'AsyncLocalStorage', oldAsync);
    else delete (globalThis as Record<string, unknown>).AsyncLocalStorage;
  }
});
