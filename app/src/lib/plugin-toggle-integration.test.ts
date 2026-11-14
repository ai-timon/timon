import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { PluginPublic } from './plugin-gallery';
import { loadRequestScope } from './next-request-scope-test';

test('rendered gallery toggles through Next and session auth, persists and reloads wanted', async (ctx) => {
  process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-contract-'));
  process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
  const daemon = (file: string) => import(pathToFileURL(resolve('../orchestrator', file)).href);
  await daemon('tests/helpers/paid-license.ts');
  const { default: express } = await import(pathToFileURL(resolve('../orchestrator/node_modules/express/index.js')).href);
  const { registerRoutes } = await daemon('src/plugins-bundled/plugins/routes.ts');
  const { createDaemonAuthMiddleware } = await daemon('src/plugins-bundled/http/auth.ts');
  const { dbApi } = await daemon('src/db.ts');
  const { hashSessionToken } = await daemon('src/users/session.ts');
  const { CONFIG_FILE } = await daemon('src/config/load.ts');
  const boss = dbApi.createUser({ email: 'toggle@example.test', name: 'Tester', passwordHash: 'unused', isSuperadmin: true, source: 'test' });
  const token = randomBytes(32).toString('hex');
  dbApi.createSession({ tokenHash: hashSessionToken(token), userId: boss.id, expiresAt: Date.now() + 60_000 });
  const app = express();
  app.use(createDaemonAuthMiddleware({ token: 'unused-daemon-token', required: true }));
  app.use(express.json());
  registerRoutes(app);
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  ctx.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/plugins' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'getComputedStyle']) install(key, Reflect.get(dom.window, key));
  install('AsyncLocalStorage', AsyncLocalStorage);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const requestAsyncStorage = await loadRequestScope();
  const { SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { POST } = await import('../app/api/ui/plugins/enabled/route');
  const { GET } = await import('../app/api/ui/plugins/route');
  const { PluginsClient } = await import('../app/(main)/plugins/plugins-client');
  let authenticated = true;
  const session = <T,>(fn: () => T): T => requestAsyncStorage.run(
    { headers: new Headers(), cookies: { get: (name: string) => name === 'timon_session' && authenticated ? { value: token } : undefined } } as never, fn,
  );
  const originalFetch = globalThis.fetch;
  const payloads: unknown[] = [];
  const catalogs: PluginPublic[][] = [];
  ctx.mock.method(globalThis, 'fetch', async (url: string, init?: RequestInit) => {
    if (url === '/api/ui/license') return Response.json({});
    // The gallery reads the account to decide whether to offer "Install a plugin" (TODO #332).
    if (url === '/api/ui/auth/me') return Response.json({ user: null, needsSetup: false });
    if (url === '/api/ui/plugins/enabled') {
      assert.equal(new Headers(init?.headers).get('content-type'), 'application/json');
      payloads.push(JSON.parse(String(init?.body)));
      return session(() => POST(new Request(`http://localhost${url}`, init)));
    }
    if (url === '/api/ui/plugins') {
      const response = await session(GET);
      catalogs.push((await response.clone().json() as { plugins: PluginPublic[] }).plugins);
      return response;
    }
    const path = new URL(url).pathname;
    assert.ok(path.startsWith('/api/plugins'), path);
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    return originalFetch(`${base}${path}`, init);
  });
  const root = createRoot(document.getElementById('root')!);
  const memorySwitch = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[role="switch"]'))
    .find((node) => node.getAttribute('aria-label')?.toLowerCase().includes('memory'));
  const settle = async (ready: () => boolean) => {
    // A shared CI runner renders this gallery in several seconds under load: wait long, fail late.
    const deadline = Date.now() + 15_000;
    while (!ready() && Date.now() < deadline) await React.act(async () => { await new Promise<void>((done) => setImmediate(done)); });
    assert.ok(ready(), 'gallery settles after HTTP response');
  };
  try {
    await React.act(async () => root.render(React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams('q=memory') }, React.createElement(PluginsClient))));
    await settle(() => !!memorySwitch());
    for (let i = 0; i < 2; i++) {
      const button = memorySwitch()!;
      const enabled = button.getAttribute('aria-checked') !== 'true';
      const before = catalogs.length;
      await React.act(async () => button.click());
      await settle(() => catalogs.length > before && memorySwitch()?.disabled === false);
      assert.deepEqual(payloads.at(-1), { id: '@timon/memory', enabled });
      assert.equal(catalogs.at(-1)?.find((p) => p.id === '@timon/memory')?.wanted, enabled);
      assert.equal(memorySwitch()?.getAttribute('aria-checked'), String(enabled));
      assert.equal((JSON.parse(readFileSync(CONFIG_FILE, 'utf8')) as { modules: Record<string, boolean> }).modules['@timon/memory'], enabled);
    }
    const before = readFileSync(CONFIG_FILE, 'utf8');
    const post = (body: unknown) => session(() => POST(new Request('http://localhost/api/ui/plugins/enabled', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    })));
    assert.equal((await post({ id: '', enabled: true })).status, 400);
    const missing = await post({ id: '@timon/memory' });
    assert.equal(missing.status, 400);
    assert.deepEqual(await missing.json(), { error: '`enabled` must be a boolean' });
    authenticated = false;
    assert.equal((await post({ id: '@timon/memory', enabled: false })).status, 401);
    assert.equal(readFileSync(CONFIG_FILE, 'utf8'), before);
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
