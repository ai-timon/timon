/**
 * The model editor and the picture of a provider added by hand, mounted on its
 * real page (Settings › AI models › Providers › <name>) with the common
 * sections of `@timon/backends`.
 *
 * `backends-form.test.ts` proves what the form sends. None of it would notice
 * a keyboard user who can no longer move a model, an eye whose label stops
 * saying what a click does, a thinking setting that sends something else than
 * what was picked, or a warning of the daemon about the backend's file that is
 * painted nowhere.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '@/lib/test-wait';
import type { ProviderOverview } from '@/lib/provider-overview';
import type { CustomBackend } from './form';

const BACKEND: CustomBackend = {
  id: 'deepseek', file: 'deepseek.json', origin: 'file', label: 'DeepSeek', dialect: 'claude', protocol: 'anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic',
  models: [
    { slug: 'deepseek-chat', label: 'Chat' },
    { slug: 'deepseek-reasoner', label: 'Reasoner' },
    { slug: 'deepseek-coder', label: 'Coder' },
  ],
  defaultModel: 'deepseek-chat', icon: null, brand: 'deepseek', hasVaultKey: true, active: true, reason: null, warnings: [],
};

const OVERVIEW: ProviderOverview = {
  id: 'user:deepseek', name: 'DeepSeek', brand: 'deepseek', icon: null, origin: 'user', pluginId: null, plugin: null, catalogAgent: null,
  enabled: true, isDefault: false,
  backends: [{ id: 'deepseek', label: 'DeepSeek', active: true, disabled: false, reason: null, modelCount: 3, defaultModel: 'deepseek-chat', isDefault: false, remote: true }],
  modelCount: 3, agentCount: 0,
  connection: { signedIn: null, signInCommand: null, signInThen: null, acceptsAccounts: false, accounts: [] },
  secret: { required: false, present: false, names: [] }, programs: [], status: 'available', updateAvailable: false,
};

async function mount(backend: CustomBackend = BACKEND, protocols: unknown[] = []) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'Element', 'Node', 'DocumentFragment',
    'MutationObserver', 'NodeFilter', 'SVGElement', 'Event', 'CustomEvent', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'InputEvent',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('EventSource', class { close() {} addEventListener() {} removeEventListener() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const sent: { url: string; method: string; body: unknown }[] = [];
  install('fetch', async (url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      sent.push({ url, method: init.method, body: JSON.parse(String(init.body)) });
      return Response.json({ ok: true });
    }
    if (url === '/api/ui/providers/overview') return Response.json({ providers: [OVERVIEW], defaultBackend: null });
    if (url === '/api/ui/backends/manage') return Response.json({ backends: [backend], protocols });
    return new Response(null, { status: 404 });
  });
  // jsdom lays nothing out, and dnd-kit's keyboard moves go from one measured
  // row to the next: give every model row a box, stacked 40 px apart.
  dom.window.Element.prototype.getBoundingClientRect = function (this: Element) {
    const row = this.closest('[data-model-row]');
    const rows = Array.from(document.querySelectorAll('[data-model-row]'));
    const top = row ? rows.indexOf(row) * 40 : 0;
    const height = row ? 36 : 0;
    return { x: 0, y: top, top, left: 0, width: row ? 480 : 0, height, right: row ? 480 : 0, bottom: top + height, toJSON() { return this; } } as DOMRect;
  };

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  slots.declareSlot('settings.provider.section', 'list');
  const { coreBackendsClient } = await import('@/plugins-client/backends');
  coreBackendsClient.apply({
    id: coreBackendsClient.module,
    realtime: { subscribe: () => () => {} } as never,
    caps: null,
    zoneVisible: () => true,
    options: {},
    register: (options, Component) => (options.slot === 'settings.provider.section'
      ? slots.register({ ...options, pluginId: coreBackendsClient.module }, Component)
      : () => {}),
    onDispose: () => {},
  });
  const { ProviderPage } = await import('@/components/provider-page/provider-page');

  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(ProviderPage, { requested: 'user:deepseek', onBack: () => {} }));
  });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const section = (key: string): HTMLElement | null => document.querySelector<HTMLElement>(`[data-provider-section="${key}"]`);
  await until(() => !!section('models')?.querySelector('[data-model-row]') && !!section('settings'), 'the Models and Settings sections');
  const act = React.act;
  const key = async (target: Element, keyName: string, code = keyName) => {
    await act(async () => {
      target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: keyName, code, bubbles: true, cancelable: true }));
    });
  };
  const click = async (target: HTMLElement) => {
    await act(async () => { target.focus(); target.click(); });
  };
  const type = async (input: HTMLInputElement, value: string) => {
    await act(async () => {
      // React tracks the value it set: go through the native setter so the
      // change is seen as the user's.
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
      input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
  };
  const patched = () => sent.find((call) => call.url === '/api/ui/backends/manage/deepseek');
  const unmount = async () => {
    await act(async () => { root.unmount(); });
    // A dialog's focus trap lets go on a timer: let it run before the window goes.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    slots.resetSlotsForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [name, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete (globalThis as Record<string, unknown>)[name];
    }
  };
  // The full editor is a mode, opened from the count row's "…" menu (from the keyboard: jsdom has no pointer events).
  const editList = async () => {
    const trigger = section('models')!.querySelector<HTMLElement>('button[data-row-menu]')!;
    await act(async () => { trigger.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await until(() => document.querySelector('[role="menu"]') !== null, 'the models menu');
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) => el.textContent === 'Edit or reorder the list');
    if (!item) assert.fail('no "Edit or reorder the list" item');
    await act(async () => { item.click(); });
    await until(() => !!section('models')?.querySelector('[data-models-editor] [data-model-row]'), 'the list editor');
  };
  return { section, patched, until, key, click, type, unmount, act, editList };
}

function findText<T extends HTMLElement>(selector: string, text: string, scope: ParentNode = document): T | undefined {
  return Array.from(scope.querySelectorAll<T>(selector)).find((node) => node.textContent?.trim() === text);
}

function byText<T extends HTMLElement>(selector: string, text: string, scope: ParentNode = document): T {
  const found = findText<T>(selector, text, scope);
  // Never hand a DOM node to `assert`: on failure it inspects the whole jsdom
  // graph behind it, and that alone eats gigabytes.
  if (!found) assert.fail(`${selector} "${text}" not found`);
  return found;
}

test('models reorder from the keyboard with their handle, and the eye toggles their visibility', async () => {
  const ui = await mount();
  try {
    await ui.editList();
    const models = ui.section('models')!;
    const slugs = () => Array.from(models.querySelectorAll<HTMLInputElement>('input[aria-label="deepseek-chat"]')).map((input) => input.value);
    assert.deepEqual(slugs(), ['deepseek-chat', 'deepseek-reasoner', 'deepseek-coder']);

    // One line per model: no arrows, a handle instead.
    assert.equal(models.querySelectorAll('[aria-label="Move model up"], [aria-label="Move model down"]').length, 0);
    const grips = Array.from(models.querySelectorAll<HTMLElement>('[aria-label="Drag to reorder this model"]'));
    assert.equal(grips.length, 3, 'one handle per model');
    assert.equal(grips[0]!.getAttribute('aria-roledescription'), 'sortable', 'the handle is a dnd-kit sortable');

    // Space lifts, the arrow moves, Space drops.
    await ui.act(async () => { grips[0]!.focus(); });
    // dnd-kit starts listening to the arrows a timer after the lift: the wait
    // on the lift covers it.
    await ui.key(grips[0]!, ' ', 'Space');
    await ui.until(() => grips[0]!.getAttribute('aria-pressed') === 'true', 'Space to lift the model');
    await ui.key(grips[0]!, 'ArrowDown');
    await ui.key(grips[0]!, ' ', 'Space');
    await ui.until(() => slugs()[0] === 'deepseek-reasoner', 'Space to drop the model one row down');
    assert.deepEqual(slugs(), ['deepseek-reasoner', 'deepseek-chat', 'deepseek-coder'], 'the first model went down one row');

    // The eye is an icon: its label says what a click does, and flips.
    const eyes = () => Array.from(models.querySelectorAll<HTMLButtonElement>('button[aria-label*="model selectors"]'));
    assert.deepEqual(eyes().map((eye) => eye.textContent), ['', '', ''], 'no visible word on the eye');
    assert.equal(eyes()[2]!.getAttribute('aria-label'), 'Shown in model selectors. Click to hide it');
    await ui.click(eyes()[2]!);
    await ui.until(() => eyes()[2]!.getAttribute('aria-label')!.startsWith('Hidden'), 'the eye to flip');
    assert.equal(eyes()[2]!.getAttribute('aria-label'), 'Hidden from model selectors. Click to show it');

    // What is saved is what the section shows.
    await ui.click(byText<HTMLButtonElement>('button', 'Save', models));
    await ui.until(() => !!ui.patched(), 'Save to send the models');
    const patch = ui.patched();
    if (!patch) assert.fail('Save sent nothing');
    const sentModels = (patch.body as { models: { slug: string; hidden?: boolean }[] }).models;
    assert.deepEqual(sentModels.map((model) => model.slug), ['deepseek-reasoner', 'deepseek-chat', 'deepseek-coder']);
    assert.deepEqual(sentModels.map((model) => !!model.hidden), [false, false, true]);
  } finally {
    await ui.unmount();
  }
});

test('the picture choices wrap inside the dialog: the brands go to the line, the emoji picker is outside their box', async () => {
  const ui = await mount();
  try {
    assert.ok(!ui.section('settings')!.querySelector('[data-picto-brands]'), 'the picture waits behind Edit');
    await ui.click(byText<HTMLButtonElement>('button', 'Edit', ui.section('settings')!));
    await ui.until(() => !!document.querySelector('[data-provider-settings-dialog] [data-picto-brands]'), 'the settings dialog');
    const brands = document.querySelector<HTMLElement>('[data-provider-settings-dialog] [data-picto-brands]');
    if (!brands) assert.fail('no brand strip');
    const row = brands.parentElement!;
    // jsdom lays nothing out: the classes are what keeps twenty logos from
    // widening the dialog into a sideways scroll.
    const classes = (el: Element) => el.className.split(/\s+/);
    assert.ok(classes(brands).includes('flex-wrap') && classes(brands).includes('min-w-0'), 'the brands shrink and wrap');
    assert.ok(!classes(brands).some((name) => name.startsWith('overflow-x')), 'the brands never scroll sideways');
    assert.ok(classes(row).includes('min-w-0'), 'the row shrinks with the dialog');
    const form = document.querySelector<HTMLElement>('[data-provider-settings-dialog]')!.querySelector('[data-picto-brands]')!.closest('[class*="space-y-5"]');
    assert.ok(form && classes(form).includes('min-w-0'), 'the form does not set the dialog column to its min-content width');
    const emoji = row.querySelector<HTMLElement>('button[aria-label="An emoji"]');
    assert.ok(!!emoji && !brands.contains(emoji), 'the emoji button sits outside the brand strip');
  } finally {
    await ui.unmount();
  }
});

test('the dialog of one model fits its width: the form shrinks, the brands wrap', async () => {
  const ui = await mount();
  try {
    const trigger = ui.section('models')!.querySelector<HTMLElement>('button[data-row-menu]')!;
    await ui.act(async () => { trigger.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await ui.until(() => document.querySelector('[role="menu"]') !== null, 'the models menu');
    const item = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find((el) => el.textContent === 'Add a model');
    if (!item) assert.fail('no "Add a model" item');
    await ui.act(async () => { item.click(); });
    await ui.until(() => !!document.querySelector('[data-model-dialog] [data-picto-brands]'), 'the model dialog');
    const dialog = document.querySelector<HTMLElement>('[data-model-dialog]')!;
    const classes = (el: Element) => el.className.split(/\s+/);
    // jsdom lays nothing out: the classes are what keeps the slug, label and
    // context fields, the logos and the buttons inside the dialog's width.
    assert.ok(classes(dialog.querySelector('form')!).includes('min-w-0'), 'the form does not set the dialog column to its min-content width');
    const brands = dialog.querySelector<HTMLElement>('[data-picto-brands]')!;
    assert.ok(classes(brands).includes('flex-wrap'), 'the logos wrap');
    assert.ok(!classes(brands).some((name) => name.startsWith('overflow-x')), 'the logos never scroll sideways');
  } finally {
    await ui.unmount();
  }
});

test('what the daemon warns about the backend\'s file heads its settings', async () => {
  const warning = 'API_KEY holds a credential in clear text — store it in the vault and reference it with { "secret": "NAME" }';
  const ui = await mount({ ...BACKEND, warnings: [warning] });
  try {
    const shown = Array.from(ui.section('settings')!.querySelectorAll('[data-backend-warning]')).map((node) => node.textContent);
    assert.deepEqual(shown, [warning]);
  } finally {
    await ui.unmount();
  }
});

test('a model\'s thinking shows what was detected, and a budget picked by hand is what Save sends', async () => {
  const backend: CustomBackend = {
    ...BACKEND,
    models: [
      { slug: 'deepseek-chat', label: 'Chat', detectedReasoning: { source: 'catalog', thinks: true, controls: [{ type: 'budget' }], catalogEntry: 'deepseek/deepseek-chat' } },
      ...BACKEND.models.slice(1),
    ] as CustomBackend['models'],
  };
  const ui = await mount(backend, [{ protocol: 'anthropic', dialect: 'claude', installed: true, thinkingControls: ['levels', 'budget', 'toggle'] }]);
  try {
    await ui.editList();
    const models = ui.section('models')!;
    const brains = Array.from(models.querySelectorAll<HTMLButtonElement>('button[aria-label="Thinking setting of this model"]'));
    assert.equal(brains.length, 3, 'one thinking button per model');
    await ui.click(brains[0]!);
    await ui.until(() => /Detected:/.test(models.textContent ?? ''), 'the thinking setting to open');
    assert.match(models.textContent ?? '', /Detected: token budget \(built-in models\.dev catalogue: deepseek\/deepseek-chat\)/);
    assert.match(models.textContent ?? '', /Thinking bar in the selectors: low \/ medium \/ high budget steps/);

    await ui.click(byText<HTMLButtonElement>('button[role="radio"]', 'Token budget', models));
    await ui.until(() => !!models.querySelector('input[aria-label="Maximum budget (tokens)"]'), 'the budget field to show');
    const max = models.querySelector<HTMLInputElement>('input[aria-label="Maximum budget (tokens)"]');
    if (!max) assert.fail('no budget field');
    await ui.type(max, '16000');
    await ui.click(byText<HTMLButtonElement>('button', 'Save', models));
    await ui.until(() => !!ui.patched(), 'Save to send the models');
    const patch = ui.patched();
    if (!patch) assert.fail('Save sent nothing');
    const sentModels = (patch.body as { models: { slug: string; reasoningControl?: unknown; supportedReasoningLevels?: unknown }[] }).models;
    assert.deepEqual(sentModels[0]!.reasoningControl, { type: 'budget', max: 16000 });
    assert.equal(sentModels[0]!.supportedReasoningLevels, null);
    assert.equal(sentModels[1]!.reasoningControl, null);
  } finally {
    await ui.unmount();
  }
});

test('without a dialect that sends a budget, only levels, as detected and "does not think" are offered', async () => {
  const ui = await mount();
  try {
    await ui.editList();
    const models = ui.section('models')!;
    await ui.click(models.querySelector<HTMLButtonElement>('button[aria-label="Thinking setting of this model"]')!);
    await ui.until(() => /Detected:/.test(models.textContent ?? ''), 'the thinking setting to open');
    const choices = Array.from(models.querySelectorAll<HTMLButtonElement>('[aria-label="How this model\'s thinking is set"] button')).map((button) => button.textContent);
    assert.deepEqual(choices, ['As detected', 'Levels', 'Does not think']);
    assert.match(models.textContent ?? '', /Detected: nothing known for this model/);
    await ui.click(byText<HTMLButtonElement>('button', 'Add a model', models));
    const thinking = () => models.querySelectorAll<HTMLButtonElement>('button[aria-label="Thinking setting of this model"]');
    await ui.until(() => thinking().length === 4, 'the new model row');
    await ui.click(thinking()[0]!);
    await ui.until(() => /shown once the provider is saved/.test(models.textContent ?? ''), 'the new model\'s thinking setting to open');
    assert.match(models.textContent ?? '', /Detected: shown once the provider is saved\./, 'a model added in this edit has not been detected yet');
  } finally {
    await ui.unmount();
  }
});
