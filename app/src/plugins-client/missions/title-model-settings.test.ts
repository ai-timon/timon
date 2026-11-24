/**
 * The title-model graft (TODO #358), on the ModelPicker since 6/6: the
 * daemon's verdict is the picker's filter (an ineligible backend is left out
 * and named with its reason), the choices that name no model stay in the
 * select, a pick is written as the body the daemon expects, and a refusal
 * restores the previous choice.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { BackendCatalog, CatalogBackend } from '@/lib/backends';
import { waitUntil } from '@/lib/test-wait';

const VIEW_BACKENDS = [
  { id: 'claude', label: 'Claude', eligible: true, auto: { model: 'haiku', reason: 'tier' as const }, models: [{ slug: 'opus', label: 'Opus' }, { slug: 'haiku', label: 'Haiku', tier: 'small' }] },
  { id: 'faraway', label: 'Far away', eligible: false, reason: 'remote' as const, auto: null, models: [{ slug: 'm', label: 'M' }] },
];

const CATALOG: BackendCatalog = {
  defaultBackend: 'claude',
  backends: [
    { id: 'claude', label: 'Claude', vendor: 'Anthropic', defaultModel: 'opus', models: [{ slug: 'opus', label: 'Opus' }, { slug: 'haiku', label: 'Haiku' }, { slug: 'fresh', label: 'Fresh' }] },
    { id: 'faraway', label: 'Far away', vendor: 'Far away', defaultModel: 'm', models: [{ slug: 'm', label: 'M' }] },
  ],
};

test('the graft paints the choices, picks through the ModelPicker, and keeps the old choice on a refusal', async (suite) => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/settings', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node', 'NodeFilter',
    'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'FocusEvent', 'DocumentFragment']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const { invalidateBackendCatalog } = await import('@/lib/backends');
  const { resetModelFavoritesForTest } = await import('@/hooks/use-model-favorites');
  invalidateBackendCatalog();
  resetModelFavoritesForTest();
  const { MissionTitleModelSettings } = await import('./title-model-settings');
  const originalFetch = globalThis.fetch;

  const view = {
    value: null as unknown,
    instance: { kind: 'auto' },
    instance_source: 'default',
    effective: { kind: 'auto' },
    backends: VIEW_BACKENDS,
  };
  const puts: unknown[] = [];
  let refuse = false;
  let getStatus = 200;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/ui/backends/catalog')) return Response.json(CATALOG);
    if (url.endsWith('/api/ui/prefs/model-favorites')) return Response.json({ favorites: [] });
    if (url !== '/api/ui/mission-titles/model') throw new Error(`unexpected fetch ${url}`);
    if (init?.method === 'PUT') {
      const body = JSON.parse(String(init.body)) as { value: unknown };
      puts.push(body.value);
      if (refuse) return Response.json({ error: 'backend faraway is served remotely', code: 'ineligible' }, { status: 400 });
      const value = body.value === null ? null : typeof body.value === 'string' ? { kind: body.value } : { kind: 'model', ...(body.value as object) };
      return Response.json({ value, effective: value ?? view.instance });
    }
    return Response.json(view, { status: getStatus });
  };
  const root = createRoot(document.getElementById('root')!);
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const select = () => document.querySelector<HTMLSelectElement>('select')!;
  const chip = () => document.querySelector<HTMLButtonElement>('button[aria-haspopup="dialog"]');
  const rows = () => Array.from(document.querySelectorAll<HTMLButtonElement>('[data-picker-row]'));
  const row = (text: string) => rows().find((el) => el.textContent?.includes(text));
  const choose = async (value: string) => {
    select().value = value;
    await React.act(async () => { select().dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  };

  try {
    await suite.test('the select holds the choices that name no model; no picker until "a model"', async () => {
      await React.act(async () => root.render(React.createElement(MissionTitleModelSettings)));
      await until(() => !!document.querySelector('select'), 'the setting to load');
      assert.equal(select().value, 'inherit');
      assert.deepEqual(Array.from(select().options).map((o) => o.value), ['inherit', 'auto', 'off', 'model']);
      assert.ok(!chip());
      assert.match(document.body.textContent!, /quota or credits of the chosen backend/);
    });

    await suite.test('"a model" opens the picker on the eligible list; the remote backend is named with its reason', async () => {
      await choose('model');
      assert.deepEqual(puts, [], 'nothing is written before a pick');
      await until(() => rows().length > 0, 'the picker to open on the catalogue');
      assert.ok(row('Haiku'));
      assert.ok(!row('Fresh'), 'a model the daemon does not list is left out');
      assert.ok(!document.querySelector('nav button[aria-label="Far away"]'), 'the ineligible backend is not in the rail');
      assert.match(document.body.textContent!, /Far away — not available: served remotely, runs no local process/);
    });

    await suite.test('a pick writes the body the daemon expects', async () => {
      await click(row('Haiku'));
      assert.deepEqual(puts, [{ backend: 'claude', model: 'haiku' }]);
      await until(() => !document.querySelector('[role="dialog"]'), 'the popover to close');
      assert.equal(select().value, 'model');
      assert.match(chip()!.textContent!, /Haiku/);
      await choose('off');
      assert.deepEqual(puts.at(-1), 'off');
      assert.ok(!chip());
      await choose('inherit');
      assert.equal(puts.at(-1), null);
      assert.equal(select().value, 'inherit');
    });

    await suite.test('closing the picker without a pick goes back to what is stored', async () => {
      const before = puts.length;
      await choose('model');
      await until(() => !!document.querySelector('[role="dialog"]'), 'the popover');
      await React.act(async () => {
        document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      });
      await until(() => select().value === 'inherit', 'the select to go back');
      assert.equal(puts.length, before);
    });

    await suite.test('a refusal restores the previous choice', async () => {
      await choose('auto');
      refuse = true;
      await choose('off');
      assert.equal(select().value, 'auto');
      refuse = false;
    });

    await suite.test('without an account behind the request, nothing is painted', async () => {
      await React.act(async () => root.unmount());
      getStatus = 401;
      const again = createRoot(document.getElementById('root')!);
      await React.act(async () => again.render(React.createElement(MissionTitleModelSettings)));
      await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
      assert.equal(document.getElementById('root')!.textContent, '');
      await React.act(async () => again.unmount());
    });
  } finally {
    globalThis.fetch = originalFetch;
    setLocale(previousLocale);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});

// After the DOM test: the module loads react-dom, which must first see a document.
test('a mode maps to the daemon body; "model" waits for a pick', async () => {
  const { choiceFromMode } = await import('./title-model-settings');
  assert.equal(choiceFromMode('inherit'), null);
  assert.deepEqual(choiceFromMode('auto'), { kind: 'auto' });
  assert.deepEqual(choiceFromMode('off'), { kind: 'off' });
  assert.equal(choiceFromMode('model'), undefined);
  assert.equal(choiceFromMode('garbage'), undefined);
});

test('the filter keeps an eligible backend\'s models the daemon lists, nothing else', async () => {
  const { titleModelFilter } = await import('./title-model-settings');
  const filter = titleModelFilter(VIEW_BACKENDS);
  const [claude, faraway] = CATALOG.backends as [CatalogBackend, CatalogBackend];
  assert.equal(filter(claude, claude.models[1]!), true);
  assert.equal(filter(claude, claude.models[2]!), false, 'a model the daemon does not list');
  assert.equal(filter(faraway, faraway.models[0]!), false, 'an ineligible backend');
});
