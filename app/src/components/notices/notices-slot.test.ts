/**
 * The bottom-left notice cards (docs/NOTICES.md): the `notices` (sources) and
 * `notices.card` (one card) slots are declared at boot; nothing shows before
 * the account's closed list is read, nor without a session; a plugin pushes
 * through `ctx.notices` and its cards leave with it; at most three show,
 * warnings first; a closed card is remembered by the daemon and stays closed;
 * text is text; an action runs and may close; the GitHub star waits for five
 * days of use; and the `examples/plugin-notice` template takes the card's
 * place with the SDK alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ComponentType } from 'react';
import { waitUntil } from '../../lib/test-wait';

type Mounted = Awaited<ReturnType<typeof mount>>;

async function mount({ dismissed = [] as string[], session = true, usageDays = [] as string[], routes = {} as Record<string, () => Response>, url = 'http://localhost/' } = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url, pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent',
    'MutationObserver', 'DocumentFragment', 'sessionStorage', 'localStorage'] as const) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    if (value !== undefined) install(key, value);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  if (usageDays.length) dom.window.localStorage.setItem('timon-notices-usage-days', JSON.stringify(usageDays));
  const opened: string[] = [];
  dom.window.open = ((url: string) => { opened.push(url); return null; }) as typeof dom.window.open;
  const server = new Set(dismissed);
  const posts: unknown[] = [];
  const writes: string[] = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (init?.method && init.method !== 'GET') writes.push(`${init.method} ${url}`);
    if (url === '/api/ui/prefs/dismissed-notices') {
      if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (init?.method === 'DELETE') server.clear();
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { id: string };
        posts.push(body);
        server.add(body.id);
      }
      return Response.json({ dismissed: [...server] });
    }
    const route = routes[url];
    if (route) return route();
    return Response.json({}, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const notices = await import('@/lib/notices');
  notices.resetNoticesForTests();
  const { NoticesHost, ProductNoticeCard } = await import('./notices-host');
  const { clientContext } = await import('@/lib/plugin-host/loader');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(NoticesHost)); });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  /** A third-party half's context, as the loader builds it. */
  const pluginContext = (id: string, declared: string[] = []) => clientContext(id, declared, () => () => {});
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    notices.resetNoticesForTests();
    slots.resetSlotsForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, slots, notices, ProductNoticeCard, until, click, pluginContext, unmount, posts, writes, opened, server, dom };
}

const cards = () => Array.from(document.querySelectorAll('[data-notice]'), (el) => el.getAttribute('data-notice'));
const settle = (m: Mounted) => m.until(() => m.notices.dismissedNoticesLoaded(), 'the closed list read');

test('both slots are declared at boot: the sources as a list, the card as single', async () => {
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  assert.equal(slots.slotKind('notices'), 'list');
  assert.equal(slots.slotKind('notices.card'), 'single');
});

test('a pushed card shows once the closed list is read, as text, and leaves with its plugin', async () => {
  const m = await mount();
  try {
    const ctx = m.pluginContext('acme');
    await m.React.act(async () => ctx.notices.push({
      id: 'hello', tone: 'warning', title: '<img src=x onerror="window.__pwned=1">', body: 'Line\n<b>two</b>',
    }));
    await m.until(() => cards().length === 1, 'the card painted');
    assert.deepEqual(cards(), ['acme:hello']);
    const card = document.querySelector('[data-notice-card]')!;
    assert.equal(card.getAttribute('data-notice-card'), 'warning');
    assert.ok(!document.querySelector('[data-notice] img'), 'the title is text');
    assert.match(card.textContent ?? '', /<b>two<\/b>/);
    assert.equal((globalThis as { __pwned?: number }).__pwned, undefined);

    // Pushing the same id updates the card in place.
    await m.React.act(async () => ctx.notices.push({ id: 'hello', title: 'Updated' }));
    await m.until(() => /Updated/.test(document.querySelector('[data-notice]')?.textContent ?? ''), 'the card updated');
    assert.equal(cards().length, 1);

    await m.React.act(async () => ctx.dispose());
    await m.until(() => cards().length === 0, 'the card gone with its plugin');
  } finally {
    await m.unmount();
  }
});

test('the product card: a brand logo or the tone\'s icon, the main action filled at the bottom right', async () => {
  const m = await mount();
  try {
    await settle(m);
    const ctx = m.pluginContext('acme');
    await m.React.act(async () => {
      ctx.notices.push({
        id: 'chat', icon: 'discord', title: 'Join the community',
        actions: [{ label: 'Join', href: 'https://discord.example/x' }, { label: 'Later', dismiss: true }],
      });
      ctx.notices.push({ id: 'plain', title: 'Plain' });
      ctx.notices.push({ id: 'late', icon: 'timon', tone: 'warning', title: 'Late' });
    });
    await m.until(() => cards().length === 3, 'three cards');
    const visual = (key: string) => document.querySelector(`[data-notice="acme:${key}"] [data-notice-card]`)?.getAttribute('data-notice-visual');
    assert.equal(visual('chat'), 'discord');
    assert.equal(visual('plain'), 'info', 'without icon, the tone\'s');
    assert.equal(visual('late'), 'timon');
    assert.ok(document.querySelector('[data-notice="acme:chat"] [data-notice-glyph] svg'), 'the logo is drawn inline');
    assert.ok(!document.querySelector('[data-notice] img'), 'no image is loaded');
    const late = document.querySelector<HTMLElement>('[data-notice="acme:late"] [data-notice-card]')!;
    assert.equal(late.style.getPropertyValue('--notice-accent'), '#f59e0b', 'a warning keeps the amber accent whatever its logo');
    const order = Array.from(document.querySelectorAll('[data-notice="acme:chat"] [data-notice-action]'), (el) => el.getAttribute('data-notice-action'));
    assert.deepEqual(order, ['1', '0'], 'the main action comes last, in the corner');
    assert.equal(m.notices.visibleNotices().find((n) => n.id === 'chat')?.icon, 'discord');
    assert.equal(m.notices.visibleNotices().find((n) => n.id === 'plain')?.icon, null);
  } finally {
    await m.unmount();
  }
});

test('/?notices-preview=1 shows one card of each kind, closed ones included, and writes nothing', async () => {
  const m = await mount({ url: 'http://localhost/?notices-preview=1', dismissed: ['@timon/settings:github-star'] });
  try {
    const ctx = m.pluginContext('acme');
    await m.React.act(async () => ctx.notices.push({ id: 'real', title: 'A real card' }));
    await m.until(() => cards().length === 8, 'the eight demonstration cards');
    assert.deepEqual(cards(), [
      '@timon/settings:github-star',
      '@timon/settings:discord',
      '@timon/settings:confirm-email-preview',
      '@timon/updates:update-0.2.0',
      '@timon/updates:build-ends-preview',
      '@timon/settings:license-paused-preview',
      '@timon/settings:license-refused-preview',
      '@timon/updates:feed.preview',
    ], 'more than three, in the demonstration\'s order; the closed star shows; the real card waits');
    const visuals = Array.from(document.querySelectorAll('[data-notice-card]'), (el) => el.getAttribute('data-notice-visual'));
    assert.deepEqual(visuals, ['github', 'discord', 'info', 'timon', 'warning', 'warning', 'warning', 'youtube']);
    assert.match(document.querySelector('[data-notice="@timon/settings:license-paused-preview"]')?.textContent ?? '', /Paid features are paused/);
    assert.match(document.querySelector('[data-notice="@timon/settings:license-refused-preview"]')?.textContent ?? '', /Enter my key/);
    assert.match(document.querySelector('[data-notice="@timon/settings:discord"]')?.textContent ?? '', /Join the community/);

    await m.click(document.querySelector('[data-notice="@timon/settings:discord"] [data-notice-dismiss]'));
    await m.until(() => cards().length === 7, 'closed in the page');
    // "Update" opens the update window's preview (`update-preview.test.ts`) and keeps the card.
    await m.click(document.querySelector('[data-notice="@timon/updates:update-0.2.0"] [data-notice-action="0"]'));
    assert.equal(cards().length, 7, 'Update keeps the card');
    await m.click(document.querySelector('[data-notice="@timon/settings:github-star"] [data-notice-action="0"]'));
    assert.deepEqual(m.opened, ['https://github.com/ai-timon/timon']);
    await m.until(() => cards().length === 6, 'the link opened and the card closed in the page');
    assert.deepEqual(m.writes, [], 'not a single write');
    assert.deepEqual([...m.server], ['@timon/settings:github-star'], 'the account\'s list untouched');
  } finally {
    await m.unmount();
  }

  const signedOut = await mount({ url: 'http://localhost/?notices-preview=1', session: false });
  try {
    await signedOut.until(() => true, 'a pass');
    assert.deepEqual(cards(), [], 'no session, no preview');
  } finally {
    await signedOut.unmount();
  }
});

test('nothing shows without a session, nor before the closed list is read', async () => {
  const m = await mount({ session: false });
  try {
    const ctx = m.pluginContext('acme');
    await m.React.act(async () => ctx.notices.push({ id: 'hello', title: 'Hello' }));
    await m.until(() => true, 'a pass');
    assert.equal(m.notices.dismissedNoticesLoaded(), false);
    assert.deepEqual(cards(), []);
  } finally {
    await m.unmount();
  }
});

test('at most three cards, warnings first, the others wait for room', async () => {
  const m = await mount();
  try {
    await settle(m);
    const ctx = m.pluginContext('acme');
    await m.React.act(async () => {
      ctx.notices.push({ id: 'a', title: 'A' });
      ctx.notices.push({ id: 'b', title: 'B' });
      ctx.notices.push({ id: 'c', title: 'C' });
      ctx.notices.push({ id: 'w', title: 'W', tone: 'warning' });
    });
    await m.until(() => cards().length === 3, 'three cards');
    assert.deepEqual(cards(), ['acme:w', 'acme:a', 'acme:b']);
    await m.React.act(async () => ctx.notices.remove('a'));
    await m.until(() => cards().includes('acme:c'), 'the waiting card shown');
    assert.deepEqual(cards(), ['acme:w', 'acme:b', 'acme:c']);
  } finally {
    await m.unmount();
  }
});

test('a closed card is remembered by the daemon and stays closed; one closed elsewhere never shows', async () => {
  const m = await mount({ dismissed: ['acme:elsewhere'] });
  try {
    const ctx = m.pluginContext('acme');
    await m.React.act(async () => {
      ctx.notices.push({ id: 'elsewhere', title: 'Closed on the desktop' });
      ctx.notices.push({ id: 'here', title: 'Close me' });
      ctx.notices.push({ id: 'sticky', title: 'No cross', dismissible: false });
    });
    await m.until(() => cards().length === 2, 'two cards');
    assert.deepEqual(cards(), ['acme:here', 'acme:sticky']);
    assert.ok(!document.querySelector('[data-notice="acme:sticky"] [data-notice-dismiss]'), 'no × when not dismissible');

    await m.click(document.querySelector('[data-notice="acme:here"] [data-notice-dismiss]'));
    await m.until(() => m.posts.length === 1, 'the closing sent');
    assert.deepEqual(m.posts, [{ id: 'acme:here' }]);
    assert.deepEqual(cards(), ['acme:sticky']);

    await m.React.act(async () => ctx.notices.push({ id: 'here', title: 'Back?' }));
    await m.until(() => true, 'a pass');
    assert.deepEqual(cards(), ['acme:sticky'], 'pushed again, a closed card stays closed');
  } finally {
    await m.unmount();
  }
});

test('showing the closed cards again: the daemon forgets them, and they come back in this page', async () => {
  const m = await mount({ dismissed: ['acme:elsewhere'] });
  try {
    const ctx = m.pluginContext('acme');
    await m.React.act(async () => {
      ctx.notices.push({ id: 'elsewhere', title: 'Closed on the desktop' });
      ctx.notices.push({ id: 'here', title: 'Close me' });
    });
    await m.until(() => cards().length === 1, 'one card');
    await m.click(document.querySelector('[data-notice="acme:here"] [data-notice-dismiss]'));
    await m.until(() => cards().length === 0, 'both closed');
    let ok = false;
    await m.React.act(async () => { ok = await m.notices.resetDismissedNotices(); });
    assert.equal(ok, true);
    assert.ok(m.writes.includes('DELETE /api/ui/prefs/dismissed-notices'));
    assert.deepEqual([...m.server], [], 'the account\'s list cleared');
    await m.until(() => cards().length === 2, 'both back');
  } finally {
    await m.unmount();
  }

  const refused = await mount({ session: false });
  try {
    assert.equal(await refused.notices.resetDismissedNotices(), false, 'refused: nothing changed');
  } finally {
    await refused.unmount();
  }
});

test('an action runs, opens its address, and closes the card for good when it says so', async () => {
  const m = await mount();
  try {
    await settle(m);
    const ctx = m.pluginContext('acme');
    const selected: string[] = [];
    await m.React.act(async () => ctx.notices.push({
      id: 'act', title: 'Act',
      actions: [
        { label: 'Open', href: 'https://example.com/x', dismiss: true },
        { label: 'Later', onSelect: () => { selected.push('later'); } },
      ],
    }));
    await m.until(() => cards().length === 1, 'the card');
    await m.click(document.querySelector('[data-notice-action="1"]'));
    assert.deepEqual(selected, ['later']);
    assert.deepEqual(cards(), ['acme:act'], 'an action without dismiss keeps the card');
    await m.click(document.querySelector('[data-notice-action="0"]'));
    assert.deepEqual(m.opened, ['https://example.com/x']);
    await m.until(() => cards().length === 0, 'closed by its action');
    assert.deepEqual(m.posts, [{ id: 'acme:act' }]);
  } finally {
    await m.unmount();
  }
});

test('an invalid notice is refused with its reason', async () => {
  const m = await mount();
  try {
    const ctx = m.pluginContext('acme');
    const refused = (notice: unknown, reason: RegExp) => assert.throws(() => ctx.notices.push(notice as never), reason);
    refused({ id: 'x', title: 'X', actions: [{ label: 'Go', href: 'javascript:alert(1)' }] }, /href/);
    refused({ id: 'x', title: 'X', actions: [{ label: 'Go', href: '//evil.example' }] }, /href/);
    refused({ id: 'bad id', title: 'X' }, /id/);
    refused({ id: 'x', title: '' }, /title/);
    refused({ id: 'x', title: 'X', tone: 'error' }, /tone/);
    refused({ id: 'x', title: 'X', icon: 'mastodon' }, /icon/);
    refused({ id: 'x', title: 'X', icon: 'https://evil.example/logo.svg' }, /icon/);
    refused({ id: 'x', title: 'X', actions: [{ label: 'Nothing' }] }, /onSelect/);
    refused({ id: 'x', title: 'X', actions: [1, 2, 3].map((n) => ({ label: `A${n}`, dismiss: true })) }, /at most/);
    assert.equal(m.notices.visibleNotices().length, 0);
  } finally {
    await m.unmount();
  }
});

test('a source of the `notices` slot pushes with useNotices(), under its plugin, and its cards leave with it', async () => {
  const m = await mount();
  try {
    await settle(m);
    const { useNotices } = await import('./notice-context');
    let seen: ReturnType<typeof useNotices> = null;
    function Source(): null {
      const notices = useNotices();
      seen = notices;
      const push = notices?.push;
      m.React.useEffect(() => { push?.({ id: 'from-source', title: 'From a source' }); }, [push]);
      return null;
    }
    let dispose: () => void = () => {};
    await m.React.act(async () => { dispose = m.slots.register({ slot: 'notices', pluginId: 'acme-source' }, Source); });
    await m.until(() => cards().includes('acme-source:from-source'), 'the source card');
    assert.equal(seen!.notices.length, 1, 'the source reads its own cards');
    assert.equal(document.querySelector('[data-notice-sources]')?.hasAttribute('hidden'), true, 'a source paints nothing visible');
    await m.React.act(async () => { dispose(); });
    await m.until(() => cards().length === 0, 'its card gone with it');
  } finally {
    await m.unmount();
  }
});

test('useNotices() and useNotice() are null outside their slots', async () => {
  const { useNotice, useNotices } = await import('./notice-context');
  const React = await import('react');
  const { renderToString } = await import('react-dom/server');
  let outside: unknown = 'unset';
  function Probe(): null { outside = [useNotices(), useNotice()]; return null; }
  renderToString(React.createElement(Probe));
  assert.deepEqual(outside, [null, null]);
});

test('the GitHub star waits for five different days of use, then offers the repository and closes for good', async () => {
  const { GitHubStarNotice, GITHUB_REPOSITORY_URL } = await import('./github-star-notice');
  const early = await mount({ usageDays: ['2026-01-01', '2026-01-02'] });
  try {
    await settle(early);
    await early.React.act(async () => { early.slots.register({ slot: 'notices', pluginId: '@timon/settings', key: 'github-star' }, GitHubStarNotice); });
    await early.until(() => true, 'a pass');
    assert.deepEqual(cards(), [], 'three days are not enough');
    assert.equal(JSON.parse(localStorage.getItem('timon-notices-usage-days')!).length, 3, 'today was counted');
  } finally {
    await early.unmount();
  }

  const m = await mount({ usageDays: ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'] });
  try {
    await settle(m);
    await m.React.act(async () => { m.slots.register({ slot: 'notices', pluginId: '@timon/settings', key: 'github-star' }, GitHubStarNotice); });
    await m.until(() => cards().includes('@timon/settings:github-star'), 'the star card');
    assert.match(document.querySelector('[data-notice]')?.textContent ?? '', /A star on GitHub\?/);
    assert.equal(document.querySelector('[data-notice-card]')?.getAttribute('data-notice-visual'), 'github');
    assert.equal(document.querySelector('[data-notice-action="0"]')?.textContent, 'Star on GitHub');
    await m.click(document.querySelector('[data-notice-action="0"]'));
    assert.deepEqual(m.opened, [GITHUB_REPOSITORY_URL]);
    await m.until(() => cards().length === 0, 'closed after starring');
    assert.deepEqual(m.posts, [{ id: '@timon/settings:github-star' }]);
  } finally {
    await m.unmount();
  }

  const closed = await mount({ dismissed: ['@timon/settings:github-star'], usageDays: ['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-04'] });
  try {
    await settle(closed);
    await closed.React.act(async () => { closed.slots.register({ slot: 'notices', pluginId: '@timon/settings', key: 'github-star' }, GitHubStarNotice); });
    await closed.until(() => true, 'a pass');
    assert.deepEqual(cards(), [], 'closed once, never again');
  } finally {
    await closed.unmount();
  }
});

/** `examples/plugin-notice`, loaded as the platform loads it: `react` and `@timon/ui` are the platform's own. */
async function loadExample(): Promise<{ apply: (ctx: unknown) => () => void; cleanup: () => void }> {
  const source = readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-notice', 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__noticeTestReact\n')
    .replace(/import \{([^}]*)\} from '@timon\/ui'\n/, 'const {$1} = globalThis.__noticeTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @timon/ui');
  const React = await import('react');
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  Object.assign(globalThis, { __noticeTestReact: React, __noticeTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'notice-example-'));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, platform);
  const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => () => void };
  return { apply: mod.apply, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the examples/plugin-notice template pushes its card and paints every card, with the SDK alone', async () => {
  const m = await mount();
  const example = await loadExample();
  try {
    await settle(m);
    let disposeProduct: () => void = () => {};
    await m.React.act(async () => {
      disposeProduct = m.slots.register({ slot: 'notices.card', fallback: true, pluginId: '@timon/settings' }, m.ProductNoticeCard as ComponentType);
    });
    const manifest = JSON.parse(readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-notice', 'package.json'), 'utf8')) as {
      timon: { id: string; apiVersion: number; client: { slots: string[] } };
    };
    assert.equal(manifest.timon.apiVersion, 17);
    const ctx = m.pluginContext(manifest.timon.id, manifest.timon.client.slots);
    await m.React.act(async () => { example.apply(ctx); });
    await m.until(() => document.querySelector('[data-compact-notice="welcome"]') !== null, 'the template painted its card');
    assert.equal(document.querySelector('[data-compact-notice="welcome"]')?.getAttribute('data-compact-icon'), 'timon', 'the template reads `icon`');
    assert.ok(!document.querySelector('[data-notice-card]'), 'the product card is not painted under it');

    await m.click(document.querySelector('[data-compact-dismiss]'));
    await m.until(() => cards().length === 0, 'closed');
    assert.deepEqual(m.posts, [{ id: 'example-notice:welcome' }]);

    // Another plugin's card, painted by the template; then the product's card back.
    await m.React.act(async () => m.pluginContext('acme').notices.push({ id: 'n', title: 'N' }));
    await m.until(() => document.querySelector('[data-compact-notice="n"]') !== null, 'the template paints every card');
    await m.React.act(async () => { (ctx as { dispose(): void }).dispose(); });
    await m.until(() => document.querySelector('[data-notice-card]') !== null, 'the product card back');
    await m.React.act(async () => { disposeProduct(); });
  } finally {
    example.cleanup();
    await m.unmount();
  }
});

test('the settings module registers the card and the star, and the root layout mounts the host', () => {
  const client = readFileSync(resolve(process.cwd(), 'src', 'plugins-client', 'settings.tsx'), 'utf8');
  assert.match(client, /ctx\.register\(\{ slot: NOTICE_CARD_SLOT, fallback: true \}, ProductNoticeCard\)/);
  assert.match(client, /ctx\.register\(\{ slot: NOTICES_SLOT, key: 'github-star' \}, GitHubStarNotice\)/);
  const layout = readFileSync(resolve(process.cwd(), 'src', 'app', 'layout.tsx'), 'utf8');
  assert.match(layout, /<NoticesHost \/>/);
});

test('the signed feed: its notices become cards, as text, a link opens and closes, a withdrawn one leaves', async () => {
  const { FeedNotices, UPDATES_NOTICES_URL } = await import('../updates/feed-notices');
  let feed: unknown[] = [
    { id: 'live-1', tone: 'info', icon: 'youtube', title: '<img src=x onerror="window.__pwned=1">', body: 'Thursday\n<b>6 pm</b>', link: 'https://timon-ai.com/live', endsAt: null },
    { id: 'plain', tone: 'warning', icon: 'https://evil.example/x.svg', title: 'Maintenance', body: 'Sunday.', link: 'javascript:alert(1)', endsAt: null },
    { id: 'over', tone: 'info', title: 'Gone', body: 'Already over.', link: null, endsAt: '2000-01-01T00:00:00.000Z' },
  ];
  const m = await mount({ routes: { [UPDATES_NOTICES_URL]: () => Response.json({ notices: feed }) } });
  try {
    await settle(m);
    await m.React.act(async () => { m.slots.register({ slot: 'notices', pluginId: '@timon/updates', key: 'feed' }, FeedNotices); });
    await m.until(() => cards().length === 2, 'the two live notices');
    assert.deepEqual(cards(), ['@timon/updates:feed.plain', '@timon/updates:feed.live-1'], 'warnings first; the ended one never shows');
    const live = document.querySelector('[data-notice="@timon/updates:feed.live-1"]')!;
    assert.match(live.textContent ?? '', /<img src=x/);
    assert.ok(!live.querySelector('img') && !live.querySelector('b'), 'title and body are text');
    assert.equal((globalThis as { __pwned?: number }).__pwned, undefined);
    const plain = document.querySelector('[data-notice="@timon/updates:feed.plain"]')!;
    assert.ok(!plain.querySelector('[data-notice-action]'), 'a link that is not https gives no action');
    assert.equal(live.querySelector('[data-notice-card]')?.getAttribute('data-notice-visual'), 'youtube', 'the feed names its logo');
    assert.equal(plain.querySelector('[data-notice-card]')?.getAttribute('data-notice-visual'), 'warning', 'an unknown logo falls back to the tone');
    await m.click(live.querySelector('[data-notice-action="0"]'));
    assert.deepEqual(m.opened, ['https://timon-ai.com/live']);
    await m.until(() => cards().length === 1, 'closed after the link');
    assert.deepEqual(m.posts, [{ id: '@timon/updates:feed.live-1' }]);
    feed = [];
    await m.React.act(async () => { document.dispatchEvent(new m.dom.window.Event('visibilitychange')); });
    await m.until(() => cards().length === 0, 'the withdrawn notice taken down');
  } finally {
    await m.unmount();
  }
});
