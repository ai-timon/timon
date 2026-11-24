import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { MenuItemConstructorOptions } from 'electron';
import { appMenuTemplate, newWindowShortcut } from './app-menu.js';
import { canReadAppInfo } from './app-info.js';
import { isMachineId, pageUrl, withMachineHeader, LOCAL_MACHINE_ID } from './window-machine.js';
import { routeOfUrl } from './window-layout.js';
import { WindowRegistry } from './window-registry.js';
import { ViewPool } from './view-pool.js';
import { machineForDetachedWindow, parseOpenWindowRequest } from './window-open.js';
import { launchedOtherBuild } from './shell-build.js';
import { parseWindowSchemeReport } from './appearance.js';
import {
  UI_ZOOM_CHANNELS, UI_ZOOM_STEPS, parseUiZoomSetRequest, parseUiZoomStepRequest, stepUiZoom, zoomShortcut, type UiZoomFactor,
} from './ui-zoom.js';

// The wiring lives in main.ts, which cannot load outside Electron: these run its real code with fake Electron objects.
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const compile = (code: string): string => ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function functionText(name: string): string {
  const node = parsed.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node, name);
  return node.getText(parsed);
}

/** The callback main.ts registers with `ipcMain.handle(<channel>, …)`. */
function handlerOf(channel: string): string {
  let found: string | null = null;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'ipcMain.handle' && node.arguments[0]?.getText(parsed) === channel) {
      found = node.arguments[1]!.getText(parsed);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(found, channel);
  return found;
}

const ORIGIN = 'http://127.0.0.1:3110';
type FakeWindow = { webContents: { id: number }; isDestroyed: () => boolean };
const fakeWindow = (id: number): FakeWindow => ({ webContents: { id }, isDestroyed: () => false });
type FakeContents = { id: number; isDestroyed: () => boolean };
type FakePage = { view: { contents: FakeContents } };

/** Two windows, each with one page: contents 10 (window 1, cookie) and 20 (window 2, vps). */
function fleet() {
  const windows = new WindowRegistry<FakeWindow, FakePage>();
  for (const [id, machineId] of [[1, null], [2, 'vps']] as const) {
    const pages = new ViewPool<FakePage>();
    pages.enter(machineId, () => ({ contentsId: id * 10, machineId, view: { contents: { id: id * 10, isDestroyed: () => false } } }));
    windows.add({ id, window: fakeWindow(id), origin: ORIGIN, machineId, pages, closing: false, route: null });
  }
  return windows;
}

/** The page a fake IPC event comes from, as `senderPage` answers it. */
const pageFor = (windows: ReturnType<typeof fleet>) => (e: { sender: { id: number } }) => windows.pageOf(e.sender.id);

const event = (id: number, url = `${ORIGIN}/settings`) => {
  const mainFrame = { url };
  return { sender: { id, mainFrame }, senderFrame: mainFrame };
};

function machineHandler(windows: ReturnType<typeof fleet>) {
  const chosen: (string | null)[] = [];
  const entered: { window: number; machine: string | null; url: string }[] = [];
  const context = {
    windows, isMachineId, canReadAppInfo, pageUrl,
    senderPage: pageFor(windows),
    senderOf: (e: ReturnType<typeof event>) => ({ isWindow: windows.pageOf(e.sender.id) !== null, isMainFrame: true, url: e.senderFrame.url }),
    layoutKeeper: { machineChosen: (id: string | null) => { chosen.push(id); } },
    enterMachine: (record: { id: number }, machine: string | null, url: string) => {
      entered.push({ window: record.id, machine, url });
      return null;
    },
    console: { log: () => {} },
  };
  const handle = runInNewContext(compile(`(${handlerOf('WINDOW_MACHINE_CHANNEL')})`), context) as (e: unknown, id: unknown, request?: unknown) => unknown;
  return { handle, chosen, entered };
}

test('V4: the machine switcher of a window shows that machine in that window only, and remembers the choice', () => {
  const windows = fleet();
  const { handle, chosen, entered } = machineHandler(windows);
  assert.equal(JSON.stringify(handle(event(10), 'nas', { route: '/missions?selected=m1' })), '{"id":"nas","shown":true}');
  assert.deepEqual(entered, [{ window: 1, machine: 'nas', url: `${ORIGIN}/missions?selected=m1` }]);
  handle(event(20), 'local', { route: '//evil.example/' });
  assert.deepEqual(entered[1], { window: 2, machine: 'local', url: `${ORIGIN}/` }, 'a route off the origin opens the root');
  assert.deepEqual(chosen, ['nas', 'local']);
});

test('V3: the switcher IPC takes an id, never a URL, and only from the page on screen of a Timon window', () => {
  const windows = fleet();
  const { handle, chosen, entered } = machineHandler(windows);
  for (const bad of ['https://evil.example', '../x', 'a, b', 42, null, { id: 'vps' }]) {
    assert.throws(() => handle(event(10), bad), /named by its id/);
  }
  assert.throws(() => handle(event(1), 'vps'), /Only a Timon window/, 'the window\'s own blank webContents');
  assert.throws(() => handle(event(9), 'vps'), /Only a Timon window/, 'a stranger webContents');
  assert.throws(() => handle(event(10, 'https://evil.example/'), 'vps'), /Only a Timon window/, 'a page of another origin');
  windows.get(1)!.pages.enter('nas', () => ({ contentsId: 11, machineId: 'nas', view: { contents: { id: 11, isDestroyed: () => false } } }));
  assert.throws(() => handle(event(10), 'vps'), /page on screen/, 'a hidden page');
  windows.get(2)!.closing = true;
  assert.throws(() => handle(event(20), 'nas'), /page on screen/, 'a window closing its pages');
  assert.deepEqual(entered, []);
  assert.deepEqual(chosen, []);
});

test('V3: one request hook for the session names the machine of the window each request comes from', () => {
  const windows = fleet();
  let listener: ((details: unknown, callback: (answer: { requestHeaders: Record<string, string> }) => void) => void) | null = null;
  runInNewContext(`${compile(functionText('installMachineHeader'))}\ninstallMachineHeader()`, {
    windows, withMachineHeader,
    session: { defaultSession: { webRequest: { onBeforeSendHeaders: (fn: typeof listener) => { listener = fn; } } } },
  });
  assert.ok(listener);
  const sent = (webContentsId: number) => {
    let headers: Record<string, string> = {};
    listener!({ url: `${ORIGIN}/api/ui/missions`, webContentsId, requestHeaders: {} }, (answer) => { headers = answer.requestHeaders; });
    return headers;
  };
  assert.deepEqual(sent(20), { 'X-Timon-Machine': 'vps' });
  assert.deepEqual(sent(10), {}, 'a page without a machine of its own leaves the cookie in charge');
  windows.get(2)!.pages.enter('nas', () => ({ contentsId: 21, machineId: 'nas', view: { contents: { id: 21, isDestroyed: () => false } } }));
  assert.deepEqual(sent(21), { 'X-Timon-Machine': 'nas' }, 'V4: each page of a window names its own machine');
  assert.deepEqual(sent(20), { 'X-Timon-Machine': 'vps' }, 'V4: the hidden page keeps its machine');
  assert.deepEqual(sent(2), {}, 'the window\'s own webContents is no page');
});

test('browser panels attach in every local window; hidden and remote pages cannot steal them', () => {
  const windows = fleet();
  const second = windows.get(2)!;
  second.pages.enter('local', () => ({ contentsId: 21, machineId: 'local', view: { contents: { id: 21, isDestroyed: () => false } } }));
  const attached: number[] = [];
  const detached: number[] = [];
  const browserOwners = new Map<number, number>();
  let allowed = true;
  const context: Record<string, unknown> = {
    windows, browserOwners, LOCAL_MACHINE_ID,
    senderPage: pageFor(windows),
    browserSenderAllowed: () => allowed,
    nativeBrowser: { attach: (w: FakeWindow) => { attached.push(w.webContents.id); }, detachWindow: (w: FakeWindow) => { detached.push(w.webContents.id); } },
  };
  runInNewContext(compile(functionText('detachBrowser')), context);
  const attach = runInNewContext(compile(`(${handlerOf('BROWSER_ATTACH_CHANNEL')})`), context) as (e: unknown, r: unknown) => { attached: boolean } | undefined;
  const detach = runInNewContext(compile(`(${handlerOf('BROWSER_DETACH_CHANNEL')})`), context) as (e: unknown) => void;
  assert.equal(attach(event(10), {})?.attached, true);
  assert.equal(attach(event(21), {})?.attached, true);
  assert.deepEqual(attached, [1, 2]);
  assert.deepEqual([...browserOwners], [[1, 10], [2, 21]]);
  detach(event(21));
  assert.deepEqual(detached, [2], 'another window keeps its panel');
  assert.equal(browserOwners.get(1), 10);
  attach(event(21), {});
  windows.get(1)!.pages.enter('local', () => ({ contentsId: 11, machineId: 'local', view: { contents: { id: 11, isDestroyed: () => false } } }));
  attach(event(10), {});
  assert.deepEqual(attached, [1, 2, 2], 'a hidden page renewing its panel shows nothing');
  attach(event(11), {});
  detach(event(10));
  assert.deepEqual(detached, [2], 'a hidden page cannot detach the active page or another window');
  second.pages.enter('vps', () => { throw new Error('page already alive'); });
  assert.equal(attach(event(20), {})?.attached, false, 'a remote page selects its video path, never a local profile');
  assert.deepEqual(attached, [1, 2, 2, 1]);
  allowed = false;
  assert.throws(() => attach(event(11), {}), /only available from Timon/);
  assert.throws(() => detach(event(11)), /only available from Timon/);
  allowed = true;
  assert.throws(() => attach(event(999), {}), /only available from Timon/);
});

const key = (over: Partial<{ key: string; control: boolean; meta: boolean; shift: boolean; alt: boolean; type: string }>) => ({
  type: 'keyDown', key: 'N', control: false, meta: false, shift: true, alt: false, ...over,
});

test('V3: Ctrl+Shift+N (Cmd+Shift+N on macOS) opens a new window', () => {
  assert.equal(newWindowShortcut(key({ control: true }), 'linux'), true);
  assert.equal(newWindowShortcut(key({ control: true, key: 'n' }), 'win32'), true);
  assert.equal(newWindowShortcut(key({ meta: true }), 'darwin'), true);
  assert.equal(newWindowShortcut(key({ control: true }), 'darwin'), false);
  assert.equal(newWindowShortcut(key({ control: true, shift: false }), 'linux'), false, 'Ctrl+N stays the page\'s');
  assert.equal(newWindowShortcut(key({ control: true, alt: true }), 'linux'), false);
  assert.equal(newWindowShortcut(key({ control: true, type: 'keyUp' }), 'linux'), false);
});

test('V3: the macOS File menu offers "New window", and only then replaces Electron\'s', () => {
  let opened = 0;
  const flatten = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
    items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
  const items = appMenuTemplate({ platform: 'darwin', appName: 'Timon', locale: 'fr-FR', onAbout: () => {}, onNewWindow: () => { opened += 1; } })!;
  const entry = flatten(items).find((item) => item.label === 'Nouvelle fenêtre'); // french-ok: the French menu label under test
  assert.ok(entry);
  assert.equal(entry.registerAccelerator, false, 'the window\'s key handler opens it, once');
  entry.click?.({} as never, undefined, {} as never);
  assert.equal(opened, 1);
  assert.ok(flatten(items).some((item) => item.role === 'close'));
  const plain = appMenuTemplate({ platform: 'darwin', appName: 'Timon', locale: 'en', onAbout: () => {} })!;
  assert.deepEqual(plain[1], { role: 'fileMenu' });
});

/** The callback main.ts registers with `app.on('second-instance', …)`. */
function secondInstanceHandler(): string {
  let body = '';
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'app.on' && node.arguments[0]?.getText(parsed) === "'second-instance'") {
      body = node.arguments[1]!.getText(parsed);
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  assert.ok(body);
  return body;
}

function secondLaunch(input: { daemonUp: boolean; failed: boolean; launch?: unknown }): string[] {
  const calls: string[] = [];
  const context = {
    daemonUp: input.daemonUp, desktopHome: 'home', app: { isPackaged: true }, uiLocale: () => 'fr',
    ownBuild: '0.1.5+100', launchedOtherBuild, DISPLAY_NAME: 'Timon',
    staleShellCopy: () => ({ message: 'm', detail: 'd' }),
    frontWindow: () => null,
    dialog: { showMessageBox: () => { calls.push('notice'); return Promise.resolve(); } },
    loadDesktopConfig: () => ({ app: { listen: {} } }), originOf: () => ORIGIN,
    windows: { list: () => [{ pages: { list: () => [{ view: { startup: { state: input.failed ? 'failed' : 'ready' } } }] } }] },
    rearmAppIfDown: () => { calls.push('rearm'); },
    showWindow: () => { calls.push('show'); },
    openNewWindow: () => { calls.push('new'); },
    console: { log: () => {}, warn: () => {} },
  };
  runInNewContext(compile(`(${secondInstanceHandler()})({}, [], '', ${JSON.stringify(input.launch ?? null)})`), context);
  return calls.sort();
}

test('V3: a second launch opens a new window, unless the interface is failing or not up yet', () => {
  for (const [daemonUp, failed, expected] of [[true, false, 'new'], [true, true, 'show+rearm'], [false, false, 'show']] as const) {
    assert.deepEqual(secondLaunch({ daemonUp, failed, launch: { build: '0.1.5+100' } }).join('+'), expected.split('+').sort().join('+'));
  }
  assert.deepEqual(secondLaunch({ daemonUp: true, failed: false }), ['new'], 'a launch that names no build (an older shell) opens the window too');
});

/**
 * 01/11/2026: "Open in a new window" answered "No handler registered for
 * 'timon:open-window'". The shell had been running for four days; each
 * `npm start` after a rebuild only handed over to it, and its new pages read
 * the rebuilt preload, whose bridge the old main process did not serve.
 */
test('a second launch of another build shows the window and asks for a restart instead of opening one it cannot serve', () => {
  assert.deepEqual(secondLaunch({ daemonUp: true, failed: false, launch: { build: '0.1.5+200' } }), ['notice', 'show']);
  assert.deepEqual(secondLaunch({ daemonUp: true, failed: false, launch: { build: '0.1.6' } }), ['notice', 'show']);
});

/** The handler of "Open in a new window", run as main.ts has it, for a page of a window. */
function openWindowHandler(windows: ReturnType<typeof fleet>, state: { releasePending?: boolean } = {}) {
  const opened: { window: number; url: string; machine: string | null }[] = [];
  const context = {
    canReadAppInfo, parseOpenWindowRequest, machineForDetachedWindow,
    senderWindow: (e: { sender: { id: number } }) => windows.pageOf(e.sender.id)?.record ?? null,
    senderOf: (e: ReturnType<typeof event>) => ({ isWindow: windows.pageOf(e.sender.id) !== null, isMainFrame: true, url: e.senderFrame.url }),
    openDetachedWindow: (caller: { id: number }, url: string, machine: string | null) => {
      if (state.releasePending) return false;
      opened.push({ window: caller.id, url, machine });
      return true;
    },
    console: { log: () => {} },
  };
  const handle = runInNewContext(compile(`(${handlerOf('OPEN_WINDOW_CHANNEL')})`), context) as (e: unknown, input: unknown) => { opened: boolean };
  return { handle, opened };
}

test('V5: a page of a window opens one of its routes in a new window, on its machine', () => {
  const windows = fleet();
  const { handle, opened } = openWindowHandler(windows);
  // Window 1 follows the cookie: the page's word pins the new one. Window 2 is pinned: its pin wins.
  assert.equal(JSON.stringify(handle(event(10), { route: '/kanban?card=4#top', machineId: 'nas' })), '{"opened":true}');
  assert.equal(JSON.stringify(handle(event(20), { route: '/chat', machineId: 'nas' })), '{"opened":true}');
  assert.equal(JSON.stringify(handle(event(10), { route: '/settings' })), '{"opened":true}');
  assert.deepEqual(opened, [
    { window: 1, url: `${ORIGIN}/kanban?card=4`, machine: 'nas' },
    { window: 2, url: `${ORIGIN}/chat`, machine: 'vps' },
    { window: 1, url: `${ORIGIN}/settings`, machine: null },
  ]);
  // A page kept alive behind the one on screen is still a page of its window (V4).
  windows.get(1)!.pages.enter('nas', () => ({ contentsId: 11, machineId: 'nas', view: { contents: { id: 11, isDestroyed: () => false } } }));
  assert.equal(JSON.stringify(handle(event(10), { route: '/' })), '{"opened":true}');
});

test('V5: only a page of a Timon window opens another, on a route of its own origin', () => {
  const windows = fleet();
  const { handle, opened } = openWindowHandler(windows);
  assert.throws(() => handle(event(1), { route: '/' }), /Only a Timon window/, 'the window\'s own blank webContents');
  assert.throws(() => handle(event(9), { route: '/' }), /Only a Timon window/, 'a stranger webContents');
  assert.throws(() => handle(event(10, 'https://evil.example/'), { route: '/' }), /Only a Timon window/, 'a page of another origin');
  for (const bad of [{ route: '//evil.example/' }, { route: 'https://evil.example/' }, { url: '/' }, '/kanban', { route: '/', machineId: 'a b' }]) {
    assert.throws(() => handle(event(10), bad), /route of this interface/);
  }
  assert.deepEqual(opened, []);
  assert.equal(JSON.stringify(openWindowHandler(windows, { releasePending: true }).handle(event(10), { route: '/' })), '{"opened":false}');
});

test('V3: quitting freezes the layout once the quit is no longer held', () => {
  const start = source.indexOf("app.on('before-quit'");
  const freeze = source.indexOf('layoutKeeper?.freeze()', start);
  const lastHold = source.indexOf('if (uninstalling && !uninstallReadyToQuit) { event.preventDefault(); return; }', start);
  assert.ok(start > 0 && lastHold > start && freeze > lastHold, 'a held quit (error box, update, uninstall) must not freeze the layout');
});

/**
 * The real page lifecycle of main.ts (enter, hide, evict, close) run against
 * fake views: a fake webContents closes the way Electron's does, through its
 * `destroyed` handler — the one `createPage` installs, replayed here.
 */
function pageWorld(options: { refuse?: Set<string> } = {}) {
  const windows = new WindowRegistry<unknown, unknown>();
  const children: unknown[] = [];
  const log: string[] = [];
  const focusLog: string[] = [];
  let nextId = 100;
  /** The webContents holding the keyboard, as `webContents.getFocusedWebContents()` reports it. */
  const keyboard = { holder: null as number | null, windowFocused: true };
  const window = {
    webContents: { id: 1, isFocused: () => keyboard.holder === 1 },
    isDestroyed: () => false, isFocused: () => keyboard.windowFocused, getContentBounds: () => ({ x: 40, y: 30, width: 1200, height: 800 }),
    contentView: {
      addChildView: (view: unknown, index: number) => { children.splice(index, 0, view); },
      removeChildView: (view: unknown) => { const at = children.indexOf(view); if (at >= 0) children.splice(at, 1); },
    },
    close: () => { log.push('window close'); },
  };
  const context: Record<string, unknown> = {
    windows, console: { log: (line: string) => { if (line.includes('→ page')) focusLog.push(line); } }, browserOwners: new Map<number, number>(), quitInProgress: false,
    nativeBrowser: { detachWindow: () => { log.push('browser detach'); } },
    layoutChanges: 0,
    layoutKeeper: { changed: () => { context.layoutChanges = (context.layoutChanges as number) + 1; }, thaw: () => { log.push('layout thawed'); } },
    routeOfUrl,
    webContents: { getFocusedWebContents: () => (keyboard.holder === null ? null : { id: keyboard.holder }) },
    BrowserWindow: { getFocusedWindow: () => null },
    refreshTitle: async () => {},
    app: { quit: () => { log.push('quit'); } },
    Promise,
  };
  const settle = (page: unknown, outcome: string) => (context.settlePage as (p: unknown, o: string) => void)(page, outcome);
  context.createPage = (record: { pages: { forget: (id: number) => void; keep: (id: number) => void } }, machineId: string | null, url: string) => {
    const id = nextId++;
    const state = { destroyed: false };
    const page: Record<string, unknown> = { contentsId: id, machineId };
    const contents = {
      id,
      isDestroyed: () => state.destroyed,
      isFocused: () => keyboard.holder === id,
      focus: () => { keyboard.holder = id; },
      close: (opts: { waitForBeforeUnload?: boolean }) => {
        log.push(`close ${machineId} ${opts?.waitForBeforeUnload ? 'asking' : 'unasked'}`);
        // `will-prevent-unload`, the user stays.
        if (options.refuse?.has(machineId ?? '(cookie)')) { record.pages.keep(id); settle(page, 'kept'); return; }
        state.destroyed = true;
        record.pages.forget(id);
        window.contentView.removeChildView(view);
        (context.detachBrowser as (id: number) => void)(id);
        settle(page, 'closed');
      },
    };
    const view = { webContents: contents, visible: false, bounds: null as unknown, url, setVisible(v: boolean) { this.visible = v; }, setBounds(b: unknown) { this.bounds = b; } };
    const startup = { runs: [] as string[], start() { this.runs.push('service'); }, begin() { this.runs.push('interface'); return Promise.resolve(); } };
    page.view = { view, startup, closed: null, settle: null, route: new URL(url).pathname };
    window.contentView.addChildView(view, 0);
    return page;
  };
  const names = ['noteRoute', 'contentsOf', 'detachBrowser', 'layoutPages', 'focusActivePage', 'showPage', 'hidePage', 'settlePage', 'closePage', 'enterMachine', 'closePages',
    'liveWindows', 'frontWindow', 'callOffQuit', 'windowsHoldQuit'];
  runInNewContext(names.map((name) => compile(functionText(name))).join('\n'), context);
  const record = windows.add({ id: 1, window, origin: ORIGIN, machineId: null, pages: new ViewPool<unknown>(), closing: false, route: null });
  type View = { visible: boolean; url: string; bounds: unknown; webContents: { isDestroyed: () => boolean } };
  const enter = (machine: string | null, url = `${ORIGIN}/`) =>
    (context.enterMachine as (r: unknown, m: string | null, u: string) => { contentsId: number; view: { view: View } })(record, machine, url);
  const closeWindow = () => (context.closePages as (r: unknown) => Promise<void>)(record);
  const holdQuit = () => (context.windowsHoldQuit as () => boolean)();
  const shown = () => (children as View[]).filter((v) => v.visible).map((v) => v.url);
  const focusPage = (why: string, take: string) => (context.focusActivePage as (r: unknown, w: string, t: string) => void)(record, why, take);
  return { windows, record, context, children: children as View[], log, focusLog, keyboard, enter, closeWindow, holdQuit, shown, focusPage };
}

const settled = () => new Promise((resolve) => setImmediate(resolve));

test('V4: switching shows the machine\'s page and hides the other one, alive and sized to the window', () => {
  const world = pageWorld();
  const a = world.enter('a', `${ORIGIN}/chat`);
  const b = world.enter('b', `${ORIGIN}/missions`);
  assert.deepEqual(world.shown(), [`${ORIGIN}/missions`]);
  assert.equal(world.children.length, 2);
  assert.equal(JSON.stringify(b.view.view.bounds), '{"x":0,"y":0,"width":1200,"height":800}');
  assert.equal(world.enter('a'), a, 'the same page comes back');
  assert.deepEqual(world.shown(), [`${ORIGIN}/chat`]);
  assert.equal(world.record.machineId, 'a');
  assert.equal(a.view.view.webContents.isDestroyed(), false);
  assert.deepEqual(world.log, []);
});

test('TIM-0150: a window reporting an empty content area leaves its pages at their last size', () => {
  const world = pageWorld();
  const page = world.enter('a');
  const sized = JSON.stringify(page.view.view.bounds);
  (world.record.window as { getContentBounds: () => unknown }).getContentBounds = () => ({ x: 0, y: 0, width: 0, height: 0 });
  (world.context.layoutPages as (r: unknown) => void)(world.record);
  assert.equal(JSON.stringify(page.view.view.bounds), sized);
});

test('TIM-0152: a page put on screen in a focused window takes the keyboard, whoever held it', () => {
  const world = pageWorld();
  world.keyboard.holder = 999;
  const a = world.enter('a');
  assert.equal(world.keyboard.holder, a.contentsId);
  world.keyboard.windowFocused = false;
  world.enter('b');
  assert.equal(world.keyboard.holder, a.contentsId, 'a window in the background takes nobody\'s keyboard');
  assert.deepEqual(world.focusLog, ['[desktop] window 1 shown → page (keyboard was: view 999)']);
});

test('TIM-0152: the page on screen takes the keyboard from its window or a hidden page, from nobody only once settled, never from a browser panel', () => {
  const world = pageWorld();
  const a = world.enter('a');
  const b = world.enter('b');
  world.focusLog.length = 0;
  world.keyboard.holder = 1;
  world.focusPage('focus', 'ours');
  assert.equal(world.keyboard.holder, b.contentsId, 'from the window\'s own webContents');
  world.keyboard.holder = a.contentsId;
  world.focusPage('focus', 'ours');
  assert.equal(world.keyboard.holder, b.contentsId, 'from a hidden page of the window');
  world.keyboard.holder = null;
  world.focusPage('focus', 'ours');
  assert.equal(world.keyboard.holder, null);
  world.focusPage('load', 'idle');
  assert.equal(world.keyboard.holder, b.contentsId, 'from nobody, once settled');
  world.focusPage('load', 'idle');
  world.keyboard.holder = 999;
  world.focusPage('focus', 'ours');
  world.focusPage('focus', 'idle');
  assert.equal(world.keyboard.holder, 999, 'a native browser panel keeps it');
  assert.deepEqual(world.focusLog, [
    '[desktop] window 1 focus → page (keyboard was: window)',
    `[desktop] window 1 focus → page (keyboard was: page ${a.contentsId})`,
    '[desktop] window 1 load → page (keyboard was: nobody)',
  ], 'a page that already has the keyboard is left alone');
});

/** `createWindow` run against a fake window: the listeners it registers, and its timers held until `flush`. */
function windowWiring() {
  type Listener = () => void;
  const on = (into: Map<string, Listener[]>) => (event: string, listener: Listener) => { into.set(event, [...(into.get(event) ?? []), listener]); };
  const windowEvents = new Map<string, Listener[]>();
  const viewEvents = new Map<string, Listener[]>();
  /** The webContents holding the keyboard: 7 is the window's own, 50 its page on screen. */
  const keyboard = { holder: null as number | null, focusLog: [] as string[] };
  class FakeBrowserWindow {
    webContents = { id: 7, setWindowOpenHandler: () => {}, on: () => {} };
    contentView = { on: on(viewEvents) };
    on = on(windowEvents);
    maximize() {}
    setFullScreen() {}
    isDestroyed() { return false; }
    isFocused() { return true; }
  }
  const layouts: unknown[] = [];
  const timers: { kind: string; delay: number; run: Listener }[] = [];
  const context: Record<string, unknown> = {
    BrowserWindow: FakeBrowserWindow, URL, console: { log: (line: string) => { if (line.includes('→ page')) keyboard.focusLog.push(line); } },
    webContents: { getFocusedWebContents: () => (keyboard.holder === null ? null : { id: keyboard.holder }) },
    windows: new WindowRegistry<unknown, unknown>(), ViewPool, browserOwners: new Map<number, number>(),
    releaseCheckWindowRetired: false, windowOrigin: '', desktopHome: '/home', DISPLAY_NAME: 'Timon', APP_ICON_PATH: '/icon.png',
    windowScheme: () => 'dark', windowBackground: () => '#000000',
    layoutKeeper: { changed: () => {} }, watchDisplays: () => {}, enterMachine: () => null,
    layoutPages: (record: unknown) => { layouts.push(record); },
    setImmediate: (run: Listener) => { timers.push({ kind: 'immediate', delay: 0, run }); },
    setTimeout: (run: Listener, delay: number) => { timers.push({ kind: 'timeout', delay, run }); },
  };
  runInNewContext(['contentsOf', 'focusActivePage', 'createWindow'].map((name) => compile(functionText(name))).join('\n'), context);
  const opening = { machineId: null, placement: { width: 1200, height: 800 } };
  const record = (context.createWindow as (url: string, begin: string, opening: unknown) => { pages: ViewPool<unknown> })(`${ORIGIN}/`, 'interface', opening);
  const contents = { id: 50, isDestroyed: () => false, isFocused: () => keyboard.holder === 50, focus: () => { keyboard.holder = 50; } };
  record.pages.enter(null, () => ({ contentsId: 50, machineId: null, view: { view: { webContents: contents } } }));
  const emit = (from: Map<string, Listener[]>, event: string) => { for (const listener of from.get(event) ?? []) listener(); };
  const flush = () => { for (const timer of timers.splice(0)) timer.run(); };
  return { windowEvents, viewEvents, layouts, timers, keyboard, emit, flush };
}

test('TIM-0150: the pages follow the size the window manager actually applies to the content area', () => {
  const wiring = windowWiring();
  assert.equal(wiring.viewEvents.get('bounds-changed')?.length, 1);
  wiring.emit(wiring.viewEvents, 'bounds-changed');
  assert.equal(wiring.layouts.length, 1);
  assert.equal(wiring.timers.length, 0);
});

test('TIM-0150: maximize, full screen and the end of a resize lay the pages out again once the new size has landed', () => {
  for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'resized']) {
    const wiring = windowWiring();
    wiring.emit(wiring.windowEvents, event);
    assert.equal(wiring.layouts.length, 1, `${event}: laid out at once`);
    assert.deepEqual(wiring.timers.map((timer) => [timer.kind, timer.delay]), [['immediate', 0], ['timeout', 100]], `${event}: and twice later`);
    wiring.flush();
    assert.equal(wiring.layouts.length, 3, event);
  }
});

test('TIM-0152: a window coming back to the front hands the keyboard to its page, from its own webContents at once', () => {
  const wiring = windowWiring();
  wiring.keyboard.holder = 7;
  wiring.emit(wiring.windowEvents, 'focus');
  assert.deepEqual(wiring.timers.map((timer) => [timer.kind, timer.delay]), [['immediate', 0], ['timeout', 100]]);
  wiring.timers[0]!.run();
  assert.equal(wiring.keyboard.holder, 50);
  wiring.timers[1]!.run();
  assert.deepEqual(wiring.keyboard.focusLog, ['[desktop] window 7 focus → page (keyboard was: window)'], 'once: the page already has it');
});

test('TIM-0152: a window restored with nobody holding the keyboard gives it to its page once it has settled', () => {
  const wiring = windowWiring();
  wiring.emit(wiring.windowEvents, 'focus');
  wiring.timers[0]!.run();
  assert.equal(wiring.keyboard.holder, null, 'too early: the OS may still be handing focus to a view');
  wiring.timers[1]!.run();
  assert.equal(wiring.keyboard.holder, 50);
  assert.deepEqual(wiring.keyboard.focusLog, ['[desktop] window 7 focus → page (keyboard was: nobody)']);
});

test('TIM-0152: a native browser panel the user was typing in keeps the keyboard when the window comes back', () => {
  const wiring = windowWiring();
  wiring.keyboard.holder = 300;
  wiring.emit(wiring.windowEvents, 'focus');
  wiring.flush();
  assert.equal(wiring.keyboard.holder, 300);
  assert.deepEqual(wiring.keyboard.focusLog, []);
});

test('TODO #760: the window remembers the page of the machine on screen, for the layout to reopen it', () => {
  const world = pageWorld();
  world.enter('a', `${ORIGIN}/kanban`);
  assert.equal(world.record.route, '/kanban');
  world.enter('b', `${ORIGIN}/missions`);
  assert.equal(world.record.route, '/missions');
  world.enter('a');
  assert.equal(world.record.route, '/kanban', 'the page kept alive comes back with its own route');
});

test('TODO #760: a navigation of the page on screen is the page the window reopens on; a hidden one waits its turn', () => {
  const world = pageWorld();
  const note = (page: unknown, target: string) => (world.context.noteRoute as (r: unknown, p: unknown, t: string) => void)(world.record, page, target);
  const a = world.enter('a', `${ORIGIN}/chat`);
  const b = world.enter('b', `${ORIGIN}/missions`);
  const changes = () => world.context.layoutChanges as number;
  const before = changes();
  note(b, `${ORIGIN}/kanban?project=timon&settings=general#card`);
  assert.equal(world.record.route, '/kanban?project=timon');
  assert.equal(changes(), before + 1);
  for (const target of ['data:text/html,waiting', `${ORIGIN}/login`, 'http://evil.example/kanban']) note(b, target);
  assert.equal(world.record.route, '/kanban?project=timon', 'the waiting page, sign-in or another origin keep the last page');
  note(a, `${ORIGIN}/agents`);
  assert.equal(world.record.route, '/kanban?project=timon', 'a hidden page does not move the window');
  assert.equal(changes(), before + 1);
  world.enter('a');
  assert.equal(world.record.route, '/agents', 'shown again, it brings its page');
});

test('V4: the fourth machine closes the page shown least recently, asking it first, and leaves nothing behind', async () => {
  const world = pageWorld();
  const a = world.enter('a');
  world.enter('b');
  world.enter('c');
  world.enter('d');
  await settled();
  assert.deepEqual(world.log, ['close a asking']);
  assert.equal(a.view.view.webContents.isDestroyed(), true);
  assert.equal(world.children.length, 3, 'its view left the window');
  assert.equal(world.windows.pageOf(a.contentsId), null);
  assert.deepEqual(world.record.pages.list().map((p) => p.machineId), ['b', 'c', 'd']);
  const again = world.enter('a', `${ORIGIN}/chat?mission=m1`);
  assert.notEqual(again, a, 'coming back builds it again, on the route asked for');
  assert.equal(again.view.view.url, `${ORIGIN}/chat?mission=m1`);
});

test('V4: hiding the page the native panel is presented for takes the panel down', () => {
  const world = pageWorld();
  const a = world.enter('a');
  (world.context.browserOwners as Map<number, number>).set(1, a.contentsId);
  world.enter('b');
  assert.deepEqual(world.log, ['browser detach']);
  assert.equal((world.context.browserOwners as Map<number, number>).size, 0);
});

test('V4: a page the user keeps (unsaved changes) comes back in front', async () => {
  const world = pageWorld({ refuse: new Set(['a']) });
  world.enter('a', `${ORIGIN}/edit`);
  world.enter('b');
  world.enter('c');
  world.enter('d');
  await settled();
  assert.deepEqual(world.log.slice(0, 2), ['close a asking', 'close b asking'], 'kept, a comes in front and b, now the oldest, goes');
  assert.deepEqual(world.shown(), [`${ORIGIN}/edit`]);
  assert.equal(world.record.machineId, 'a');
});

test('V4: closing a window closes every page first, the one on screen last, then the window', async () => {
  const world = pageWorld();
  world.enter('a'); world.enter('b'); world.enter('c');
  world.context.quitInProgress = true;
  await world.closeWindow();
  assert.deepEqual(world.log, ['close a asking', 'close b asking', 'close c asking', 'window close', 'quit']);
  assert.equal(world.record.pages.size + world.record.pages.closingCount, 0);
  assert.equal(world.children.length, 0);
});

test('V4: a page kept while its window closes stays on screen, and the window and the quit stop there', async () => {
  const world = pageWorld({ refuse: new Set(['b']) });
  world.enter('a'); world.enter('b'); world.enter('c');
  world.context.quitInProgress = true;
  await world.closeWindow();
  assert.deepEqual(world.log, ['close a asking', 'close b asking', 'layout thawed']);
  assert.deepEqual(world.record.pages.list().map((p) => p.machineId), ['c', 'b']);
  assert.equal(world.record.machineId, 'b');
  assert.equal(world.context.quitInProgress, false);
  assert.equal(world.record.closing, false);
});

test('TODO #758: a quit holds while a window has pages, closing them before anything stops', async () => {
  const world = pageWorld();
  world.enter('a'); world.enter('b');
  world.context.quitInProgress = true;
  assert.equal(world.holdQuit(), true, 'the window still holds pages');
  assert.equal(world.holdQuit(), true, 'asked again while it closes: still held');
  await settled();
  assert.deepEqual(world.log, ['close a asking', 'close b asking', 'window close', 'quit'], 'each page asked once, then the quit resumes');
  assert.equal(world.holdQuit(), false, 'an empty window no longer holds the quit');
});

test('TODO #758: "Stay" during a quit calls it off before anything was stopped', async () => {
  const world = pageWorld({ refuse: new Set(['a']) });
  world.enter('a'); world.enter('b');
  world.context.quitInProgress = true;
  assert.equal(world.holdQuit(), true);
  await settled();
  assert.deepEqual(world.log, ['close a asking', 'layout thawed']);
  assert.equal(world.context.quitInProgress, false);
  assert.equal(world.record.machineId, 'a', 'the kept page is on screen');
});

test('TODO #758: before-quit asks every page before it stops speech, the browser or the embedded daemon', () => {
  const start = source.indexOf("app.on('before-quit'");
  const end = source.indexOf("app.on('activate'", start);
  const handler = source.slice(start, end);
  const hold = handler.indexOf('if (windowsHoldQuit()) { event.preventDefault(); return; }');
  assert.ok(hold > handler.indexOf('layoutKeeper?.freeze()'), 'the layout is frozen first: the windows the quit closes stay in it');
  for (const stop of ['speech?.dispose()', 'stopEmbedded = null', 'nativeBrowser = null', 'stopBrowserProvider = null']) {
    assert.ok(hold > 0 && handler.indexOf(stop) > hold, `${stop} only once no page can keep the app open`);
  }
});

/** The handler of a page's light/dark report, run as main.ts has it. */
function schemeHandler(windows: ReturnType<typeof fleet>) {
  const recorded: { machine: string | null; scheme: string }[] = [];
  const painted: { contents: number; scheme: string }[] = [];
  const context = {
    canReadAppInfo, parseWindowSchemeReport, desktopHome: '/home',
    senderPage: pageFor(windows),
    senderOf: (e: ReturnType<typeof event>) => ({ isWindow: windows.pageOf(e.sender.id) !== null, isMainFrame: true, url: e.senderFrame.url }),
    paintPageScheme: (caller: { page: { contentsId: number } }, scheme: string) => { painted.push({ contents: caller.page.contentsId, scheme }); },
    recordMachineScheme: (_home: string, machine: string | null, scheme: string) => { recorded.push({ machine, scheme }); return machine !== null; },
  };
  const handle = runInNewContext(compile(`(${handlerOf('WINDOW_SCHEME_CHANNEL')})`), context) as (e: unknown, input: unknown) => { recorded: boolean };
  return { handle, recorded, painted };
}

test('each machine its mode: a page reports what it paints, recorded under its window\'s pin first', () => {
  const windows = fleet();
  const { handle, recorded, painted } = schemeHandler(windows);
  // Window 2 is pinned to vps: a page naming another machine cannot write it.
  assert.equal(JSON.stringify(handle(event(20), { scheme: 'light', machineId: 'nas' })), '{"recorded":true}');
  // Window 1 follows the cookie: the machine its page was served for.
  handle(event(10), { scheme: 'dark', machineId: 'nas' });
  handle(event(10), { scheme: 'light' });
  assert.deepEqual(recorded, [{ machine: 'vps', scheme: 'light' }, { machine: 'nas', scheme: 'dark' }, { machine: null, scheme: 'light' }]);
  assert.deepEqual(painted.map((p) => p.contents), [20, 10, 10]);
});

test('each machine its mode: only a page of a Timon window reports, and only a mode', () => {
  const windows = fleet();
  const { handle, recorded, painted } = schemeHandler(windows);
  assert.throws(() => handle(event(1), { scheme: 'light' }), /Only a Timon window/, 'the window\'s own blank webContents');
  assert.throws(() => handle(event(9), { scheme: 'light' }), /Only a Timon window/, 'a stranger webContents');
  assert.throws(() => handle(event(10, 'https://evil.example/'), { scheme: 'light' }), /Only a Timon window/, 'a page of another origin');
  for (const bad of [{ scheme: 'sepia' }, 'light', { scheme: 'light', machineId: '../x' }]) {
    assert.throws(() => handle(event(10), bad), /light or dark/);
  }
  assert.deepEqual(recorded, []);
  assert.deepEqual(painted, []);
});

// Interface size (desktop zoom): one factor for every page of every window, never for a browser panel.

test('zoom: the macOS View menu sizes the interface, shown with its keys but not registering them', () => {
  const steps: string[] = [];
  const flatten = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
    items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
  const items = appMenuTemplate({ platform: 'darwin', appName: 'Timon', locale: 'en', onAbout: () => {}, onZoom: (d) => { steps.push(d); } })!;
  const view = items.find((item) => item.role === 'viewMenu')!;
  assert.equal(view.label, 'View');
  assert.ok(Array.isArray(view.submenu));
  const entries = view.submenu;
  assert.deepEqual(entries.filter((item) => item.role).map((item) => item.role), ['reload', 'forceReload', 'toggleDevTools', 'togglefullscreen']);
  assert.ok(!flatten(items).some((item) => item.role === 'zoomIn' || item.role === 'zoomOut' || item.role === 'resetZoom'),
    'Electron\'s own zoom would size one page only');
  for (const [label, accelerator, direction] of [['Actual Size', 'CmdOrCtrl+0', 'reset'], ['Zoom In', 'CmdOrCtrl+Plus', 'in'], ['Zoom Out', 'CmdOrCtrl+-', 'out']] as const) {
    const entry = entries.find((item) => item.label === label);
    assert.ok(entry, label);
    assert.equal(entry.accelerator, accelerator);
    assert.equal(entry.registerAccelerator, false, 'shown, not registered: a key sizes every page once');
    entry.click?.({} as never, undefined, {} as never);
    assert.equal(steps.at(-1), direction);
  }
  const french = appMenuTemplate({ platform: 'darwin', appName: 'Timon', locale: 'fr-FR', onAbout: () => {}, onZoom: () => {} })!;
  assert.ok(flatten(french).some((item) => item.label === 'Zoom avant'), 'the entries speak the language of the app'); // french-ok: the French menu label under test
  const plain = appMenuTemplate({ platform: 'darwin', appName: 'Timon', locale: 'en', onAbout: () => {} })!;
  assert.deepEqual(plain.find((item) => item.role === 'viewMenu'), { role: 'viewMenu' }, 'without a handler, Electron\'s View menu stays');
});

type ZoomContents = { id: number; destroyed: boolean; log: string[] };
const zoomContents = (id: number, destroyed = false): ZoomContents => ({ id, destroyed, log: [] });

function zoomApplier(records: { pages: ZoomContents[] }[]) {
  const written: number[] = [];
  /** Every call on every page, in the order they happened. */
  const calls: string[] = [];
  const context: Record<string, unknown> = {
    currentUiZoom: 1, desktopHome: 'home', UI_ZOOM_CHANNELS,
    liveWindows: () => records.map((record) => ({ pages: { list: () => record.pages.map((contents) => ({ contents })) } })),
    contentsOf: (page: { contents: ZoomContents }) => ({
      isDestroyed: () => page.contents.destroyed,
      send: (channel: string, payload: { factor: number }) => {
        page.contents.log.push(`send ${channel} ${payload.factor}`);
        calls.push(`send ${page.contents.id}`);
      },
      setZoomFactor: (factor: number) => {
        page.contents.log.push(`zoom ${factor}`);
        calls.push(`zoom ${page.contents.id}`);
      },
    }),
    writeUiZoom: (_home: string, factor: number) => { written.push(factor); return true; },
    console: { warn: () => {} },
  };
  runInNewContext(compile(functionText('applyUiZoom')), context);
  const apply = runInNewContext('applyUiZoom', context) as (factor: UiZoomFactor, persist: boolean) => number;
  return { apply, written, calls, current: () => runInNewContext('currentUiZoom', context) as number };
}

test('zoom: every page of every window takes the size, told first so its next resize measures with it', () => {
  const pages = [zoomContents(10), zoomContents(11), zoomContents(20), zoomContents(30, true)];
  const { apply, written, current } = zoomApplier([{ pages: pages.slice(0, 2) }, { pages: pages.slice(2) }]);
  assert.equal(apply(1.25, true), 1.25);
  assert.equal(current(), 1.25);
  for (const page of pages.slice(0, 3)) assert.deepEqual(page.log, [`send ${UI_ZOOM_CHANNELS.changed} 1.25`, 'zoom 1.25']);
  assert.deepEqual(pages[3]!.log, [], 'a destroyed page is left alone');
  assert.deepEqual(written, [1.25]);
  apply(1, false);
  assert.deepEqual(written, [1.25], 'a size not meant to persist is not written');
});

test('zoom: every page of every window is told before any page is zoomed', () => {
  const pages = [zoomContents(10), zoomContents(11), zoomContents(20)];
  const { apply, calls } = zoomApplier([{ pages: pages.slice(0, 2) }, { pages: pages.slice(2) }]);
  apply(1.5, true);
  // Chromium zooms every page of a host at once: the second window must already know the size.
  assert.deepEqual(calls, ['send 10', 'send 11', 'send 20', 'zoom 10', 'zoom 11', 'zoom 20']);
});

test('zoom: the size the interface already has changes nothing, sends nothing and writes nothing', () => {
  const pages = [zoomContents(10), zoomContents(20)];
  const { apply, written, calls, current } = zoomApplier([{ pages: pages.slice(0, 1) }, { pages: pages.slice(1) }]);
  assert.equal(apply(1, true), 1, 'Ctrl+0 at 100 %');
  assert.deepEqual(written, []);
  assert.deepEqual(calls, []);
  apply(2, true);
  calls.length = 0;
  for (let tick = 0; tick < 5; tick += 1) assert.equal(apply(2, true), 2, 'a wheel held at 200 %');
  assert.deepEqual(written, [2], 'written once');
  assert.deepEqual(calls, []);
  assert.equal(current(), 2);
});

test('zoom: applying the size never reaches the native browser or its overlays', () => {
  const body = functionText('applyUiZoom');
  assert.doesNotMatch(body, /nativeBrowser|annotation|overlay/i);
  assert.match(body, /record\.pages\.list\(\)/);
});

/** The listener createPage registers with `contents.on(<event>, …)`. */
function pageListener(name: string): string {
  const createPage = parsed.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === 'createPage')!;
  let found = '';
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'contents.on' && node.arguments[0]?.getText(parsed) === `'${name}'`) {
      found = node.arguments[1]!.getText(parsed);
    }
    ts.forEachChild(node, visit);
  };
  visit(createPage);
  assert.ok(found, name);
  return found;
}

function pageKeys(platform: NodeJS.Platform) {
  const applied: number[] = [];
  const reloads: string[] = [];
  const context = {
    currentUiZoom: 1.2, process: { platform }, zoomShortcut, stepUiZoom,
    applyUiZoom: (factor: number, persist: boolean) => { assert.equal(persist, true); applied.push(factor); return factor; },
    newWindowShortcut: () => false, openNewWindow: () => {},
    reloadShortcut: () => null,
    contents: { reload: () => { reloads.push('reload'); }, reloadIgnoringCache: () => { reloads.push('force'); } },
  };
  const keys = runInNewContext(compile(`(${pageListener('before-input-event')})`), context) as (event: { preventDefault: () => void }, input: unknown) => void;
  const wheel = runInNewContext(compile(`(${pageListener('zoom-changed')})`), context) as (event: unknown, direction: string) => void;
  return { keys, wheel, applied, reloads };
}

test('zoom: Ctrl (Cmd on macOS) with plus, minus or zero sizes the interface, and the key goes no further', () => {
  const press = (key: string, code: string, mods: Record<string, boolean>) => ({ type: 'keyDown', key, code, control: false, meta: false, shift: false, alt: false, ...mods });
  for (const [platform, mods] of [['linux', { control: true }], ['win32', { control: true }], ['darwin', { meta: true }]] as const) {
    const { keys, applied } = pageKeys(platform);
    let prevented = 0;
    const event = { preventDefault: () => { prevented += 1; } };
    keys(event, press('=', 'Equal', mods));
    keys(event, press('-', 'Digit6', mods));
    keys(event, press('à', 'Digit0', mods)); // french-ok: the AZERTY character of the zero key
    keys(event, press(')', 'Minus', mods));
    assert.deepEqual(applied, [1.25, 1.1, 1], platform);
    assert.equal(prevented, 3, `${platform}: Ctrl+) on AZERTY stays the page's`);
  }
});

test('zoom: Ctrl+wheel steps one stop at a time', () => {
  const { wheel, applied } = pageKeys('linux');
  wheel({}, 'in');
  wheel({}, 'out');
  assert.deepEqual(applied, [1.25, 1.1]);
});

test('zoom: each page is sized before it loads and again once it has, the size told to it', () => {
  const body = functionText('createPage');
  assert.match(body, /zoomFactor: currentUiZoom,/, 'the first paint is at the size');
  assert.match(body, /contents\.setZoomFactor\(currentUiZoom\);\n\s*contents\.on\('did-navigate', \(\) => \{ contents\.setZoomFactor\(currentUiZoom\); \}\);\n\s*contents\.on\('dom-ready'/,
    'a cross-origin commit (the waiting page to the interface) takes the size again');
  const finished = body.split("contents.on('did-finish-load'").slice(1).join('');
  assert.match(finished, /setZoomFactor\(currentUiZoom\)/);
  assert.match(finished, /send\(UI_ZOOM_CHANNELS\.changed, \{ factor: currentUiZoom \}\)/);
  assert.match(source, /currentUiZoom = readUiZoom\(desktopHome\);/, 'the saved size is read at launch');
});

function zoomHandlers(windows: ReturnType<typeof fleet>) {
  const applied: { factor: number; persist: boolean }[] = [];
  const context: Record<string, unknown> = {
    windows, canReadAppInfo, UI_ZOOM_STEPS, parseUiZoomSetRequest, parseUiZoomStepRequest, stepUiZoom,
    currentUiZoom: 1.1,
    senderPage: pageFor(windows),
    senderOf: (e: ReturnType<typeof event>) => ({ isWindow: windows.pageOf(e.sender.id) !== null, isMainFrame: true, url: e.senderFrame.url }),
    applyUiZoom: (factor: number, persist: boolean) => { applied.push({ factor, persist }); return factor; },
  };
  runInNewContext(compile(functionText('zoomCaller')), context);
  const handler = (channel: string) => runInNewContext(compile(`(${handlerOf(channel)})`), context) as (e: unknown, input?: unknown) => unknown;
  return {
    get: handler('UI_ZOOM_CHANNELS.get'), set: handler('UI_ZOOM_CHANNELS.set'), step: handler('UI_ZOOM_CHANNELS.step'), applied,
  };
}

test('zoom: any page of a Timon window, local or remote, reads and changes the size of this screen', () => {
  const windows = fleet();
  const { get, set, step, applied } = zoomHandlers(windows);
  assert.equal(JSON.stringify(get(event(10))), JSON.stringify({ factor: 1.1, steps: UI_ZOOM_STEPS }));
  assert.equal(JSON.stringify(set(event(20), { factor: 1.24 })), '{"factor":1.25}', 'a page of another machine too, snapped to a stop');
  assert.equal(JSON.stringify(step(event(10), { direction: 'in' })), '{"factor":1.2}');
  assert.deepEqual(applied, [{ factor: 1.25, persist: true }, { factor: 1.2, persist: true }]);
});

test('zoom: only a page of a Timon window sizes the interface, and only with a size or a direction', () => {
  const windows = fleet();
  const { get, set, step, applied } = zoomHandlers(windows);
  for (const handle of [get, set, step]) {
    assert.throws(() => handle(event(1), { factor: 1.25, direction: 'in' }), /Only a Timon window/, 'the window\'s own blank webContents');
    assert.throws(() => handle(event(9), { factor: 1.25, direction: 'in' }), /Only a Timon window/, 'a stranger webContents');
    assert.throws(() => handle(event(10, 'https://evil.example/'), { factor: 1.25, direction: 'in' }), /Only a Timon window/, 'another origin');
  }
  for (const bad of [{ factor: 10 }, { factor: '1.25' }, 1.25, null]) assert.throws(() => set(event(10), bad), /between 0\.5 and 3/);
  for (const bad of [{ direction: 'up' }, 'in', null]) assert.throws(() => step(event(10), bad), /in, out or back/);
  assert.deepEqual(applied, []);
});
