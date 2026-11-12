import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { toast } from 'sonner';
import { answerConfirmsForTests } from './confirm-dialog/confirm-dialog-context';

/**
 * The install sheet of a bundle whose children name secrets and hosts (TODO
 * #660): each child has its own boxes, by id, never shared with another child
 * nor with the bundle; every line of every child that names something goes
 * back as shown; a child the sheet asks nothing for says why, without a box;
 * a 409 shows the sheet again; a child that got nothing is named afterwards.
 */
type Preview = import('@/lib/plugin-install').PluginPreview;
type Child = import('@/lib/plugin-install').BundleChildPreview;
type Vault = import('@/lib/plugin-install').PluginVault;
type Consent = import('@/lib/plugin-install').VaultConsent;
type ChildConsent = import('@/lib/plugin-install').ChildVaultConsent[] | undefined;

async function withDom(run: (env: {
  React: typeof import('react');
  root: import('react-dom/client').Root;
  dialog: () => Element;
}) => Promise<void>): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/plugins' });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLAnchorElement', 'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'getComputedStyle', 'DocumentFragment']) {
    install(key, Reflect.get(dom.window, key));
  }
  // `next/link` reads `self`.
  install('self', dom.window);
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('AsyncLocalStorage', AsyncLocalStorage);
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  try {
    await run({ React, root, dialog: () => document.querySelector('[role="dialog"]')! });
  } finally {
    await React.act(async () => root.unmount());
    // Radix schedules focus events on unmount: let them land while the jsdom globals still exist.
    await new Promise((done) => setTimeout(done, 50));
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
}

// The same secret and host named by the bundle and by two children: a box is still its own.
const vault = (id: string): Vault => ({
  scope: `agent:plugin:${id}`,
  secrets: [
    { name: 'ACME_TOKEN', mode: 'read', why: null, present: true, otherMode: false, state: 'grantable' },
    { name: 'ACME_OLD', mode: 'broker', why: null, present: true, otherMode: false, state: 'granted' },
    { name: 'ACME_NEW', mode: 'read', why: null, present: false, otherMode: false, state: 'missing' },
  ],
  hosts: [
    { host: 'api.acme.test', why: null, allowedBy: null },
    { host: 'cdn.acme.test', why: null, allowedBy: 'plugin' },
    { host: 'example.org', why: null, allowedBy: 'global' },
  ],
});

const child = (over: Partial<Child> & { id: string }): Child => ({
  pkg: `@acme/${over.id}`, version: '1.0.0', label: null, state: 'install', permissions: [],
  signature: { state: 'signed', keyId: 'k' }, vault: null, provider: null, ...over,
});

function bundle(children: Child[], over: Partial<Preview> = {}): Preview {
  return {
    token: 'a'.repeat(48), origin: 'path', format: 'folder', pkg: '@acme/bundle', version: '1.0.0', id: 'acme-bundle',
    label: 'Acme bundle', description: null, author: 'Acme', kind: ['bundle'], permissions: [],
    slots: [], route: null, declares: {}, modifies: [], contains: children.map((c) => c.id), settings: [], webhooks: [], licenseRequired: false,
    provider: null, icon: null, cover: null, signature: { state: 'signed', keyId: 'k' }, manifestError: null, installed: null,
    installable: true, blocked: null, children, ...over,
  };
}

const button = (scope: Element, label: string) =>
  Array.from(scope.querySelectorAll<HTMLButtonElement>('button')).find((b) => b.textContent === label)!;
const inChild = (scope: Element, id: string) => scope.querySelector(`[data-child="${id}"]`)!;
const box = (scope: Element, attr: string, key: string) =>
  scope.querySelector<HTMLInputElement>(`[${attr}="${key}"] input[type="checkbox"]`);

const untouched = (id: string) => ({
  id, pkg: `@acme/${id}`, version: '1.0.0',
  secrets: [
    { name: 'ACME_TOKEN', mode: 'read', state: 'grantable', grant: false },
    { name: 'ACME_OLD', mode: 'broker', state: 'granted', grant: false },
    { name: 'ACME_NEW', mode: 'read', state: 'missing', grant: false },
  ],
  hosts: [
    { host: 'api.acme.test', allowedBy: null, grant: false },
    { host: 'cdn.acme.test', allowedBy: 'plugin', grant: true },
    { host: 'example.org', allowedBy: 'global', grant: false },
  ],
});

test('bundle sheet: each child has its own boxes, by id, and every line of every child goes back as shown', async () => {
  // acme-chat is unsigned: every Install asks first, and the lines must come through the yes intact.
  const asked: string[] = [];
  answerConfirmsForTests((request) => { asked.push(request.title); return true; });
  try { await withDom(async ({ React, root, dialog }) => {
    const { PluginInstallDialog } = await import('./plugin-install-dialog');
    const calls: Array<{ vault?: Consent; children: ChildConsent }> = [];
    const render = (p: Preview) => React.act(async () => root.render(React.createElement(PluginInstallDialog, {
      preview: p, open: true, busy: false, onOpenChange: () => {},
      onInstall: (_p: Preview, _exec?: string[], own?: Consent, _execChildren?: unknown, children?: ChildConsent) => { calls.push({ vault: own, children }); },
    })));
    const children = [
      child({ id: 'acme-mail', label: 'Mail', permissions: ['secrets:read', 'http:outbound'], vault: vault('acme-mail') }),
      child({ id: 'acme-chat', vault: vault('acme-chat'), signature: { state: 'unsigned', loads: true } }),
    ];
    await render(bundle(children, { vault: vault('acme-bundle') }));
    const sheet = dialog();
    const mail = inChild(sheet, 'acme-mail');
    const chat = inChild(sheet, 'acme-chat');
    assert.match(mail.textContent ?? '', /^Mail · @acme\/acme-mail · 1\.0\.0 · Verified signature/);
    assert.match(mail.textContent ?? '', /Asks for: secrets:read, http:outbound/);
    assert.match(chat.textContent ?? '', /^acme-chat · @acme\/acme-chat · 1\.0\.0 · Unsigned — loads in developer mode/, 'no label: the id');
    assert.match(chat.textContent ?? '', /Asks for: no permission/);
    assert.equal(mail.querySelector('[data-secret="ACME_NEW"] a')?.getAttribute('href'), '/secrets?grant=ACME_NEW&plugin=acme-mail', 'a secret to create is for that child');
    assert.equal(box(mail, 'data-host', 'cdn.acme.test')?.checked, true, 'a host already open to that child starts ticked');
    assert.ok(!box(mail, 'data-secret', 'ACME_OLD') && !box(mail, 'data-host', 'example.org'), 'no box where nothing can be granted');

    await React.act(async () => button(sheet, 'Install').click());
    assert.deepEqual(asked, ['Install Acme bundle without a signature?'], 'an unsigned child: Install asks before anything goes back');
    assert.deepEqual(calls[0]?.children, [untouched('acme-mail'), untouched('acme-chat')], 'unticked, every line still goes back');

    await React.act(async () => box(mail, 'data-secret', 'ACME_TOKEN')!.click());
    await React.act(async () => box(mail, 'data-host', 'api.acme.test')!.click());
    await React.act(async () => box(chat, 'data-host', 'cdn.acme.test')!.click());
    assert.equal(box(chat, 'data-secret', 'ACME_TOKEN')?.checked, false, 'never shared with another child');
    assert.equal(box(chat, 'data-host', 'api.acme.test')?.checked, false);
    assert.equal(box(mail, 'data-host', 'cdn.acme.test')?.checked, true);
    const own = sheet.querySelector(':scope [data-testid="vault-named"]:not([data-child] *)')!;
    assert.equal(box(own, 'data-secret', 'ACME_TOKEN')?.checked, false, 'nor with the bundle');

    await React.act(async () => button(sheet, 'Install').click());
    const mailLine = untouched('acme-mail');
    mailLine.secrets[0]!.grant = true;
    mailLine.hosts[0]!.grant = true;
    const chatLine = untouched('acme-chat');
    chatLine.hosts[1]!.grant = false;
    assert.deepEqual(calls[1]?.children, [mailLine, chatLine]);
    assert.deepEqual(calls[1]?.vault?.secrets.filter((s) => s.grant), [], 'the bundle\'s own lines are untouched');

    // A refreshed preview starts again from its own defaults.
    await render(bundle(children, { token: 'b'.repeat(48) }));
    assert.equal(box(inChild(dialog(), 'acme-mail'), 'data-secret', 'ACME_TOKEN')?.checked, false);
    await React.act(async () => button(dialog(), 'Install').click());
    assert.deepEqual(calls[2]?.children, [untouched('acme-mail'), untouched('acme-chat')]);
    assert.equal(asked.length, 3, 'one question per Install');
  }); } finally {
    answerConfirmsForTests(null);
  }
});

test('bundle sheet: kept, unreadable, unresolved and altered children say why nothing is asked, with no box and no line sent', async () => {
  await withDom(async ({ React, root, dialog }) => {
    const { PluginInstallDialog } = await import('./plugin-install-dialog');
    const calls: ChildConsent[] = [];
    await React.act(async () => root.render(React.createElement(PluginInstallDialog, {
      preview: bundle([
        child({ id: 'acme-kept', pkg: null, version: null, state: 'kept', signature: null }),
        child({ id: 'acme-far', pkg: null, version: null, state: 'unreadable', signature: null }),
        child({ id: 'acme-none', pkg: null, version: null, state: 'unresolved', signature: null }),
        child({ id: 'acme-broken', signature: { state: 'tampered' } }),
        child({ id: 'acme-plain' }),
      ]),
      open: true, busy: false, onOpenChange: () => {},
      onInstall: (_p: Preview, _e?: string[], _v?: Consent, _x?: unknown, children?: ChildConsent) => { calls.push(children); },
    })));
    const sheet = dialog();
    const note = (id: string) => inChild(sheet, id).querySelector('[data-child-note]');
    assert.equal(note('acme-kept')?.getAttribute('data-child-note'), 'kept');
    assert.match(note('acme-kept')?.textContent ?? '', /Already installed: this bundle leaves it as it is/);
    assert.equal(note('acme-far')?.getAttribute('data-child-note'), 'unreadable');
    assert.match(note('acme-far')?.textContent ?? '', /installed without being granted anything\. Grant its secrets from the Secrets page/);
    assert.equal(note('acme-none')?.getAttribute('data-child-note'), 'unresolved');
    assert.match(note('acme-none')?.textContent ?? '', /will not be installed/);
    assert.equal(note('acme-broken')?.getAttribute('data-child-note'), 'tampered');
    assert.match(note('acme-broken')?.textContent ?? '', /no longer match their signature: it will not load/);
    assert.ok(!note('acme-plain'), 'a child that lands and names nothing has nothing to excuse');
    assert.equal(sheet.querySelectorAll('input[type="checkbox"]').length, 0);
    assert.equal(sheet.querySelectorAll('[data-testid="vault-named"]').length, 0);
    await React.act(async () => button(sheet, 'Install').click());
    assert.deepEqual(calls, [[]], 'no child names anything: nothing to send');
  });
});

type Sent = { method: string; url: string; body: Record<string, unknown> | undefined };

async function withPanel(confirm: () => Response, stages: Preview[], run: (env: {
  React: typeof import('react');
  dialog: () => Element;
  requests: Sent[];
}) => Promise<void>, root: import('react-dom/client').Root, React: typeof import('react')): Promise<void> {
  const requests: Sent[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({ method: init?.method ?? 'GET', url, body: typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined });
    if (url.endsWith('/candidates')) {
      return Response.json({ candidates: [{ name: 'acme-bundle-1.0.0.tgz', format: 'archive', pkg: '@acme/bundle', version: '1.0.0', id: 'acme-bundle', label: 'Acme bundle', description: null, kind: ['bundle'] }] });
    }
    if (url.endsWith('/stage')) return Response.json(stages.shift(), { status: 201 });
    if (url.endsWith('/confirm')) return confirm();
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    const { PluginInstallPanel } = await import('./plugin-install-panel');
    await React.act(async () => root.render(React.createElement(PluginInstallPanel, { onInstalled: async () => {} })));
    await React.act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    await React.act(async () => document.querySelector<HTMLButtonElement>('button[aria-label]')!.click());
    await React.act(async () => { await new Promise((done) => setTimeout(done, 0)); });
    await run({ React, dialog: () => document.querySelector('[role="dialog"]')!, requests });
  } finally {
    globalThis.fetch = original;
  }
}

test('install panel: a 409 on a child\'s lines shows the sheet again, refreshed, and discards the stale preview', async () => {
  await withDom(async ({ React, root }) => {
    const stale = bundle([child({ id: 'acme-mail', vault: vault('acme-mail') })], { token: 'e'.repeat(48) });
    const freshVault = vault('acme-mail');
    freshVault.secrets[2] = { ...freshVault.secrets[2]!, present: true, state: 'grantable' };
    const fresh = bundle([child({ id: 'acme-mail', vault: freshVault })], { token: 'f'.repeat(48) });
    await withPanel(() => Response.json({ error: 'mismatch', message: 'changed' }, { status: 409 }), [stale, fresh], async ({ dialog, requests }) => {
      assert.ok(!box(inChild(dialog(), 'acme-mail'), 'data-secret', 'ACME_NEW'), 'first sheet: still to create');
      await React.act(async () => box(inChild(dialog(), 'acme-mail'), 'data-secret', 'ACME_TOKEN')!.click());
      await React.act(async () => button(dialog(), 'Install').click());
      await React.act(async () => { await new Promise((done) => setTimeout(done, 0)); });

      const confirm = requests.find((r) => r.url.endsWith('/confirm'))!;
      assert.equal(confirm.body?.token, stale.token);
      const sent = untouched('acme-mail');
      sent.secrets[0]!.grant = true;
      assert.deepEqual(confirm.body?.vaultChildren, [sent], 'every line of the child, as shown');
      assert.equal(requests.filter((r) => r.url.endsWith('/stage')).length, 2, 'the bundle was read again');
      assert.ok(requests.some((r) => r.method === 'DELETE' && r.url.endsWith(`/staged/${stale.token}`)), 'the stale preview is discarded');
      const sheet = dialog();
      assert.match(sheet.querySelector('[role="alert"]')?.textContent ?? '', /up to date/);
      const mail = inChild(sheet, 'acme-mail');
      assert.equal(box(mail, 'data-secret', 'ACME_NEW')?.checked, false, 'now grantable, off by default');
      assert.equal(box(mail, 'data-secret', 'ACME_TOKEN')?.checked, false, 'no box carried over from the stale sheet');
    }, root, React);
  });
});

test('install panel: a child that got none of its secrets and hosts is named with why; a bundle whose children name nothing sends no `vaultChildren`', async (t) => {
  const warned = t.mock.method(toast, 'warning', () => '');
  t.mock.method(toast, 'success', () => '');
  await withDom(async ({ React, root }) => {
    const p = bundle([child({ id: 'acme-mail', label: 'Mail', vault: vault('acme-mail') }), child({ id: 'acme-chat', vault: vault('acme-chat') })]);
    const outcome = {
      ok: true, id: 'acme-bundle', pkg: '@acme/bundle', version: '1.0.0', refused: null, signature: { state: 'signed' },
      vaultChildren: [
        { id: 'acme-mail', granted: null, refused: 'changed' },
        { id: 'acme-chat', granted: { secrets: [], hosts: ['cdn.acme.test'] }, refused: null },
      ],
    };
    await withPanel(() => Response.json(outcome), [p], async ({ dialog, requests }) => {
      await React.act(async () => button(dialog(), 'Install').click());
      await React.act(async () => { await new Promise((done) => setTimeout(done, 0)); });
      assert.deepEqual((requests.find((r) => r.url.endsWith('/confirm'))?.body?.vaultChildren as unknown[]).map((l) => (l as { id: string }).id), ['acme-mail', 'acme-chat']);
      const shown = warned.mock.calls.map((call) => String(call.arguments[0]));
      assert.equal(shown.length, 1, 'a child that got its grants is not named');
      assert.match(shown[0]!, /“Mail” is not what the sheet showed, so none of its secrets and hosts were granted/);
    }, root, React);
  });
  await withDom(async ({ React, root }) => {
    const p = bundle([child({ id: 'acme-plain' }), child({ id: 'acme-kept', pkg: null, version: null, state: 'kept', signature: null })], { token: 'c'.repeat(48) });
    await withPanel(() => Response.json({ ok: true, id: 'acme-bundle', pkg: '@acme/bundle', version: '1.0.0', refused: null, signature: { state: 'signed' }, vaultChildren: null }), [p], async ({ dialog, requests }) => {
      await React.act(async () => button(dialog(), 'Install').click());
      await React.act(async () => { await new Promise((done) => setTimeout(done, 0)); });
      const body = requests.find((r) => r.url.endsWith('/confirm'))?.body ?? {};
      assert.deepEqual(Object.keys(body).sort(), ['confirm', 'token'], 'no child names anything: the field is not sent');
    }, root, React);
  });
});
