// french-ok-file: the localised menu labels under test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import type { MenuItemConstructorOptions } from 'electron';
import { appMenuTemplate } from './app-menu.js';
import { stepUiZoom } from './ui-zoom.js';

type Item = MenuItemConstructorOptions;

function template(locale = 'en-US', onAbout: () => void = () => {}): Item[] {
  const items = appMenuTemplate({ platform: 'darwin', appName: 'Timon', locale, onAbout });
  assert.ok(items);
  return items;
}

function flatten(items: Item[]): Item[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])]);
}

function aboutEntry(items: Item[], label: string): Item {
  const entry = flatten(items).find((item) => item.label === label);
  assert.ok(entry, `no "${label}" entry`);
  return entry;
}

test('app menu: on macOS no entry keeps the native About panel, and "About Timon" calls Timon\'s window', () => {
  let opened = 0;
  const items = template('en-US', () => { opened += 1; });
  assert.equal(flatten(items).filter((item) => item.role === 'about').length, 0);
  const about = aboutEntry(items, 'About Timon');
  assert.equal(items[0]?.label, 'Timon');
  assert.ok(Array.isArray(items[0]?.submenu));
  assert.equal(items[0].submenu[0], about, 'first entry of the application menu, where macOS users look for it');
  assert.equal(opened, 0);
  about.click?.({} as never, undefined, {} as never);
  assert.equal(opened, 1);
});

test('app menu: the entry speaks the language of the app', () => {
  assert.ok(aboutEntry(template('fr-FR'), 'À propos de Timon'));
  assert.ok(aboutEntry(template('de'), 'Über Timon'));
  assert.ok(aboutEntry(template('sv'), 'About Timon'));
});

// Replacing the default menu must not take its keys away: Cmd+C and Cmd+V reach a page through Edit, Cmd+Q through the app menu.
test('app menu: every other default menu of Electron stays', () => {
  const items = template();
  assert.deepEqual(items.slice(1).map((item) => item.role), ['fileMenu', 'editMenu', 'viewMenu', 'windowMenu', 'help']);
  const appEntries = flatten(items.slice(0, 1)).map((item) => item.role).filter(Boolean);
  assert.deepEqual(appEntries, ['services', 'hide', 'hideOthers', 'unhide', 'quit']);
});

test('app menu: Windows and Linux keep Electron\'s menu, which has no About', () => {
  for (const platform of ['win32', 'linux'] as const) {
    assert.equal(appMenuTemplate({ platform, appName: 'Timon', locale: 'en', onAbout: () => {} }), null);
  }
});

test('app menu: on Windows and Linux, with a zoom handler, Electron\'s menus stay but View sizes the interface', () => {
  for (const platform of ['win32', 'linux'] as const) {
    const steps: string[] = [];
    const items = appMenuTemplate({ platform, appName: 'Timon', locale: 'en', onAbout: () => {}, onZoom: (d) => { steps.push(d); } });
    assert.ok(items, platform);
    assert.deepEqual(items.map((item) => item.role), ['fileMenu', 'editMenu', 'viewMenu', 'windowMenu'], 'no macOS application menu');
    assert.ok(!flatten(items).some((item) => item.label === 'About Timon' || item.role === 'about' || item.role === 'services'));
    assert.ok(!flatten(items).some((item) => item.role === 'zoomIn' || item.role === 'zoomOut' || item.role === 'resetZoom'));
    const view = items[2]!;
    assert.ok(Array.isArray(view.submenu));
    assert.deepEqual(view.submenu.filter((item) => item.role).map((item) => item.role), ['reload', 'forceReload', 'toggleDevTools', 'togglefullscreen']);
    for (const [label, direction] of [['Actual Size', 'reset'], ['Zoom In', 'in'], ['Zoom Out', 'out']] as const) {
      const entry = view.submenu.find((item) => item.label === label);
      assert.ok(entry, label);
      assert.equal(entry.registerAccelerator, false, 'the keys stay with before-input-event');
      entry.click?.({} as never, undefined, {} as never);
      assert.equal(steps.at(-1), direction);
    }
  }
});

// The wiring lives in main.ts, which cannot load outside Electron: this runs its real functions with fake Electron objects.
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);

function functionText(name: string): string {
  const node = parsed.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  assert.ok(node, name);
  return node.getText(parsed);
}

// import.meta does not exist in a vm script.
const wiring = `${functionText('openAbout')}\n${functionText('installAppMenu')}`.replaceAll('import.meta.url', '"file:///desktop/dist/main.js"');
const compiled = ts.transpileModule(wiring, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function boot(input: { platform: NodeJS.Platform; releasePending: boolean }) {
  const shown: { locale: string; notices: string | null }[] = [];
  const zoomed: { factor: number; persist: boolean }[] = [];
  const check: string[] = [];
  const installed: Item[][] = [];
  const context = {
    process: { platform: input.platform, versions: { electron: '33.2.0' }, resourcesPath: 'resources' },
    app: { name: 'Timon', isPackaged: true, getVersion: () => '0.2.0' },
    uiLocale: () => 'fr',
    Menu: { buildFromTemplate: (items: Item[]) => items, setApplicationMenu: (items: Item[]) => { installed.push(items); } },
    URL,
    appMenuTemplate,
    fileURLToPath: () => 'desktop',
    readThirdPartyNotices: () => 'NOTICE',
    thirdPartyNoticesPath: () => 'path',
    windowScheme: () => 'dark',
    nativeTheme: { shouldUseDarkColors: true },
    desktopHome: 'home',
    APP_ICON_PATH: 'icon',
    showAboutWindow: (page: { locale: string; notices: string | null }) => { shown.push(page); },
    releasePending: input.releasePending,
    releaseCheckWindow: { show: () => check.push('show'), focus: () => check.push('focus') },
    currentUiZoom: 1.2,
    stepUiZoom,
    applyUiZoom: (factor: number, persist: boolean) => { zoomed.push({ factor, persist }); return factor; },
  };
  runInNewContext(`${compiled}\ninstallAppMenu()`, context);
  return { context, shown, check, installed, zoomed };
}

test('main.ts: the macOS menu bar opens the same window, with the licences', () => {
  const { shown, installed, check } = boot({ platform: 'darwin', releasePending: false });
  assert.equal(installed.length, 1);
  aboutEntry(installed[0] ?? [], 'À propos de Timon').click?.({} as never, undefined, {} as never);
  assert.equal(shown.length, 1);
  assert.equal(shown[0]?.notices, 'NOTICE');
  assert.deepEqual(check, []);
});

test('main.ts: while the release is being checked, the menu bar opens no window; once verified, it does', () => {
  const { context, shown, installed, check } = boot({ platform: 'darwin', releasePending: true });
  const about = aboutEntry(installed[0] ?? [], 'À propos de Timon');
  about.click?.({} as never, undefined, {} as never);
  assert.equal(shown.length, 0, 'TODO #439: no other window until the release is verified');
  assert.deepEqual(check, ['show', 'focus']);
  context.releasePending = false;
  about.click?.({} as never, undefined, {} as never);
  assert.equal(shown.length, 1);
});

test('main.ts: Windows and Linux install Electron\'s menus with a View that sizes the interface, and no macOS application menu', () => {
  for (const platform of ['win32', 'linux'] as const) {
    const { installed, zoomed } = boot({ platform, releasePending: false });
    assert.equal(installed.length, 1, platform);
    const items = installed[0] ?? [];
    assert.deepEqual(items.map((item) => item.role), ['fileMenu', 'editMenu', 'viewMenu', 'windowMenu']);
    assert.ok(!flatten(items).some((item) => item.label === 'À propos de Timon'), 'no About entry outside macOS');
    aboutEntry(items, 'Zoom avant').click?.({} as never, undefined, {} as never);
    aboutEntry(items, 'Zoom arrière').click?.({} as never, undefined, {} as never);
    aboutEntry(items, 'Taille réelle').click?.({} as never, undefined, {} as never);
    assert.deepEqual(zoomed, [{ factor: 1.25, persist: true }, { factor: 1.1, persist: true }, { factor: 1, persist: true }], 'View › Zoom goes through applyUiZoom');
  }
});

test('main.ts: the menu is installed once windows are guarded and before the release check can open one', () => {
  const body = functionText('main');
  const permissions = body.indexOf('installWindowPermissions(');
  const menu = body.indexOf('installAppMenu()');
  const verify = body.indexOf('verifyInstalledRelease()');
  assert.ok(permissions >= 0 && permissions < menu, 'a window opened from the menu must find the permission handlers in place');
  assert.ok(menu < verify, 'during the check, Electron\'s default menu would still offer the native panel');
});
