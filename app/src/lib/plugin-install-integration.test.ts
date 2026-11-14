import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { generateKeyPairSync, randomBytes, sign as signCrypto } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { loadRequestScope } from './next-request-scope-test';

/**
 * "Install a plugin" (TODO #332), rendered against the real daemon routes
 * through the real Next proxies and a session cookie: a package dropped in
 * the plugins folder is listed, its sheet carries the disclaimer, nothing is
 * installed before the Install click, and an altered package keeps the button
 * off. npm is the test double the daemon tests use.
 */
test('rendered install flow: list, sheet with disclaimer, install on click only, tampered stays off', async (ctx) => {
  process.env.TIMON_HOME = mkdtempSync(join(tmpdir(), 'timon-plugin-install-ui-'));
  process.env.TIMON_RESOURCE_GUARD_ENABLED = '0';
  const daemon = (file: string) => import(pathToFileURL(resolve('../orchestrator', file)).href);
  await daemon('tests/helpers/paid-license.ts');
  const { default: express } = await import(pathToFileURL(resolve('../orchestrator/node_modules/express/index.js')).href);
  const { registerRoutes } = await daemon('src/plugins-bundled/plugins/routes.ts');
  const { attachPluginInstallSources } = await daemon('src/plugins-bundled/plugins/install-routes.ts');
  const { PluginInstallSources } = await daemon('src/plugins/install-sources.ts');
  const { hashPluginDirectory } = await daemon('src/plugins/signature.ts');
  const { createDaemonAuthMiddleware } = await daemon('src/plugins-bundled/http/auth.ts');
  const { createBodyParser } = await daemon('src/kernel/body-parser.ts');
  const { dbApi } = await daemon('src/db.ts');
  const { hashSessionToken } = await daemon('src/users/session.ts');

  const boss = dbApi.createUser({ email: 'install@example.test', name: 'Boss', passwordHash: 'unused', isSuperadmin: true, source: 'test' });
  const token = randomBytes(32).toString('hex');
  dbApi.createSession({ tokenHash: hashSessionToken(token), userId: boss.id, expiresAt: Date.now() + 60_000 });

  const pair = generateKeyPairSync('ed25519');
  const keys = [{ keyId: 'ui-test', publicKey: pair.publicKey.export({ type: 'spki', format: 'pem' }).toString() }];
  const plugins = join(process.env.TIMON_HOME, 'plugins');
  mkdirSync(plugins, { recursive: true });
  const drop = (folder: string, id: string, label: string, tamper: boolean) => {
    const dir = join(plugins, folder);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: `@acme/${id}`, version: '2.0.0', main: 'index.js',
      timon: { id, apiVersion: 1, kind: 'behavior', label, author: 'Acme', permissions: ['usage:read'] },
    }));
    writeFileSync(join(dir, 'index.js'), 'throw new Error("never runs in a preview")\n');
    const hash = hashPluginDirectory(dir);
    writeFileSync(join(dir, 'SIGNATURE'), JSON.stringify({ alg: 'ed25519', keyId: 'ui-test', hash, sig: signCrypto(null, Buffer.from(hash, 'hex'), pair.privateKey).toString('base64') }));
    if (tamper) writeFileSync(join(dir, 'index.js'), 'console.log("changed")\n');
  };
  drop('good-plugin', 'acme-good', 'Good plugin', false);
  drop('bad-plugin', 'acme-bad', 'Bad plugin', true);

  const npmCalls: string[] = [];
  const npm = async (args: string[], cwd: string) => {
    const spec = args[args.length - 1] as string;
    npmCalls.push(spec);
    const pkgFile = join(cwd, 'package.json');
    const pkg = JSON.parse(readFileSync(pkgFile, 'utf8')) as { dependencies?: Record<string, string> };
    const name = (JSON.parse(readFileSync(join(spec, 'package.json'), 'utf8')) as { name: string }).name;
    cpSync(spec, join(cwd, 'node_modules', name), { recursive: true });
    pkg.dependencies = { ...(pkg.dependencies ?? {}), [name]: `file:${spec}` };
    writeFileSync(pkgFile, JSON.stringify(pkg));
  };

  const app = express();
  attachPluginInstallSources(app, new PluginInstallSources({
    pluginsRoot: plugins, stagingRoot: join(process.env.TIMON_HOME, 'tmp', 'plugin-install'),
    publicKeys: keys, unsignedLoads: () => false,
    install: { npm, config: join(process.env.TIMON_HOME, 'timon.config.json'), publicKeys: keys },
  }));
  app.use(createDaemonAuthMiddleware({ token: 'unused-daemon-token', required: true }));
  app.use(createBodyParser());
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
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'DocumentFragment']) {
    install(key, Reflect.get(dom.window, key));
  }
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('AsyncLocalStorage', AsyncLocalStorage);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const requestAsyncStorage = await loadRequestScope();
  const route = await import('../app/api/ui/plugin-install/[...path]/route');
  const { PluginInstallPanel } = await import('../components/plugin-install-panel');
  const session = <T,>(fn: () => T): T => requestAsyncStorage.run(
    { headers: new Headers(), cookies: { get: (name: string) => (name === 'timon_session' ? { value: token } : undefined) } } as never, fn,
  );
  const steps: string[] = [];
  const originalFetch = globalThis.fetch;
  ctx.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const href = String(url);
    if (href.startsWith('/api/ui/plugin-install/')) {
      const path = href.slice('/api/ui/plugin-install/'.length).split('/');
      steps.push(`${init?.method ?? 'GET'} ${path.join('/')}`);
      const request = new Request(`http://localhost${href}`, init);
      const params = { params: { path } };
      const method = (init?.method ?? 'GET') as 'GET' | 'POST' | 'DELETE';
      return session(() => route[method](request, params));
    }
    // Next → daemon hop: the session cookie and nothing else.
    assert.equal(new Headers(init?.headers).get('authorization'), null);
    const target = new URL(href);
    assert.ok(target.pathname.startsWith('/api/plugins/-/install/'), target.pathname);
    return originalFetch(`${base}${target.pathname}`, init);
  });

  const root = createRoot(document.getElementById('root')!);
  const settle = async (ready: () => boolean, label: string) => {
    const deadline = Date.now() + 5_000;
    while (!ready() && Date.now() < deadline) await React.act(async () => { await new Promise<void>((done) => setImmediate(done)); });
    assert.ok(ready(), label);
  };
  const button = (text: string) => Array.from(document.querySelectorAll<HTMLButtonElement>('button'))
    .find((node) => node.textContent?.includes(text));
  const dialog = () => document.querySelector('[role="dialog"]');
  let reloaded = 0;
  try {
    await React.act(async () => root.render(React.createElement(PluginInstallPanel, { onInstalled: async () => { reloaded++; } })));
    await settle(() => !!button('Good plugin') && !!button('Bad plugin'), 'dropped packages are listed');

    await React.act(async () => button('Bad plugin')!.click());
    await settle(() => !!dialog(), 'the sheet opens');
    assert.match(dialog()!.textContent ?? '', /not responsible/);
    const blocked = Array.from(dialog()!.querySelectorAll('button')).find((b) => b.textContent === 'Install');
    assert.ok(blocked?.disabled, 'an altered package cannot be installed');
    await React.act(async () => button('Cancel')!.click());
    await settle(() => !dialog(), 'the sheet closes');

    await React.act(async () => button('Good plugin')!.click());
    await settle(() => !!dialog(), 'the sheet opens again');
    assert.match(dialog()!.textContent ?? '', /Verified signature/);
    assert.match(dialog()!.textContent ?? '', /usage:read/);
    assert.deepEqual(npmCalls, [], 'nothing installed before the click');
    const confirm = Array.from(dialog()!.querySelectorAll('button')).find((b) => b.textContent === 'Install');
    assert.equal(confirm?.disabled, false);
    await React.act(async () => confirm!.click());
    await settle(() => npmCalls.length === 1 && !dialog() && !button('Good plugin'), 'installed, sheet closed, list updated');
    assert.equal(npmCalls[0], join(plugins, 'good-plugin'));
    assert.equal(reloaded, 1);
    assert.ok(steps.includes('POST confirm'));
    assert.ok(steps.some((s) => s.startsWith('DELETE staged/')), 'the cancelled preview was discarded');
  } finally {
    await React.act(async () => root.unmount());
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
