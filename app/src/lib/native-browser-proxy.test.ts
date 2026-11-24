import assert from 'node:assert/strict';
import test from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { loadRequestScope } from './next-request-scope-test';

test('native browser proxy forwards only the authenticated session cookie', async () => {
  // Next initializes its request storage from this global in the server runtime.
  const oldAsync = Object.getOwnPropertyDescriptor(globalThis, 'AsyncLocalStorage');
  Object.defineProperty(globalThis, 'AsyncLocalStorage', { value: AsyncLocalStorage, configurable: true });
  const requestAsyncStorage = await loadRequestScope();
  const { GET, POST, DELETE } = await import('../app/api/ui/native-browser/[...path]/route');
  const previousFetch = globalThis.fetch;
  const oldToken = process.env.TIMON_DAEMON_TOKEN;
  process.env.TIMON_DAEMON_TOKEN = 'must-never-be-forwarded';
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ available: true }); };
  try {
    const run = (session: string | undefined, work: () => Promise<Response>) => requestAsyncStorage.run({ headers: new Headers(), cookies: { get: (name: string) => name === 'timon_session' && session ? { value: session } : undefined } } as never, work);
    await run('session-one', () => GET(new Request('http://localhost/api/ui/native-browser/resolve?agent=one'), { params: { path: ['resolve'] } }));
    assert.equal(new Headers(calls[0]?.init?.headers).get('cookie'), 'timon_session=session-one');
    assert.equal(new Headers(calls[0]?.init?.headers).get('authorization'), null);
    assert.ok(calls[0]?.url.endsWith('/api/native-browser/resolve?agent=one'));
    await run(undefined, () => POST(new Request('http://localhost/api/ui/native-browser/id/command', { method: 'POST', body: JSON.stringify({ action: 'status' }) }), { params: { path: ['id', 'command'] } }));
    assert.equal(new Headers(calls[1]?.init?.headers).get('cookie'), null);
    assert.equal(new Headers(calls[1]?.init?.headers).get('authorization'), null);
    assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { action: 'status' });
    await run('session-one', () => DELETE(new Request('http://localhost/api/ui/native-browser/id/credentials/credential'), { params: { path: ['id', 'credentials', 'credential'] } }));
    assert.equal(calls[2]?.init?.method, 'DELETE');
    assert.equal(new Headers(calls[2]?.init?.headers).get('cookie'), 'timon_session=session-one');
    const downloads: Record<string, unknown>[] = [];
    globalThis.fetch = async (_url, init) => {
      assert.equal(new Headers(init?.headers).get('cookie'), 'timon_session=session-one');
      assert.equal(new Headers(init?.headers).get('Authorization'), null);
      const body = JSON.parse(String(init?.body)); downloads.push(body);
      assert.equal(body.action, 'downloadRead'); assert.equal(body.downloadId, 'report'); assert.equal(body.clientId, 'viewer');
      const data = body.offset === 0 ? 'part1' : 'part2';
      return Response.json({ result: { data: Buffer.from(data).toString('base64'), offset: body.offset, size: 10, name: 'résumé.txt', mimeType: 'text/plain', eof: body.offset !== 0 } }); // french-ok: an accented file name, kept as is
    };
    const download = await run('session-one', () => GET(new Request('http://localhost/api/ui/native-browser/id/downloads/report?clientId=viewer'), { params: { path: ['id', 'downloads', 'report'] } }));
    assert.equal(await download.text(), 'part1part2');
    assert.equal(download.headers.get('content-length'), '10');
    assert.match(download.headers.get('content-disposition')!, /attachment.*r%C3%A9sum%C3%A9/);
    assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(downloads.map((value) => value.offset), [0, 5]);
  } finally {
    globalThis.fetch = previousFetch;
    if (oldToken === undefined) delete process.env.TIMON_DAEMON_TOKEN; else process.env.TIMON_DAEMON_TOKEN = oldToken;
    if (oldAsync) Object.defineProperty(globalThis, 'AsyncLocalStorage', oldAsync); else delete (globalThis as Record<string, unknown>).AsyncLocalStorage;
  }
});

test('native browser proxy relays the recording routes (TODO #461) with the session only', async () => {
  const oldAsync = Object.getOwnPropertyDescriptor(globalThis, 'AsyncLocalStorage');
  Object.defineProperty(globalThis, 'AsyncLocalStorage', { value: AsyncLocalStorage, configurable: true });
  const requestAsyncStorage = await loadRequestScope();
  const { GET, POST, PATCH, DELETE } = await import('../app/api/ui/native-browser/[...path]/route');
  const previousFetch = globalThis.fetch;
  const oldToken = process.env.TIMON_DAEMON_TOKEN;
  process.env.TIMON_DAEMON_TOKEN = 'must-never-be-forwarded';
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ ok: true }); };
  try {
    const run = (work: () => Promise<Response>) => requestAsyncStorage.run({ headers: new Headers(), cookies: { get: (name: string) => name === 'timon_session' ? { value: 'session-one' } : undefined } } as never, work);
    const req = (path: string, init?: RequestInit) => new Request(`http://localhost/api/ui/native-browser/${path}`, init);
    const cases: Array<[string, string, () => Promise<Response>, unknown]> = [
      ['POST', '/api/native-browser/p1/recording/start', () => POST(req('p1/recording/start', { method: 'POST' }), { params: { path: ['p1', 'recording', 'start'] } }), undefined],
      ['POST', '/api/native-browser/p1/recording/stop', () => POST(req('p1/recording/stop', { method: 'POST', body: '{}' }), { params: { path: ['p1', 'recording', 'stop'] } }), {}],
      ['GET', '/api/native-browser/p1/recordings', () => GET(req('p1/recordings'), { params: { path: ['p1', 'recordings'] } }), undefined],
      ['GET', '/api/native-browser/recordings/br-1', () => GET(req('recordings/br-1'), { params: { path: ['recordings', 'br-1'] } }), undefined],
      ['PATCH', '/api/native-browser/recordings/br-1', () => PATCH(req('recordings/br-1', { method: 'PATCH', body: JSON.stringify({ ops: [{ op: 'mask', step: 2 }] }) }), { params: { path: ['recordings', 'br-1'] } }), { ops: [{ op: 'mask', step: 2 }] }],
      ['DELETE', '/api/native-browser/recordings/br-1', () => DELETE(req('recordings/br-1', { method: 'DELETE' }), { params: { path: ['recordings', 'br-1'] } }), undefined],
      ['GET', '/api/native-browser/recordings/br-1/learn-agents', () => GET(req('recordings/br-1/learn-agents'), { params: { path: ['recordings', 'br-1', 'learn-agents'] } }), undefined],
      ['POST', '/api/native-browser/recordings/br-1/learn', () => POST(req('recordings/br-1/learn', { method: 'POST', body: JSON.stringify({ autoSubmit: false }) }), { params: { path: ['recordings', 'br-1', 'learn'] } }), { autoSubmit: false }],
    ];
    for (const [method, path, call, body] of cases) {
      const res = await run(call);
      const sent = calls.at(-1)!;
      assert.equal(res.status, 200, `${method} ${path}`);
      assert.equal(res.headers.get('cache-control'), 'no-store');
      assert.equal(sent.init?.method, method);
      assert.equal(new URL(sent.url).pathname, path);
      assert.equal(new Headers(sent.init?.headers).get('cookie'), 'timon_session=session-one');
      assert.equal(new Headers(sent.init?.headers).get('authorization'), null, 'never the daemon token');
      assert.deepEqual(sent.init?.body === undefined ? undefined : JSON.parse(String(sent.init.body)), body);
    }
    const before = calls.length;
    const bad = await run(() => PATCH(req('recordings/br-1', { method: 'PATCH', body: '{oops' }), { params: { path: ['recordings', 'br-1'] } }));
    assert.equal(bad.status, 400);
    assert.equal(calls.length, before, 'invalid JSON never reaches the daemon');
  } finally {
    globalThis.fetch = previousFetch;
    if (oldToken === undefined) delete process.env.TIMON_DAEMON_TOKEN; else process.env.TIMON_DAEMON_TOKEN = oldToken;
    if (oldAsync) Object.defineProperty(globalThis, 'AsyncLocalStorage', oldAsync); else delete (globalThis as Record<string, unknown>).AsyncLocalStorage;
  }
});

test('native browser proxy relays the annotation routes (TODO #468) with the session only', async () => {
  const oldAsync = Object.getOwnPropertyDescriptor(globalThis, 'AsyncLocalStorage');
  Object.defineProperty(globalThis, 'AsyncLocalStorage', { value: AsyncLocalStorage, configurable: true });
  const requestAsyncStorage = await loadRequestScope();
  const { GET, POST, PATCH, DELETE } = await import('../app/api/ui/native-browser/[...path]/route');
  const previousFetch = globalThis.fetch;
  const oldToken = process.env.TIMON_DAEMON_TOKEN;
  process.env.TIMON_DAEMON_TOKEN = 'must-never-be-forwarded';
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return Response.json({ ok: true }); };
  try {
    const run = (session: string | undefined, work: () => Promise<Response>) => requestAsyncStorage.run({ headers: new Headers(), cookies: { get: (name: string) => name === 'timon_session' && session ? { value: session } : undefined } } as never, work);
    const req = (path: string, init?: RequestInit) => new Request(`http://localhost/api/ui/native-browser/${path}`, init);
    const segments = (path: string) => ({ params: { path: path.split('?')[0]!.split('/') } });
    const id = 'ba-00000000-0000-4000-8000-000000000468';
    const batch = 'bab-00000000-0000-4000-8000-000000000468';
    const send = { ids: [id], agent: 'timon.coder' };
    const cases: Array<[string, string, (path: string) => Promise<Response>, unknown]> = [
      ['POST', 'p1/annotation/start', (p) => POST(req(p, { method: 'POST' }), segments(p)), undefined],
      ['POST', 'p1/annotation/stop', (p) => POST(req(p, { method: 'POST', body: '{}' }), segments(p)), {}],
      ['POST', 'p1/annotation/collect', (p) => POST(req(p, { method: 'POST' }), segments(p)), undefined],
      ['POST', 'p1/annotation/pick', (p) => POST(req(p, { method: 'POST', body: JSON.stringify({ x: 4, y: 8, preview: true }) }), segments(p)), { x: 4, y: 8, preview: true }],
      ['POST', 'p1/command', (p) => POST(req(p, { method: 'POST', body: JSON.stringify({ action: 'annotateCollect', clientId: 'pane-0001' }) }), segments(p)), { action: 'annotateCollect', clientId: 'pane-0001' }],
      ['GET', 'p1/annotations?status=draft', (p) => GET(req(p), segments(p)), undefined],
      ['GET', `annotations?batch=${batch}`, (p) => GET(req(p), segments(p)), undefined],
      ['GET', `annotations/${id}`, (p) => GET(req(p), segments(p)), undefined],
      // Three segments, like a download: the thumbnail must not be taken for one.
      ['GET', `annotations/${id}/thumbnail`, (p) => GET(req(p), segments(p)), undefined],
      ['PATCH', `annotations/${id}`, (p) => PATCH(req(p, { method: 'PATCH', body: JSON.stringify({ comment: 'Bigger' }) }), segments(p)), { comment: 'Bigger' }],
      // Bodiless: relayed as is, the daemon's schema answers.
      ['PATCH', `annotations/${id}`, (p) => PATCH(req(p, { method: 'PATCH' }), segments(p)), undefined],
      ['DELETE', `annotations/${id}`, (p) => DELETE(req(p, { method: 'DELETE' }), segments(p)), undefined],
      ['POST', 'annotations/send', (p) => POST(req(p, { method: 'POST', body: JSON.stringify(send) }), segments(p)), send],
      ['POST', `annotations/${id}/resolve`, (p) => POST(req(p, { method: 'POST', body: JSON.stringify({ status: 'dismissed', reason: 'Not a bug' }) }), segments(p)), { status: 'dismissed', reason: 'Not a bug' }],
    ];
    for (const session of ['session-one', undefined]) {
      for (const [method, path, call, body] of cases) {
        const res = await run(session, () => call(path));
        const sent = calls.at(-1)!;
        const upstream = new URL(sent.url);
        assert.equal(res.status, 200, `${method} ${path}`);
        assert.equal(res.headers.get('cache-control'), 'no-store');
        assert.equal(sent.init?.method, method);
        assert.equal(upstream.pathname + upstream.search, `/api/native-browser/${path}`);
        assert.equal(new Headers(sent.init?.headers).get('cookie'), session ? `timon_session=${session}` : null);
        assert.equal(new Headers(sent.init?.headers).get('authorization'), null, 'never the daemon token');
        assert.deepEqual(sent.init?.body === undefined ? undefined : JSON.parse(String(sent.init.body)), body, `${method} ${path}`);
      }
    }
    assert.equal(calls.length, cases.length * 2);
    const bad = await run('session-one', () => POST(req('annotations/send', { method: 'POST', body: '{oops' }), segments('annotations/send')));
    assert.equal(bad.status, 400);
    assert.equal(calls.length, cases.length * 2, 'invalid JSON never reaches the daemon');
  } finally {
    globalThis.fetch = previousFetch;
    if (oldToken === undefined) delete process.env.TIMON_DAEMON_TOKEN; else process.env.TIMON_DAEMON_TOKEN = oldToken;
    if (oldAsync) Object.defineProperty(globalThis, 'AsyncLocalStorage', oldAsync); else delete (globalThis as Record<string, unknown>).AsyncLocalStorage;
  }
});
