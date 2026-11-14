import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { loadRequestScope } from './next-request-scope-test';

(globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = AsyncLocalStorage;

/** The task attachment proxy: the file and the download flag cross, nothing else. */
test('task attachments: the proxy forwards the file fields and the download flag only', async (ctx) => {
  const requestAsyncStorage = await loadRequestScope();
  const list = await import('../app/api/ui/tasks/[id]/attachments/route');
  const one = await import('../app/api/ui/tasks/[id]/attachments/[attachmentId]/route');
  const calls: { url: string; init: RequestInit }[] = [];
  ctx.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(new Uint8Array([0x89, 0x50]), {
      headers: { 'content-type': 'image/png', 'content-disposition': 'inline; filename="a.png"', 'x-content-type-options': 'nosniff' },
    });
  });
  const store = { headers: new Headers(), cookies: { get: (name: string) => (name === 'timon_session' ? { value: 'session' } : undefined) } } as never;
  await requestAsyncStorage.run(store, async () => {
    await list.POST(new Request('http://localhost/api/ui/tasks/t1/attachments', {
      method: 'POST',
      body: JSON.stringify({ name: 'a.png', data: 'iVA=', mime: 'image/png', path: '/etc/passwd', task_id: 'other' }),
    }), { params: { id: 't1' } });
    const served = await one.GET(
      new Request('http://localhost/api/ui/tasks/t1/attachments/abc?download=1&token=secret'),
      { params: { id: 't1', attachmentId: 'abc' } },
    );
    assert.equal(served.headers.get('content-type'), 'image/png');
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    assert.match(served.headers.get('content-disposition') ?? '', /^inline/);
    await one.DELETE(new Request('http://localhost/'), { params: { id: '../x', attachmentId: 'abc' } });
  });
  assert.match(calls[0]!.url, /\/api\/tasks\/t1\/attachments$/);
  assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), { name: 'a.png', data: 'iVA=', mime: 'image/png' });
  assert.match(calls[1]!.url, /\/api\/tasks\/t1\/attachments\/abc\?download=1$/);
  assert.match(calls[2]!.url, /\/api\/tasks\/\.\.%2Fx\/attachments\/abc$/);
  assert.equal(calls[2]!.init.method, 'DELETE');
});

/** The idea attachment proxy: same shape as the task one. */
test('idea attachments: the proxy forwards the file fields and the download flag only', async (ctx) => {
  const requestAsyncStorage = await loadRequestScope();
  const list = await import('../app/api/ui/project-todo/[id]/attachments/route');
  const one = await import('../app/api/ui/project-todo/[id]/attachments/[attachmentId]/route');
  const calls: { url: string; init: RequestInit }[] = [];
  ctx.mock.method(globalThis, 'fetch', async (url: unknown, init: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(new Uint8Array([0x89, 0x50]), {
      headers: { 'content-type': 'image/png', 'content-disposition': 'inline; filename="a.png"', 'x-content-type-options': 'nosniff' },
    });
  });
  const store = { headers: new Headers(), cookies: { get: (name: string) => (name === 'timon_session' ? { value: 'session' } : undefined) } } as never;
  await requestAsyncStorage.run(store, async () => {
    await list.GET(new Request('http://localhost/api/ui/project-todo/209/attachments'), { params: { id: '209' } });
    await list.POST(new Request('http://localhost/api/ui/project-todo/209/attachments', {
      method: 'POST',
      body: JSON.stringify({ name: 'a.png', data: 'iVA=', mime: 'image/png', path: '/etc/passwd', todo_id: 1 }),
    }), { params: { id: '209' } });
    const served = await one.GET(
      new Request('http://localhost/api/ui/project-todo/209/attachments/abc?download=1&token=secret'),
      { params: { id: '209', attachmentId: 'abc' } },
    );
    assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
    await one.DELETE(new Request('http://localhost/'), { params: { id: '../x', attachmentId: 'abc' } });
  });
  assert.match(calls[0]!.url, /\/api\/project-todo\/209\/attachments$/);
  assert.deepEqual(JSON.parse(String(calls[1]!.init.body)), { name: 'a.png', data: 'iVA=', mime: 'image/png' });
  assert.match(calls[2]!.url, /\/api\/project-todo\/209\/attachments\/abc\?download=1$/);
  assert.match(calls[3]!.url, /\/api\/project-todo\/\.\.%2Fx\/attachments\/abc$/);
  assert.equal(calls[3]!.init.method, 'DELETE');
});

test('idea attachments: an anonymous call reaches the daemon with no credential, and its 401 comes back', async (ctx) => {
  const requestAsyncStorage = await loadRequestScope();
  const list = await import('../app/api/ui/project-todo/[id]/attachments/route');
  const one = await import('../app/api/ui/project-todo/[id]/attachments/[attachmentId]/route');
  const previous = process.env.TIMON_DAEMON_TOKEN;
  process.env.TIMON_DAEMON_TOKEN = 'daemon-token-must-not-leak';
  const seen: Headers[] = [];
  ctx.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    seen.push(new Headers(init?.headers));
    return Response.json({ error: 'Authentication required', code: 'unauthorized' }, { status: 401 });
  });
  const anonymous = { headers: new Headers(), cookies: { get: () => undefined } } as never;
  try {
    const statuses = await requestAsyncStorage.run(anonymous, async () => [
      (await list.GET(new Request('http://localhost/api/ui/project-todo/209/attachments'), { params: { id: '209' } })).status,
      (await list.POST(new Request('http://localhost/api/ui/project-todo/209/attachments', {
        method: 'POST', body: JSON.stringify({ name: 'a.png', data: 'iVA=' }),
      }), { params: { id: '209' } })).status,
      (await one.GET(new Request('http://localhost/api/ui/project-todo/209/attachments/abc'), { params: { id: '209', attachmentId: 'abc' } })).status,
      (await one.DELETE(new Request('http://localhost/'), { params: { id: '209', attachmentId: 'abc' } })).status,
    ]);
    assert.deepEqual(statuses, [401, 401, 401, 401]);
    assert.equal(seen.length, 4);
    for (const headers of seen) {
      assert.equal(headers.get('authorization'), null, 'never the daemon token for a browser call');
      assert.equal(headers.get('cookie'), null);
    }
  } finally {
    if (previous === undefined) delete process.env.TIMON_DAEMON_TOKEN;
    else process.env.TIMON_DAEMON_TOKEN = previous;
  }
});
