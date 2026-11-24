/**
 * The providers list of Settings › AI models: the groups and the search, the
 * default selector, the one "Check" that replaces four buttons (and keeps
 * going when one source fails), and the picker's order in "Reorder".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';
import type { ProviderOverview, ProvidersOverview } from '@/lib/provider-overview';

function provider(id: string, over: Partial<ProviderOverview> = {}): ProviderOverview {
  return {
    id, name: id, brand: null, icon: null, origin: 'plugin', pluginId: id, plugin: null, catalogAgent: null, enabled: true, isDefault: false,
    backends: [{ id, label: id, active: true, disabled: false, reason: null, modelCount: 1, defaultModel: null, isDefault: false, remote: false }],
    modelCount: 1, agentCount: 0,
    connection: { signedIn: null, signInCommand: null, signInThen: null, acceptsAccounts: false, accounts: [] },
    secret: { required: false, present: false, names: [] }, programs: [], status: 'available', updateAvailable: false, ...over,
  };
}

test('Connected holds what can run now; the search folds case and accents and reads the backends too', async () => {
  const { groupProviders } = await import('@/lib/provider-list');
  const list = [
    provider('claude', { name: 'Claude', status: 'connected' }),
    provider('codex', { name: 'Codex', status: 'not-connected' }),
    provider('user:local', { name: 'Modèle local', status: 'available', backends: [{ ...provider('x').backends[0]!, id: 'ollama', label: 'Ollama' }] }), // french-ok: a model name a French user gave
    provider('acme', { name: 'Acme', status: 'blocked' }),
    provider('off', { name: 'Off', status: 'disabled' }),
    provider('wait', { name: 'Wait', status: 'needs-authorization' }),
  ];
  const all = groupProviders(list);
  assert.deepEqual(all.connected.map((p) => p.id), ['claude', 'user:local']);
  assert.deepEqual(all.others.map((p) => p.id), ['codex', 'acme', 'off', 'wait'], 'the daemon\'s order is kept');
  assert.deepEqual(groupProviders(list, '  MODELE ').connected.map((p) => p.id), ['user:local']);
  assert.deepEqual(groupProviders(list, 'ollama').connected.map((p) => p.id), ['user:local']);
  assert.deepEqual(groupProviders(list, 'nothing'), { connected: [], others: [] });
});

test('the default selector offers each backend of a switched-on provider, under the provider\'s name', async () => {
  const { defaultChoices } = await import('@/lib/provider-list');
  const base = provider('x').backends[0]!;
  const choices = defaultChoices([
    provider('claude', { name: 'Claude' }),
    provider('off', { enabled: false }),
    provider('pair', { name: 'Pair', backends: [{ ...base, id: 'a', label: 'Alpha' }, { ...base, id: 'b', label: 'Beta', disabled: true }, { ...base, id: 'c', label: 'Gamma' }] }),
  ]);
  assert.deepEqual(choices.map((c) => `${c.backend}=${c.label}`), ['claude=Claude', 'a=Alpha', 'c=Gamma']);
});

test('Check runs every step, and one that fails never stops the others', async () => {
  const { verifyProviders } = await import('@/lib/provider-list');
  const ran: string[] = [];
  const out = await verifyProviders([
    async () => { ran.push('clis'); },
    async () => { ran.push('binaries'); throw new Error('offline'); },
    async () => { ran.push('catalogue'); },
  ]);
  assert.deepEqual(ran, ['clis', 'binaries', 'catalogue']);
  assert.deepEqual(out, { failed: ['offline'] });
});

type Server = {
  overview: ProvidersOverview;
  preferred: { value: string; source: 'db' | 'default' | 'env' | 'config' };
  manage: Array<{ id: string; label: string; origin: string; dialect: string | null; disabled: boolean; icon: null; brand: null }>;
  calls: string[];
  fail: Set<string>;
};

async function mount(server: Server) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/?settings=models/backends', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'Element', 'Node',
    'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent', 'FocusEvent', 'PointerEvent', 'DocumentFragment'] as const) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  install('fetch', async (input: string, init?: { method?: string; body?: string }) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    server.calls.push(`${method} ${url}`);
    if (server.fail.has(url)) return Response.json({ error: 'nope' }, { status: 502 });
    if (url === '/api/ui/providers/overview') return Response.json(server.overview);
    if (url === '/api/ui/settings' && method === 'GET') {
      return Response.json({ settings: [{ key: 'TIMON_PREFERRED_BACKEND', type: 'string', value: server.preferred.value, source: server.preferred.source }] });
    }
    if (url === '/api/ui/settings' && method === 'PUT') {
      const body = JSON.parse(init?.body ?? '{}') as { value: string | null };
      server.preferred = { value: body.value ?? '', source: body.value ? 'db' : 'default' };
      return Response.json({ ok: true });
    }
    if (url === '/api/ui/backends/manage' && method === 'GET') return Response.json({ backends: server.manage });
    if (url.startsWith('/api/ui/backends/manage/') && method === 'PATCH') return Response.json({ ok: true });
    if (url === '/api/ui/backends/provider-clis/check') return Response.json({ backends: [], jobs: {}, updateCheck: true });
    if (url === '/api/ui/backends/binaries/recheck') return Response.json({ binaries: [], configError: null });
    if (url.startsWith('/api/ui/providers/acp-registry')) return Response.json({ registryVersion: '1', dropped: 0, stale: false, agents: [] });
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
  const list = await import('./providers-list');

  const root = createRoot(document.getElementById('root')!);
  const render = async (element: React.ReactElement) => {
    await React.act(async () => { root.render(element); });
  };
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (element: Element | null | undefined) => {
    assert.ok(element, 'element to click');
    await React.act(async () => { (element as HTMLElement).click(); });
  };
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
  return { React, list, render, until, click, unmount };
}

function server(over: Partial<Server> = {}): Server {
  return {
    overview: {
      providers: [
        provider('claude', { name: 'Claude', status: 'connected', isDefault: true, updateAvailable: true }),
        provider('codex', { name: 'Codex', status: 'not-installed' }),
        provider('user:local', { name: 'Local', status: 'available' }),
      ],
      defaultBackend: 'claude',
    },
    preferred: { value: '', source: 'default' },
    manage: [
      { id: 'claude', label: 'Claude', origin: 'plugin', dialect: 'claude', disabled: false, icon: null, brand: null },
      { id: 'codex', label: 'Codex', origin: 'plugin', dialect: 'codex', disabled: false, icon: null, brand: null },
    ],
    calls: [],
    fail: new Set(),
    ...over,
  };
}

const rowIds = (group: string) => Array.from(document.querySelectorAll(`[data-provider-group="${group}"] [data-provider-row]`))
  .map((row) => row.getAttribute('data-provider-row'));

test('the list paints the default provider, both groups and the rows; the search narrows them', async () => {
  const s = server();
  const m = await mount(s);
  try {
    await m.render(m.React.createElement(m.list.ProvidersList, { onOpen: () => {} }));
    await m.until(() => document.querySelector('[data-provider-row]') !== null, 'the rows');
    assert.deepEqual(rowIds('connected'), ['claude', 'user:local']);
    assert.deepEqual(rowIds('others'), ['codex']);
    assert.match(document.querySelector('[data-provider-group="connected"] h4')?.textContent ?? '', /Connected\s*2/);
    assert.match(document.querySelector('[data-provider-group="others"] h4')?.textContent ?? '', /Other providers\s*1/);
    assert.match(document.querySelector('[data-provider-row="codex"]')?.textContent ?? '', /Not downloaded/);
    assert.ok(document.querySelector('[data-provider-row="claude"] [data-provider-update]'), 'the update chip');
    assert.ok(!document.querySelector('[data-provider-row="codex"] [data-provider-update]'));
    await m.until(() => /Automatic \(Claude\)/.test(document.querySelector('[data-default-provider]')?.textContent ?? ''), 'the resolved default');

    const search = document.querySelector('input[type="search"]') as HTMLInputElement;
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')!.set!;
    await m.React.act(async () => {
      setValue.call(search, 'cod');
      search.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    assert.deepEqual(rowIds('connected'), []);
    assert.deepEqual(rowIds('others'), ['codex']);
    assert.ok(!document.querySelector('[data-provider-group="connected"]'), 'an empty group is not shown');
    await m.React.act(async () => {
      setValue.call(search, 'zzz');
      search.dispatchEvent(new window.Event('input', { bubbles: true }));
    });
    assert.match(document.body.textContent ?? '', /No provider matches “zzz”/);
  } finally {
    await m.unmount();
  }
});

test('one Check asks every source again, then reads the list again', async () => {
  const s = server();
  s.fail.add('/api/ui/backends/binaries/recheck');
  const m = await mount(s);
  try {
    await m.render(m.React.createElement(m.list.ProvidersList, { onOpen: () => {} }));
    await m.until(() => document.querySelector('[data-provider-row]') !== null, 'the rows');
    const reads = () => s.calls.filter((call) => call === 'GET /api/ui/providers/overview').length;
    const before = reads();
    const check = Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Check');
    await m.click(check);
    await m.until(() => reads() === before + 1, 'the check to end');
    assert.ok(s.calls.includes('POST /api/ui/backends/provider-clis/check'));
    assert.ok(s.calls.includes('POST /api/ui/backends/binaries/recheck'));
    assert.ok(s.calls.includes('GET /api/ui/providers/acp-registry?refresh=1'));
    assert.equal(reads(), before + 1, 'the overview is read again');
  } finally {
    await m.unmount();
  }
});

test('Reorder shows the picker\'s order flat; Done brings the groups back', async () => {
  const s = server();
  const m = await mount(s);
  try {
    await m.render(m.React.createElement(m.list.ProvidersList, { onOpen: () => {} }));
    await m.until(() => document.querySelector('[data-provider-row]') !== null, 'the rows');
    await m.click(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Reorder'));
    await m.until(() => document.querySelector('[data-reorder-row]') !== null, 'the reorder rows');
    assert.deepEqual(Array.from(document.querySelectorAll('[data-reorder-row]')).map((row) => row.getAttribute('data-reorder-row')), ['claude', 'codex']);
    assert.ok(!document.querySelector('[data-provider-group]'));
    assert.ok(!document.querySelector('input[type="search"]'));
    await m.click(Array.from(document.querySelectorAll('button')).find((b) => b.textContent === 'Done'));
    assert.deepEqual(rowIds('connected'), ['claude', 'user:local']);
  } finally {
    await m.unmount();
  }
});

test('a default set in the config file is shown and cannot be changed here', async () => {
  const s = server({ preferred: { value: 'codex', source: 'config' } });
  const m = await mount(s);
  try {
    await m.render(m.React.createElement(m.list.ProvidersList, { onOpen: () => {} }));
    await m.until(() => /config/i.test(document.querySelector('[data-default-provider] p')?.textContent ?? ''), 'the lock');
    const trigger = document.querySelector('[data-default-provider] button[role="combobox"]');
    assert.ok(trigger?.hasAttribute('disabled') || trigger?.getAttribute('data-disabled') !== null);
    assert.match(trigger?.textContent ?? '', /Codex/);
  } finally {
    await m.unmount();
  }
});
