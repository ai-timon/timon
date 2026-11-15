import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from '@/lib/test-wait';
import type { ProviderOverview } from '@/lib/provider-overview';
import type { CustomBackend } from './form';

/**
 * The Models and own-settings sections of a provider page, mounted on the real
 * page with the common sections of `@timon/backends` and the client half of the
 * Claude provider: the count of models the selector offers, the search, a save
 * that sends the models alone; for a provider added by hand only, its name and
 * its connection behind Edit, saved apart, its Test reusing the stored key; and
 * the long-lived Claude token on the Claude page only. The daemon's refusal of
 * anyone but a superadmin is covered by the routes' own tests.
 */
function overview(id: string, name: string, backend: string, over: Partial<ProviderOverview> = {}): ProviderOverview {
  return {
    id, name, brand: null, icon: null, origin: 'plugin', pluginId: id, plugin: null, catalogAgent: null, enabled: true, isDefault: false,
    backends: [{ id: backend, label: name, active: true, disabled: false, reason: null, modelCount: 1, defaultModel: null, isDefault: false, remote: false }],
    modelCount: 1, agentCount: 0,
    connection: { signedIn: null, signInCommand: null, signInThen: null, acceptsAccounts: false, accounts: [] },
    secret: { required: false, present: false, names: [] }, programs: [], status: 'available', updateAvailable: false, ...over,
  };
}

function backend(id: string, over: Partial<CustomBackend>): CustomBackend {
  return {
    id, file: null, origin: 'plugin', label: id, dialect: null, protocol: null, baseUrl: null, models: [], defaultModel: null,
    icon: null, brand: null, hasVaultKey: false, active: true, reason: null, warnings: [], ...over,
  };
}

const claude = backend('claude', {
  label: 'Claude', brand: 'claude', defaultModel: 'opus',
  models: [{ slug: 'opus', label: 'Opus' }, { slug: 'haiku', label: 'Haiku', hidden: true }, { slug: 'sonnet', label: 'Sonnet' }],
});
const deepseek = backend('deepseek', {
  origin: 'file', file: 'deepseek.json', label: 'DeepSeek', dialect: 'anthropic', protocol: 'anthropic',
  baseUrl: 'https://api.deepseek.com/anthropic', hasVaultKey: true, models: [{ slug: 'chat', label: 'Chat' }], defaultModel: 'chat',
});

test('a provider page edits its models and its own settings, each saved apart', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'Element', 'Node', 'DocumentFragment',
    'MutationObserver', 'NodeFilter', 'SVGElement', 'Event', 'CustomEvent', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'InputEvent',
    'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);

  const sent: { method: string; url: string; body: Record<string, unknown> }[] = [];
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      sent.push({ method, url, body: init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {} });
      if (url.endsWith('/test')) return Response.json({ outcome: 'ok', status: 200, models: [] });
      return Response.json({});
    }
    if (url === '/api/ui/providers/overview') {
      return Response.json({
        providers: [overview('provider-claude', 'Claude', 'claude'), overview('user:deepseek', 'DeepSeek', 'deepseek', { origin: 'user', pluginId: null })],
        defaultBackend: 'claude',
      });
    }
    if (url === '/api/ui/backends/manage') return Response.json({ backends: [claude, deepseek], protocols: [] });
    if (url === '/api/ui/backends/claude-token') return Response.json({ configured: false, readable: false, serviceOutsideSession: false });
    return new Response(null, { status: 404 });
  });

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
  const { providerClaudeClient } = await import('@/plugins-client/provider-claude');
  for (const plugin of [coreBackendsClient, providerClaudeClient]) {
    plugin.apply({
      id: plugin.module,
      realtime: { subscribe: () => () => {} } as never,
      caps: null,
      zoneVisible: () => true,
      options: {},
      register: (options, Component) => (options.slot === 'settings.provider.section'
        ? slots.register({ ...options, pluginId: plugin.module }, Component)
        : () => {}),
      onDispose: () => {},
    });
  }
  const { ProviderPage } = await import('@/components/provider-page/provider-page');

  const root = createRoot(document.getElementById('root')!);
  const show = (requested: string) => React.act(async () => {
    root.render(React.createElement(ProviderPage, { requested, onBack: () => {} }));
  });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const section = (key: string) => document.querySelector(`[data-provider-section="${key}"]`);
  const buttonIn = (scope: Element | null, label: string) => Array.from(scope?.querySelectorAll('button') ?? [])
    .find((b) => b.textContent === label || b.getAttribute('aria-label') === label) as HTMLButtonElement | undefined;
  const click = (el: Element) => React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
  const type = (el: HTMLInputElement, value: string) => React.act(async () => {
    Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
  });
  const count = () => section('models')?.querySelector('[data-models-count]')?.textContent;
  const rows = () => Array.from(section('models')?.querySelectorAll('[data-model-row]') ?? [])
    .map((row) => row.getAttribute('data-model-row'));

  try {
    await show('provider-claude');
    await until(() => count() !== undefined, 'the Models section');
    assert.equal(count(), '2 of 3 models appear in the selector');
    assert.deepEqual(rows(), ['opus', 'haiku', 'sonnet']);

    await type(section('models')!.querySelector('input[type="search"]') as HTMLInputElement, 'hai');
    assert.deepEqual(rows(), ['haiku']);
    assert.equal(section('models')!.querySelectorAll('input:not([type="search"])').length, 0, 'the list reads, it is not a grid of fields');
    assert.equal(buttonIn(section('models'), 'Save'), undefined, 'a switch saves by itself');
    await click(buttonIn(section('models'), 'Hidden from model selectors. Click to show it')!);
    assert.equal(count(), '3 of 3 models appear in the selector');
    await until(() => sent.length === 1, 'the switch to save the models');
    assert.equal(sent[0]!.url, '/api/ui/backends/manage/claude');
    assert.deepEqual(Object.keys(sent[0]!.body).sort(), ['defaultModel', 'models'], 'a models save never resends the name');
    assert.equal((sent[0]!.body.models as { hidden?: boolean }[])[1]!.hidden, false);

    // An official provider has no name, picture or connection to change: no own-settings section.
    assert.equal(section('settings')?.textContent ?? '', '', 'nothing to customize on an official provider');
    // The Claude provider's own section: the long-lived token, one row, right after the common settings.
    await until(() => document.querySelector('[data-provider-section="provider-claude"] [data-claude-token]') !== null, 'the Claude token section');
    assert.ok(!document.querySelector('[data-provider-section="provider-claude"] input'), 'the token field waits for Set');
    const order = Array.from(document.querySelectorAll('[data-provider-section]')).map((el) => el.getAttribute('data-provider-section'));
    assert.deepEqual(order.slice(-2), ['settings', 'provider-claude']);
    assert.ok(order.indexOf('models') < order.indexOf('program'), 'Models comes before Program');

    // A provider added by hand: its connection under Advanced, saved without its models.
    await show('user:deepseek');
    await until(() => buttonIn(section('settings'), 'Edit') !== undefined, 'the Edit button');
    assert.ok(!document.querySelector('[data-provider-section="provider-claude"]'), 'the Claude token lands on the Claude page only');
    assert.match(section('settings')!.textContent ?? '', /Reaches api\.deepseek\.com/);
    assert.ok(!section('settings')!.querySelector('input'), 'no field on the page');
    await click(buttonIn(section('settings'), 'Edit')!);
    const dialog = () => document.querySelector('[data-provider-settings-dialog]');
    await until(() => buttonIn(dialog(), 'Advanced') !== undefined, 'the settings dialog and its Advanced fold');
    assert.ok(!document.querySelector('input[type="url"]'), 'folded by default');
    await click(buttonIn(dialog(), 'Advanced')!);
    assert.equal((document.querySelector('input[type="url"]') as HTMLInputElement).value, 'https://api.deepseek.com/anthropic');

    await click(buttonIn(dialog(), 'Test')!);
    await until(() => sent.length === 2, 'the test');
    assert.deepEqual(sent[1], { method: 'POST', url: '/api/ui/backends/custom/test', body: { id: 'deepseek' } }, 'unchanged: the stored key is tested');

    await type(dialog()!.querySelector('input[type="password"]') as HTMLInputElement, 'sk-new');
    await click(buttonIn(dialog(), 'Save')!);
    await until(() => sent.length === 3, 'the settings save');
    assert.equal(sent[2]!.url, '/api/ui/backends/manage/deepseek');
    assert.equal(sent[2]!.body.key, 'sk-new');
    assert.equal(sent[2]!.body.baseUrl, 'https://api.deepseek.com/anthropic');
    for (const field of ['models', 'defaultModel']) assert.equal(field in sent[2]!.body, false, `${field} is the Models section's`);
  } finally {
    await React.act(async () => { root.unmount(); });
    await React.act(async () => { await new Promise((resolve) => setTimeout(resolve, 30)); });
    slots.resetSlotsForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete (globalThis as Record<string, unknown>)[key];
    }
  }
});

test('a hidden default hands its place to the first model still offered; Hide all keeps it for when one comes back', async () => {
  const { withVisibility, withAllVisibility } = await import('./provider-models-section');
  const list = { models: [{ slug: 'opus', label: 'Opus' }, { slug: 'haiku', label: 'Haiku' }], defaultModel: 'opus' };
  assert.deepEqual(withVisibility(list, 'opus', true), { models: [{ slug: 'opus', label: 'Opus', hidden: true }, { slug: 'haiku', label: 'Haiku' }], defaultModel: 'haiku' });
  assert.equal(withVisibility(list, 'haiku', true).defaultModel, 'opus');
  assert.deepEqual(withAllVisibility(list, true).models.map((model) => model.hidden), [true, true]);
  assert.equal(withAllVisibility(list, true).defaultModel, 'opus');
  assert.equal(withAllVisibility({ ...list, defaultModel: null }, false).defaultModel, 'opus');
});
