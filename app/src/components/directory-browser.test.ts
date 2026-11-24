/**
 * TIM-0136 on screen: driving another machine, "Browse…" lists that
 * machine's folders through the daemon, never this computer's OS dialog;
 * on this computer's own daemon the desktop dialog is kept.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import type { DirectoryPick } from '@/lib/directory-pick';

type Env = {
  React: typeof import('react');
  render: (element: import('react').ReactElement) => Promise<void>;
  act: (run: () => Promise<void> | void) => Promise<void>;
  fetched: string[];
  nativeCalls: Array<string | undefined>;
};

const LEVELS: Record<string, unknown> = {
  '/srv/vault': { path: '/srv/vault', parent: '/srv', entries: [{ name: 'notes', path: '/srv/vault/notes', hidden: false }, { name: '.obsidian', path: '/srv/vault/.obsidian', hidden: true }], truncated: false, home: '/home/robin', roots: ['/'] },
  '/srv/vault/notes': { path: '/srv/vault/notes', parent: '/srv/vault', entries: [], truncated: false, home: '/home/robin', roots: ['/'] },
};

const BIN = { path: '/usr/local/bin', parent: '/usr/local', entries: [{ name: 'lib', path: '/usr/local/bin/lib', hidden: false }], truncated: false, home: '/home/robin', roots: ['/'] };
const BIN_FILES = [{ name: 'claude', path: '/usr/local/bin/claude', hidden: false }, { name: 'codex', path: '/usr/local/bin/codex', hidden: false }];
const FILE_LEVELS: Record<string, unknown> = {
  '/usr/local/bin': { ...BIN, files: BIN_FILES },
  '/usr/local/bin/claude': { ...BIN, files: BIN_FILES, selected: '/usr/local/bin/claude' },
  // A pinned file out of the filter: the daemon opens its folder, nothing selected.
  '/usr/local/bin/notes.md': { ...BIN, files: BIN_FILES },
};

async function withDom(machine: string, run: (env: Env) => Promise<void>): Promise<void> {
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM(`<html data-timon-machine="${machine}"><body><div id="root"></div></body></html>`, { url: 'http://localhost/', pretendToBeVisual: true });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const install = (key: string, value: unknown) => {
    if (!saved.has(key)) saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  };
  for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'MutationObserver', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'KeyboardEvent', 'MouseEvent', 'PointerEvent', 'Event', 'CustomEvent', 'NodeFilter', 'HTMLInputElement', 'HTMLButtonElement', 'DocumentFragment', 'ShadowRoot', 'FocusEvent', 'sessionStorage', 'localStorage']) {
    const value = (dom.window as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    install(key, key === 'window' ? dom.window : typeof value === 'function' && /^[a-z]/.test(key) ? value.bind(dom.window) : value);
  }
  install('IS_REACT_ACT_ENVIRONMENT', true);
  const fetched: string[] = [];
  const realFetch = globalThis.fetch;
  install('fetch', async (url: string) => {
    fetched.push(url);
    const params = new URL(url, 'http://localhost').searchParams;
    const path = params.get('path') ?? '/srv/vault';
    if (params.has('files')) {
      // File mode: a file path opens its folder with the file selected.
      const named = FILE_LEVELS[path];
      if (named) return new Response(JSON.stringify(named), { status: 200 });
    }
    const level = LEVELS[path];
    return new Response(JSON.stringify(level ?? { error: 'not_found' }), { status: level ? 200 : 404 });
  });
  const nativeCalls: Array<string | undefined> = [];
  (dom.window as unknown as { timonDesktop: unknown }).timonDesktop = {
    restartAfterSetup: async () => {},
    selectDirectory: async (defaultPath?: string) => { nativeCalls.push(defaultPath); return '/home/local/Vault'; },
  };
  const React = await import('react');
  install('React', React);
  const { createRoot } = await import('react-dom/client');
  const root = createRoot(document.getElementById('root')!);
  const act = async (fn: () => Promise<void> | void) => { await React.act(async () => { await fn(); }); };
  const render = async (element: import('react').ReactElement) => { await act(() => { root.render(element); }); };
  try {
    await run({ React, render, act, fetched, nativeCalls });
  } finally {
    await React.act(async () => { root.unmount(); });
    // Radix restores the focus on a timer after the dialog closes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    install('fetch', realFetch);
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
    dom.window.close();
  }
}

async function harness(env: Env): Promise<{ pick: () => Promise<DirectoryPick> }> {
  const { useDirectoryPicker } = await import('./directory-browser');
  let pick: ((current: string) => Promise<DirectoryPick>) | null = null;
  function Host() {
    const picker = useDirectoryPicker();
    pick = picker.pick;
    return picker.dialog;
  }
  await env.render(env.React.createElement(Host));
  return { pick: () => pick!('/srv/vault') };
}

const buttonNamed = (text: string) => Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text);
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

test('on a remote machine, the folders come from its daemon and the native dialog stays shut', async () => {
  await withDom('nas-01', async (env) => {
    const { pick } = await harness(env);
    let result: Promise<DirectoryPick> | null = null;
    await env.act(async () => { result = pick(); await settle(); });
    assert.deepEqual(env.fetched, ['/api/ui/host/directories?path=%2Fsrv%2Fvault']);
    assert.ok(buttonNamed('notes'), 'the remote folder is listed');
    assert.ok(!buttonNamed('.obsidian'), 'hidden folders are folded away');
    await env.act(async () => { buttonNamed('notes')!.click(); await settle(); });
    assert.equal(env.fetched.at(-1), '/api/ui/host/directories?path=%2Fsrv%2Fvault%2Fnotes');
    await env.act(async () => { buttonNamed('Choose this folder')!.click(); await settle(); });
    assert.deepEqual(await result!, { status: 'chosen', path: '/srv/vault/notes' });
    assert.deepEqual(env.nativeCalls, []);
  });
});

test('cancelling the folder browser hands back cancelled', async () => {
  await withDom('nas-01', async (env) => {
    const { pick } = await harness(env);
    let result: Promise<DirectoryPick> | null = null;
    await env.act(async () => { result = pick(); await settle(); });
    await env.act(async () => { buttonNamed('Cancel')!.click(); await settle(); });
    assert.deepEqual(await result!, { status: 'cancelled' });
  });
});

test('Enter in the path field does not submit a form around the host', async () => {
  await withDom('nas-01', async (env) => {
    const { useDirectoryPicker } = await import('./directory-browser');
    let pick: ((current: string) => Promise<DirectoryPick>) | null = null;
    let submitted = 0;
    function Host() {
      const picker = useDirectoryPicker();
      pick = picker.pick;
      return env.React.createElement('form', { onSubmit: (e: { preventDefault: () => void }) => { e.preventDefault(); submitted += 1; } }, picker.dialog);
    }
    await env.render(env.React.createElement(Host));
    await env.act(async () => { void pick!('/srv/vault'); await settle(); });
    await env.act(async () => { buttonNamed('Open')!.click(); await settle(); });
    assert.equal(submitted, 0);
    assert.equal(env.fetched.length, 2, 'the typed path was opened');
  });
});

test('on this computer, the desktop keeps its OS dialog', async () => {
  await withDom('local', async (env) => {
    const { pick } = await harness(env);
    let picked: DirectoryPick | null = null;
    await env.act(async () => { picked = await pick(); });
    assert.deepEqual(picked, { status: 'chosen', path: '/home/local/Vault' });
    assert.deepEqual(env.nativeCalls, ['/srv/vault']);
    assert.deepEqual(env.fetched, []);
  });
});

test('a second pick while the browser is open settles the first as cancelled and answers the second', async () => {
  await withDom('nas-01', async (env) => {
    const { pick } = await harness(env);
    let first: Promise<DirectoryPick> | null = null;
    let second: Promise<DirectoryPick> | null = null;
    await env.act(async () => { first = pick(); await settle(); });
    await env.act(async () => { second = pick(); await settle(); });
    assert.deepEqual(await first!, { status: 'cancelled' }, 'the first caller is not left waiting');
    assert.equal(document.querySelectorAll('[role="dialog"]').length, 1, 'one browser on screen');
    await env.act(async () => { buttonNamed('notes')!.click(); await settle(); });
    await env.act(async () => { buttonNamed('Choose this folder')!.click(); await settle(); });
    assert.deepEqual(await second!, { status: 'chosen', path: '/srv/vault/notes' });
  });
});

test('unmounting the form while the browser is open settles the pick as cancelled', async () => {
  await withDom('nas-01', async (env) => {
    const { pick } = await harness(env);
    let result: Promise<DirectoryPick> | null = null;
    await env.act(async () => { result = pick(); await settle(); });
    await env.render(env.React.createElement('div'));
    const outcome = await Promise.race([result!, new Promise((resolve) => setTimeout(() => resolve('hanging'), 200))]);
    assert.deepEqual(outcome, { status: 'cancelled' });
  });
});

test('file mode: even on this computer it lists the daemon\'s files, and a file must be selected to be chosen', async () => {
  await withDom('local', async (env) => {
    const { useDirectoryPicker } = await import('./directory-browser');
    let pickFile: ((current: string) => Promise<DirectoryPick>) | null = null;
    function Host() {
      const picker = useDirectoryPicker();
      pickFile = picker.pickFile;
      return picker.dialog;
    }
    await env.render(env.React.createElement(Host));
    let result: Promise<DirectoryPick> | null = null;
    await env.act(async () => { result = pickFile!('/usr/local/bin'); await settle(); });
    assert.deepEqual(env.fetched, ['/api/ui/host/directories?path=%2Fusr%2Flocal%2Fbin&files=*']);
    assert.deepEqual(env.nativeCalls, [], 'no OS dialog: its file pickers are specific to their form');
    assert.equal(buttonNamed('Choose this file')?.disabled, true, 'nothing selected yet');
    assert.ok(buttonNamed('lib'), 'folders still listed to walk the disk');
    await env.act(async () => { buttonNamed('codex')!.click(); await settle(); });
    assert.equal(buttonNamed('codex')!.getAttribute('aria-pressed'), 'true');
    await env.act(async () => { buttonNamed('Choose this file')!.click(); await settle(); });
    assert.deepEqual(await result!, { status: 'chosen', path: '/usr/local/bin/codex' });
  });
});

test('file mode: a pinned file reopens its folder with the file selected', async () => {
  await withDom('nas-01', async (env) => {
    const { useDirectoryPicker } = await import('./directory-browser');
    let pickFile: ((current: string) => Promise<DirectoryPick>) | null = null;
    function Host() {
      const picker = useDirectoryPicker();
      pickFile = picker.pickFile;
      return picker.dialog;
    }
    await env.render(env.React.createElement(Host));
    let result: Promise<DirectoryPick> | null = null;
    await env.act(async () => { result = pickFile!('/usr/local/bin/claude'); await settle(); });
    assert.equal(buttonNamed('claude')!.getAttribute('aria-pressed'), 'true');
    await env.act(async () => { buttonNamed('Choose this file')!.click(); await settle(); });
    assert.deepEqual(await result!, { status: 'chosen', path: '/usr/local/bin/claude' });
  });
});

test('file mode: a pinned file out of the filter opens its folder and cannot be chosen', async () => {
  await withDom('nas-01', async (env) => {
    const { useDirectoryPicker } = await import('./directory-browser');
    let pickFile: ((current: string, accept?: readonly string[]) => Promise<DirectoryPick>) | null = null;
    function Host() {
      const picker = useDirectoryPicker();
      pickFile = picker.pickFile;
      return picker.dialog;
    }
    await env.render(env.React.createElement(Host));
    let result: Promise<DirectoryPick> | null = null;
    await env.act(async () => { result = pickFile!('/usr/local/bin/notes.md', ['.tgz']); await settle(); });
    assert.deepEqual(env.fetched, ['/api/ui/host/directories?path=%2Fusr%2Flocal%2Fbin%2Fnotes.md&files=.tgz']);
    assert.ok(buttonNamed('claude'), 'its folder is open');
    assert.ok(!buttonNamed('notes.md'), 'the pinned file is not listed');
    assert.ok(!document.querySelector('[aria-pressed="true"]'), 'nothing selected');
    assert.equal(buttonNamed('Choose this file')?.disabled, true);
    await env.act(async () => { buttonNamed('Choose this file')!.click(); await settle(); });
    assert.ok(document.querySelector('[role="dialog"]'), 'still open: nothing was chosen');
    await env.act(async () => { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await settle(); });
    assert.deepEqual(await result!, { status: 'cancelled' });
  });
});
