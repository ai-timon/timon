/**
 * The "Confirm your email address" card (docs/NOTICES.md): shown to a signed-in
 * account whose address is not confirmed, never to a confirmed one nor without
 * an account; one action, the Profile's confirmation row; closed per account
 * and per address; gone on its own once the address is confirmed; not shown on
 * the Profile, where the row already is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitUntil } from '../../lib/test-wait';

type Me = { user: { email: string } | null; emailUnverified?: boolean };

const USER = { id: 'u1', email: 'member@example.com', name: 'Member', status: 'active', is_superadmin: false, created_at: 1, last_login_at: null, avatar_url: null };

async function mount({ me, dismissed = [] as string[], url = 'http://localhost/' }: { me: Me; dismissed?: string[]; url?: string }) {
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
  const server = new Set(dismissed);
  const posts: unknown[] = [];
  const state = { me };
  install('fetch', async (input: string, init?: RequestInit) => {
    const target = String(input);
    if (target === '/api/ui/prefs/dismissed-notices') {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { id: string };
        posts.push(body);
        server.add(body.id);
      }
      return Response.json({ dismissed: [...server] });
    }
    if (target === '/api/ui/auth/me') {
      return Response.json({ user: state.me.user ? { ...USER, ...state.me.user } : null, emailUnverified: state.me.emailUnverified });
    }
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
  const { refreshMe } = await import('@/hooks/use-me');
  // The account is a module-level value shared by the whole file: read it anew.
  await refreshMe();
  const { NoticesHost } = await import('./notices-host');
  const { ConfirmEmailNotice } = await import('./confirm-email-notice');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(NoticesHost)); });
  await React.act(async () => { slots.register({ slot: 'notices', pluginId: '@timon/settings', key: 'confirm-email' }, ConfirmEmailNotice); });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  await until(() => notices.dismissedNoticesLoaded(), 'the closed list read');
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  /** The account changes daemon-side, and the page reads it again. */
  const setMe = async (next: Me) => {
    state.me = next;
    await React.act(async () => { await refreshMe(); });
  };
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
  return { React, notices, until, click, setMe, unmount, posts };
}

const cards = () => Array.from(document.querySelectorAll('[data-notice]'), (el) => el.getAttribute('data-notice'));
const confirmCard = () => document.querySelector('[data-notice^="@timon/settings:confirm-email-"]');
/** Lets every effect and read settle where the card would show. */
const idle = (m: { React: typeof import('react') }) => m.React.act(async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setTimeout(r, 2));
});

test('an unconfirmed account gets the card: a title, one line, one action to the Profile\'s row', async () => {
  const m = await mount({ me: { user: { email: 'member@example.com' }, emailUnverified: true } });
  try {
    await m.until(() => confirmCard() !== null, 'the confirm card');
    const { confirmEmailNoticeId } = await import('./confirm-email-notice');
    assert.deepEqual(cards(), [`@timon/settings:${confirmEmailNoticeId('member@example.com')}`]);
    const card = confirmCard()!;
    assert.match(card.textContent ?? '', /Confirm your email address/);
    assert.match(card.textContent ?? '', /It lets you reset your password by email\./);
    assert.equal(card.querySelectorAll('[data-notice-action]').length, 1, 'one action');
    // jsdom does not navigate: the action's target is read from the store.
    const [notice] = m.notices.visibleNotices();
    assert.deepEqual(notice?.actions.map((a) => ({ href: a.href, dismiss: a.dismiss })), [{ href: '/profile#confirm-email', dismiss: undefined }],
      'the Profile\'s row; following it keeps the card until the address is confirmed');
    assert.equal(notice?.dismissible, true);
  } finally {
    await m.unmount();
  }
});

test('nothing for a confirmed account, nor for a session without an account', async () => {
  for (const me of [{ user: { email: 'member@example.com' }, emailUnverified: false }, { user: null, emailUnverified: true }] satisfies Me[]) {
    const m = await mount({ me });
    try {
      await idle(m);
      assert.ok(!confirmCard(), `no card for ${JSON.stringify(me)}`);
    } finally {
      await m.unmount();
    }
  }
});

test('the card goes away on its own once the address is confirmed', async () => {
  const m = await mount({ me: { user: { email: 'member@example.com' }, emailUnverified: true } });
  try {
    await m.until(() => confirmCard() !== null, 'the confirm card');
    await m.setMe({ user: { email: 'member@example.com' }, emailUnverified: false });
    await m.until(() => confirmCard() === null, 'the card gone');
    assert.deepEqual(m.posts, [], 'taken away, not closed: a later unconfirmed address may ask again');
  } finally {
    await m.unmount();
  }
});

test('closed, it stays closed for the account, and a new unconfirmed address asks again', async () => {
  const { confirmEmailNoticeId } = await import('./confirm-email-notice');
  const first = await mount({ me: { user: { email: 'member@example.com' }, emailUnverified: true } });
  const key = `@timon/settings:${confirmEmailNoticeId('member@example.com')}`;
  try {
    await first.until(() => confirmCard() !== null, 'the confirm card');
    await first.click(document.querySelector(`[data-notice="${key}"] [aria-label="Close"]`));
    await first.until(() => confirmCard() === null, 'the card closed');
    assert.deepEqual(first.posts, [{ id: key }], 'remembered by the daemon, for this account');
  } finally {
    await first.unmount();
  }

  const again = await mount({ me: { user: { email: 'member@example.com' }, emailUnverified: true }, dismissed: [key] });
  try {
    await idle(again);
    assert.ok(!confirmCard(), 'a closed card does not come back on the next load');
    await again.setMe({ user: { email: 'new@example.com' }, emailUnverified: true });
    await again.until(() => cards().includes(`@timon/settings:${confirmEmailNoticeId('new@example.com')}`), 'the card for the new address');
  } finally {
    await again.unmount();
  }
});

test('not on the Profile, where the confirmation row already is', async () => {
  const m = await mount({ me: { user: { email: 'member@example.com' }, emailUnverified: true }, url: 'http://localhost/profile' });
  try {
    await idle(m);
    assert.ok(!confirmCard(), 'no second call to the same action');
  } finally {
    await m.unmount();
  }
});

test('the address tag is stable, case-blind and does not carry the address', async () => {
  const { addressTag, confirmEmailNoticeId } = await import('./confirm-email-notice');
  assert.equal(addressTag('Member@Example.com '), addressTag('member@example.com'));
  assert.notEqual(addressTag('member@example.com'), addressTag('other@example.com'));
  const id = confirmEmailNoticeId('member@example.com');
  assert.match(id, /^confirm-email-[0-9a-f]{8}$/);
  assert.doesNotMatch(id, /member|example/);
});

test('the settings module registers the source in the `notices` slot', () => {
  const client = readFileSync(resolve(process.cwd(), 'src/plugins-client/settings.tsx'), 'utf8');
  assert.match(client, /ctx\.register\(\{ slot: NOTICES_SLOT, key: 'confirm-email' \}, ConfirmEmailNotice\)/);
});
