/**
 * The page of one provider and its slot `settings.provider.section`: which
 * sections a provider shows and in what order, how `provider=<id>` resolves
 * (the refused-launch card names a plugin), and the page itself — header,
 * breadcrumb, the common sections of `@timon/backends`, and a provider
 * plugin's own section reading `useProviderPage()` on its provider's page only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ComponentType } from 'react';
import { waitUntil } from '../../lib/test-wait';
import type { SlotEntry } from '@/lib/plugin-host/slots';
import type { ProviderOverview, ProvidersOverview } from '@/lib/provider-overview';

const Nothing: ComponentType = () => null;
let seq = 0;
function entry(pluginId: string, over: Partial<SlotEntry> = {}): SlotEntry {
  seq += 1;
  return { id: `${pluginId}:${seq}`, pluginId, order: Number.POSITIVE_INFINITY, seq, Component: Nothing, ...over };
}

function provider(id: string, over: Partial<ProviderOverview> = {}): ProviderOverview {
  return {
    id, name: id, brand: null, icon: null, origin: 'plugin', pluginId: id, plugin: null, catalogAgent: null, enabled: true, isDefault: false,
    backends: [{ id, label: id, active: true, disabled: false, reason: null, modelCount: 1, defaultModel: null, isDefault: false, remote: false }],
    modelCount: 1, agentCount: 0,
    connection: { signedIn: null, signInCommand: null, signInThen: null, acceptsAccounts: false, accounts: [] },
    secret: { required: false, present: false, names: [] }, programs: [], status: 'available', updateAvailable: false, ...over,
  };
}

test('the common sections keep their order; a plugin section lands on its own provider only', async () => {
  const { sectionsFor, PROVIDER_SECTION_KEYS, PROVIDER_SECTION_ORDER } = await import('./provider-sections');
  const acme = entry('acme-provider', { order: 350 });
  const other = entry('other-plugin');
  const common = PROVIDER_SECTION_KEYS.map((key) => entry('@timon/backends', { key, order: PROVIDER_SECTION_ORDER[key], fallback: true }));
  // The registry's own order puts defaults last; the page must not.
  const registry = [acme, other, ...common];

  assert.deepEqual(sectionsFor(registry, 'acme-provider').map((e) => e.key ?? e.pluginId),
    ['connection', 'apiKey', 'models', 'program', 'acme-provider', 'settings']);
  assert.deepEqual(sectionsFor(registry, 'claude-like').map((e) => e.key), [...PROVIDER_SECTION_KEYS]);
  assert.deepEqual(sectionsFor(registry, null).map((e) => e.key), [...PROVIDER_SECTION_KEYS], 'a hand-added backend has no plugin');
  // Models sits right under how the provider is reached, before the rest.
  assert.deepEqual([...PROVIDER_SECTION_KEYS], ['connection', 'apiKey', 'models', 'program', 'settings']);
  assert.deepEqual(PROVIDER_SECTION_KEYS.map((key) => PROVIDER_SECTION_ORDER[key]), [100, 200, 250, 300, 400]);
});

test('a provider plugin takes the place of a common section by its key, on its page only', async () => {
  const { sectionsFor, PROVIDER_SECTION_ORDER } = await import('./provider-sections');
  const settings = entry('@timon/backends', { key: 'settings', order: PROVIDER_SECTION_ORDER.settings, fallback: true });
  const models = entry('@timon/backends', { key: 'models', order: PROVIDER_SECTION_ORDER.models, fallback: true });
  const own = entry('acme-provider', { key: 'settings', order: PROVIDER_SECTION_ORDER.settings });
  assert.deepEqual(sectionsFor([own, settings, models], 'acme-provider').map((e) => e.pluginId), ['@timon/backends', 'acme-provider']);
  assert.deepEqual(sectionsFor([own, settings, models], 'beta').map((e) => e.id), [models.id, settings.id]);
});

test('a third-party entry that calls itself a default is still not a common section', async () => {
  const { sectionsFor } = await import('./provider-sections');
  const intruder = entry('acme-provider', { fallback: true, key: 'connection', order: 1 });
  assert.deepEqual(sectionsFor([intruder], 'beta'), [], 'never painted on another provider\'s page');
  assert.deepEqual(sectionsFor([intruder], 'acme-provider').map((e) => e.id), [intruder.id]);
});

test('provider=<id> resolves a provider id, then a plugin id, then a backend id', async () => {
  const { resolveProviderId, statusTone } = await import('@/lib/provider-overview');
  const opencode = provider('provider-acp.opencode', { pluginId: 'provider-acp', backends: [{ ...provider('x').backends[0]!, id: 'opencode' }] });
  const hermes = provider('provider-acp.hermes', { pluginId: 'provider-acp', backends: [{ ...provider('x').backends[0]!, id: 'hermes' }] });
  const mine = provider('user:my-endpoint', { pluginId: null, backends: [{ ...provider('x').backends[0]!, id: 'my-endpoint' }] });
  const list = [opencode, hermes, mine];
  assert.equal(resolveProviderId(list, 'provider-acp.hermes'), hermes);
  assert.equal(resolveProviderId(list, 'provider-acp'), opencode, 'a refused-launch card names the plugin');
  assert.equal(resolveProviderId(list, 'my-endpoint'), mine);
  assert.equal(resolveProviderId(list, 'nobody'), null);
  assert.equal(resolveProviderId(list, null), null);
  assert.deepEqual(['connected', 'not-installed', 'blocked', 'disabled'].map((s) => statusTone(s as never)), ['ready', 'action', 'blocked', 'off']);
});

async function mount(overview: () => ProvidersOverview | Response) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'Element', 'Node',
    'MutationObserver', 'CustomEvent', 'Event', 'MouseEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const requests: string[] = [];
  install('fetch', async (input: string) => {
    requests.push(String(input));
    if (String(input) === '/api/ui/providers/overview') {
      const body = overview();
      return body instanceof Response ? body : Response.json(body);
    }
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
  // Declared at boot by the product layout (`UI_LAYOUT_CHILD_SLOTS`).
  slots.declareSlot('settings.provider.section', 'list');
  const page = await import('./provider-page');
  const context = await import('./provider-page-context');

  // The common sections, registered the way the bundled half of `@timon/backends` mounts them.
  const { coreBackendsClient } = await import('@/plugins-client/backends');
  coreBackendsClient.apply({
    id: '@timon/backends',
    realtime: { subscribe: () => () => {} } as never,
    caps: null,
    zoneVisible: () => true,
    options: {},
    register: (options, Component) => (options.slot === 'settings.provider.section'
      ? slots.register({ ...options, pluginId: '@timon/backends' }, Component)
      : () => {}),
    onDispose: () => {},
  });

  const root = createRoot(document.getElementById('root')!);
  const render = async (element: React.ReactElement) => {
    await React.act(async () => { root.render(element); });
  };
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    slots.resetSlotsForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, slots, page, context, render, until, unmount, requests };
}

test('the page paints its header and a provider plugin\'s section with the provider on screen', async () => {
  const acme = provider('acme-provider', { name: 'Acme AI', status: 'needs-authorization', agentCount: 2, isDefault: true });
  const beta = provider('beta-provider', { name: 'Beta', status: 'connected' });
  const m = await mount(() => ({ providers: [acme, beta], defaultBackend: 'acme-provider' }));
  try {
    const { React, slots, page, context } = m;
    const seen: Array<string | null> = [];
    const refreshes: Array<() => Promise<void>> = [];
    slots.register({ slot: 'settings.provider.section', pluginId: 'acme-provider' }, function AcmeSection() {
      const host = context.useProviderPage();
      seen.push(host?.provider.id ?? null);
      if (host) refreshes.push(host.refresh);
      return React.createElement('p', { 'data-acme-section': host?.provider.id }, host?.provider.name);
    });
    let backs = 0;
    await m.render(React.createElement(page.ProviderPage, { requested: 'acme-provider', onBack: () => { backs += 1; } }));
    await m.until(() => document.querySelector('[data-acme-section]') !== null, 'the plugin section');

    assert.equal(document.querySelector('h3')?.textContent, 'Acme AI');
    assert.equal(document.querySelector('[data-provider-status]')?.getAttribute('data-provider-status'), 'needs-authorization');
    assert.match(document.body.textContent ?? '', /Waiting for your authorization/);
    assert.match(document.body.textContent ?? '', /2 agents use it/);
    assert.match(document.body.textContent ?? '', /Default provider/);
    assert.equal(document.querySelector('[data-acme-section]')?.textContent, 'Acme AI');
    assert.ok(seen.every((id) => id === 'acme-provider'));
    // The common sections are there, in order, and paint nothing yet.
    const order = Array.from(document.querySelectorAll('[data-provider-section]')).map((el) => el.getAttribute('data-provider-section'));
    assert.deepEqual(order, ['connection', 'apiKey', 'models', 'program', 'settings', 'acme-provider']);

    const crumb = document.querySelector('nav button');
    assert.equal(crumb?.textContent, 'Providers');
    assert.equal(document.querySelector('nav [aria-current="page"]')?.textContent, 'Acme AI');
    await m.React.act(async () => { (crumb as HTMLElement).click(); });
    assert.equal(backs, 1);

    const before = m.requests.length;
    await m.React.act(async () => { await refreshes.at(-1)!(); });
    assert.equal(m.requests.length, before + 1, 'refresh() reads the overview again');

    await m.render(React.createElement(page.ProviderPage, { requested: 'beta-provider', onBack: () => {} }));
    await m.until(() => document.querySelector('h3')?.textContent === 'Beta', 'the other provider');
    assert.ok(!document.querySelector('[data-acme-section]'), 'a plugin section never lands on another provider\'s page');
  } finally {
    await m.unmount();
  }
});

test('a plugin id from a refused-launch card lands on its provider and the address is rewritten', async () => {
  const opencode = provider('provider-acp.opencode', { name: 'OpenCode', pluginId: 'provider-acp' });
  const m = await mount(() => ({ providers: [opencode], defaultBackend: null }));
  try {
    const canonical: string[] = [];
    await m.render(m.React.createElement(m.page.ProviderPage, { requested: 'provider-acp', onBack: () => {}, onCanonical: (id: string) => { canonical.push(id); } }));
    await m.until(() => document.querySelector('h3')?.textContent === 'OpenCode', 'the provider page');
    assert.deepEqual(canonical, ['provider-acp.opencode']);
  } finally {
    await m.unmount();
  }
});

test('an unknown provider says so; a refused read says why, never in the daemon\'s words', async () => {
  const m = await mount(() => ({ providers: [], defaultBackend: null }));
  try {
    await m.render(m.React.createElement(m.page.ProviderPage, { requested: 'gone', onBack: () => {} }));
    await m.until(() => /no longer on this computer/.test(document.body.textContent ?? ''), 'the not-found line');
    assert.ok(!document.querySelector('[data-provider-section]'));
  } finally {
    await m.unmount();
  }
  const denied = await mount(() => Response.json({ error: 'forbidden' }, { status: 403 }));
  try {
    await denied.render(denied.React.createElement(denied.page.ProviderPage, { requested: 'acme', onBack: () => {} }));
    await denied.until(() => document.querySelector('[role="alert"]') !== null, 'the refusal');
    assert.equal(document.querySelector('[role="alert"]')?.textContent, 'Only an administrator can see the providers.');
  } finally {
    await denied.unmount();
  }
});

test('a blocked provider says why under its header; another status keeps its reasons to itself', async () => {
  const broken = provider('user:broken', {
    name: 'broken', origin: 'user', pluginId: null, status: 'blocked',
    backends: [{ id: 'broken', label: 'broken', active: false, disabled: false, reason: 'not valid JSON', modelCount: 0, defaultModel: null, isDefault: false, remote: false }],
  });
  const missing = provider('user:missing', {
    name: 'missing', origin: 'user', pluginId: null, status: 'not-connected',
    backends: [{ id: 'missing', label: 'missing', active: false, disabled: false, reason: 'missing credential', modelCount: 0, defaultModel: null, isDefault: false, remote: true }],
  });
  const m = await mount(() => ({ providers: [broken, missing], defaultBackend: null }));
  try {
    const reasons = () => Array.from(document.querySelectorAll('[data-provider-reason]')).map((node) => node.textContent);
    await m.render(m.React.createElement(m.page.ProviderPage, { requested: 'user:broken', onBack: () => {} }));
    await m.until(() => document.querySelector('h3')?.textContent === 'broken', 'the blocked provider');
    assert.deepEqual(reasons(), ['not valid JSON']);
    await m.render(m.React.createElement(m.page.ProviderPage, { requested: 'user:missing', onBack: () => {} }));
    await m.until(() => document.querySelector('h3')?.textContent === 'missing', 'the other provider');
    assert.deepEqual(reasons(), [], 'its own sections say what is missing');
  } finally {
    await m.unmount();
  }
});
