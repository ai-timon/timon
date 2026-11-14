import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { loadRequestScope } from './next-request-scope-test';

(globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = AsyncLocalStorage;

test('login and binary proxy relay only the browser user-agent alongside session auth', async (ctx) => {
  const requestAsyncStorage = await loadRequestScope();
  const { POST } = await import('../app/api/ui/auth/login/route');
  const { proxyBinary } = await import('./ui/proxy');
  const calls: RequestInit[] = [];
  ctx.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    calls.push(init);
    return Response.json({ ok: true }, { headers: { 'set-cookie': 'timon_session=new-session; HttpOnly' } });
  });
  for (const userAgent of ['Mozilla/5.0 (iPhone)', 'Mozilla/5.0 (Windows NT 10.0)', undefined]) {
    for (const session of [undefined, 'existing-session']) {
      const headers = new Headers({
        authorization: 'Bearer untrusted', cookie: 'other=private',
        'x-forwarded-for': '192.0.2.1', 'x-real-ip': '192.0.2.2', 'x-custom': 'private',
      });
      if (userAgent) headers.set('user-agent', userAgent);
      await requestAsyncStorage.run({ headers, cookies: { get: (name: string) => name === 'timon_session' && session ? { value: session } : undefined } } as never, async () => {
        const response = await POST(new Request('http://localhost/api/ui/auth/login', {
          method: 'POST', body: JSON.stringify({ email: 'test@example.test', password: 'test' }),
        }));
        assert.match(response.headers.get('set-cookie')!, /new-session/);
        await proxyBinary('/api/image');
      });
      const expected = {
        ...(session ? { cookie: `timon_session=${session}` } : {}),
        ...(userAgent ? { 'user-agent': userAgent } : {}),
      };
      assert.deepEqual(calls.at(-2)?.headers, { ...expected, 'content-type': 'application/json' });
      assert.deepEqual(calls.at(-1)?.headers, expected);
      assert.equal(calls.at(-2)?.cache, 'no-store');
    }
  }
});
