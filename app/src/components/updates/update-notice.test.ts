/**
 * A newer Timon as a bottom-left notice card (docs/AUTO-UPDATE.md §10): the
 * product's source of the `notices` slot pushes "Timon x.y.z is available"
 * only while the daemon offers it, with one main gesture that goes through
 * `openUpdateDialog()`; closing it is "later" for that version, per account;
 * the end of the build turns it into a warning, or is a card of its own; the
 * desktop flow (download, verify, install, missions first) runs inside it;
 * "Update" opens the update window (`updates.dialog`), which runs the same
 * flow with the release's highlights; and the deprecated `updates.banner`
 * slot still loads a plugin but paints nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitUntil } from '../../lib/test-wait';
import type { UpdateStatus } from '../../lib/updates';
import { INSTALL_PAGE_URL } from '../../lib/update-settings';

const NOW = Date.now();
const DAY = 86_400_000;
const OFFER_STATUS: UpdateStatus = {
  installed: '0.1.6', channel: 'beta', enabled: true, state: 'available', checkedAt: new Date(NOW).toISOString(),
  available: {
    version: '0.1.8-rc.1', publishedAt: new Date(NOW).toISOString(),
    notes: 'Faster boot.',
    notesUrl: 'https://docs.timon-ai.com/changelog',
    artifacts: [
      { key: 'linux-x64-deb', os: 'linux', arch: 'x64', format: 'deb', name: 'timon.deb', url: 'https://github.com/acme/r/releases/download/v0.1.8-rc.1/timon.deb', size: 1 },
      { key: 'linux-x64-appimage', os: 'linux', arch: 'x64', format: 'appimage', name: 'Timon.AppImage', url: 'https://github.com/acme/r/releases/download/v0.1.8-rc.1/Timon.AppImage', size: 1 },
      { key: 'win-x64-nsis', os: 'win', arch: 'x64', format: 'nsis', name: 'Timon.Setup.exe', url: 'https://github.com/acme/r/releases/download/v0.1.8-rc.1/Timon.Setup.exe', size: 1 },
    ],
  },
  host: { os: 'linux', arch: 'x64' },
  buildExpiresAt: new Date(NOW + 40 * DAY).toISOString(),
};
const CARD = '@timon/updates:update-0.1.8-rc.1';

/** The desktop shell's `window.timonDesktop.updates`, recorded. */
function fakeShell(initial: unknown = { phase: 'idle' }, { installs = [] as unknown[] } = {}) {
  const calls: unknown[][] = [];
  const installQueue = [...installs];
  let listener: ((state: unknown) => void) | null = null;
  let state = initial;
  const reply = (name: string) => (...args: unknown[]) => { calls.push([name, ...args]); return Promise.resolve(state); };
  return {
    calls,
    bridge: {
      state: reply('state'),
      start: reply('start'),
      cancel: reply('cancel'),
      open: (...args: unknown[]) => { calls.push(['open', ...args]); return Promise.resolve({ status: 'opened' }); },
      install: (...args: unknown[]) => { calls.push(['install', ...args]); return Promise.resolve(installQueue.shift() ?? { status: 'failed', message: null }); },
      onState: (fn: (state: unknown) => void) => { listener = fn; return () => { listener = null; }; },
    },
    push: (next: unknown) => { state = next; listener?.(next); },
  };
}

type MountOptions = {
  dismissed?: string[];
  shell?: ReturnType<typeof fakeShell> | null;
  buildExpiresAt?: string | null;
  withLicenseNotices?: boolean;
};

async function mount(status: UpdateStatus | null, { dismissed = [], shell = null, buildExpiresAt = OFFER_STATUS.buildExpiresAt, withLicenseNotices = false }: MountOptions = {}) {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  // The desktop app on Linux. Set on the navigator: jsdom ignores a `userAgent`
  // option, and its own names the host (`(darwin)`, `(win32)`), so the system
  // the card offers an installer for would be the machine running the test.
  Object.defineProperty(dom.window.navigator, 'userAgent', { value: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Timon/0.1.6', configurable: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  // The update window is a Radix dialog: focus, Escape and its portal need these too.
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement',
    'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'KeyboardEvent', 'MouseEvent',
    'PointerEvent', 'FocusEvent', 'DocumentFragment', 'ShadowRoot', 'sessionStorage', 'localStorage'] as const) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    if (value !== undefined) install(key, value);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  if (shell) Object.assign(dom.window, { timonDesktop: { restartAfterSetup: async () => undefined, updates: shell.bridge } });
  const opened: string[] = [];
  dom.window.open = ((url: string) => { opened.push(url); return null; }) as typeof dom.window.open;
  const closed = new Set(dismissed);
  const posts: unknown[] = [];
  const requests: string[] = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url === '/api/ui/updates') return status ? Response.json(status) : Response.json({ error: 'forbidden' }, { status: 403 });
    if (url === '/api/ui/license') {
      return Response.json({ status: 'valid', reason: null, lifetime: true, build: { channel: 'beta', expiresAt: buildExpiresAt } });
    }
    if (url === '/api/ui/prefs/dismissed-notices') {
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { id: string };
        posts.push(body);
        closed.add(body.id);
      }
      return Response.json({ dismissed: [...closed] });
    }
    if (url === '/api/ui/capabilities') return Response.json({ beta: true, surfaces: { all: true } });
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
  const store = await import('@/lib/updates');
  store.resetUpdateStoreForTests();
  const notices = await import('@/lib/notices');
  notices.resetNoticesForTests();
  const dialog = await import('@/lib/update-open');
  dialog.resetUpdateDialogForTests();
  const { NoticesHost } = await import('@/components/notices/notices-host');
  const { UpdateNotice } = await import('./update-notice');
  const { LicenseNotices } = await import('@/components/notices/license-notices');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(NoticesHost));
  });
  // As the client half of `@timon/updates` registers it.
  await React.act(async () => { slots.register({ slot: 'notices', key: 'update', pluginId: '@timon/updates' }, UpdateNotice); });
  // As the client half of `@timon/settings` registers it: the licence's cards beside the update's.
  if (withLicenseNotices) await React.act(async () => { slots.register({ slot: 'notices', key: 'license', pluginId: '@timon/settings' }, LicenseNotices); });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const settle = async () => {
    await until(() => requests.includes('/api/ui/updates') && requests.includes('/api/ui/license'), 'the reads');
    await React.act(async () => { await new Promise((r) => setTimeout(r, 20)); });
  };
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    // An open window gives its focus back on a timer: let it run before jsdom goes.
    await React.act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    store.resetUpdateStoreForTests();
    notices.resetNoticesForTests();
    dialog.resetUpdateDialogForTests();
    slots.resetSlotsForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, slots, dialog, until, click, settle, unmount, requests, opened, posts };
}

const card = (key = CARD) => document.querySelector(`[data-notice="${key}"]`);
const text = (key = CARD) => card(key)?.textContent ?? '';
const action = (index: number, key = CARD) => card(key)?.querySelector(`[data-notice-action="${index}"]`) ?? null;
/** In the notice's order, main action first; the card paints it last, at the bottom right. */
const labels = (key = CARD) => Array.from(card(key)?.querySelectorAll('[data-notice-action]') ?? [])
  .sort((a, b) => Number(a.getAttribute('data-notice-action')) - Number(b.getAttribute('data-notice-action')))
  .map((el) => el.textContent);
const windowEl = () => document.querySelector('[data-update-dialog]');

test('the deprecated updates.banner slot still loads a plugin, says so once, and paints nothing', async () => {
  const m = await mount(OFFER_STATUS);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (message: string) => { warnings.push(String(message)); };
  try {
    assert.equal(m.slots.slotKind('updates.banner'), 'single');
    const Painted = () => m.React.createElement('div', { 'data-old-banner': '' });
    let dispose: () => void = () => {};
    await m.React.act(async () => { dispose = m.slots.register({ slot: 'updates.banner', pluginId: 'acme-banner' }, Painted); });
    await m.React.act(async () => { dispose(); dispose = m.slots.register({ slot: 'updates.banner', pluginId: 'acme-banner' }, Painted); });
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /`acme-banner`: the `updates\.banner` slot is deprecated and no longer painted/);
    await m.until(() => card() !== null, 'the update card');
    assert.ok(!document.querySelector('[data-old-banner]'), 'nothing paints the old slot');
    await m.React.act(async () => { dispose(); });
  } finally {
    console.warn = warn;
    await m.unmount();
  }
});

test('no offer, or no right to read it: no update card', async () => {
  for (const status of [null, { ...OFFER_STATUS, state: 'up_to_date' as const, available: null }, { ...OFFER_STATUS, state: 'off' as const }]) {
    const m = await mount(status);
    try {
      await m.settle();
      assert.ok(!card(), JSON.stringify(status?.state ?? 'forbidden'));
      assert.equal(document.querySelectorAll('[data-notice]').length, 0);
    } finally {
      await m.unmount();
    }
  }
});

test('in a browser the card says the version, its one action opens the window, which links the installer of this system', async () => {
  const m = await mount(OFFER_STATUS);
  try {
    await m.until(() => card() !== null, 'the update card');
    assert.equal(card()?.querySelector('[data-notice-card]')?.getAttribute('data-notice-card'), 'info');
    assert.equal(card()?.querySelector('[data-notice-card]')?.getAttribute('data-notice-visual'), 'timon', 'the Timon mark');
    assert.match(text(), /^Timon 0\.1\.8-rc\.1 is available/);
    assert.deepEqual(labels(), ['Update']);
    await m.click(action(0));
    await m.until(() => windowEl() !== null, 'the update window');
    const link = windowEl()?.querySelector('[data-update-dialog-action="installer"]');
    assert.equal(link?.getAttribute('href'), OFFER_STATUS.available!.artifacts[1]!.url, 'the AppImage, through openUpdateDialog()');
    assert.deepEqual(m.opened, [], 'nothing downloads by itself');
    assert.ok(card(), 'the action leaves the card');
  } finally {
    await m.unmount();
  }
});

test('in a browser with no installer for its system the window links the install page, never the release notes', async () => {
  const winOnly: UpdateStatus = {
    ...OFFER_STATUS,
    available: { ...OFFER_STATUS.available!, artifacts: OFFER_STATUS.available!.artifacts.filter((a) => a.os === 'win') },
  };
  const m = await mount(winOnly);
  try {
    await m.until(() => card() !== null, 'the update card');
    await m.click(action(0));
    await m.until(() => windowEl() !== null, 'the update window');
    const link = windowEl()?.querySelector('[data-update-dialog-action="installer"]');
    assert.equal(link?.getAttribute('href'), INSTALL_PAGE_URL);
    assert.equal(link?.textContent, 'All installers');
  } finally {
    await m.unmount();
  }
});

test('closing is later for that version, per account: the same version stays closed, a newer one comes back', async () => {
  const m = await mount(OFFER_STATUS);
  try {
    await m.until(() => card() !== null, 'the update card');
    await m.click(card()?.querySelector('[data-notice-dismiss]'));
    await m.until(() => card() === null, 'closed');
    assert.deepEqual(m.posts, [{ id: CARD }]);
  } finally {
    await m.unmount();
  }
  const same = await mount(OFFER_STATUS, { dismissed: [CARD] });
  try {
    await same.settle();
    assert.ok(!card());
  } finally {
    await same.unmount();
  }
  const newer = await mount({ ...OFFER_STATUS, available: { ...OFFER_STATUS.available!, version: '0.1.8-rc.2' } }, { dismissed: [CARD] });
  try {
    await newer.until(() => card('@timon/updates:update-0.1.8-rc.2') !== null, 'the newer version announced');
  } finally {
    await newer.unmount();
  }
});

test('a build about to stop makes the card a warning that says when; alone, it is a card of its own; the top banner no longer says it', async () => {
  const ending = new Date(NOW + 5 * DAY).toISOString();
  const m = await mount(OFFER_STATUS, { buildExpiresAt: ending, withLicenseNotices: true });
  try {
    await m.until(() => /This build stops running on/.test(text()), 'the end in the update card');
    assert.equal(card()?.querySelector('[data-notice-card]')?.getAttribute('data-notice-card'), 'warning');
    assert.equal(document.querySelectorAll('[data-notice]').length, 1, 'one card, not two');
    assert.doesNotMatch(document.body.textContent ?? '', /beta build stops running/, 'no top banner for the build');
  } finally {
    await m.unmount();
  }
  const day = ending.slice(0, 10);
  const alone = await mount({ ...OFFER_STATUS, state: 'up_to_date', available: null }, { buildExpiresAt: ending });
  try {
    await alone.until(() => card(`@timon/updates:build-ends-${day}`) !== null, 'the end of the build alone');
    assert.match(text(`@timon/updates:build-ends-${day}`), /This build stops running on/);
    assert.deepEqual(labels(`@timon/updates:build-ends-${day}`), []);
    assert.equal(card(`@timon/updates:build-ends-${day}`)?.querySelector('[data-notice-card]')?.getAttribute('data-notice-visual'), 'warning', 'the tone\'s icon');
  } finally {
    await alone.unmount();
  }
  // Closed while it was weeks away, it comes back once the end is urgent.
  const soon = new Date(NOW + 2 * DAY).toISOString();
  const urgent = await mount({ ...OFFER_STATUS, state: 'up_to_date', available: null }, { buildExpiresAt: soon, dismissed: [`@timon/updates:build-ends-${soon.slice(0, 10)}`] });
  try {
    await urgent.until(() => card(`@timon/updates:build-ends-${soon.slice(0, 10)}-urgent`) !== null, 'the urgent stage');
  } finally {
    await urgent.unmount();
  }
  // The offer put off while the end was weeks away comes back, as a warning, once the end is urgent.
  const putOff = await mount(OFFER_STATUS, { buildExpiresAt: ending, dismissed: [CARD] });
  try {
    await putOff.settle();
    assert.ok(!card(), 'the offer stays put off while the end is not urgent');
  } finally {
    await putOff.unmount();
  }
  const back = await mount(OFFER_STATUS, { buildExpiresAt: soon, dismissed: [CARD] });
  try {
    await back.until(() => card(`${CARD}-urgent`) !== null, 'the offer back at the urgent stage');
    assert.equal(card(`${CARD}-urgent`)?.querySelector('[data-notice-card]')?.getAttribute('data-notice-card'), 'warning');
    const { formatDate } = await import('@/lib/intl');
    const date = formatDate(soon, { year: 'numeric', month: 'numeric', day: 'numeric' });
    assert.ok(text(`${CARD}-urgent`).includes(`This build stops running on ${date}.`), 'the date said');
    assert.deepEqual(labels(`${CARD}-urgent`), ['Update']);
  } finally {
    await back.unmount();
  }
});

test('in the desktop app Update opens the window, which starts the shell\'s download: the card follows it — progress, cancel, refusal, then Install', async () => {
  const shell = fakeShell();
  const m = await mount(OFFER_STATUS, { shell });
  try {
    await m.until(() => labels().join() === 'Update', 'the card');
    await m.click(action(0));
    await m.until(() => windowEl() !== null, 'the update window');
    assert.deepEqual(shell.calls.filter(([name]) => name === 'start'), [['start']], 'no URL, path or version crosses');
    assert.deepEqual(m.opened, [], 'the shell downloads, not the browser');
    await m.React.act(async () => { (document.activeElement ?? windowEl()!).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await m.until(() => windowEl() === null, 'the window closed');

    const base = { version: '0.1.8-rc.1', name: 'Timon.AppImage', format: 'appimage' };
    await m.React.act(async () => { shell.push({ phase: 'downloading', ...base, received: 50_000_000, total: 200_000_000 }); });
    await m.until(() => /Downloading… 25%/.test(text()), 'the progress');
    assert.deepEqual(labels(), ['Cancel']);
    await m.click(action(0));
    assert.deepEqual(shell.calls.at(-1), ['cancel']);

    await m.React.act(async () => { shell.push({ phase: 'failed', ...base, code: 'insecure_redirect', resumable: false }); });
    await m.until(() => /unsafe address/.test(text()), 'the refusal said');
    assert.equal(card()?.querySelector('[data-notice-card]')?.getAttribute('data-notice-card'), 'warning');
    assert.deepEqual(labels(), ['Try again']);

    await m.React.act(async () => { shell.push({ phase: 'ready', ...base, total: 200_000_000 }); });
    await m.until(() => labels().join() === 'Install and restart', 'the verified AppImage');
    await m.React.act(async () => { shell.push({ phase: 'ready', version: '0.1.8-rc.1', name: 'timon.deb', format: 'deb', total: 1 }); });
    await m.until(() => labels().join() === 'Install', 'the verified .deb');

    // A file of an older offer is not this version's.
    await m.React.act(async () => { shell.push({ phase: 'ready', version: '0.1.7', name: 'old.deb', format: 'deb', total: 1 }); });
    await m.until(() => labels().join() === 'Update', 'back to Update');
  } finally {
    await m.unmount();
  }
});

test('Install: running missions are said first, Wait asks nothing, Install anyway confirms; each answer says what follows', async () => {
  const command = "sudo apt install '/home/user/.timon/updates/0.1.8-rc.1/timon.deb'";
  const shell = fakeShell({ phase: 'ready', version: '0.1.8-rc.1', name: 'timon.deb', format: 'deb', total: 1 }, {
    installs: [
      { status: 'missions', count: 2 },
      { status: 'missions', count: 2 },
      { status: 'guided', command, opened: true },
      { status: 'not_writable' },
      { status: 'failed', message: 'EBUSY' },
      { status: 'unsupported' },
    ],
  });
  const m = await mount(OFFER_STATUS, { shell });
  const installs = () => shell.calls.filter(([name]) => name === 'install');
  try {
    await m.until(() => labels().join() === 'Install', 'the install action');
    await m.click(action(0));
    await m.until(() => /2 missions are running\. Installing now stops them\./.test(text()), 'the running missions');
    assert.deepEqual(labels(), ['Install anyway', 'Wait']);
    assert.deepEqual(installs(), [['install', false]]);
    await m.click(action(1));
    await m.until(() => labels().join() === 'Install', 'back to Install');
    assert.equal(installs().length, 1);
    await m.click(action(0));
    await m.until(() => labels().join() === 'Install anyway,Wait', 'asked again');
    await m.click(action(0));
    await m.until(() => text().includes(command), 'the command of the .deb');
    assert.deepEqual(installs().at(-1), ['install', true]);
    assert.deepEqual(labels(), ['Copy']);

    // A new file starts over; the next answers come in order.
    await m.React.act(async () => { shell.push({ phase: 'ready', version: '0.1.8-rc.1', name: 'Timon.AppImage', format: 'appimage', total: 1 }); });
    await m.until(() => labels().join() === 'Install and restart', 'Install again');
    await m.click(action(0));
    await m.until(() => /cannot be written/.test(text()), 'the read-only folder');
    await m.click(action(0));
    assert.deepEqual(shell.calls.at(-1), ['open', 'folder']);

    await m.React.act(async () => { shell.push({ phase: 'ready', version: '0.1.8-rc.1', name: 'Timon.Setup.exe', format: 'nsis', total: 1 }); });
    await m.until(() => labels().join() === 'Install', 'Install again');
    await m.click(action(0));
    await m.until(() => /did not start\. Your current version is unchanged/.test(text()), 'the failure');
    assert.doesNotMatch(text(), /EBUSY/);
    // An older desktop cannot install: the installer opens as before.
    await m.click(action(0));
    await m.until(() => shell.calls.at(-1)?.[0] === 'open', 'the installer opened');
    assert.deepEqual(shell.calls.at(-1), ['open', 'installer']);
  } finally {
    await m.unmount();
  }
});

test('Install with no verified file left says so and downloads again', async () => {
  const shell = fakeShell({ phase: 'ready', version: '0.1.8-rc.1', name: 'Timon.Setup.exe', format: 'nsis', total: 1 }, { installs: [{ status: 'none' }] });
  const m = await mount(OFFER_STATUS, { shell });
  try {
    await m.until(() => labels().join() === 'Install', 'the install action');
    await m.click(action(0));
    await m.until(() => /no longer on this computer/.test(text()), 'the missing file said');
    assert.deepEqual(labels(), ['Download again']);
    await m.click(action(0));
    assert.deepEqual(shell.calls.at(-1), ['start'], 'no URL, path or version crosses');
  } finally {
    await m.unmount();
  }
});

test('Install: the system\'s password prompt shows Installing…; dismissing it goes back to Install, without an error', async () => {
  let answer: (outcome: unknown) => void = () => undefined;
  const pending = new Promise((resolve) => { answer = resolve; });
  const shell = fakeShell({ phase: 'ready', version: '0.1.8-rc.1', name: 'Timon-0.1.8-rc.1.pkg', format: 'pkg', total: 1 }, { installs: [pending] });
  const m = await mount(OFFER_STATUS, { shell });
  try {
    await m.until(() => labels().join() === 'Install', 'the install action');
    await m.click(action(0));
    await m.until(() => /Installing…/.test(text()), 'the installation under way');
    assert.deepEqual(labels(), [], 'nothing to click twice');
    await m.React.act(async () => { answer({ status: 'cancelled' }); await pending; });
    await m.until(() => labels().join() === 'Install', 'the prompt dismissed');
    assert.equal(card()?.querySelector('[data-notice-card]')?.getAttribute('data-notice-card'), 'info', 'nothing alarming');
  } finally {
    await m.unmount();
  }
});

test('openUpdateDialog() from elsewhere opens the window; a flow registered later takes over, and gives it back', async () => {
  const shell = fakeShell();
  const m = await mount(OFFER_STATUS, { shell });
  try {
    await m.until(() => card() !== null, 'the update card');
    await m.React.act(async () => { assert.equal(m.dialog.openUpdateDialog(), true, 'the card\'s source provides the window'); });
    await m.until(() => windowEl() !== null, 'the update window');
    assert.deepEqual(shell.calls.filter(([name]) => name === 'start'), [['start']]);
    await m.React.act(async () => { (document.activeElement ?? windowEl()!).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    await m.until(() => windowEl() === null, 'the window closed');
    const otherOpened: string[] = [];
    const dispose = m.dialog.provideUpdateDialog(() => { otherOpened.push('other'); });
    await m.click(action(0));
    assert.deepEqual(otherOpened, ['other'], 'the card\'s Update opens the newer flow');
    dispose();
    await m.click(action(0));
    await m.until(() => windowEl() !== null, 'the window again');
  } finally {
    await m.unmount();
  }
});

test('the updates module registers the card source and the window\'s fallback, and the banner is gone from the top bar', () => {
  const client = readFileSync(resolve(process.cwd(), 'src', 'plugins-client', 'updates.tsx'), 'utf8');
  assert.match(client, /ctx\.register\(\{ slot: NOTICES_SLOT, key: 'update' \}, UpdateNotice\)/);
  assert.match(client, /ctx\.register\(\{ slot: UPDATE_DIALOG_SLOT, fallback: true \}, ProductUpdateDialog\)/);
  assert.doesNotMatch(client, /UPDATES_BANNER_SLOT/);
  const topbar = readFileSync(resolve(process.cwd(), 'src', 'components', 'topbar.tsx'), 'utf8');
  assert.doesNotMatch(topbar, /Update/);
  assert.equal(existsSync(resolve(process.cwd(), 'src', 'components', 'updates', 'update-banner.tsx')), false);
  const index = readFileSync(resolve(process.cwd(), 'src', 'plugins-client', 'index.ts'), 'utf8');
  assert.match(index, /updatesClient,/);
});

// The update window the card opens (docs/AUTO-UPDATE.md §10, volet E).

const HIGHLIGHTED: UpdateStatus = {
  ...OFFER_STATUS,
  available: {
    ...OFFER_STATUS.available!,
    publishedAt: '2026-11-20T10:00:00.000Z',
    notes: '### Highlights\n- Updates install **from the app**\n- A notice card at the bottom left\n- Faster boot\n\n### Added\n- Not a highlight\n',
  },
};
const inWindow = (selector: string) => windowEl()?.querySelector(selector) ?? null;
const windowActions = () => Array.from(windowEl()?.querySelectorAll('[data-update-dialog-action]') ?? [], (el) => el.textContent);
const windowAction = (marker: string) => inWindow(`[data-update-dialog-action="${marker}"]`);
const escape = async (m: Awaited<ReturnType<typeof mount>>) => {
  await m.React.act(async () => { (document.activeElement ?? windowEl()!).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
  await m.until(() => windowEl() === null, 'the window closed');
};

test('the window: Timon x.y.z and its date, the highlights as text, the full changelog; without highlights, the link alone', async () => {
  const m = await mount(HIGHLIGHTED);
  try {
    await m.until(() => card() !== null, 'the update card');
    await m.click(action(0));
    await m.until(() => windowEl() !== null, 'the update window');
    const { formatDate } = await import('@/lib/intl');
    assert.match(inWindow('[data-update-dialog-body]')?.textContent ?? '', new RegExp(`^Timon 0\\.1\\.8-rc\\.1${formatDate('2026-11-20T10:00:00.000Z', 'long')}`));
    assert.equal(windowEl()?.getAttribute('role'), 'dialog');
    assert.equal(document.getElementById(windowEl()?.getAttribute('aria-labelledby') ?? '')?.textContent, 'Timon 0.1.8-rc.1', 'named for assistive technology');
    assert.deepEqual(Array.from(windowEl()?.querySelectorAll('[data-update-highlights] li') ?? [], (li) => li.textContent),
      ['Updates install from the app', 'A notice card at the bottom left', 'Faster boot']);
    assert.equal(inWindow('[data-update-changelog]')?.getAttribute('href'), 'https://docs.timon-ai.com/changelog');
    assert.equal(inWindow('[data-update-changelog]')?.textContent, 'See the full changelog');
    assert.deepEqual(windowActions(), ['Download the installer'], 'a browser downloads nothing: one link');
    assert.ok(!inWindow('[role="progressbar"]'));
  } finally {
    await m.unmount();
  }
  const bare = await mount(OFFER_STATUS);
  try {
    await bare.until(() => card() !== null, 'the update card');
    await bare.click(action(0));
    await bare.until(() => windowEl() !== null, 'the update window');
    assert.ok(!inWindow('[data-update-highlights]'), 'no section, no list');
    assert.ok(inWindow('[data-update-changelog]'), 'the changelog link stays');
  } finally {
    await bare.unmount();
  }
});

test('the window in the desktop app: progress in bytes and %, verified, then Restart and install calls install(false)', async () => {
  const shell = fakeShell(undefined, { installs: [{ status: 'restarting' }] });
  const m = await mount(HIGHLIGHTED, { shell });
  try {
    await m.until(() => labels().join() === 'Update', 'the card');
    await m.click(action(0));
    await m.until(() => windowEl() !== null, 'the update window');
    assert.deepEqual(shell.calls.filter(([name]) => name === 'start'), [['start']], 'opening the window downloads');

    const base = { version: '0.1.8-rc.1', name: 'Timon.AppImage', format: 'appimage' };
    await m.React.act(async () => { shell.push({ phase: 'downloading', ...base, received: 50_000_000, total: 200_000_000 }); });
    await m.until(() => /Downloading… 25%/.test(inWindow('[data-update-line]')?.textContent ?? ''), 'the progress');
    assert.match(inWindow('[data-update-line]')?.textContent ?? '', /\(50 MB of 200 MB\)/);
    assert.equal(inWindow('[role="progressbar"]')?.getAttribute('aria-valuenow'), '25');
    assert.deepEqual(windowActions(), ['Cancel']);
    // Cancelled from the window, it stays cancelled while the window is open.
    await m.click(windowAction('cancel'));
    await m.React.act(async () => { shell.push({ phase: 'idle' }); });
    await m.until(() => windowActions().join() === 'Download', 'Download again, by hand');
    assert.equal(shell.calls.filter(([name]) => name === 'start').length, 1);
    await m.click(windowAction('download'));
    assert.equal(shell.calls.filter(([name]) => name === 'start').length, 2);

    await m.React.act(async () => { shell.push({ phase: 'verifying', ...base, total: 200_000_000 }); });
    await m.until(() => /Verifying/.test(inWindow('[data-update-line]')?.textContent ?? ''), 'the verification');
    await m.React.act(async () => { shell.push({ phase: 'ready', ...base, total: 200_000_000 }); });
    await m.until(() => windowActions().join() === 'Restart and install', 'the verified file');
    assert.equal(inWindow('[data-update-line]')?.textContent, 'Downloaded and verified');
    assert.equal(inWindow('[role="progressbar"]')?.getAttribute('aria-valuenow'), '100');
    await m.click(windowAction('install'));
    await m.until(() => /restarting/.test(inWindow('[data-update-line]')?.textContent ?? ''), 'what follows');
    assert.deepEqual(shell.calls.filter(([name]) => name === 'install'), [['install', false]]);
  } finally {
    await m.unmount();
  }
});

test('the window\'s guard: N missions running, Wait asks nothing, Install anyway confirms', async () => {
  const shell = fakeShell({ phase: 'ready', version: '0.1.8-rc.1', name: 'Timon.Setup.exe', format: 'nsis', total: 1 }, {
    installs: [{ status: 'missions', count: 3 }, { status: 'missions', count: 3 }, { status: 'closing' }],
  });
  const m = await mount(OFFER_STATUS, { shell });
  const installs = () => shell.calls.filter(([name]) => name === 'install');
  try {
    await m.until(() => labels().join() === 'Install', 'the card at the verified file');
    await m.React.act(async () => { m.dialog.openUpdateDialog(); });
    await m.until(() => windowActions().join() === 'Restart and install', 'the window');
    assert.deepEqual(shell.calls.filter(([name]) => name === 'start'), [], 'a verified file is not downloaded again');
    await m.click(windowAction('install'));
    await m.until(() => /3 missions are running/.test(inWindow('[data-update-line]')?.textContent ?? ''), 'the running missions');
    assert.equal(inWindow('[data-update-line]')?.getAttribute('role'), 'alert');
    // The main gesture last, at the right.
    assert.deepEqual(windowActions(), ['Wait', 'Install anyway']);
    await m.click(windowAction('wait'));
    await m.until(() => windowActions().join() === 'Restart and install', 'back');
    assert.equal(installs().length, 1);
    await m.click(windowAction('install'));
    await m.until(() => windowActions().join() === 'Wait,Install anyway', 'asked again');
    await m.click(windowAction('install-anyway'));
    await m.until(() => /closes so it can be replaced/.test(inWindow('[data-update-line]')?.textContent ?? ''), 'the installer runs');
    assert.deepEqual(installs(), [['install', false], ['install', false], ['install', true]]);
    // The card says the same thing: one flow.
    assert.match(text(), /closes so it can be replaced/);
    await escape(m);
  } finally {
    await m.unmount();
  }
});

test('a plugin that takes updates.dialog paints the window from useUpdateDialog(); the host still names it', async () => {
  const m = await mount(HIGHLIGHTED);
  try {
    await m.until(() => card() !== null, 'the update card');
    const { useUpdateDialog } = await import('./update-dialog-context');
    const Mine = () => {
      const value = useUpdateDialog();
      return value ? m.React.createElement('p', { 'data-mine': value.step }, `${value.version}: ${value.highlights.length}`) : null;
    };
    await m.React.act(async () => { m.slots.register({ slot: 'updates.dialog', pluginId: 'acme-window' }, Mine); });
    await m.click(action(0));
    await m.until(() => inWindow('[data-mine]') !== null, 'the plugin\'s window');
    assert.equal(inWindow('[data-mine]')?.textContent, '0.1.8-rc.1: 3');
    assert.equal(inWindow('[data-mine]')?.getAttribute('data-mine'), 'offer');
    assert.ok(!inWindow('[data-update-dialog-body]'), 'the product\'s window is replaced');
    assert.equal(document.getElementById(windowEl()?.getAttribute('aria-labelledby') ?? '')?.textContent, 'Timon 0.1.8-rc.1');
  } finally {
    await m.unmount();
  }
});
