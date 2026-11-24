/**
 * The licence's bottom-left cards (docs/NOTICES.md), as the settings module
 * registers them: nothing for an outage within the offline tolerance nor for
 * Free; one card when paid features are paused or the licence was refused,
 * gone by itself once the rights are back; a late payment and the licence's
 * end as cards too; a closed card stays closed until the state changes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';

const CONTACT = '2026-11-18T07:35:07.000Z';
const EPISODE = String(Date.parse(CONTACT) / 1000);
const DAY = 86_400_000;

const PAID = {
  status: 'valid', reason: null, edition: 'expert', plan: 'Timon Pro', lifetime: false, expiresAt: null,
  subscriptionExpiresAt: null, paymentStatus: 'active', offlineSince: null, lapse: null,
  build: { channel: 'stable', expiresAt: null },
};
const FREE = { ...PAID, status: 'unlicensed', localFree: true, plan: 'Free', reason: 'missing', lifetime: true };

async function mount({ license, beta = false, dismissed = [] as string[], surfaces = { all: true } as unknown }: { license: unknown; beta?: boolean; dismissed?: string[]; surfaces?: unknown }) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
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
  // The global stream, so a test can publish `license_changed` as the daemon does.
  const streams: EventTarget[] = [];
  class FakeEventSource extends dom.window.EventTarget {
    static CLOSED = 2;
    readyState = 1;
    constructor() { super(); streams.push(this); }
    close() { this.readyState = 2; }
  }
  install('EventSource', FakeEventSource);
  const state = { license, beta };
  const server = new Set(dismissed);
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/ui/license') return Response.json(state.license);
    if (url === '/api/ui/capabilities') return Response.json({ beta: state.beta, surfaces });
    if (url === '/api/ui/prefs/dismissed-notices') {
      if (init?.method === 'POST') server.add((JSON.parse(String(init.body)) as { id: string }).id);
      return Response.json({ dismissed: [...server] });
    }
    return Response.json({}, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const capabilities = await import('@/lib/capabilities');
  capabilities.resetCapabilitiesCacheForTests();
  const slots = await import('@/lib/plugin-host/slots');
  slots.resetSlotsForTests();
  const notices = await import('@/lib/notices');
  notices.resetNoticesForTests();
  const { NoticesHost } = await import('./notices-host');
  const { LicenseNotices } = await import('./license-notices');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(NoticesHost)); });
  // As the client half of `@timon/settings` registers it.
  await React.act(async () => { slots.register({ slot: 'notices', key: 'license', pluginId: '@timon/settings' }, LicenseNotices); });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  await until(() => notices.dismissedNoticesLoaded(), 'the closed list read');
  /** The daemon's `license_changed`: the source reads the state again. */
  const publish = async (next: unknown) => {
    state.license = next;
    await React.act(async () => { for (const stream of streams) stream.dispatchEvent(new dom.window.Event('license_changed')); });
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    notices.resetNoticesForTests();
    slots.resetSlotsForTests();
    capabilities.resetCapabilitiesCacheForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, until, publish, unmount, server };
}

const cards = () => Array.from(document.querySelectorAll('[data-notice]'), (el) => el.getAttribute('data-notice'));
const text = (key: string) => document.querySelector(`[data-notice="${key}"]`)?.textContent ?? '';
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Lets the source's reads land before asserting that nothing showed. */
async function quiet(m: Awaited<ReturnType<typeof mount>>): Promise<void> {
  for (let i = 0; i < 5; i += 1) await m.React.act(async () => { await pause(10); });
}

test('a server out of reach within the offline tolerance shows nothing; Free shows nothing', async () => {
  for (const license of [
    { ...PAID, offlineSince: CONTACT },
    FREE,
    { ...FREE, reason: 'expired' },
    { ...FREE, reason: 'revoked' },
  ]) {
    const m = await mount({ license });
    try {
      await quiet(m);
      assert.deepEqual(cards(), [], JSON.stringify(license));
      assert.ok(!document.querySelector('[role="status"]'), 'no banner either');
    } finally {
      await m.unmount();
    }
  }
});

test('paid features paused: one warning card, no dates, gone by itself once the rights are back', async () => {
  const m = await mount({ license: { ...FREE, reason: 'expired', lapse: { cause: 'offline', since: CONTACT } } });
  try {
    const key = `@timon/settings:license-paused-${EPISODE}`;
    await m.until(() => cards().length === 1, 'the paused card');
    assert.deepEqual(cards(), [key]);
    assert.match(text(key), /Paid features are paused/);
    assert.match(text(key), /as soon as Timon reaches the license server/);
    assert.doesNotMatch(text(key), /2026|\d{1,2}:\d{2}/, 'no technical date');
    assert.equal(document.querySelector(`[data-notice="${key}"] [data-notice-card]`)?.getAttribute('data-notice-card'), 'warning');
    assert.equal(document.querySelectorAll(`[data-notice="${key}"] [data-notice-action]`).length, 1, 'one action');

    await m.publish(PAID);
    await m.until(() => cards().length === 0, 'the card gone with the rights back');
  } finally {
    await m.unmount();
  }
});

test('a licence refused for good: a card that leads to the key, replacing "paused" in place', async () => {
  const m = await mount({ license: { ...FREE, reason: 'expired', lapse: { cause: 'offline', since: CONTACT } } });
  try {
    await m.until(() => cards().length === 1, 'the paused card');
    await m.publish({ ...FREE, reason: 'revoked', lapse: { cause: 'refused', since: CONTACT } });
    const key = `@timon/settings:license-refused-${EPISODE}`;
    await m.until(() => cards().join() === key, 'the refused card, alone');
    assert.match(text(key), /Your license is no longer active/);
    const actions = Array.from(document.querySelectorAll(`[data-notice="${key}"] [data-notice-action]`), (el) => el.textContent);
    assert.deepEqual(actions, ['Enter my key']);
  } finally {
    await m.unmount();
  }
});

test('a closed card stays closed through restarts, and comes back only for a new episode', async () => {
  const lapse = { ...FREE, reason: 'expired', lapse: { cause: 'offline', since: CONTACT } };
  const m = await mount({ license: lapse, dismissed: [`@timon/settings:license-paused-${EPISODE}`] });
  try {
    await quiet(m);
    assert.deepEqual(cards(), [], 'closed by the account');
    const later = '2026-11-20T09:00:00.000Z';
    await m.publish({ ...lapse, lapse: { cause: 'offline', since: later } });
    await m.until(() => cards().length === 1, 'a new episode');
    assert.deepEqual(cards(), [`@timon/settings:license-paused-${Date.parse(later) / 1000}`]);
  } finally {
    await m.unmount();
  }
});

test('a late payment is a card (quiet during the beta); an account without the licence page gets no link', async () => {
  const until = new Date(Date.now() + 40 * DAY).toISOString();
  const m = await mount({ license: { ...PAID, paymentStatus: 'past_due', subscriptionExpiresAt: until } });
  try {
    const key = `@timon/settings:license-past-due-${until.slice(0, 10)}`;
    await m.until(() => cards().length === 1, 'the payment card');
    assert.deepEqual(cards(), [key]);
    assert.match(text(key), /Payment overdue/);
    assert.match(text(key), /Renew your subscription before/);
  } finally {
    await m.unmount();
  }
  const restricted = await mount({ license: { ...PAID, paymentStatus: 'past_due' }, surfaces: { all: false, pages: [], widgets: [], nav: [], plugins: [], themes: [], layouts: [] } });
  try {
    await restricted.until(() => cards().length === 1, 'the payment card');
    assert.equal(document.querySelectorAll('[data-notice-action]').length, 0, 'no link to a page that would answer 403');
  } finally {
    await restricted.unmount();
  }
  const beta = await mount({ license: { ...PAID, paymentStatus: 'past_due' }, beta: true });
  try {
    await quiet(beta);
    assert.deepEqual(cards(), []);
  } finally {
    await beta.unmount();
  }
});

test('the licence\'s end is a card at 14 days, a warning at 3', async () => {
  const soon = new Date(Date.now() + 10 * DAY).toISOString();
  const m = await mount({ license: { ...PAID, subscriptionExpiresAt: soon } });
  try {
    const key = `@timon/settings:license-ends-${soon.slice(0, 10)}`;
    await m.until(() => cards().length === 1, 'the end card');
    assert.match(text(key), /Your license ends on/);
    assert.equal(document.querySelector('[data-notice-card]')?.getAttribute('data-notice-card'), 'info');
    const urgent = new Date(Date.now() + 2 * DAY).toISOString();
    await m.publish({ ...PAID, subscriptionExpiresAt: urgent });
    await m.until(() => cards().join() === `@timon/settings:license-ends-${urgent.slice(0, 10)}-urgent`, 'the urgent stage');
    assert.equal(document.querySelector('[data-notice-card]')?.getAttribute('data-notice-card'), 'warning');
    await m.publish({ ...PAID, lifetime: true, subscriptionExpiresAt: urgent });
    await m.until(() => cards().length === 0, 'a lifetime plan has no end');
  } finally {
    await m.unmount();
  }
});
