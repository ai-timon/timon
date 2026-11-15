/**
 * "Mascot style": the product's mascot draws the 3D head by default, the 2D
 * drawing when the user picks it or when the browser has no WebGL2, the eyes'
 * screen alone always in 2D, and a plugin that takes `agent.mascot` still
 * replaces both.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import React from 'react';

// The test runner compiles JSX to `React.createElement`; the app's build does not need this.
Object.defineProperty(globalThis, 'React', { value: React, configurable: true, writable: true });

type Dom = {
  act: (fn: () => void | Promise<void>) => Promise<void>;
  render: (el: unknown) => Promise<void>;
  document: Document;
  requests: { method: string; url: string; body: unknown }[];
};

/**
 * A page in jsdom. `webgl2`: the browser offers a WebGL2 context. The 2D
 * context stays unavailable, so a 3D head mounts its canvas without loading
 * the engine.
 */
async function mount(ctx: TestContext, { webgl2, stored = null }: { webgl2: boolean; stored?: unknown }): Promise<Dom> {
  const { JSDOM } = await import('jsdom');
  const { resetWebGL2ProbeForTests } = await import('./three/tile');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/chat', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
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
  const requests: Dom['requests'] = [];
  install('fetch', async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    requests.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) as unknown : null });
    return method === 'GET' ? Response.json({ layout: stored }) : Response.json({ ok: true });
  });
  resetWebGL2ProbeForTests();

  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  ctx.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
    resetWebGL2ProbeForTests();
  });
  return {
    act,
    render: (el) => act(() => { root.render(el as React.ReactElement); }),
    document: dom.window.document,
    requests,
  };
}

const settle = (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 5); });

test('the stored style: anything but an explicit 2d is 3D; a read never beats a choice', async () => {
  const { createMascotStylePref, readMascotStyle } = await import('./mascot-style-pref');
  assert.equal(readMascotStyle(null), '3d');
  assert.equal(readMascotStyle({ style: 'flat' }), '3d');
  assert.equal(readMascotStyle({ style: '2d' }), '2d');

  let release: (r: Response) => void = () => {};
  const pref = createMascotStylePref({
    fetchImpl: async (_url, init) => (init?.method === 'PUT'
      ? Response.json({ ok: true })
      : new Promise<Response>((resolve) => { release = resolve; })),
  });
  pref.subscribe(() => {});
  assert.equal(pref.get(), '3d', '3D until the daemon answers');
  await pref.set('3d');
  release(Response.json({ layout: { style: '2d' } }));
  await settle();
  assert.equal(pref.get(), '3d', 'the late read does not undo the choice made meanwhile');

  const stored = createMascotStylePref({ fetchImpl: async () => Response.json({ layout: { style: '2d' } }) });
  stored.subscribe(() => {});
  await settle();
  assert.equal(stored.get(), '2d');
});

test('the host draws the 3D head by default, the 2D drawing once the user picks it, and 3D again', async (t) => {
  const { resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  const { AgentMascotHost } = await import('./agent-mascot');
  const { mascotStylePref } = await import('./mascot-style-pref');
  resetSlotsForTests();
  const w = await mount(t, { webgl2: true });
  await w.render(React.createElement(AgentMascotHost, { look: { shape: 'gem', color: '#ff5fbf', acc: 'globe' }, size: 40, state: 'thinking', label: 'Nova' }));
  await w.act(settle);
  const canvas = () => w.document.querySelector('canvas[data-mascot]');
  // The 2D drawing that stands in while the models load is not the 2D style: leave it out.
  const svg = () => Array.from(w.document.querySelectorAll('svg[data-mascot]')).find((el) => !el.closest('[data-mascot-fallback]')) ?? null;
  const standIn = () => w.document.querySelector('[data-mascot-fallback] svg[data-mascot]');
  assert.ok(canvas(), 'a 3D head');
  assert.ok(!svg());
  assert.equal(standIn()?.getAttribute('data-shape'), 'gem', 'its 2D drawing stands in until the models are drawn');
  assert.equal(canvas()?.getAttribute('data-shape'), 'gem');
  assert.equal(canvas()?.getAttribute('data-acc'), 'globe');
  assert.equal(canvas()?.getAttribute('data-mascot-3d'), 'thinking');
  assert.equal(canvas()?.getAttribute('aria-label'), 'Nova');
  assert.ok(w.requests.some((r) => r.method === 'GET' && r.url === '/api/ui/layout?scope=mascot.style'), 'the style is read from the account');

  await w.act(async () => { await mascotStylePref().set('2d'); });
  assert.ok(!canvas(), 'the 3D head steps aside');
  assert.equal(svg()?.getAttribute('data-shape'), 'gem', 'the 2D drawing, same look');
  assert.deepEqual(
    w.requests.filter((r) => r.method === 'PUT').map((r) => [r.url, r.body]),
    [['/api/ui/layout?scope=mascot.style', { layout: { style: '2d' } }]],
    'stored per account',
  );

  await w.act(async () => { await mascotStylePref().set('3d'); });
  assert.ok(canvas(), 'back to 3D');
});

test('without WebGL2 the 3D style draws the 2D mascot', async (t) => {
  const { resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  const { AgentMascotHost } = await import('./agent-mascot');
  const { mascotStylePref } = await import('./mascot-style-pref');
  resetSlotsForTests();
  const w = await mount(t, { webgl2: false });
  await w.act(async () => { await mascotStylePref().set('3d'); });
  await w.render(React.createElement(AgentMascotHost, { look: { shape: 'gem' }, size: 40 }));
  assert.ok(!w.document.querySelector('canvas'), 'no 3D head');
  assert.equal(w.document.querySelector('svg[data-mascot]')?.getAttribute('data-shape'), 'gem');
});

test('the configurator\'s cells: the eyes\' screen stays 2D, an accessory\'s cell is the 3D head wearing it', async (t) => {
  const { resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  const { AgentMascotHost } = await import('./agent-mascot');
  const { mascotStylePref } = await import('./mascot-style-pref');
  resetSlotsForTests();
  const w = await mount(t, { webgl2: true });
  await w.act(async () => { await mascotStylePref().set('3d'); });
  await w.render(React.createElement('div', null,
    React.createElement(AgentMascotHost, { look: { eyes: 'heart' }, size: 40, part: 'screen', shadow: false }),
    React.createElement(AgentMascotHost, { look: { acc: 'rocket' }, size: 40, part: 'acc', shadow: false })));
  assert.equal(w.document.querySelector('svg[data-mascot]')?.getAttribute('data-mascot-part'), 'screen');
  assert.equal(Array.from(w.document.querySelectorAll('svg[data-mascot]')).filter((el) => !el.closest('[data-mascot-fallback]')).length, 1);
  assert.equal(w.document.querySelector('canvas[data-mascot]')?.getAttribute('data-acc'), 'rocket');
});

test('a plugin that takes agent.mascot still wins over the 3D head; the default occupant draws 3D', async (t) => {
  const { register, resetSlotsForTests, AGENT_MASCOT_SLOT } = await import('@/lib/plugin-host/slots');
  const { AgentMascotHost, ProductAgentMascot } = await import('./agent-mascot');
  const { useAgentMascot } = await import('./agent-mascot-context');
  const { mascotStylePref } = await import('./mascot-style-pref');
  resetSlotsForTests();
  const w = await mount(t, { webgl2: true });
  await w.act(async () => { await mascotStylePref().set('3d'); });
  const disposeFallback = register({ slot: AGENT_MASCOT_SLOT, pluginId: '@timon/agents', fallback: true }, ProductAgentMascot);
  await w.render(React.createElement(AgentMascotHost, { look: { shape: 'gem' }, size: 40 }));
  assert.equal(w.document.querySelector('canvas[data-mascot]')?.getAttribute('data-shape'), 'gem', 'the default occupant draws 3D');

  function Replacement() {
    const m = useAgentMascot();
    return React.createElement('i', { 'data-replacement': m?.look.shape });
  }
  const dispose = register({ slot: AGENT_MASCOT_SLOT, pluginId: 'acme-mascot' }, Replacement);
  await w.act(() => {});
  assert.ok(!w.document.querySelector('[data-mascot]'), 'neither the 3D head nor the 2D one');
  assert.equal(w.document.querySelector('[data-replacement]')?.getAttribute('data-replacement'), 'gem');
  await w.act(() => { dispose(); });
  assert.ok(w.document.querySelector('canvas[data-mascot]'), 'the 3D head comes back');
  disposeFallback();
});

test('Settings → Appearance: the style radios store the choice, and say so when the browser cannot draw 3D', async (t) => {
  const { resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  const { AgentMascotHost } = await import('./agent-mascot');
  const { mascotStylePref } = await import('./mascot-style-pref');
  const { MascotAnimationSetting } = await import('@/plugins-client/ui-theme-appearance');
  resetSlotsForTests();
  const w = await mount(t, { webgl2: true });
  await w.act(async () => { await mascotStylePref().set('3d'); });
  await w.render(React.createElement('div', null,
    React.createElement(MascotAnimationSetting),
    React.createElement(AgentMascotHost, { look: { shape: 'gem' }, size: 40 })));
  const radio = (style: string) => w.document.querySelector<HTMLInputElement>(`[data-mascot-style="${style}"]`)!;
  assert.equal(radio('3d').checked, true, '3D by default');
  assert.equal(radio('2d').checked, false);
  assert.ok(!w.document.querySelector('[data-mascot-style-no-webgl]'), 'no warning where 3D draws');

  const before = w.requests.filter((r) => r.method === 'PUT').length;
  await w.act(async () => { radio('2d').click(); await settle(); });
  assert.equal(radio('2d').checked, true);
  assert.equal(mascotStylePref().get(), '2d');
  assert.deepEqual(w.requests.filter((r) => r.method === 'PUT').slice(before).map((r) => r.body), [{ layout: { style: '2d' } }]);
  assert.ok(w.document.querySelector('svg[data-mascot]') && !w.document.querySelector('canvas[data-mascot]'), 'the page\'s mascots turn 2D at once');
});

test('Settings → Appearance: without WebGL2 the setting warns that mascots stay 2D', async (t) => {
  const { MascotAnimationSetting } = await import('@/plugins-client/ui-theme-appearance');
  const w = await mount(t, { webgl2: false });
  await w.render(React.createElement(MascotAnimationSetting));
  assert.ok(w.document.querySelector('[data-mascot-style-no-webgl]'));
});
