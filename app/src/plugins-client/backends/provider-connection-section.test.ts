import assert from 'node:assert/strict';
import test from 'node:test';
import { waitUntil } from '@/lib/test-wait';
import type { ProviderOverview } from '@/lib/provider-overview';

/**
 * The Connection section of a provider page: mounts the real `ProvidersSettings` and checks that
 * it says whether this computer is signed in, signs it in with the provider cards' gesture, and
 * carries the subscription accounts of THIS provider only, with the former tab's gestures (here:
 * adding one, which opens its sign-in and reads the provider again). A provider with nothing to
 * connect paints no section. The daemon's refusal of anyone but a superadmin is covered by
 * `provider-overview-routes.test.ts` and `account-routes.test.ts`.
 */
function overviewOf(id: string, name: string, connection: Partial<ProviderOverview['connection']>): ProviderOverview {
  return {
    id, name, brand: null, icon: null, origin: 'built-in', pluginId: null, plugin: null, catalogAgent: null, enabled: true, isDefault: false,
    backends: [{ id, label: name, active: true, disabled: false, reason: null, modelCount: 1, defaultModel: null, isDefault: false, remote: false }],
    modelCount: 1, agentCount: 0,
    connection: { signedIn: null, signInCommand: null, signInThen: null, acceptsAccounts: false, accounts: [], ...connection },
    secret: { required: false, present: false, names: [] },
    programs: [],
    status: 'available', updateAvailable: false,
  };
}

function account(id: string, backend: string, name: string) {
  return { id, instance: `${backend}@${id}`, backend, name, ownerUserId: 'owner', mine: true, state: 'active', connected: false, identity: null, grantedTo: [] };
}

test('the Connection section signs this computer in and manages the accounts of this provider only', async () => {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/?settings=models%2Fbackends&provider=claude', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLFormElement', 'Element', 'Node', 'DocumentFragment', 'MutationObserver', 'NodeFilter', 'HTMLInputElement', 'HTMLSelectElement', 'SVGElement', 'Event', 'CustomEvent', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'SubmitEvent', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);

  // Timon's terminal takes the sign-in line.
  const typed: string[] = [];
  dom.window.addEventListener('timon:terminal-open', (event) => {
    const detail = (event as CustomEvent<{ insert?: string; accepted?: boolean }>).detail;
    typed.push(detail.insert ?? '');
    detail.accepted = true;
  });

  const accounts = [account('a1', 'claude', 'Perso'), account('a2', 'codex', 'Work')];
  const posts: { url: string; body: unknown }[] = [];
  let overviewReads = 0;
  install('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/ui/auth/me') return Response.json({ user: { id: 'owner', email: 'o@x', name: 'Owner', is_superadmin: true }, needsSetup: false });
    if (url === '/api/ui/users/directory') return Response.json({ users: [] });
    if (url === '/api/ui/providers/overview') {
      overviewReads += 1;
      return Response.json({
        providers: [
          overviewOf('claude', 'Claude', { signedIn: false, signInCommand: 'claude /login', acceptsAccounts: true }),
          overviewOf('ollama', 'Ollama', {}),
        ],
        defaultBackend: null,
      });
    }
    if (url === '/api/ui/backends/accounts' && method === 'GET') return Response.json({ accounts, backends: ['claude', 'codex'] });
    if (url === '/api/ui/backends/accounts' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as { backend: string; name: string };
      posts.push({ url, body });
      const created = account('a3', body.backend, body.name);
      accounts.push(created);
      return Response.json({ account: created }, { status: 201 });
    }
    if (url.endsWith('/login') && method === 'POST') {
      return Response.json({ accountId: 'a3', backend: 'claude', state: 'starting', prompt: null, failure: null, identity: null, codeSent: false, startedAt: 0, expiresAt: 0 });
    }
    if (url.endsWith('/login')) return Response.json(null);
    return Response.json({});
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { SearchParamsContext } = await import('next/dist/shared/lib/hooks-client-context.shared-runtime');
  const { AppRouterContext } = await import('next/dist/shared/lib/app-router-context.shared-runtime');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  slots.declareSlot('settings.provider.section', 'list');
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
  const { ProvidersSettings } = await import('./providers-settings');

  const router = { push: () => {}, replace: () => {}, back: () => {}, forward: () => {}, refresh: () => {}, prefetch: () => {} };
  const root = createRoot(document.getElementById('root')!);
  const render = (search: string) => React.act(async () => {
    root.render(React.createElement(AppRouterContext.Provider, { value: router as never },
      React.createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) as never },
        React.createElement(ProvidersSettings))));
  });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const section = () => document.querySelector('[data-provider-section="connection"]');
  const button = (label: string) => Array.from(section()?.querySelectorAll('button') ?? []).find((b) => b.textContent === label);
  const click = (el: Element) => React.act(async () => {
    el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }));
  });

  try {
    await render('settings=models%2Fbackends&provider=claude');
    await until(() => (section()?.textContent ?? '').includes('Perso'), 'the accounts of the provider');
    const text = section()!.textContent ?? '';
    assert.match(section()!.querySelector('[data-connection="computer"]')?.textContent ?? '', /This computer\s*Not signed in/);
    assert.ok(!text.includes('Work'), 'an account of another provider is not listed');
    assert.ok(!text.includes('claude /login'), 'the sign-in command waits for a click');
    assert.equal(section()!.querySelectorAll('[data-account-row="a1"] button[data-row-menu]').length, 1, 'the account\'s other gestures sit in its menu');

    await click(button('Connect')!);
    await until(() => typed.length === 1, 'the sign-in line typed in the terminal');
    assert.deepEqual(typed, ['claude /login']);
    await until(() => section()?.querySelector('[data-sign-in-steps]') != null, 'the sign-in steps unfolded');
    assert.match(section()!.textContent ?? '', /Typed in Timon's terminal/);
    assert.match(section()!.querySelector('[data-sign-in-steps] code')?.textContent ?? '', /claude \/login/);

    await click(button('Add an account')!);
    await until(() => section()?.querySelector('form') !== null, 'the add form');
    const labels = Array.from(section()!.querySelectorAll('form label > span')).map((span) => span.textContent);
    // Never compare a DOM node in an assertion: printing a jsdom element on failure exhausts the memory.
    assert.deepEqual(labels, ['Name', 'For'], 'one backend to add to: nothing to choose');
    const name = section()!.querySelector('form input') as HTMLInputElement;
    await React.act(async () => {
      const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!;
      setter.call(name, 'Second');
      name.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    const readsBefore = overviewReads;
    await click(Array.from(section()!.querySelectorAll('form button')).find((b) => b.textContent === 'Create and sign in')!);
    await until(() => posts.length === 1, 'the account to be created');
    assert.deepEqual(posts[0]!.body, { backend: 'claude', name: 'Second' });
    await until(() => (section()?.textContent ?? '').includes('Second') && overviewReads > readsBefore, 'the new account listed and the provider read again');

    // A provider with nothing to connect: no section at all.
    await render('settings=models%2Fbackends&provider=ollama');
    await until(() => document.querySelector('h3')?.textContent === 'Ollama', 'the other provider page');
    assert.equal(section()?.textContent ?? '', '', 'no Connection section');
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

test('a computer signed out while an account is signed in says so without alarm', async () => {
  const { computerState } = await import('./provider-connection-section');
  const base = { signInCommand: 'claude /login', signInThen: null, acceptsAccounts: true };
  const connected = { ...account('a1', 'claude', 'Perso'), state: 'active' as const, connected: true, createdAt: 0, ownerUserId: 'owner' };
  assert.deepEqual(computerState({ ...base, signedIn: false, accounts: [connected] }), { tone: 'off', key: 'providerPage.connection.usesAccounts' });
  assert.deepEqual(computerState({ ...base, signedIn: false, accounts: [] }), { tone: 'action', key: 'providerPage.connection.signedOut' });
  assert.deepEqual(computerState({ ...base, signedIn: true, accounts: [] }), { tone: 'ready', key: 'providerPage.connection.signedIn' });
  assert.equal(computerState({ ...base, signedIn: null, accounts: [connected] }), null);
});
