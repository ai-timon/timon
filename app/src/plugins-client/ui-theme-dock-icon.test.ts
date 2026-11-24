/**
 * "Dock icon" in Settings › Appearance: offered only where the desktop shell
 * answers (macOS, this computer's window), and a choice the shell refuses
 * leaves the previous one checked.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

type Bridge = { get: () => Promise<{ icon: string } | null>; set: (icon: string) => Promise<{ icon: string }> };

async function mount(ctx: TestContext, bridge: Bridge | undefined) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'MouseEvent', 'MutationObserver', 'getComputedStyle', 'DocumentFragment', 'CustomEvent', 'KeyboardEvent', 'FocusEvent', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  if (bridge) Object.defineProperty(dom.window, 'timonDesktop', { value: { dockIcon: bridge }, configurable: true });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('@/lib/i18n');
  setLocale('en');
  const { DockIconSetting } = await import('./ui-theme-dock-icon');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  ctx.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const flush = () => act(async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)); });
  await act(() => { root.render(React.createElement(DockIconSetting)); });
  await flush();
  const doc = dom.window.document;
  const checked = () => doc.querySelector<HTMLInputElement>('[data-dock-icon]:checked')?.value ?? null;
  const pick = async (icon: string) => {
    await act(() => { doc.querySelector<HTMLInputElement>(`[data-dock-icon="${icon}"]`)?.click(); });
    await flush();
  };
  return { doc, checked, pick };
}

test('without a Dock to set, the setting is not offered', async (ctx) => {
  const web = await mount(ctx, undefined);
  assert.ok(!web.doc.querySelector('[data-dock-icon-setting]'), 'a browser has no desktop shell');
});

test('a shell without a Dock answers null, and nothing is offered', async (ctx) => {
  const other = await mount(ctx, { get: async () => null, set: async () => { throw new Error('unreachable'); } });
  assert.ok(!other.doc.querySelector('[data-dock-icon-setting]'), 'Windows and Linux answer null');
});

test('on macOS the current icon is checked and a choice reaches the shell', async (ctx) => {
  const sent: string[] = [];
  const mac = await mount(ctx, { get: async () => ({ icon: 'classic' }), set: async (icon) => { sent.push(icon); return { icon }; } });
  assert.ok(mac.doc.querySelector('[data-dock-icon-setting]'));
  assert.equal(mac.checked(), 'classic');
  await mac.pick('dark');
  assert.deepEqual(sent, ['dark']);
  assert.equal(mac.checked(), 'dark');
});

test('a choice the shell refuses puts the previous one back', async (ctx) => {
  const mac = await mount(ctx, { get: async () => ({ icon: 'dark' }), set: async () => { throw new Error('The Dock icon could not be loaded.'); } });
  assert.equal(mac.checked(), 'dark');
  await mac.pick('classic');
  assert.equal(mac.checked(), 'dark');
});
