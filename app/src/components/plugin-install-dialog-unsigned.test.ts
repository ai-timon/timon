import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The install sheet of an unsigned package, against developer mode as the
 * daemon applies it NOW (not the preview's frozen verdict):
 *  - mode off: the sheet says why it will not load, turns the mode on in place
 *    unless a fixed plugin composition keeps it shut, and then says so;
 *  - Install always asks first, mode on or off (a package installed with the
 *    mode off starts the moment it goes on), and nothing installs without an
 *    explicit yes; the question says whether it will load;
 *  - a signed package asks nothing; an unsigned child of a bundle counts.
 */
test('unsigned sheet: developer mode off, on in place, and a confirmation before every unsigned install', async () => {
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

  type State = { requested: boolean; effective: boolean; available: boolean; blockedBy: 'plugin_composition_fixed' | null };
  let developer: State = { requested: false, effective: false, available: true, blockedBy: null };
  const puts: unknown[] = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    if (input === '/api/ui/plugins/developer') {
      if (init?.method === 'PUT') {
        const { enabled } = JSON.parse(String(init.body)) as { enabled: boolean };
        puts.push(enabled);
        developer = { ...developer, requested: enabled, effective: enabled && developer.available };
      }
      return Response.json(developer);
    }
    return new Response('{}', { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { PluginInstallDialog } = await import('./plugin-install-dialog');
  const { answerConfirmsForTests } = await import('./confirm-dialog/confirm-dialog-context');
  type Preview = import('@/lib/plugin-install').PluginPreview;

  const preview = (over: Partial<Preview> = {}): Preview => ({
    token: 'b'.repeat(48), origin: 'path', format: 'folder', pkg: '@me/mine', version: '0.0.1', id: 'my-plugin',
    label: 'My plugin', description: null, author: 'Me', kind: ['behavior'], permissions: [],
    slots: [], route: null, declares: {}, modifies: [], contains: [], settings: [], webhooks: [], licenseRequired: false,
    provider: null, icon: null, cover: null, signature: { state: 'unsigned', loads: false }, manifestError: null, installed: null,
    installable: true, blocked: null, ...over,
  });
  const installs: string[] = [];
  const asked: string[] = [];
  const bodies: string[] = [];
  let answer = false;
  answerConfirmsForTests((request) => { asked.push(request.title); bodies.push(request.description ?? ''); return answer; });
  const root = createRoot(document.getElementById('root')!);
  const render = async (p: Preview) => React.act(async () => root.render(React.createElement(PluginInstallDialog, {
    preview: p, open: true, busy: false, onOpenChange: () => {}, onInstall: (target: Preview) => { installs.push(target.pkg); },
  })));
  const settle = () => React.act(async () => { await new Promise((done) => setTimeout(done, 0)); });
  const dialog = () => document.querySelector('[role="dialog"]')!;
  const button = (label: string) => Array.from(dialog().querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === label);
  const notice = () => dialog().querySelector('[data-testid="unsigned-developer-mode"]');
  try {
    await render(preview());
    await settle();
    assert.match(notice()?.textContent ?? '', /Developer mode is off.*will not load until developer mode is turned on/);
    assert.match(dialog().textContent ?? '', /Unsigned — will not load/);

    // Mode off: Install still asks, says it will not load yet, and a no installs nothing.
    await React.act(async () => button('Install')!.click());
    await settle();
    assert.deepEqual(asked, ['Install My plugin without a signature?']);
    assert.match(bodies[0] ?? '', /will not load while developer mode is off/);
    assert.deepEqual(installs, []);
    answer = true;
    await React.act(async () => button('Install')!.click());
    await settle();
    assert.deepEqual(installs, ['@me/mine']);
    answer = false;
    asked.length = 0;
    bodies.length = 0;

    // On, in place: the verdict follows the daemon's answer, not the preview.
    await React.act(async () => button('Turn on developer mode')!.click());
    await settle();
    assert.deepEqual(puts, [true]);
    assert.equal(notice(), null);
    assert.match(dialog().textContent ?? '', /Unsigned — loads in developer mode/);

    // Mode on: a no installs nothing, a yes installs.
    await React.act(async () => button('Install')!.click());
    await settle();
    assert.deepEqual(asked, ['Install My plugin without a signature?']);
    assert.match(bodies[0] ?? '', /Once installed, its code runs inside the Timon daemon/);
    assert.deepEqual(installs, ['@me/mine'], 'no confirmation, no install');
    answer = true;
    await React.act(async () => button('Install')!.click());
    await settle();
    assert.deepEqual(installs, ['@me/mine', '@me/mine']);

    // A signed package asks nothing.
    asked.length = 0;
    await render(preview({ token: 'c'.repeat(48), signature: { state: 'signed', keyId: 'k' } }));
    await settle();
    await React.act(async () => button('Install')!.click());
    await settle();
    assert.deepEqual(asked, []);

    // A signed bundle with one unsigned child counts as unsigned code.
    await render(preview({
      token: 'd'.repeat(48), signature: { state: 'signed', keyId: 'k' }, kind: ['bundle'],
      children: [{ id: 'my-child', pkg: '@me/child', version: '0.0.1', label: 'Child', state: 'install', permissions: [], signature: { state: 'unsigned', loads: true }, vault: null, provider: null }],
    }));
    await settle();
    await React.act(async () => button('Install')!.click());
    await settle();
    assert.deepEqual(asked, ['Install My plugin without a signature?']);

    // A fixed composition keeps the mode shut: no button that cannot work, and the reason.
    developer = { requested: false, effective: false, available: false, blockedBy: 'plugin_composition_fixed' };
    await render(preview({ token: 'e'.repeat(48) }));
    await settle();
    assert.equal(button('Turn on developer mode'), undefined);
    assert.match(notice()?.textContent ?? '', /fixed plugin composition/);
    assert.ok(button('Open developer mode settings'));
  } finally {
    answerConfirmsForTests(null);
    await React.act(async () => root.unmount());
    await new Promise((done) => setTimeout(done, 50));
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
