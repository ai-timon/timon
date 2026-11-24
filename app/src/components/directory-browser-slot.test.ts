/**
 * The folder browser's slot `directory.picker`: declared at boot, the
 * product's browser is painted while nothing claims it, a plugin loaded
 * through the real client loader takes its place, lists and chooses through
 * the host, and its removal gives the product's browser back. The
 * `examples/plugin-directory-picker` template does the same with the SDK alone.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ComponentType } from 'react';
import { waitUntil } from '../lib/test-wait';
import type { DirectoryPick } from '@/lib/directory-pick';

// Signed and versioned: on a remote machine its browser half runs here only as the twin of this computer's copy.
const ACME = { id: 'acme-directory-picker', state: 'active', version: '1.0.0', signature: { hash: 'h1' }, client: { url: '/x', rev: '1', slots: ['directory.picker'] } };

const LEVELS: Record<string, unknown> = {
  '/srv': { path: '/srv', parent: '/', entries: [{ name: 'vault', path: '/srv/vault', hidden: false }], truncated: false, home: '/home/robin', roots: ['/'] },
  '/srv/vault': { path: '/srv/vault', parent: '/srv', entries: [{ name: 'notes', path: '/srv/vault/notes', hidden: false }, { name: '.git', path: '/srv/vault/.git', hidden: true }], truncated: false, home: '/home/robin', roots: ['/'] },
  '/srv/vault/notes': { path: '/srv/vault/notes', parent: '/srv/vault', entries: [], truncated: false, home: '/home/robin', roots: ['/'] },
};

/** File mode (TODO #791): the files of a level, served when the read carries `files`. */
const FILES: Record<string, Array<{ name: string; path: string; hidden: boolean }>> = {
  '/srv/vault': [{ name: 'acme.tgz', path: '/srv/vault/acme.tgz', hidden: false }, { name: '.secret.tgz', path: '/srv/vault/.secret.tgz', hidden: true }],
};

async function mount(plugins: unknown[] = []) {
  const { JSDOM } = await import('jsdom');
  // A window driving another machine: "Browse…" goes to its daemon.
  const dom = new JSDOM('<html data-timon-machine="nas-01"><body><div id="root"></div></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'self', 'document', 'navigator', 'HTMLElement', 'HTMLInputElement', 'HTMLButtonElement', 'HTMLFormElement',
    'Element', 'Node', 'NodeFilter', 'MutationObserver', 'CustomEvent', 'Event', 'SubmitEvent', 'KeyboardEvent', 'MouseEvent',
    'PointerEvent', 'FocusEvent', 'DocumentFragment', 'ShadowRoot', 'sessionStorage', 'localStorage'] as const) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    if (value !== undefined) install(key, value);
  }
  install('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
  install('requestAnimationFrame', dom.window.requestAnimationFrame.bind(dom.window));
  install('cancelAnimationFrame', dom.window.cancelAnimationFrame.bind(dom.window));
  install('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const listed: string[] = [];
  install('fetch', async (input: string) => {
    const url = String(input);
    // On a remote machine a browser half runs only if this computer has it too (`remote-plugins.ts`).
    if (url === '/api/ui/plugins' || url === '/api/ui/plugins/local') return Response.json({ plugins });
    if (url.startsWith('/api/ui/host/directories')) {
      const params = new URL(url, 'http://localhost').searchParams;
      const path = params.get('path') ?? '/srv';
      listed.push(params.has('files') ? `${path} files=${params.get('files')}` : path);
      // A file out of the filter, named by its path: its folder, nothing selected (the daemon's answer).
      if (path === '/srv/vault/notes.md' && params.has('files')) return Response.json({ ...(LEVELS['/srv/vault'] as object), files: FILES['/srv/vault'] });
      const level = LEVELS[path];
      if (level && params.has('files')) return Response.json({ ...(level as object), files: FILES[path] ?? [] });
      return Response.json(level ?? { error: 'not_found' }, { status: level ? 200 : 404 });
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
  const loader = await import('@/lib/plugin-host/loader');
  loader.resetClientPluginsForTests();
  const { useDirectoryPicker, ProductDirectoryBrowser } = await import('./directory-browser');
  const context = await import('./directory-browser-context');

  const root = createRoot(document.getElementById('root')!);
  let pick: ((current: string) => Promise<DirectoryPick>) | null = null;
  let pickFile: ((current: string, accept?: readonly string[]) => Promise<DirectoryPick>) | null = null;
  function Host() {
    const picker = useDirectoryPicker();
    pick = picker.pick;
    pickFile = picker.pickFile;
    return picker.dialog;
  }
  await React.act(async () => { root.render(React.createElement(Host)); });

  const until = (condition: () => boolean, what: string) => waitUntil(React.act, condition, what);
  const click = async (el: Element | null | undefined) => {
    assert.ok(el, 'element to click');
    await React.act(async () => { (el as HTMLElement).click(); });
  };
  const buttonNamed = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
  /** Opens the browser for `current` and hands back the pending pick (boxed: awaiting `open` must not await the pick). */
  const open = async (current: string): Promise<{ result: Promise<DirectoryPick> }> => {
    let result: Promise<DirectoryPick> | null = null;
    await React.act(async () => { result = pick!(current); });
    return { result: result! };
  };
  const openFile = async (current: string, accept: readonly string[]): Promise<{ result: Promise<DirectoryPick> }> => {
    let result: Promise<DirectoryPick> | null = null;
    await React.act(async () => { result = pickFile!(current, accept); });
    return { result: result! };
  };
  const productBrowsers = () => document.querySelectorAll('ul[aria-label="Folders"]').length;
  const occupants = () => slots.slotEntries('directory.picker').map((e) => e.pluginId);
  /** The product's browser, registered as the bundled half of `@timon/settings` does. */
  const registerProduct = async () => {
    let dispose: () => void = () => {};
    // The host on screen re-renders on a slot change.
    await React.act(async () => { dispose = slots.register({ slot: 'directory.picker', fallback: true, pluginId: '@timon/settings' }, ProductDirectoryBrowser); });
    return dispose;
  };

  const unmount = async () => {
    await React.act(async () => { root.unmount(); });
    loader.setLoadClientModuleForTests(null);
    loader.resetClientPluginsForTests();
    slots.resetSlotsForTests();
    // Radix restores the focus on a timer after the dialog closes.
    await new Promise((r) => setTimeout(r, 50));
    setLocale(previousLocale);
    dom.window.close();
    for (const [k, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, k, descriptor);
      else delete (globalThis as Record<string, unknown>)[k];
    }
  };
  return { React, context, slots, loader, listed, until, click, buttonNamed, open, openFile, productBrowsers, occupants, registerProduct, unmount };
}

type Mounted = Awaited<ReturnType<typeof mount>>;

function acmeBrowser(m: Mounted): ComponentType {
  const { React, context } = m;
  return function AcmeBrowser() {
    const host = context.useDirectoryBrowser();
    const [path, setPath] = React.useState<string | null>(null);
    if (!host) return null;
    return React.createElement('div', { 'data-acme': host.initialPath },
      React.createElement('button', {
        type: 'button', 'data-acme-read': '',
        onClick: () => void host.read('/srv/vault/notes').then((out) => { if (out.ok) setPath(out.listing.path); }),
      }, 'read'),
      React.createElement('button', { type: 'button', 'data-acme-choose': '', disabled: !path, onClick: () => { if (path) host.choose(path); } }, 'choose'));
  };
}

test('the slot is declared at boot, and an empty slot still paints the product browser', async () => {
  const m = await mount();
  try {
    assert.equal(m.slots.slotKind('directory.picker'), 'single');
    const { result } = await m.open('/srv/vault');
    await m.until(() => !!m.buttonNamed('notes'), 'the product browser, without any occupant');
    await m.click(m.buttonNamed('Cancel'));
    assert.deepEqual(await result, { status: 'cancelled' });

    const dispose = await m.registerProduct();
    assert.equal(m.slots.slotEntries('directory.picker')[0]?.fallback, true);
    const { result: again } = await m.open('/srv/vault');
    await m.until(() => !!m.buttonNamed('notes'), 'the product browser through the slot');
    assert.equal(m.productBrowsers(), 1);
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.equal(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent, 'Choose a folder', 'the host names the dialog');
    await m.click(m.buttonNamed('Cancel'));
    assert.deepEqual(await again, { status: 'cancelled' });
    await m.React.act(async () => { dispose(); });
  } finally {
    await m.unmount();
  }
});

test('the settings module registers the product browser as the fallback, and the forms ask through the host', () => {
  const source = readFileSync(resolve(process.cwd(), 'src', 'plugins-client', 'settings.tsx'), 'utf8');
  assert.match(source, /ctx\.register\(\{ slot: DIRECTORY_PICKER_SLOT, fallback: true \}, ProductDirectoryBrowser\)/);
  for (const form of ['src/components/settings/settings-row.tsx', 'src/components/project-edit-dialog.tsx', 'src/components/agent-editor/agent-editor.tsx']) {
    assert.match(readFileSync(resolve(process.cwd(), form), 'utf8'), /useDirectoryPicker\(\)/, `${form} asks for a folder through the host`);
  }
});

test('a plugin takes the slot, reads and chooses through the host, and its removal gives the product browser back', async () => {
  const m = await mount([ACME]);
  try {
    const dispose = await m.registerProduct();
    m.loader.setLoadClientModuleForTests(async () => ({
      apply(ctx) { ctx.slots.register({ slot: 'directory.picker' }, acmeBrowser(m)); },
    }));
    await m.React.act(async () => { await m.loader.syncClientPlugins(); });
    assert.equal(m.occupants()[0], 'acme-directory-picker', 'the replacement wins over the fallback');

    const { result } = await m.open('/srv/vault');
    await m.until(() => !!document.querySelector('[data-acme="/srv/vault"]'), 'the replacement, told the form\'s folder');
    assert.equal(m.productBrowsers(), 0, 'the product browser is not painted under it');
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.equal(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent, 'Choose a folder', 'the host still names the dialog');
    await m.click(document.querySelector('[data-acme-read]'));
    await m.until(() => !(document.querySelector('[data-acme-choose]') as HTMLButtonElement | null)?.disabled, 'the level read');
    assert.deepEqual(m.listed, ['/srv/vault/notes'], 'the daemon was asked, nothing else');
    await m.click(document.querySelector('[data-acme-choose]'));
    assert.deepEqual(await result, { status: 'chosen', path: '/srv/vault/notes' });

    m.loader.setLoadClientModuleForTests(null);
    await m.React.act(async () => { m.loader.resetClientPluginsForTests(); });
    const { result: again } = await m.open('/srv/vault');
    await m.until(() => m.productBrowsers() === 1, 'the product browser back');
    await m.click(m.buttonNamed('Cancel'));
    assert.deepEqual(await again, { status: 'cancelled' });
    await m.React.act(async () => { dispose(); });
  } finally {
    await m.unmount();
  }
});

/** `examples/plugin-directory-picker`, loaded as the platform loads it: `react` and `@timon/ui` are the platform's own. */
async function loadExample(): Promise<{ apply: (ctx: unknown) => void; cleanup: () => void }> {
  const source = readFileSync(resolve(process.cwd(), '..', 'examples', 'plugin-directory-picker', 'lib', 'client.js'), 'utf8');
  const platform = source
    .replace(/import React from 'react'\n/, 'const React = globalThis.__directoryPickerTestReact\n')
    .replace(/import \{([^}]*)\} from '@timon\/ui'\n/, 'const {$1} = globalThis.__directoryPickerTestUi\n');
  assert.notEqual(platform, source, 'the client still imports react and @timon/ui');
  const React = await import('react');
  const { UI_KIT } = await import('@/lib/plugin-host/ui-kit');
  Object.assign(globalThis, { __directoryPickerTestReact: React, __directoryPickerTestUi: UI_KIT });
  const dir = mkdtempSync(join(tmpdir(), 'directory-picker-example-'));
  const file = join(dir, 'client.mjs');
  writeFileSync(file, platform);
  const mod = await import(pathToFileURL(file).href) as { apply: (ctx: unknown) => void };
  return { apply: mod.apply, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('the examples/plugin-directory-picker template browses and chooses with the SDK alone', async () => {
  const m = await mount();
  const example = await loadExample();
  try {
    const disposeProduct = await m.registerProduct();
    const disposers: Array<() => void> = [];
    await m.React.act(async () => example.apply({
      id: 'example-directory-picker',
      slots: { register: (options: { slot: string }, Component: ComponentType) => {
        const dispose = m.slots.register({ ...options, pluginId: 'example-directory-picker' }, Component);
        disposers.push(dispose);
        return dispose;
      } },
    }));
    assert.equal(m.occupants()[0], 'example-directory-picker');
    const { result } = await m.open('/srv/vault');
    await m.until(() => document.querySelector('[data-breadcrumb]')?.textContent === '/srv/vault', 'the opening level');
    assert.equal(m.productBrowsers(), 0);
    assert.ok(!document.querySelector('[data-folder=".git"]'), 'hidden folders left out');
    await m.click(document.querySelector('[data-folder="notes"]'));
    await m.until(() => document.querySelector('[data-breadcrumb]')?.textContent === '/srv/vault/notes', 'the subfolder');
    await m.click(document.querySelector('[data-breadcrumb-choose]'));
    assert.deepEqual(await result, { status: 'chosen', path: '/srv/vault/notes' });
    await m.React.act(async () => { for (const d of disposers.splice(0)) d(); });
    const { result: again } = await m.open('/srv/vault');
    await m.until(() => m.productBrowsers() === 1, 'the product browser back');
    await m.click(m.buttonNamed('Cancel'));
    assert.deepEqual(await again, { status: 'cancelled' });
    await m.React.act(async () => { disposeProduct(); });
  } finally {
    example.cleanup();
    await m.unmount();
  }
});

test('file mode: an occupant written for folders cannot answer a file request with a folder', async () => {
  const m = await mount([ACME]);
  try {
    const dispose = await m.registerProduct();
    m.loader.setLoadClientModuleForTests(async () => ({
      apply(ctx) { ctx.slots.register({ slot: 'directory.picker' }, acmeBrowser(m)); },
    }));
    await m.React.act(async () => { await m.loader.syncClientPlugins(); });
    const { result } = await m.openFile('/srv/vault', ['.tgz']);
    await m.until(() => !!document.querySelector('[data-acme="/srv/vault"]'), 'the replacement');
    const dialog = document.querySelector('[role="dialog"]')!;
    assert.equal(document.getElementById(dialog.getAttribute('aria-labelledby')!)?.textContent, 'Choose a file', 'the host names a file request');
    await m.click(document.querySelector('[data-acme-read]'));
    await m.until(() => !(document.querySelector('[data-acme-choose]') as HTMLButtonElement | null)?.disabled, 'the level read');
    assert.deepEqual(m.listed, ['/srv/vault/notes files=.tgz'], 'the read carried the filter');
    await m.click(document.querySelector('[data-acme-choose]'));
    assert.ok(document.querySelector('[role="dialog"]'), 'a folder does not close a file request');
    // The host's frame still closes it: Escape answers cancelled.
    await m.React.act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.deepEqual(await result, { status: 'cancelled' });
    m.loader.setLoadClientModuleForTests(null);
    await m.React.act(async () => { m.loader.resetClientPluginsForTests(); dispose(); });
  } finally {
    await m.unmount();
  }
});

test('file mode: an occupant cannot choose a file the daemon opened out of the filter', async () => {
  const m = await mount([ACME]);
  try {
    const dispose = await m.registerProduct();
    m.loader.setLoadClientModuleForTests(async () => ({
      apply(ctx) {
        ctx.slots.register({ slot: 'directory.picker' }, function PinnedBrowser() {
          const host = m.context.useDirectoryBrowser();
          const [read, setRead] = m.React.useState(false);
          if (!host) return null;
          const pinned = '/srv/vault/notes.md';
          return m.React.createElement('div', { 'data-pinned': '' },
            m.React.createElement('button', { type: 'button', 'data-pinned-read': '', onClick: () => void host.read(pinned).then(() => setRead(true)) }, 'read'),
            m.React.createElement('button', { type: 'button', 'data-pinned-choose': '', disabled: !read, onClick: () => host.choose(pinned) }, 'choose'));
        });
      },
    }));
    await m.React.act(async () => { await m.loader.syncClientPlugins(); });
    const { result } = await m.openFile('/srv/vault', ['.tgz']);
    await m.until(() => !!document.querySelector('[data-pinned]'), 'the replacement');
    await m.click(document.querySelector('[data-pinned-read]'));
    await m.until(() => !(document.querySelector('[data-pinned-choose]') as HTMLButtonElement | null)?.disabled, 'the pinned read');
    assert.deepEqual(m.listed, ['/srv/vault/notes.md files=.tgz']);
    await m.click(document.querySelector('[data-pinned-choose]'));
    assert.ok(document.querySelector('[role="dialog"]'), 'a file the daemon did not serve does not close the request');
    await m.React.act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    assert.deepEqual(await result, { status: 'cancelled' });
    m.loader.setLoadClientModuleForTests(null);
    await m.React.act(async () => { m.loader.resetClientPluginsForTests(); dispose(); });
  } finally {
    await m.unmount();
  }
});

test('file mode: the examples/plugin-directory-picker template lists the files and uses the one clicked', async () => {
  const m = await mount();
  const example = await loadExample();
  try {
    const disposers: Array<() => void> = [];
    await m.React.act(async () => example.apply({
      id: 'example-directory-picker',
      slots: { register: (options: { slot: string }, Component: ComponentType) => {
        const dispose = m.slots.register({ ...options, pluginId: 'example-directory-picker' }, Component);
        disposers.push(dispose);
        return dispose;
      } },
    }));
    const { result } = await m.openFile('/srv/vault', ['.tgz', '.zip']);
    await m.until(() => !!document.querySelector('[data-file="acme.tgz"]'), 'the archive listed');
    assert.ok(!document.querySelector('[data-file=".secret.tgz"]'), 'hidden files left out');
    assert.ok(!document.querySelector('[data-breadcrumb-choose]'), 'no folder button in file mode');
    assert.deepEqual(m.listed, ['/srv/vault files=.tgz,.zip']);
    await m.click(document.querySelector('[data-file="acme.tgz"]'));
    assert.deepEqual(await result, { status: 'chosen', path: '/srv/vault/acme.tgz' });
    await m.React.act(async () => { for (const d of disposers.splice(0)) d(); });
  } finally {
    example.cleanup();
    await m.unmount();
  }
});
