/**
 * The Git stack's shortcut to the "Pull requests" setting: while the project
 * merges its jobs locally, the Pull requests and Jobs tabs show one short line
 * and an icon (never a labelled button in a 300 px widget) that opens the
 * setting's own dialog. Gone in pull request mode, and never offered to an
 * account that cannot read the setting, which is then not even asked.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type Who = 'reader' | 'manager';
type Call = { url: string; method: string };

const LOCAL = {
  mode: 'local', remote: 'origin', target: 'main', forge: 'github', account: null, gh_config_dir: null,
  branch_prefix: 'feat/', remote_url: null,
};
const PR = { ...LOCAL, mode: 'pr', account: 'acme-bot', remote_url: 'git@github.com:acme/widgets.git' };

async function mount(widget: 'pulls' | 'jobs', who: Who, integration: Record<string, unknown>) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLSelectElement', 'Element', 'Node',
    'DocumentFragment', 'MutationObserver', 'NodeFilter', 'HTMLInputElement', 'SVGElement', 'Event', 'CustomEvent',
    'FocusEvent', 'MouseEvent', 'PointerEvent', 'KeyboardEvent', 'getComputedStyle', 'localStorage']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);

  let stored = integration;
  const calls: Call[] = [];
  install('fetch', async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    calls.push({ url, method });
    if (url === '/api/ui/auth/me') {
      return Response.json({ user: { id: 'u1', email: 'a@b.c' }, can: { 'projects:manage': who === 'manager' }, prefs: {} });
    }
    if (url === '/api/ui/projects') return Response.json({ projects: [{ slug: 'acme', name: 'Acme' }] });
    if (url === '/api/ui/projects/acme/integration') {
      if (who !== 'manager') return Response.json({ error: 'forbidden', code: 'account_lacks_permission' }, { status: 403 });
      if (method === 'PUT') stored = { ...stored, ...(JSON.parse(String(init.body)) as Record<string, unknown>) };
      return Response.json({ integration: stored, configured: stored.mode === 'pr' });
    }
    if (url === '/api/ui/projects/acme/pull-requests') {
      if (who !== 'manager') return Response.json({ error: 'forbidden', code: 'account_lacks_permission' }, { status: 403 });
      if (stored.mode !== 'pr') return Response.json({ error: 'integration_not_pr', code: 'integration_not_pr' }, { status: 409 });
      return Response.json({ repo: 'acme/widgets', pulls: [] });
    }
    if (url.startsWith('/api/ui/kanban/landings')) return Response.json({ landings: [] });
    if (url === '/api/ui/git-remote/acme/remotes') return Response.json({ remotes: [] });
    return Response.json({ error: 'not_found' }, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const { refreshMe } = await import('@/hooks/use-me');
  await refreshMe().catch(() => undefined);
  (await import('./pull-requests-model')).forgetPullListsForTests();
  (await import('./git-stack-project')).pickStackProject('acme');
  const { PullRequestsWidget } = await import('./pull-requests-widget');
  const { LandingWidget } = await import('./landing-widget');
  const root = createRoot(document.getElementById('root')!);
  const Widget = widget === 'pulls' ? PullRequestsWidget : LandingWidget;
  await React.act(async () => { root.render(React.createElement(Widget, { handle: null })); });
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  await settle();
  const click = async (el: Element | null) => {
    assert.ok(el);
    await React.act(async () => { (el as HTMLElement).dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await settle();
  };
  const type = async (el: Element | null, value: string) => {
    assert.ok(el instanceof dom.window.HTMLInputElement);
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')?.set?.call(el, value);
      el.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    });
    await settle();
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { document: dom.window.document, calls, click, type, settle, unmount };
}

for (const widget of ['pulls', 'jobs'] as const) {
  test(`${widget}: a project that merges locally gets one line and an icon, not a labelled button`, async () => {
    const view = await mount(widget, 'manager', LOCAL);
    try {
      const empty = view.document.querySelector('[data-local-landing="acme"]');
      assert.ok(empty, 'the local-mode line');
      assert.match(empty.textContent ?? '', /merges its jobs locally/);
      const button = view.document.querySelector('[data-local-landing-setup]');
      assert.ok(button, 'the shortcut');
      assert.equal(button.getAttribute('aria-label'), 'Set up pull requests');
      assert.equal(button.getAttribute('title'), 'Set up pull requests');
      assert.equal(button.textContent, '', 'an icon only: a label would crowd a narrow widget');
    } finally {
      await view.unmount();
    }
  });

  test(`${widget}: no shortcut once the project lands through pull requests`, async () => {
    const view = await mount(widget, 'manager', PR);
    try {
      assert.ok(!view.document.querySelector('[data-local-landing]'));
      assert.ok(!view.document.querySelector('[data-local-landing-setup]'));
    } finally {
      await view.unmount();
    }
  });

  test(`${widget}: without projects:manage the setting is not asked and nothing is offered`, async () => {
    const view = await mount(widget, 'reader', LOCAL);
    try {
      assert.ok(!view.document.querySelector('[data-local-landing-setup]'));
      assert.ok(!view.calls.some((c) => c.url === '/api/ui/projects/acme/integration'), 'the setting is never read');
    } finally {
      await view.unmount();
    }
  });
}

test('the shortcut opens the setting\'s own dialog, and turning pull requests on lists them', async () => {
  const view = await mount('pulls', 'manager', LOCAL);
  try {
    await view.click(view.document.querySelector('[data-local-landing-setup]'));
    const dialog = view.document.querySelector('[data-pr-setting-dialog]');
    assert.ok(dialog, 'the "Pull requests" dialog of the project window');
    assert.match(dialog.textContent ?? '', /Pull requests · acme/);
    await view.type(view.document.querySelector('[data-pr-setting-account]'), 'acme-bot');
    await view.click(view.document.querySelector('[data-pr-setting-save]')?.closest('button') ?? null);
    assert.ok(view.calls.some((c) => c.url === '/api/ui/projects/acme/integration' && c.method === 'PUT'), 'saved');
    assert.ok(!view.document.querySelector('[data-pr-setting-dialog]'), 'closed once saved');
    assert.ok(!view.document.querySelector('[data-local-landing]'), 'the local line is gone');
    assert.match(view.document.body.textContent ?? '', /No open pull request\./);
  } finally {
    await view.unmount();
  }
});
