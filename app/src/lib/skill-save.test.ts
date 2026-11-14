import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { prepareSkillWrite } from './skill-save';
import { loadRequestScope } from './next-request-scope-test';

// Exercise the two independently packaged applications over their real JSON boundary.
test('form payload crosses the Next proxy and daemon and creates the skill', async (ctx) => {
  process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-skill-contract-'));
  process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
  const daemon = (file: string) => import(pathToFileURL(resolve('../orchestrator', file)).href);
  await daemon('tests/helpers/paid-license.ts');
  const { default: express } = await import(pathToFileURL(resolve('../orchestrator/node_modules/express/index.js')).href);
  const { registerRoutes } = await daemon('src/plugins-bundled/agents/routes.ts');
  const { createDaemonAuthMiddleware } = await daemon('src/plugins-bundled/http/auth.ts');
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: 'contract-token', required: true }));
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  ctx.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  (globalThis as unknown as { AsyncLocalStorage: unknown }).AsyncLocalStorage = AsyncLocalStorage;
  const requestAsyncStorage = await loadRequestScope();
  const { POST: routePost } = await import('../app/api/ui/skills/route');
  const POST = (req: Request) => requestAsyncStorage.run(
    { headers: req.headers, cookies: { get: () => undefined } } as never, () => routePost(req),
  );
  const originalFetch = globalThis.fetch;
  let authenticated = true;
  ctx.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
    assert.equal(new URL(_url).pathname, '/api/skills');
    assert.equal(new Headers(init.headers).has('authorization'), false);
    return originalFetch(`${base}/api/skills`, {
      ...init,
      headers: { ...init.headers, ...(authenticated ? { authorization: 'Bearer contract-token' } : {}) },
    });
  });
  const draft = { id: ' contract-skill ', content: '# Contract\r\n\nInstructions é\n' };
  const prepared = prepareSkillWrite(draft);
  assert.equal(prepared.ok, true);
  if (!prepared.ok) return;
  const request = (body: unknown = prepared.payload) => new Request('http://localhost/api/ui/skills', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await POST(request())).status, 200);
  assert.equal(readFileSync(join(process.env.TIMON_HOME, 'skills', 'contract-skill', 'SKILL.md'), 'utf8'), draft.content);
  const path = join(process.env.TIMON_HOME, 'skills', 'contract-skill', 'SKILL.md');
  const edited = prepareSkillWrite({ id: 'contract-skill', content: '# Edited\n' }, path);
  assert.equal(edited.ok, true);
  if (edited.ok) assert.equal((await POST(request(edited.payload))).status, 200);
  assert.equal(readFileSync(path, 'utf8'), '# Edited\n');
  assert.equal((await POST(request({ id: 'missing-content' }))).status, 400);
  authenticated = false;
  assert.equal((await POST(request())).status, 401);
});

test('invalid form drafts return field errors without a network request', (ctx) => {
  const network = ctx.mock.method(globalThis, 'fetch', async () => { throw new Error('unexpected network'); });
  for (const id of ['', '.', '..', 'Invalid ID', '../escape']) {
    const result = prepareSkillWrite({ id, content: '# Skill' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.errors.id);
  }
  const empty = prepareSkillWrite({ id: 'valid', content: ' \r\n' });
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.ok(empty.errors.content);
  assert.equal(network.mock.callCount(), 0);
});

test('malformed JSON is reported by the proxy instead of becoming missing content', async (ctx) => {
  const { POST } = await import('../app/api/ui/skills/route');
  const network = ctx.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'content required' }, { status: 400 }));
  const response = await POST(new Request('http://localhost/api/ui/skills', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{',
  }));
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: 'Invalid JSON' });
  assert.equal(network.mock.callCount(), 0);
});

test('the new-skill form shows the id error and does not POST an empty id', async (ctx) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/skills' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'getComputedStyle']) {
    install(key, Reflect.get(dom.window, key));
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { SkillsClient } = await import('../app/(main)/skills/skills-client');
  const requests: string[] = [];
  ctx.mock.method(globalThis, 'fetch', async (_url: string, init?: RequestInit) => {
    requests.push(init?.method ?? 'GET');
    return Response.json({ skills: [] });
  });
  const root = createRoot(document.getElementById('root')!);
  try {
    await React.act(async () => root.render(React.createElement(SkillsClient)));
    const button = (label: string) => Array.from(document.querySelectorAll('button')).find((node) => node.textContent?.trim() === label)!;
    await React.act(async () => button('New Timon skill').click());
    await React.act(async () => button('Create').click());
    assert.equal(document.querySelectorAll('[aria-invalid="true"]').length, 1);
    assert.equal(document.querySelectorAll('[role="alert"]').length, 1);
    assert.deepEqual(requests, ['GET']);
  } finally {
    await React.act(async () => root.unmount());
    // Radix restores focus asynchronously when its portal unmounts.
    await React.act(async () => { await new Promise((done) => setTimeout(done, 100)); });
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
