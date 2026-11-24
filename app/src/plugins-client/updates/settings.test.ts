/**
 * Settings › System › Updates, painted: the status row, "Check" asking the
 * daemon then showing its answer or "Check failed" with "Retry", "Update"
 * going through the shared door, and a member without `settings:write`
 * seeing the state without the button or the switch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { waitUntil } from '../../lib/test-wait';
import type { UpdateStatus } from '../../lib/updates';

const CHECKED = new Date(Date.now() - 2 * 3_600_000).toISOString();
const UP_TO_DATE: UpdateStatus = {
  installed: '0.1.8', channel: 'beta', enabled: true, state: 'up_to_date', checkedAt: CHECKED,
  available: null, host: { os: 'linux', arch: 'x64' }, buildExpiresAt: null,
};
const OFFER: UpdateStatus = {
  ...UP_TO_DATE,
  state: 'available',
  available: {
    version: '0.1.9', publishedAt: CHECKED, notes: 'Faster.', notesUrl: 'https://docs.timon-ai.com/changelog',
    artifacts: [{ key: 'linux-x64-appimage', os: 'linux', arch: 'x64', format: 'appimage', name: 'Timon.AppImage', url: 'https://example.com/Timon.AppImage', size: 1 }],
  },
};

type Answer = { status: number; body: unknown };

async function mount({ status, canWrite, check, notices = true }: { status: UpdateStatus; canWrite: boolean; check?: () => Answer; notices?: boolean }) {
  let noticesValue = notices;
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  // A browser on Linux. Set on the navigator: jsdom ignores a `userAgent`
  // option, and its own names the host (`(darwin)`, `(win32)`).
  Object.defineProperty(dom.window.navigator, 'userAgent', { value: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130', configurable: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'Event', 'MouseEvent',
    'MutationObserver', 'DocumentFragment', 'sessionStorage', 'localStorage',
    // The "…" menu (Radix: portal, focus scope, typeahead) reads these too.
    'NodeFilter', 'CustomEvent', 'KeyboardEvent', 'FocusEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    if (value !== undefined) install(key, value);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const requests: string[] = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    requests.push(`${init?.method ?? 'GET'} ${url}`);
    if (url === '/api/ui/updates') return Response.json(status);
    if (url === '/api/ui/updates/check') {
      const answer = check?.() ?? { status: 200, body: status };
      return Response.json(answer.body, { status: answer.status });
    }
    if (url === '/api/ui/settings') {
      if (init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { key: string; value: boolean };
        requests[requests.length - 1] += ` ${body.key}=${String(body.value)}`;
        if (body.key === 'TIMON_NOTICES_CHECK') noticesValue = body.value;
        return Response.json({ ok: true, setting: { key: body.key, value: body.value, source: 'db' } });
      }
      return Response.json({ settings: [{ key: 'TIMON_UPDATES_CHECK', value: status.enabled }, { key: 'TIMON_NOTICES_CHECK', value: noticesValue }] });
    }
    if (url === '/api/ui/prefs/dismissed-notices') return Response.json({ dismissed: [] });
    if (url === '/api/ui/auth/me') {
      return Response.json({ user: { id: 'u1', email: 'a@example.com', name: 'A', status: 'active', is_superadmin: false, created_at: 0, last_login_at: null, avatar_url: null }, needsSetup: false, prefs: {}, can: { 'settings:write': canWrite } });
    }
    return Response.json({}, { status: 404 });
  });

  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const { setLocale, getLocale } = await import('@/lib/i18n');
  const previousLocale = getLocale();
  setLocale('en');
  const store = await import('@/lib/updates');
  store.resetUpdateStoreForTests();
  const opener = await import('@/lib/update-open');
  opener.resetUpdateDialogForTests();
  const { refreshMe } = await import('@/hooks/use-me');
  await refreshMe();
  const { UpdatesSettings } = await import('./settings');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => { root.render(React.createElement(UpdatesSettings)); });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    // An open menu's focus scope dispatches its unmount event on a zero timeout: let it land in this DOM.
    await React.act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    store.resetUpdateStoreForTests();
    opener.resetUpdateDialogForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  const openMenu = async () => {
    const trigger = document.querySelector('[data-row-menu]');
    assert.ok(trigger, 'the "…" button');
    await React.act(async () => {
      trigger.dispatchEvent(new window.MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    });
  };
  return { React, opener, until, click, openMenu, unmount, requests };
}

const row = () => document.querySelector('[data-update-settings]');
const action = () => document.querySelector('[data-update-settings-action]');
const noticesSwitch = () => document.querySelector('[data-update-settings-notices]');

test('up to date: the version, when it was checked, and "Check" asking the daemon', async () => {
  const m = await mount({ status: UP_TO_DATE, canWrite: true });
  try {
    await m.until(() => row()?.getAttribute('data-update-settings') === 'upToDate', 'the status');
    assert.match(row()?.textContent ?? '', /Timon 0\.1\.8/);
    assert.match(row()?.textContent ?? '', /Up to date · checked 2 hr ago/);
    assert.equal(action()?.getAttribute('data-update-settings-action'), 'check');
    await m.click(action());
    await m.until(() => m.requests.includes('POST /api/ui/updates/check'), 'the check');
    await m.until(() => action()?.getAttribute('data-update-settings-action') === 'check', 'the answer');
  } finally {
    await m.unmount();
  }
});

test('a check without an answer says so and offers "Retry"', async () => {
  const m = await mount({ status: UP_TO_DATE, canWrite: true, check: () => ({ status: 502, body: { error: 'down' } }) });
  try {
    await m.until(() => action() !== null, 'the button');
    await m.click(action());
    await m.until(() => row()?.getAttribute('data-update-settings') === 'failed', 'the failure');
    assert.match(row()?.textContent ?? '', /Check failed/);
    assert.equal(action()?.getAttribute('data-update-settings-action'), 'retry');
  } finally {
    await m.unmount();
  }
});

test('a member without settings:write sees the state, not the button', async () => {
  const m = await mount({ status: UP_TO_DATE, canWrite: false });
  try {
    await m.until(() => row()?.getAttribute('data-update-settings') === 'upToDate', 'the status');
    await m.React.act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    assert.ok(!action(), 'no action for a member without settings:write');
    assert.equal(m.requests.includes('POST /api/ui/updates/check'), false);
  } finally {
    await m.unmount();
  }
});

test('a newer version: "Update" opens the shared update flow, else links the installer', async () => {
  const m = await mount({ status: OFFER, canWrite: false });
  try {
    await m.until(() => row()?.getAttribute('data-update-settings') === 'available', 'the offer');
    assert.match(row()?.textContent ?? '', /Timon 0\.1\.9 available/);
    // Nothing provides the flow yet: the installer of this system, by hand.
    assert.equal(action()?.getAttribute('href'), 'https://example.com/Timon.AppImage');
    let opened = 0;
    await m.React.act(async () => { m.opener.provideUpdateDialog(() => { opened += 1; }); });
    await m.until(() => action()?.tagName === 'BUTTON', 'the button');
    await m.click(action());
    assert.equal(opened, 1);
  } finally {
    await m.unmount();
  }
});

test('the menu names the link by where it goes: this system\'s installer, else every installer', async () => {
  const download = () => document.querySelector('[data-update-settings-download]');
  for (const [status, state, label, href] of [
    [OFFER, 'available', 'Download the installer', 'https://example.com/Timon.AppImage'],
    [UP_TO_DATE, 'upToDate', 'All installers', 'https://timon-ai.com/install'],
  ] as const) {
    const m = await mount({ status, canWrite: false });
    try {
      await m.until(() => row()?.getAttribute('data-update-settings') === state, 'the status');
      await m.openMenu();
      await m.until(() => download() !== null, 'the menu');
      assert.equal(download()?.textContent, label);
      assert.equal(download()?.getAttribute('href'), href);
    } finally {
      await m.unmount();
    }
  }
});

test('"Announcements" in the menu: a switch that writes TIMON_NOTICES_CHECK', async () => {
  const m = await mount({ status: UP_TO_DATE, canWrite: true, notices: false });
  try {
    await m.until(() => m.requests.includes('GET /api/ui/settings'), 'the settings read');
    await m.until(() => row()?.getAttribute('data-update-settings') === 'upToDate', 'the status');
    await m.openMenu();
    await m.until(() => noticesSwitch()?.getAttribute('data-update-settings-notices') === 'off', 'the switch, off');
    const item = noticesSwitch();
    assert.equal(item?.getAttribute('role'), 'menuitemcheckbox');
    assert.equal(item?.getAttribute('aria-checked'), 'false');
    assert.equal(item?.hasAttribute('data-disabled'), false);
    assert.match(item?.textContent ?? '', /Announcements/);
    await m.click(item);
    await m.until(() => m.requests.includes('PUT /api/ui/settings TIMON_NOTICES_CHECK=true'), 'the write');
    await m.until(() => noticesSwitch()?.getAttribute('aria-checked') === 'true', 'the switch, on');
  } finally {
    await m.unmount();
  }
});

test('the update check off: "Announcements" shows off and cannot be moved', async () => {
  const m = await mount({ status: { ...UP_TO_DATE, enabled: false, state: 'off' }, canWrite: true, notices: true });
  try {
    await m.until(() => m.requests.includes('GET /api/ui/settings'), 'the settings read');
    await m.until(() => row()?.getAttribute('data-update-settings') === 'off', 'the status');
    await m.openMenu();
    await m.until(() => noticesSwitch() !== null, 'the switch');
    const item = noticesSwitch();
    assert.equal(item?.getAttribute('aria-checked'), 'false');
    assert.equal(item?.hasAttribute('data-disabled'), true);
    await m.click(item);
    assert.equal(m.requests.some((r) => r.startsWith('PUT /api/ui/settings')), false);
  } finally {
    await m.unmount();
  }
});

test('without settings:write: no "Announcements" switch, no settings read', async () => {
  const m = await mount({ status: UP_TO_DATE, canWrite: false });
  try {
    await m.until(() => row()?.getAttribute('data-update-settings') === 'upToDate', 'the status');
    await m.openMenu();
    await m.until(() => document.querySelector('[data-update-settings-notes]') !== null, 'the menu');
    assert.equal(noticesSwitch(), null);
    assert.equal(m.requests.includes('GET /api/ui/settings'), false);
  } finally {
    await m.unmount();
  }
});

test('"Show closed cards again" in the menu, for any account: it forgets this account\'s closings', async () => {
  const m = await mount({ status: UP_TO_DATE, canWrite: false });
  try {
    await m.until(() => row()?.getAttribute('data-update-settings') === 'upToDate', 'the status');
    await m.openMenu();
    await m.until(() => document.querySelector('[data-update-settings-show-notices]') !== null, 'the entry');
    assert.match(document.querySelector('[data-update-settings-show-notices]')?.textContent ?? '', /Show closed cards again/);
    await m.click(document.querySelector('[data-update-settings-show-notices]'));
    await m.until(() => m.requests.includes('DELETE /api/ui/prefs/dismissed-notices'), 'the reset sent');
    assert.equal(m.requests.filter((r) => r.startsWith('DELETE ')).length, 1);
  } finally {
    await m.unmount();
  }
});
