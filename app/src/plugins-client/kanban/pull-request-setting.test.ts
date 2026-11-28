/**
 * The project's row "Pull requests": readable but greyed without
 * `projects:manage` (an anonymous browser included, and the setting is never
 * asked for then), "Jobs merge locally" with a "Set up" action, the pull
 * request target and account once set, a dialog that checks a draft before
 * saving it, and the "…" menu that checks the stored setting and goes back to
 * the local merge.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

type Call = { url: string; method: string; body: unknown };
type Who = 'anonymous' | 'reader' | 'manager';

const DEFAULT = {
  mode: 'local', remote: 'origin', target: 'main', forge: 'github', account: null, gh_config_dir: null,
  branch_prefix: 'feat/', remote_url: null, contributor_conflicts: 'ask',
};

type Options = {
  who: Who;
  integration?: Record<string, unknown> | null;
  check?: Record<string, unknown> | { status: number; body: Record<string, unknown> };
  saveRefusal?: Record<string, unknown>;
};

async function mount(opts: Options) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  install('window', dom.window);
  install('self', dom.window);
  for (const key of ['document', 'navigator', 'HTMLElement', 'HTMLButtonElement', 'HTMLInputElement', 'HTMLSelectElement', 'HTMLTextAreaElement', 'Element', 'Node', 'DocumentFragment',
    'MutationObserver', 'NodeFilter', 'SVGElement', 'Event', 'CustomEvent', 'FocusEvent', 'MouseEvent', 'PointerEvent',
    'KeyboardEvent', 'getComputedStyle', 'localStorage']) {
    install(key, (dom.window as unknown as Record<string, unknown>)[key]);
  }
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  // Radix measures the menu's trigger.
  (dom.window as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  install('ResizeObserver', (dom.window as unknown as { ResizeObserver: unknown }).ResizeObserver);

  let stored: Record<string, unknown> | null = opts.integration ?? null;
  const calls: Call[] = [];
  const answer = () => Response.json({ integration: stored ?? DEFAULT, configured: stored !== null });
  install('fetch', async (input: string, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) as unknown : null;
    calls.push({ url, method, body });
    if (url === '/api/ui/auth/me') {
      if (opts.who === 'anonymous') return Response.json({ error: 'unauthorized' }, { status: 401 });
      return Response.json({ user: { id: 'u1', email: 'a@b.c' }, can: { 'projects:manage': opts.who === 'manager' }, prefs: {} });
    }
    if (url === '/api/ui/git-remote/acme/remotes') {
      return Response.json({ remotes: [
        { name: 'origin', url: 'git@github.com:acme/app.git', push_url: null },
        { name: 'upstream', url: 'https://github.com/up/app.git', push_url: 'git@github.com:up/app.git' },
      ] });
    }
    if (url === '/api/ui/projects/acme/integration/fork') {
      stored = { ...(stored ?? DEFAULT), push_remote_url: 'git@github.com:acme-bot/app.git' };
      return Response.json({ ok: true, fork: 'acme-bot/app', integration: stored });
    }
    if (url === '/api/ui/projects/acme/integration/check') {
      const c = opts.check ?? { ok: true, login: 'acme-bot', expected: 'acme-bot', matches: true };
      if ('status' in c && typeof c.status === 'number') return Response.json(c.body, { status: c.status });
      return Response.json(c);
    }
    if (url !== '/api/ui/projects/acme/integration') return Response.json({ error: 'not_found' }, { status: 404 });
    if (opts.who !== 'manager') return Response.json({ error: 'forbidden', code: 'account_lacks_permission', permission: 'projects:manage' }, { status: 403 });
    if (method === 'PUT') {
      if (opts.saveRefusal) return Response.json(opts.saveRefusal, { status: 400 });
      stored = { ...(stored ?? DEFAULT), ...(body as Record<string, unknown>) };
    }
    if (method === 'DELETE') stored = null;
    return answer();
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const { refreshMe } = await import('@/hooks/use-me');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const { PullRequestSetting } = await import('./pull-request-setting');
  const dispose = slots.register({ slot: 'project.settings', pluginId: '@timon/kanban', key: 'pull-requests' }, PullRequestSetting);
  const { ProjectSettingsSlot } = await import('@/components/project-settings-slot');
  await refreshMe().catch(() => undefined);
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(ProjectSettingsSlot, { project: 'acme' })); });
  const settle = async () => {
    for (let i = 0; i < 8; i += 1) await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  };
  await settle();
  const click = async (el: Element | null) => {
    assert.ok(el);
    await React.act(async () => { el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); });
    await settle();
  };
  const type = async (el: Element | null, value: string) => {
    assert.ok(el instanceof dom.window.HTMLInputElement || el instanceof dom.window.HTMLSelectElement);
    const proto = el instanceof dom.window.HTMLSelectElement ? dom.window.HTMLSelectElement.prototype : dom.window.HTMLInputElement.prototype;
    await React.act(async () => {
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
      el.dispatchEvent(new dom.window.Event(el instanceof dom.window.HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
    });
    await settle();
  };
  const openMenu = async () => {
    const trigger = document.querySelector('[data-pr-setting-menu]');
    assert.ok(trigger, 'the menu trigger');
    await React.act(async () => {
      trigger.dispatchEvent(new dom.window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
    await settle();
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    await React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    dispose();
    slots.resetSlotsForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { calls, click, type, openMenu, unmount };
}

const status = () => document.querySelector('[data-pr-setting-status]');
const configure = () => document.querySelector('[data-pr-setting-configure]')?.closest('button') ?? null;
const integrationCalls = (calls: Call[]) => calls.filter((c) => c.url.startsWith('/api/ui/projects/acme/integration'));

for (const who of ['anonymous', 'reader'] as const) {
  test(`${who}: the row is readable, its action greyed with the reason, and the setting never asked for`, async () => {
    const m = await mount({ who });
    try {
      assert.match(document.body.textContent ?? '', /Pull requests/);
      assert.equal(status()?.getAttribute('data-pr-setting-status'), 'restricted');
      assert.equal(status()?.textContent, 'Visible to accounts that manage projects');
      const button = configure();
      assert.ok(button?.hasAttribute('disabled'), 'the action is greyed');
      assert.match(document.querySelector('[data-pr-setting-reason]')?.getAttribute('title') ?? '', /projects:manage/, 'the reason shows on hover');
      assert.match(document.getElementById(button?.getAttribute('aria-describedby') ?? '')?.textContent ?? '', /projects:manage/, 'and is read out');
      assert.ok(!document.querySelector('[data-pr-setting-menu]'), 'no menu');
      assert.deepEqual(integrationCalls(m.calls), []);
    } finally {
      await m.unmount();
    }
  });
}

test('local: "Jobs merge locally", no menu, and the dialog turns pull requests on with the chosen remote', async () => {
  const m = await mount({ who: 'manager' });
  try {
    assert.equal(status()?.getAttribute('data-pr-setting-status'), 'local');
    assert.equal(status()?.textContent, 'Jobs merge locally');
    assert.equal(document.querySelector('[data-pr-setting-configure]')?.textContent, 'Set up');
    assert.ok(!document.querySelector('[data-pr-setting-menu]'), 'nothing to check or undo yet');
    assert.ok(!document.querySelector('[data-pr-setting-dialog]'), 'no field in the row');

    await m.click(configure());
    assert.ok(document.querySelector('[data-pr-setting-dialog]'));
    const remote = document.querySelector('[data-pr-setting-remote]');
    assert.equal(remote?.tagName, 'SELECT', 'the repository\'s remotes are offered');
    assert.equal((document.querySelector('[data-pr-setting-remote-url]') as HTMLInputElement).value, 'git@github.com:acme/app.git');
    assert.ok(document.querySelector('[data-pr-setting-save]')?.closest('button')?.hasAttribute('disabled'), 'no account, no save');

    await m.type(remote, 'upstream');
    assert.equal((document.querySelector('[data-pr-setting-remote-url]') as HTMLInputElement).value, 'git@github.com:up/app.git', 'the URL follows the remote');
    await m.type(document.querySelector('[data-pr-setting-account]'), 'acme-bot');
    await m.type(document.querySelector('[data-pr-setting-gh-dir]'), '/home/me/.config/gh-acme');
    assert.equal(document.querySelector('[data-pr-setting-save]')?.textContent, 'Turn on');
    await m.click(document.querySelector('[data-pr-setting-save]'));

    const put = m.calls.find((c) => c.method === 'PUT');
    assert.deepEqual(put?.body, {
      mode: 'pr', remote: 'upstream', target: 'main', account: 'acme-bot', gh_config_dir: '/home/me/.config/gh-acme',
      branch_prefix: 'feat/', remote_url: 'git@github.com:up/app.git', push_remote_url: null,
    });
    assert.ok(!document.querySelector('[data-pr-setting-dialog]'));
    assert.equal(status()?.textContent, 'Pull request to upstream/main · account acme-bot');
  } finally {
    await m.unmount();
  }
});

test('the dialog checks the draft, not the stored setting, and says which login gh answers', async () => {
  const m = await mount({ who: 'manager', check: { ok: false, login: 'someone', expected: 'acme-bot', matches: false } });
  try {
    await m.click(configure());
    await m.type(document.querySelector('[data-pr-setting-account]'), 'acme-bot');
    await m.click(document.querySelector('[data-pr-setting-check-run]'));
    const check = m.calls.find((c) => c.url.endsWith('/integration/check'));
    assert.deepEqual(check?.body, { account: 'acme-bot', gh_config_dir: null });
    assert.equal(document.querySelector('[data-pr-setting-check]')?.textContent, 'gh signs in as someone, not acme-bot.');
    assert.ok(!m.calls.some((c) => c.method === 'PUT'), 'checking writes nothing');
  } finally {
    await m.unmount();
  }
});

test('a refused check and a refused save stay in the dialog, translated', async () => {
  const m = await mount({
    who: 'manager',
    check: { status: 400, body: { error: 'gh_config_dir must be a folder inside your home folder', code: 'integration_invalid', params: { detail: 'gh_config_dir must be a folder inside your home folder' } } },
    saveRefusal: { error: 'remote_url: not allowed', code: 'integration_invalid', params: { detail: 'remote_url: not allowed' } },
  });
  try {
    await m.click(configure());
    await m.type(document.querySelector('[data-pr-setting-account]'), 'acme-bot');
    await m.type(document.querySelector('[data-pr-setting-gh-dir]'), '/etc/gh');
    await m.click(document.querySelector('[data-pr-setting-check-run]'));
    assert.equal(
      document.querySelector('[data-pr-setting-check]')?.textContent,
      'The integration setting was refused: gh_config_dir must be a folder inside your home folder',
    );
    await m.click(document.querySelector('[data-pr-setting-save]'));
    assert.equal(document.querySelector('[data-pr-setting-error]')?.textContent, 'The integration setting was refused: remote_url: not allowed');
    assert.ok(document.querySelector('[data-pr-setting-dialog]'), 'the dialog stays open');
    assert.equal(status()?.getAttribute('data-pr-setting-status'), 'local');
  } finally {
    await m.unmount();
  }
});

test('pr: the status names the target and the account; the menu checks gh and goes back to local', async () => {
  const m = await mount({
    who: 'manager',
    integration: { ...DEFAULT, mode: 'pr', account: 'acme-bot', remote_url: 'git@github.com:acme/app.git' },
    check: { ok: false, expected: 'acme-bot', code: 'gh_missing', reason: 'the GitHub CLI (gh) was not found on this machine' },
  });
  try {
    assert.equal(status()?.getAttribute('data-pr-setting-status'), 'pr');
    assert.equal(status()?.textContent, 'Pull request to origin/main · account acme-bot');
    assert.equal(document.querySelector('[data-pr-setting-configure]')?.textContent, 'Configure');

    await m.openMenu();
    await m.click(document.querySelector('[data-pr-setting-verify]'));
    const check = m.calls.find((c) => c.url.endsWith('/integration/check'));
    assert.deepEqual(check?.body, {}, 'the stored setting is checked');
    assert.equal(
      document.querySelector('[data-pr-setting-notice]')?.textContent,
      'The GitHub CLI (gh) was not found on the machine that runs Timon.',
    );

    await m.openMenu();
    await m.click(document.querySelector('[data-pr-setting-local]'));
    assert.ok(m.calls.some((c) => c.method === 'DELETE' && c.url === '/api/ui/projects/acme/integration'));
    assert.equal(status()?.getAttribute('data-pr-setting-status'), 'local');
    assert.ok(!document.querySelector('[data-pr-setting-menu]'));
  } finally {
    await m.unmount();
  }
});

const PR_SETTING = { ...DEFAULT, mode: 'pr', account: 'acme-bot', remote_url: 'git@github.com:acme/app.git' };
const NO_PUSH = {
  ok: true, login: 'acme-bot', expected: 'acme-bot', matches: true,
  access: { target: { repository: 'acme/app', exists: true, can_push: false }, fork: null },
};

test('a target the account cannot push to offers a fork, created only after an explicit confirmation', async () => {
  const m = await mount({ who: 'manager', integration: PR_SETTING, check: NO_PUSH });
  try {
    await m.click(configure());
    assert.ok(!document.querySelector('[data-pr-setting-fork-offer]'), 'nothing is offered before the rights are read');
    await m.click(document.querySelector('[data-pr-setting-access-run]'));
    assert.deepEqual(m.calls.find((c) => c.url.endsWith('/integration/check'))?.body, {}, 'the stored setting is read');
    assert.equal(document.querySelector('[data-pr-setting-access]')?.textContent, 'Your account cannot push to acme/app.');

    await m.click(document.querySelector('[data-pr-setting-fork-offer]'));
    assert.ok(document.querySelector('[data-pr-setting-fork-confirm]'), 'the confirmation is shown');
    assert.ok(!m.calls.some((c) => c.url.endsWith('/integration/fork')), 'nothing is created yet');

    await m.click(document.querySelector('[data-pr-setting-fork-create]'));
    const fork = m.calls.find((c) => c.url.endsWith('/integration/fork'));
    assert.equal(fork?.method, 'POST');
    assert.deepEqual(fork?.body, { confirm: true });
    assert.equal((document.querySelector('[data-pr-setting-fork-url]') as HTMLInputElement).value, 'git@github.com:acme-bot/app.git');
  } finally {
    await m.unmount();
  }
});

test('the rights check is off while a field differs from the stored setting', async () => {
  const m = await mount({ who: 'manager', integration: PR_SETTING, check: NO_PUSH });
  try {
    await m.click(configure());
    const button = () => document.querySelector('[data-pr-setting-access-run]')?.closest('button') as HTMLButtonElement | null;
    assert.equal(button()?.disabled, false, 'the form matches the stored setting');
    await m.type(document.querySelector('[data-pr-setting-account]'), 'someone-else');
    assert.equal(button()?.disabled, true, 'the check would read another setting');
    await m.click(button());
    assert.ok(!m.calls.some((c) => c.url.endsWith('/integration/check')), 'nothing is read while the form is modified');
  } finally {
    await m.unmount();
  }
});

test('cancelling the confirmation creates no fork; a target the account can push to offers none', async () => {
  const m = await mount({ who: 'manager', integration: PR_SETTING, check: NO_PUSH });
  try {
    await m.click(configure());
    await m.click(document.querySelector('[data-pr-setting-access-run]'));
    await m.click(document.querySelector('[data-pr-setting-fork-offer]'));
    const cancel = Array.from(document.querySelectorAll('[data-pr-setting-fork-confirm] button')).find((b) => b.textContent === 'Cancel');
    await m.click(cancel ?? null);
    assert.ok(!document.querySelector('[data-pr-setting-fork-confirm]'));
    assert.ok(!m.calls.some((c) => c.url.endsWith('/integration/fork')));
  } finally {
    await m.unmount();
  }
  const pushable = await mount({
    who: 'manager', integration: PR_SETTING,
    check: { ...NO_PUSH, access: { target: { repository: 'acme/app', exists: true, can_push: true }, fork: null } },
  });
  try {
    await pushable.click(configure());
    await pushable.click(document.querySelector('[data-pr-setting-access-run]'));
    assert.equal(document.querySelector('[data-pr-setting-access]')?.textContent, 'Your account can push to acme/app: no fork is needed.');
    assert.ok(!document.querySelector('[data-pr-setting-fork-offer]'));
  } finally {
    await pushable.unmount();
  }
});
