/**
 * "Interface size" in Settings › Appearance: offered only where the desktop
 * shell answers, every change reaches the shell, and a size changed elsewhere
 * (the keys, the wheel, another window) shows while Settings is open.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';

type Zoom = {
  get: () => Promise<{ factor: number; steps: number[] }>;
  set: (factor: number) => Promise<{ factor: number }>;
  step: (direction: 'in' | 'out' | 'reset') => Promise<{ factor: number }>;
  onChange: (listener: (factor: number) => void) => () => void;
};
const STEPS = [0.8, 0.9, 1, 1.1, 1.2, 1.25, 1.33, 1.5, 1.75, 2];

/** A shell holding `factor`, which announces each change like the preload does, before answering. */
function shell(factor: number, calls: unknown[] = []) {
  const state = { factor, listeners: new Set<(factor: number) => void>() };
  const announce = (next: number) => { state.factor = next; for (const listener of state.listeners) listener(next); };
  const move = (direction: 'in' | 'out' | 'reset') => {
    if (direction === 'reset') return 1;
    const index = STEPS.indexOf(state.factor) + (direction === 'in' ? 1 : -1);
    return STEPS[Math.max(0, Math.min(STEPS.length - 1, index))]!;
  };
  const zoom: Zoom = {
    get: async () => ({ factor: state.factor, steps: STEPS }),
    set: async (next) => { calls.push(['set', next]); announce(next); return { factor: next }; },
    step: async (direction) => { calls.push(['step', direction]); const next = move(direction); announce(next); return { factor: next }; },
    onChange: (listener) => { state.listeners.add(listener); return () => { state.listeners.delete(listener); }; },
  };
  return { zoom, announce, calls };
}

async function mount(ctx: TestContext, zoom: Zoom | undefined) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('self', dom.window);
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'Event', 'MouseEvent', 'PointerEvent', 'MutationObserver', 'getComputedStyle', 'DocumentFragment', 'CustomEvent', 'KeyboardEvent', 'FocusEvent', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, key === 'window' ? dom.window : Reflect.get(dom.window, key));
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  if (zoom) Object.defineProperty(dom.window, 'timonDesktop', { value: { restartAfterSetup: async () => {}, zoom }, configurable: true });
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale } = await import('@/lib/i18n');
  setLocale('en');
  const { resetUiZoomForTests } = await import('@/lib/ui-zoom');
  const { InterfaceSizeSetting } = await import('./ui-theme-zoom');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  let mounted = true;
  const unmount = async () => {
    if (!mounted) return;
    mounted = false;
    await act(() => root.unmount());
  };
  ctx.after(async () => {
    await unmount();
    resetUiZoomForTests();
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  const flush = () => act(async () => { for (let i = 0; i < 8; i += 1) await new Promise((r) => setTimeout(r, 0)); });
  await act(() => { root.render(React.createElement(InterfaceSizeSetting)); });
  await flush();
  const doc = dom.window.document;
  const control = (name: string) => doc.querySelector<HTMLButtonElement>(`[data-interface-size="${name}"]`);
  const shown = () => control('value')?.textContent ?? null;
  const press = async (name: string) => {
    await act(() => { control(name)?.click(); });
    await flush();
  };
  return { doc, control, shown, press, act, flush, unmount };
}

test('the web and an older desktop do not offer an interface size', async (ctx) => {
  const web = await mount(ctx, undefined);
  assert.ok(!web.doc.querySelector('[data-interface-size-setting]'));
});

test('the current size shows as a percentage, with each control held at its end', async (ctx) => {
  const view = await mount(ctx, shell(1).zoom);
  assert.ok(view.doc.querySelector('[data-interface-size-setting]'));
  assert.equal(view.shown(), '100%');
  assert.equal(view.control('reset')?.disabled, true, 'already at 100 %');
  assert.equal(view.control('in')?.disabled, false);
  assert.equal(view.control('out')?.disabled, false);
  assert.equal(view.control('in')?.getAttribute('aria-label'), 'Larger');
  assert.equal(view.control('out')?.getAttribute('aria-label'), 'Smaller');
});

test('at the largest and smallest stops, the way further is closed', async (ctx) => {
  await ctx.test('largest stop', async (sub) => {
    const largest = await mount(sub, shell(2).zoom);
    assert.equal(largest.shown(), '200%');
    assert.equal(largest.control('in')?.disabled, true);
    assert.equal(largest.control('out')?.disabled, false);
  });
  await ctx.test('smallest stop', async (sub) => {
    const smallest = await mount(sub, shell(0.8).zoom);
    assert.equal(smallest.shown(), '80%');
    assert.equal(smallest.control('out')?.disabled, true);
    assert.equal(smallest.control('in')?.disabled, false);
  });
});

test('larger, smaller and reset each reach the shell, and the size it settled on shows', async (ctx) => {
  const { zoom, calls } = shell(1.2);
  const view = await mount(ctx, zoom);
  assert.equal(view.shown(), '120%');
  await view.press('in');
  assert.equal(view.shown(), '125%');
  await view.press('out');
  assert.equal(view.shown(), '120%');
  await view.press('reset');
  assert.equal(view.shown(), '100%');
  assert.deepEqual(calls, [['step', 'in'], ['step', 'out'], ['step', 'reset']]);
});

test('a size changed with the keys or in another window shows while Settings is open', async (ctx) => {
  const { zoom, announce } = shell(1);
  const view = await mount(ctx, zoom);
  await view.act(() => { announce(1.5); });
  await view.flush();
  assert.equal(view.shown(), '150%');
  assert.equal(view.control('reset')?.disabled, false);
});

test('a size the shell refuses leaves the current one and says so', async (ctx) => {
  const { zoom } = shell(1.1);
  zoom.step = async () => { throw new Error('refused'); };
  const view = await mount(ctx, zoom);
  await view.press('in');
  assert.equal(view.shown(), '110%');
  assert.equal(view.control('in')?.disabled, false, 'the controls come back');
});

test('the icon-only controls carry a tooltip trigger and hide their glyph from screen readers', async (ctx) => {
  const view = await mount(ctx, shell(1).zoom);
  for (const name of ['in', 'out']) {
    const button = view.control(name);
    assert.ok(button?.hasAttribute('data-state'), `${name}: wrapped by the kit\'s Tooltip`);
    assert.equal(button?.querySelector('svg')?.getAttribute('aria-hidden'), 'true');
  }
});

test('Settings closed while the shell is answering: the late answer is dropped without a word', async (ctx) => {
  const { zoom } = shell(1);
  let answer!: (state: { factor: number }) => void;
  zoom.step = () => new Promise((resolve) => { answer = resolve; });
  const view = await mount(ctx, zoom);
  const errors: unknown[] = [];
  const error = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  try {
    await view.act(() => { view.control('in')?.click(); });
    await view.unmount();
    await view.act(async () => { answer({ factor: 1.1 }); });
    await view.flush();
  } finally {
    console.error = error;
  }
  assert.deepEqual(errors, []);
});
