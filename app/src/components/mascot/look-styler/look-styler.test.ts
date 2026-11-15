/**
 * The shared mascot configurator (`agent.lookstyler`, TODO #880): the host
 * paints the product's grids while the slot is empty, a plugin's
 * replacement once it takes it — reading `useLookStyler()` — and the product
 * again after it leaves. What a replacement hands back is normalised before
 * it reaches the screen.
 */
import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import React from 'react';

type Dom = { act: (fn: () => void | Promise<void>) => Promise<void>; render: (el: React.ReactElement) => Promise<void>; document: Document };

async function mount(ctx: TestContext): Promise<Dom> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/agents', pretendToBeVisual: true });
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
  // The test runner compiles JSX to `React.createElement`.
  install('React', React);
  // Reduced motion: the preview's mascot stays still, no frame loop to run.
  Object.defineProperty(dom.window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: query.includes('reduce'), media: query, addEventListener: () => undefined, removeEventListener: () => undefined }),
  });
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(dom.window.document.getElementById('root')!);
  const act = (fn: () => void | Promise<void>) => React.act(async () => { await fn(); });
  ctx.after(async () => {
    await act(() => root.unmount());
    dom.window.close();
    for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else Reflect.deleteProperty(globalThis, key); }
  });
  return { act, render: (el) => act(() => { root.render(el); }), document: dom.window.document };
}

/**
 * A change of the slot registry re-renders every mascot of the grids (a
 * hundred of them): out of `act`, each one is an act() warning — 12,000 for
 * this file, the flood that kept the app suite from finishing in CI
 * (05/11/2026). Every change made while a tree may be mounted, cleanups
 * included, goes through this.
 */
function inAct(fn: () => void): Promise<void> {
  return React.act(async () => { fn(); });
}

test('the host paints the product while the slot is empty, a plugin\'s configurator once it takes it, and the product again after', async (t) => {
  const { register, resetSlotsForTests, AGENT_LOOK_STYLER_SLOT, slotEntries } = await import('@/lib/plugin-host/slots');
  const { LookStylerHost, ProductLookStyler, TRY_STATES } = await import('./look-styler');
  const { useLookStyler } = await import('./look-styler-context');
  const { ACC, EYES, FURS, SHAPES, defaultLookFor } = await import('../agent-look');
  const reviewEyes = defaultLookFor('review').eyes;
  resetSlotsForTests();
  assert.equal(slotEntries(AGENT_LOOK_STYLER_SLOT).length, 0, 'a boot slot, empty');
  const w = await mount(t);
  const picked: unknown[] = [];
  const host = React.createElement(LookStylerHost, {
    look: { shape: 'gem', color: '#FF5FBF' as never, eyes: 'bogus' as never, acc: 'globe' },
    onChange: (look) => { picked.push(look); },
    name: 'Nova',
    role: 'review',
  });
  await w.render(host);
  const product = () => w.document.querySelector('[data-look-styler-content]');
  assert.ok(product(), 'the product\'s configurator');
  assert.equal(w.document.querySelector('button[data-shape="gem"]')?.getAttribute('aria-pressed'), 'true');
  assert.equal(w.document.querySelector(`button[data-eyes="${reviewEyes}"]`)?.getAttribute('aria-pressed'), 'true', 'an invalid field falls back to the role\'s default');
  await w.act(() => { w.document.querySelector<HTMLElement>('button[data-acc="coffee"]')!.click(); });
  assert.deepEqual(picked.pop(), { shape: 'gem', color: '#ff5fbf', eyes: reviewEyes, acc: 'coffee' });

  let disposeFallback = () => {};
  await inAct(() => { disposeFallback = register({ slot: AGENT_LOOK_STYLER_SLOT, pluginId: '@timon/agents', fallback: true }, ProductLookStyler); });
  assert.ok(product(), 'the default occupant paints the same configurator');

  const seen: Array<ReturnType<typeof useLookStyler>> = [];
  function Replacement() {
    const v = useLookStyler();
    seen.push(v);
    return React.createElement('button', {
      type: 'button',
      'data-replacement': v?.look.shape,
      // A plugin that hands back a value off the lists.
      onClick: () => v?.onChange({ ...v.look, shape: 'star' as never, acc: 'wrench' }),
    });
  }
  let dispose = () => {};
  await inAct(() => { dispose = register({ slot: AGENT_LOOK_STYLER_SLOT, pluginId: 'acme-styler' }, Replacement); });
  assert.ok(!product(), 'the product steps aside');
  const last = seen[seen.length - 1]!;
  assert.ok(last);
  assert.equal(last.name, 'Nova');
  assert.equal(last.role, 'review');
  assert.deepEqual(last.states, TRY_STATES);
  assert.deepEqual(last.choices, { shapes: SHAPES, colors: FURS, eyes: EYES, accessories: ACC });
  assert.deepEqual(last.packs, [], 'no pack installed');
  const drawn = last.random();
  assert.ok((SHAPES as readonly string[]).includes(drawn.shape) && (ACC as readonly string[]).includes(drawn.acc), 'a random look from the lists');
  await w.act(() => { w.document.querySelector<HTMLElement>('[data-replacement]')!.click(); });
  assert.deepEqual(picked.pop(), { shape: 'gem', color: '#ff5fbf', eyes: reviewEyes, acc: 'wrench' }, 'a field off the lists keeps the current value');

  await w.act(() => { dispose(); });
  assert.ok(product(), 'the product comes back');
  await inAct(() => { disposeFallback(); resetSlotsForTests(); });
});

test('a mascot pack\'s parts show in their grids under the pack\'s name, and fall back to the default when it leaves', async (t) => {
  const { register, resetSlotsForTests, MASCOT_PARTS_SLOT } = await import('@/lib/plugin-host/slots');
  const { recordMascotDeclarations, resetMascotDeclarationsForTests } = await import('@/lib/mascot/parts-declarations');
  const { LookStylerHost } = await import('./look-styler');
  const { defaultLookFor } = await import('../agent-look');
  resetSlotsForTests();
  t.after(() => inAct(() => { resetSlotsForTests(); resetMascotDeclarationsForTests(); }));
  recordMascotDeclarations([{ id: 'acme-pack', label: 'Acme pack', mascot: { acc: ['cap'], color: ['midnight'], eyes: ['sparkle'], shape: ['blob'] } }]);
  const parts = [
    register({ slot: MASCOT_PARTS_SLOT, pluginId: 'acme-pack', key: 'cap', mascotPart: { type: 'acc', label: { en: 'Cap', fr: 'Casquette' }, svg: '<rect x="-8" y="-4" width="16" height="8" rx="3" fill="#3fa9ff"/>' } }),
    register({ slot: MASCOT_PARTS_SLOT, pluginId: 'acme-pack', key: 'midnight', mascotPart: { type: 'color', label: 'Midnight', hex: '#1d2b53' } }),
    register({ slot: MASCOT_PARTS_SLOT, pluginId: 'acme-pack', key: 'sparkle', mascotPart: { type: 'eyes', label: 'Sparkle', left: [[0, -6], [2, -1], [6, 0], [2, 1], [0, 6], [-2, 1], [-6, 0], [-2, -1]] } }),
    register({ slot: MASCOT_PARTS_SLOT, pluginId: 'acme-pack', key: 'blob', mascotPart: { type: 'shape', label: 'Blob', skull: { top: 70, bottom: 90, height: 70, radius: 34 } } }),
  ];
  const w = await mount(t);
  const picked: Array<Record<string, string>> = [];
  const render = (look: Record<string, string>) => w.render(React.createElement(LookStylerHost, {
    look: look as never, onChange: (next) => { picked.push(next as never); }, name: 'Nova', role: 'review',
  }));
  await render({ shape: 'acme-pack:blob', color: 'acme-pack:midnight', eyes: 'acme-pack:sparkle', acc: 'none' });
  const pack = w.document.querySelectorAll('[data-mascot-pack="acme-pack"]');
  assert.equal(pack.length, 4, 'one group per grid that the pack fills');
  assert.ok(Array.from(pack).every((group) => group.textContent?.includes('Acme pack')), 'each group is headed by the pack\'s name');
  assert.equal(w.document.querySelector('button[data-shape="acme-pack:blob"]')?.getAttribute('aria-pressed'), 'true');
  assert.equal(w.document.querySelector('button[data-fur="acme-pack:midnight"]')?.getAttribute('aria-pressed'), 'true');
  assert.equal(w.document.querySelector('button[data-eyes="acme-pack:sparkle"]')?.getAttribute('aria-pressed'), 'true');
  // The cell is the agent wearing the part: the pack's tool is drawn from its markup.
  const cap = w.document.querySelector<HTMLElement>('button[data-acc="acme-pack:cap"]')!;
  assert.ok(cap.querySelector('[data-mascot-acc="acme-pack:cap"] rect'), 'the cap is drawn');
  assert.equal(cap.getAttribute('aria-label'), 'Cap');
  await w.act(() => { cap.click(); });
  assert.deepEqual(picked.pop(), { shape: 'acme-pack:blob', color: 'acme-pack:midnight', eyes: 'acme-pack:sparkle', acc: 'acme-pack:cap' });

  // The plugin leaves: its parts leave the grids and the look reads as the job's default for each of them.
  await w.act(() => { for (const dispose of parts) dispose(); });
  assert.equal(w.document.querySelectorAll('[data-mascot-pack]').length, 0);
  const fallback = defaultLookFor('review');
  assert.equal(w.document.querySelector(`button[data-shape="${fallback.shape}"]`)?.getAttribute('aria-pressed'), 'true');
  assert.equal(w.document.querySelector(`button[data-eyes="${fallback.eyes}"]`)?.getAttribute('aria-pressed'), 'true');
});

test('the examples/plugin-look-styler template replaces the configurator with the SDK alone', async (t) => {
  const { readFileSync, mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join, resolve } = await import('node:path');
  const { pathToFileURL } = await import('node:url');
  const { register, resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  resetSlotsForTests();
  const source = readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-look-styler', 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__stylerTestReact\n')
    .replace(/import \{([^}]*)\} from '@timon\/ui'\n/, 'const {$1} = globalThis.__stylerTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @timon/ui');
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  Object.assign(globalThis, { __stylerTestReact: React, __stylerTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'look-styler-example-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, platform);
  const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => () => void };
  const { LookStylerHost } = await import('./look-styler');
  const w = await mount(t);
  const dispose = mod.apply({ slots: { register: (options: { slot: string }, Component: React.ComponentType) => register({ ...options, pluginId: 'example-look-styler' }, Component) } });
  const picked: unknown[] = [];
  await w.render(React.createElement(LookStylerHost, {
    look: { shape: 'round', color: '#d4a373', eyes: 'happy', acc: 'none' },
    onChange: (look) => { picked.push(look); },
    name: 'Nova',
  }));
  assert.equal(w.document.querySelector('[data-compact-styler]')?.getAttribute('data-compact-styler'), 'Nova');
  assert.ok(!w.document.querySelector('[data-look-styler-content]'), 'the product steps aside');
  await w.act(() => { w.document.querySelector<HTMLElement>('[data-compact-fur="#3fa9ff"]')!.click(); });
  assert.deepEqual(picked.pop(), { shape: 'round', color: '#3fa9ff', eyes: 'happy', acc: 'none' });
  await w.act(() => { dispose(); });
  assert.ok(w.document.querySelector('[data-look-styler-content]'), 'the product\'s configurator comes back');
  await inAct(() => { resetSlotsForTests(); });
});

test('the configurator follows its container\'s width: two columns when wide, the stack when narrow', async (t) => {
  const { resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  const { LookStylerHost, LOOK_STYLER_COLUMNS_MIN_WIDTH } = await import('./look-styler');
  resetSlotsForTests();
  // jsdom lays nothing out: a stand-in observer reports the widths a real container would.
  const observers: FakeObserver[] = [];
  class FakeObserver {
    observed: Element[] = [];
    disconnected = false;
    constructor(readonly callback: (entries: Array<{ contentRect: { width: number } }>) => void) { observers.push(this); }
    observe(el: Element): void { this.observed.push(el); }
    unobserve(): void {}
    disconnect(): void { this.disconnected = true; }
  }
  const saved = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  Object.defineProperty(globalThis, 'ResizeObserver', { value: FakeObserver, configurable: true, writable: true });
  t.after(() => {
    if (saved) Object.defineProperty(globalThis, 'ResizeObserver', saved);
    else Reflect.deleteProperty(globalThis, 'ResizeObserver');
    return inAct(() => { resetSlotsForTests(); });
  });
  const w = await mount(t);
  await w.render(React.createElement(LookStylerHost, { look: null, onChange: () => undefined, name: 'Nova', role: 'review' }));
  const root = () => w.document.querySelector<HTMLElement>('[data-look-styler-content]')!;
  assert.equal(root().getAttribute('data-look-styler-layout'), 'stack', 'nothing measured yet: the stack');
  const observer = observers.find((o) => o.observed.includes(root()));
  assert.ok(observer, 'the configurator\'s own root is measured');
  const resize = (width: number) => w.act(() => { observer.callback([{ contentRect: { width } }]); });

  await resize(900);
  assert.equal(root().getAttribute('data-look-styler-layout'), 'columns');
  assert.match(root().className, /flex-row/);
  const preview = root().querySelector<HTMLElement>(':scope > [data-look-styler-preview]');
  const choices = root().querySelector<HTMLElement>(':scope > [data-look-styler-choices]');
  assert.ok(preview && choices, 'the preview and the grids are two zones side by side');
  assert.ok(preview.querySelector('[data-try="happy"]') && preview.querySelector('[data-surprise]'), 'the states and « Surprise me » stay with the preview');
  assert.ok(!preview.querySelector('button[data-shape]'), 'no grid under the preview');
  for (const cell of ['data-shape', 'data-fur', 'data-eyes', 'data-acc']) {
    assert.ok(choices.querySelector(`button[${cell}]`), `the ${cell} grid sits with the choices`);
  }
  assert.match(choices.className, /overflow-auto/, 'the choices scroll on their own');

  await resize(LOOK_STYLER_COLUMNS_MIN_WIDTH - 1);
  assert.equal(root().getAttribute('data-look-styler-layout'), 'stack', 'a narrow container (the onboarding\'s panel) keeps the stack');
  assert.match(root().className, /flex-col/);
  assert.equal(root().firstElementChild?.hasAttribute('data-look-styler-preview'), true, 'the preview first, the grids under it');

  await w.render(React.createElement('div'));
  assert.ok(observer.disconnected, 'the observer goes with the configurator');
});

test('a screen\'s header sits among the product\'s choices, and above a plugin\'s replacement', async (t) => {
  const { register, resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  const { LookStylerHost } = await import('./look-styler');
  resetSlotsForTests();
  t.after(() => inAct(() => { resetSlotsForTests(); }));
  const w = await mount(t);
  const header = React.createElement('div', { 'data-test-switch': '' }, 'switch');
  const host = () => React.createElement(LookStylerHost, { look: null, onChange: () => undefined, name: 'Nova', header });

  await w.render(host());
  const choices = w.document.querySelector('[data-look-styler-choices]');
  assert.ok(choices?.querySelector('[data-test-switch]'), 'the product paints the header with its choices');
  assert.equal(w.document.querySelectorAll('[data-test-switch]').length, 1, 'painted once');

  const Replacement = (): React.ReactElement => React.createElement('div', { 'data-replacement': '' }, 'replacement');
  let dispose = () => undefined as void;
  await w.act(() => { dispose = register({ slot: 'agent.lookstyler', pluginId: 'acme-styler' }, Replacement); });
  await w.render(host());
  assert.ok(w.document.querySelector('[data-replacement]'), 'the plugin paints the configurator');
  assert.ok(!w.document.querySelector('[data-look-styler-content]'), 'the product steps aside');
  const switches = w.document.querySelectorAll('[data-test-switch]');
  assert.equal(switches.length, 1, 'the header still shows, once');
  assert.ok(!w.document.querySelector('[data-replacement] [data-test-switch]'), 'painted by the host, outside the replacement');
  await w.act(() => { dispose(); });
});

test('the fur grid ends with a colour picker: it shows a fur off the presets, and hands back the colour mixed, lower case', async (t) => {
  const { resetSlotsForTests } = await import('@/lib/plugin-host/slots');
  const { LookStylerHost } = await import('./look-styler');
  resetSlotsForTests();
  const w = await mount(t);
  const picked: Array<{ color: string }> = [];
  await w.render(React.createElement(LookStylerHost, {
    look: { shape: 'round', color: '#123456' as never, eyes: 'pill', acc: 'none' },
    onChange: (look) => { picked.push(look); },
    name: 'Nova',
  }));
  const input = () => w.document.querySelector<HTMLInputElement>('label[data-fur-custom] input[type="color"]')!;
  assert.ok(input(), 'the picker cell');
  assert.equal(input().value, '#123456', 'it opens on the agent\'s own fur');
  assert.equal(w.document.querySelectorAll('button[data-fur][aria-pressed="true"]').length, 0, 'no preset is selected');
  // The way a browser reports a pick: the value set natively, then an input event React listens to.
  await w.act(() => {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input()), 'value')!.set!;
    setter.call(input(), '#ABCDEF');
    input().dispatchEvent(new window.Event('input', { bubbles: true }));
  });
  assert.equal(picked.pop()?.color, '#abcdef');

  // A preset keeps its own cell: picking it leaves the picker on the fur mixed last.
  await w.render(React.createElement(LookStylerHost, {
    look: { shape: 'round', color: '#7a4f35', eyes: 'pill', acc: 'none' },
    onChange: () => undefined,
    name: 'Nova',
  }));
  assert.equal(w.document.querySelector('button[data-fur="#7a4f35"]')?.getAttribute('aria-pressed'), 'true');
});
