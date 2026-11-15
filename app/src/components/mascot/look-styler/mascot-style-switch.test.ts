/**
 * The onboarding's 3D / 2D switch: it is the preference of Settings →
 * Appearance → Mascot style (a choice in one shows in the other), it sits in
 * the configurator's header of the onboarding's panel, and without WebGL2 it
 * shows 2D, cannot be changed and says why.
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

/** A page in jsdom; `webgl2`: the browser offers a WebGL2 context. */
async function mount(ctx: TestContext, { webgl2 }: { webgl2: boolean }): Promise<Dom> {
  const { JSDOM } = await import('jsdom');
  const { resetWebGL2ProbeForTests } = await import('../three/tile');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/onboarding', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'Event', 'KeyboardEvent', 'MutationObserver', 'getComputedStyle']) {
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
    return method === 'GET' ? Response.json({ layout: null }) : Response.json({ ok: true });
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

test('the switch and Settings → Appearance share one preference, 3D by default', async (t) => {
  const { resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  const { mascotStylePref } = await import('../mascot-style-pref');
  const { MascotStyleSwitch } = await import('./mascot-style-switch');
  const { MascotAnimationSetting } = await import('@/plugins-client/ui-theme-appearance');
  resetSlotsForTests();
  const w = await mount(t, { webgl2: true });
  await w.act(async () => { await mascotStylePref().set('3d'); });
  await w.render(React.createElement('div', null,
    React.createElement('section', { 'data-onboarding': '' }, React.createElement(MascotStyleSwitch)),
    React.createElement('section', { 'data-appearance': '' }, React.createElement(MascotAnimationSetting))));
  await w.act(settle);

  const option = (style: string) => w.document.querySelector<HTMLButtonElement>(`[data-onboarding] [data-mascot-style="${style}"]`)!;
  const appearance = (style: string) => w.document.querySelector<HTMLInputElement>(`[data-appearance] input[data-mascot-style="${style}"]`)!;
  assert.equal(option('3d').getAttribute('aria-checked'), 'true', '3D by default');
  assert.equal(option('2d').getAttribute('aria-checked'), 'false');
  assert.equal(option('3d').disabled, false);
  assert.equal(w.document.querySelector('[data-mascot-style-note]')?.getAttribute('data-mascot-style-note'), 'shared');

  w.requests.length = 0;
  await w.act(async () => { option('2d').click(); await settle(); });
  assert.equal(mascotStylePref().get(), '2d', 'the shared preference changed');
  assert.equal(option('2d').getAttribute('aria-checked'), 'true');
  assert.equal(appearance('2d').checked, true, 'Appearance shows the choice made in onboarding');
  assert.deepEqual(
    w.requests.filter((r) => r.method === 'PUT').map((r) => [r.url, r.body]),
    [['/api/ui/layout?scope=mascot.style', { layout: { style: '2d' } }]],
    'stored per account, in the scope Appearance reads',
  );

  await w.act(async () => { appearance('3d').click(); await settle(); });
  assert.equal(option('3d').getAttribute('aria-checked'), 'true', 'onboarding shows the choice made in Appearance');
});

test('without WebGL2 the switch shows 2D, is disabled and says why, and stores nothing', async (t) => {
  const { resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  const { mascotStylePref } = await import('../mascot-style-pref');
  const { MascotStyleSwitch } = await import('./mascot-style-switch');
  resetSlotsForTests();
  const w = await mount(t, { webgl2: false });
  await w.act(async () => { await mascotStylePref().set('3d'); });
  await w.render(React.createElement(MascotStyleSwitch));
  await w.act(settle);

  const option = (style: string) => w.document.querySelector<HTMLButtonElement>(`[data-mascot-style="${style}"]`)!;
  assert.equal(option('2d').getAttribute('aria-checked'), 'true', '2D shown although 3D is stored');
  assert.equal(option('3d').getAttribute('aria-checked'), 'false');
  assert.equal(option('3d').disabled, true);
  assert.equal(option('2d').disabled, true);
  assert.equal(w.document.querySelector('[role="radiogroup"]')?.getAttribute('aria-disabled'), 'true');
  const note = w.document.querySelector('[data-mascot-style-note]');
  assert.equal(note?.getAttribute('data-mascot-style-note'), 'no-webgl', 'the reason is shown');
  assert.ok(note?.textContent);

  w.requests.length = 0;
  await w.act(async () => { option('2d').click(); await settle(); });
  assert.equal(w.requests.filter((r) => r.method === 'PUT').length, 0, 'nothing stored');
  assert.equal(mascotStylePref().get(), '3d', 'the stored choice is kept for a browser that can draw 3D');
});

test('the onboarding\'s look panel paints the switch above the configurator', async (t) => {
  const { resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  const { LookStylerPanel } = await import('@/components/onboarding/agent/look-styler-panel');
  const { defaultLookFor } = await import('../agent-look');
  resetSlotsForTests();
  const w = await mount(t, { webgl2: true });
  await w.render(React.createElement(LookStylerPanel, {
    open: true, name: 'Nova', role: 'coder', look: defaultLookFor('coder'), onChange: () => {}, onClose: () => {},
  }));
  await w.act(settle);
  assert.ok(w.document.querySelector('[data-look-styler-header] [data-mascot-style-switch]'), 'in the configurator\'s header');
});
