/**
 * The update window's preview (`update-preview.ts`): `?update-preview=1`
 * opens the real window over a simulated 0.2.0 — highlights, changelog link,
 * a download that fills, "Downloaded and verified", two running missions,
 * then "Restart and install", which closes it with a toast. The selector
 * jumps between states. Nothing reaches the daemon or the desktop shell,
 * even when the shell is there; nothing without a session; and outside the
 * preview the host paints nothing.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { waitUntil } from '../../lib/test-wait';

type MountOptions = { url?: string; session?: boolean; downloadMs?: number; delayMs?: number };

async function mount({ url = 'http://localhost/?update-preview=1', session = true, downloadMs = 400, delayMs = 20 }: MountOptions = {}) {
  const { JSDOM } = await import('jsdom');
  const options = { url, pretendToBeVisual: true, userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/130 Timon/0.1.9' };
  const dom = new JSDOM('<html><body><div id="root"></div></body></html>', options as ConstructorParameters<typeof JSDOM>[1]);
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
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
  // The desktop shell is there: the preview must not touch it.
  const shellCalls: string[] = [];
  const record = (name: string) => (...args: unknown[]) => { shellCalls.push([name, ...args].join(' ')); return Promise.resolve({ phase: 'idle' }); };
  Object.assign(dom.window, {
    timonDesktop: {
      restartAfterSetup: record('restartAfterSetup'),
      updates: { state: record('state'), start: record('start'), cancel: record('cancel'), open: record('open'), install: record('install'), onState: () => { shellCalls.push('onState'); return () => undefined; } },
    },
  });
  const opened: string[] = [];
  dom.window.open = ((target: string) => { opened.push(target); return null; }) as typeof dom.window.open;
  const requests: string[] = [];
  install('fetch', async (input: string, init?: RequestInit) => {
    requests.push(`${init?.method ?? 'GET'} ${String(input)}`);
    if (String(input) === '/api/ui/prefs/dismissed-notices' && (init?.method ?? 'GET') === 'GET') {
      return session ? Response.json({ dismissed: [] }) : Response.json({ error: 'unauthorized' }, { status: 401 });
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
  const { createRequire } = await import('node:module');
  // The host loads sonner through `require` under the test runner: take the same instance.
  const { toast } = createRequire(`${process.cwd()}/package.json`)('sonner') as typeof import('sonner');
  const toastsBefore = toast.getHistory().length;
  const { NoticesHost } = await import('@/components/notices/notices-host');
  const { UpdatePreviewHost } = await import('./update-preview-host');
  const root = createRoot(document.getElementById('root')!);
  await React.act(async () => {
    root.render(React.createElement(React.Fragment, null,
      React.createElement(NoticesHost),
      React.createElement(UpdatePreviewHost, { downloadMs, delayMs })));
  });
  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const toasts = () => toast.getHistory().slice(toastsBefore).map((item) => ('title' in item ? String(item.title) : ''));
  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    await React.act(async () => { await new Promise((r) => setTimeout(r, 10)); });
    notices.resetNoticesForTests();
    slots.resetSlotsForTests();
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, until, click, unmount, requests, shellCalls, opened, toasts };
}

const windowEl = () => document.querySelector('[data-update-dialog]');
const step = () => document.querySelector('[data-update-dialog-step]')?.getAttribute('data-update-dialog-step') ?? null;
const line = () => document.querySelector('[data-update-line]')?.textContent ?? '';
const act = (marker: string) => document.querySelector(`[data-update-dialog-action="${marker}"]`);
const actions = () => Array.from(document.querySelectorAll('[data-update-dialog-action]'), (el) => el.getAttribute('data-update-dialog-action'));
const pick = (state: string) => document.querySelector(`[data-update-preview-state="${state}"]`);
const selector = () => document.querySelector('[data-update-preview-states]');

/** Only the notices host's own read of the closed cards: the session check it makes anyway. */
function assertNothingSent(m: Awaited<ReturnType<typeof mount>>): void {
  assert.deepEqual([...new Set(m.requests)], ['GET /api/ui/prefs/dismissed-notices'], 'no request but the session read');
  assert.deepEqual(m.shellCalls, [], 'the desktop shell is never called');
  assert.deepEqual(m.opened, [], 'no installer link opened');
}

test('?update-preview=1 plays the whole journey in the real window, and sends nothing', async () => {
  const m = await mount({ downloadMs: 1_500 });
  try {
    await m.until(() => windowEl() !== null, 'the window, open at once');
    assert.equal(windowEl()?.getAttribute('data-update-dialog'), '0.2.0');
    assert.match(windowEl()?.textContent ?? '', /Timon 0\.2\.0/);
    assert.equal(document.querySelectorAll('[data-update-highlights] li').length, 4, 'four highlights');
    assert.equal(document.querySelector('[data-update-changelog]')?.getAttribute('href'), 'https://docs.timon-ai.com/changelog');

    await m.until(() => step() === 'downloading' && /\d+%/.test(line()), 'the download, with its percentage');
    assert.match(line(), /of/, 'bytes received of the total');
    await m.until(() => step() === 'ready', 'verified');
    assert.equal(line(), 'Downloaded and verified');
    assert.equal(document.querySelector('[data-update-preview-state="verified"]')?.getAttribute('aria-pressed'), 'true');

    await m.click(act('install'));
    await m.until(() => step() === 'missions', 'the missions guard');
    assert.match(line(), /2 missions are running/);
    assert.deepEqual(actions(), ['wait', 'install-anyway'], 'Wait, then the main gesture at the right');

    await m.click(act('wait'));
    await m.until(() => step() === 'ready', 'back to Restart and install');
    await m.click(act('install'));
    await m.until(() => windowEl() === null, 'the window closes');
    assert.deepEqual(m.toasts(), ['Preview: nothing was installed.']);
    assertNothingSent(m);
  } finally {
    await m.unmount();
  }
});

test('the selector jumps to each state, and Install anyway closes the window', async () => {
  // Slow enough that a loaded machine still sees the resumed download and the install under way.
  const m = await mount({ downloadMs: 20_000, delayMs: 400 });
  try {
    await m.until(() => selector() !== null, 'the selector, inside the window');
    assert.deepEqual(Array.from(selector()!.querySelectorAll('button'), (el) => el.textContent),
      ['Download', 'Verified', 'Missions', 'Network error', 'Password cancelled']);

    await m.click(pick('network'));
    await m.until(() => step() === 'download-failed', 'the network error');
    assert.equal(line(), 'The download was interrupted.');
    await m.click(act('retry'));
    await m.until(() => step() === 'downloading', 'resumed');

    await m.click(pick('verified'));
    await m.until(() => step() === 'ready', 'verified');

    await m.click(pick('cancelled'));
    await m.until(() => step() === 'installing', 'the install asked for the password');
    await m.until(() => step() === 'ready', 'the prompt dismissed: back to Restart and install');
    assert.equal(windowEl() !== null, true, 'the window stays');

    await m.click(pick('missions'));
    await m.until(() => step() === 'missions', 'the missions guard');
    await m.click(act('install-anyway'));
    await m.until(() => windowEl() === null, 'the window closes');
    assert.deepEqual(m.toasts(), ['Preview: nothing was installed.']);
    assertNothingSent(m);
  } finally {
    await m.unmount();
  }
});

test('in /?notices-preview=1 the demonstration card\'s Update opens the simulated window, and the card stays', async () => {
  const m = await mount({ url: 'http://localhost/?notices-preview=1' });
  try {
    const card = () => document.querySelector('[data-notice="@timon/updates:update-0.2.0"]');
    await m.until(() => card() !== null, 'the demonstration card');
    assert.equal(windowEl(), null, 'not open before the click');
    await m.click(card()?.querySelector('[data-notice-action="0"]'));
    await m.until(() => windowEl() !== null && step() === 'downloading', 'the simulated window, downloading');
    assert.ok(card(), 'the card stays, to open the window again');
    assertNothingSent(m);
  } finally {
    await m.unmount();
  }
});

test('no session, no preview; outside the preview, no window and no selector', async () => {
  const signedOut = await mount({ session: false });
  try {
    await signedOut.until(() => signedOut.requests.length > 0, 'the session read');
    await signedOut.React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    assert.equal(windowEl(), null);
    assert.equal(selector(), null);
  } finally {
    await signedOut.unmount();
  }

  const plain = await mount({ url: 'http://localhost/' });
  try {
    await plain.until(() => plain.requests.length > 0, 'the session read');
    await plain.React.act(async () => { await new Promise((r) => setTimeout(r, 30)); });
    assert.equal(windowEl(), null);
    assert.equal(selector(), null);
    const { openUpdatePreview } = await import('./update-preview');
    assert.equal(openUpdatePreview(), false, 'no preview host registered');
  } finally {
    await plain.unmount();
  }
});

test('the simulator reaches neither the daemon nor the shell, and the real flow carries no preview branch', () => {
  const read = (file: string) => readFileSync(resolve(process.cwd(), 'src', 'components', 'updates', file), 'utf8');
  for (const file of ['update-preview.ts', 'update-preview-host.tsx']) {
    const source = read(file).replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    assert.doesNotMatch(source, /\bfetch\(|timonDesktop|useUpdateDownload|openUpdateDialog|provideUpdateDialog/, `${file} stays off the real channels`);
  }
  for (const file of ['update-flow.ts', 'update-dialog.tsx', 'update-notice.tsx', '../../lib/update-download.ts']) {
    assert.doesNotMatch(read(file), /preview/i, `${file} has no preview branch`);
  }
});
