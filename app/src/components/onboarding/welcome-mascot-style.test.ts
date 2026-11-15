/**
 * The welcome screen's 3D / 2D switch: 3D by default, a choice made before any
 * account exists kept in the browser and read back, handed to the account
 * once a session can take it (the account's own value winning), the avalanche
 * re-mounting its cast in the chosen style, and 2D with the reason when the
 * browser has no WebGL2.
 */
import '@/lib/i18n-test-locales';
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import React from 'react';

// The test runner compiles JSX to `React.createElement`; the app's build does not need this.
Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

type Request = { method: string; url: string; body: unknown };

/** A fake daemon: `session` false answers 401 to everything, as before the account exists. */
function daemon(state: { session: boolean; stored: unknown }): { fetchImpl: (url: string, init?: RequestInit) => Promise<Response>; requests: Request[] } {
  const requests: Request[] = [];
  return {
    requests,
    fetchImpl: async (url, init) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? JSON.parse(String(init.body)) as { layout?: unknown } : null;
      requests.push({ method, url, body });
      if (!state.session) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (method === 'PUT') { state.stored = body?.layout ?? null; return Response.json({ ok: true }); }
      return Response.json({ layout: state.stored });
    },
  };
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 5); });

test('with no session the choice stays in the browser and is read back on the next page', async () => {
  const { createMascotStylePref, MASCOT_STYLE_LOCAL_KEY } = await import('@/components/mascot/mascot-style-pref');
  const storage = memoryStorage();
  const server = daemon({ session: false, stored: null });
  const pref = createMascotStylePref({ fetchImpl: server.fetchImpl, storage });
  pref.subscribe(() => {});
  assert.equal(pref.get(), '3d', '3D by default');
  assert.equal(await pref.set('2d'), false, 'the daemon refuses it: there is no account yet');
  assert.equal(pref.get(), '2d', 'the page keeps the choice');
  assert.deepEqual(JSON.parse(storage.map.get(MASCOT_STYLE_LOCAL_KEY) ?? 'null'), { style: '2d' }, 'and so does the browser');

  const reloaded = createMascotStylePref({ fetchImpl: server.fetchImpl, storage });
  assert.equal(reloaded.get(), '2d', 'read back as the starting value');
  reloaded.subscribe(() => {});
  await settle();
  assert.equal(reloaded.get(), '2d', 'a refused read changes nothing');
});

test('once a session exists the browser choice goes to the account, then the account wins', async () => {
  const { createMascotStylePref, MASCOT_STYLE_LOCAL_KEY } = await import('@/components/mascot/mascot-style-pref');
  const storage = memoryStorage();
  const state = { session: false, stored: null as unknown };
  const server = daemon(state);
  const pref = createMascotStylePref({ fetchImpl: server.fetchImpl, storage });
  pref.subscribe(() => {});
  await pref.set('2d');
  await settle();

  // The account step created the account: the next subscriber (the mascot step's switch) reads again.
  state.session = true;
  pref.subscribe(() => {});
  await settle();
  assert.deepEqual(state.stored, { style: '2d' }, 'copied to the account');
  assert.equal(storage.map.has(MASCOT_STYLE_LOCAL_KEY), false, 'the browser copy is dropped');
  assert.equal(pref.get(), '2d');

  // Another browser left a choice behind, but this account already holds one: the account's wins.
  const other = memoryStorage();
  other.setItem(MASCOT_STYLE_LOCAL_KEY, JSON.stringify({ style: '3d' }));
  const elsewhere = createMascotStylePref({ fetchImpl: server.fetchImpl, storage: other });
  assert.equal(elsewhere.get(), '3d', 'the browser value until the account answers');
  elsewhere.subscribe(() => {});
  await settle();
  assert.equal(elsewhere.get(), '2d', 'the account value wins');
  assert.deepEqual(state.stored, { style: '2d' }, 'and is not overwritten');
  assert.equal(other.map.has(MASCOT_STYLE_LOCAL_KEY), false);
});

type Page = { document: Document; act: (fn: () => void | Promise<void>) => Promise<void>; render: (el: React.ReactElement) => Promise<void> };

/** A page in jsdom without a session; `webgl2`: the browser offers a WebGL2 context. Animation frames never fire. */
async function mount(ctx: TestContext, webgl2: boolean): Promise<Page> {
  const { JSDOM } = await import('jsdom');
  const { resetWebGL2ProbeForTests } = await import('@/components/mascot/three/tile');
  const { resetMascotStylePrefForTests } = await import('@/components/mascot/mascot-style-pref');
  const { resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/onboarding', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown): void => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'Event', 'MutationObserver', 'getComputedStyle']) {
    install(key, Reflect.get(dom.window, key));
  }
  install('window', dom.window);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('requestAnimationFrame', () => 1);
  install('cancelAnimationFrame', () => {});
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {} }),
  });
  if (webgl2) {
    install('WebGL2RenderingContext', class {});
    Object.defineProperty(dom.window.HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: (type: string) => (type === 'webgl2' ? { getExtension: () => null } : null),
    });
  } else {
    install('WebGL2RenderingContext', undefined);
  }
  install('fetch', daemon({ session: false, stored: null }).fetchImpl);
  resetWebGL2ProbeForTests();
  resetMascotStylePrefForTests();
  resetSlotsForTests();

  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  ctx.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
    resetWebGL2ProbeForTests();
    resetMascotStylePrefForTests();
  });
  return { document: dom.window.document, act, render: (el) => act(() => { root.render(el); }) };
}

const checked = (doc: Document): string | null => doc.querySelector('[data-mascot-style-toggle] [aria-checked="true"]')?.getAttribute('data-mascot-style') ?? null;

test('the welcome switch: 3D by default, a click turns the avalanche\'s cast to 2D and back, with no error', async (t) => {
  const { MascotStyleToggle } = await import('@/components/mascot/look-styler/mascot-style-switch');
  const { MascotAvalanche } = await import('./mascot-avalanche');
  const { MASCOT_STYLE_LOCAL_KEY } = await import('@/components/mascot/mascot-style-pref');
  const page = await mount(t, true);
  await page.render(React.createElement('div', null, React.createElement(MascotStyleToggle), React.createElement(MascotAvalanche)));
  await page.act(settle);
  const cast = () => page.document.querySelector('[data-avalanche-cast]');
  const heads3d = () => cast()?.querySelectorAll('canvas[data-mascot]').length ?? 0;

  assert.equal(checked(page.document), '3d', '3D by default');
  assert.equal(page.document.querySelector('[data-mascot-style-toggle]')?.getAttribute('aria-label'), 'Mascot style');
  assert.equal(cast()?.getAttribute('data-avalanche-cast'), '3d');
  assert.ok(heads3d() > 0, 'the cast draws 3D heads');

  await page.act(async () => { (page.document.querySelector('[data-mascot-style="2d"]') as HTMLElement).click(); await settle(); });
  assert.equal(checked(page.document), '2d');
  assert.equal(cast()?.getAttribute('data-avalanche-cast'), '2d', 'the cast mounts again in the new style');
  assert.equal(heads3d(), 0, 'no 3D head left in it');
  assert.ok((cast()?.querySelectorAll('svg[data-mascot]').length ?? 0) > 0, 'the 2D drawings, to rasterise');
  assert.equal(page.document.defaultView?.localStorage.getItem(MASCOT_STYLE_LOCAL_KEY), JSON.stringify({ style: '2d' }), 'kept in the browser');

  await page.act(async () => { (page.document.querySelector('[data-mascot-style="3d"]') as HTMLElement).click(); await settle(); });
  assert.equal(cast()?.getAttribute('data-avalanche-cast'), '3d', 'and back');
  assert.ok(heads3d() > 0);
});

test('without WebGL2 the welcome switch shows 2D, cannot change, and says why', async (t) => {
  const { MascotStyleToggle } = await import('@/components/mascot/look-styler/mascot-style-switch');
  const page = await mount(t, false);
  await page.render(React.createElement(MascotStyleToggle));
  await page.act(settle);
  const group = page.document.querySelector('[data-mascot-style-toggle]');
  assert.equal(checked(page.document), '2d');
  assert.equal(group?.getAttribute('data-mascot-style-toggle'), 'no-webgl');
  assert.equal(group?.getAttribute('aria-disabled'), 'true');
  assert.match(group?.getAttribute('title') ?? '', /WebGL2/);
  assert.ok(Array.from(page.document.querySelectorAll('[data-mascot-style]')).every((b) => (b as HTMLButtonElement).disabled));
});
