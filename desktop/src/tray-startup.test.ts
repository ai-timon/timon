import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { loadTrayIcon } from './tray-icon.js';
import { shellText } from './shell-i18n.js';

// Execute the real startup boundary with fake Electron objects, without launching a shell.
const source = readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
const parsed = ts.createSourceFile('main.ts', source, ts.ScriptTarget.Latest, true);
const buildTray = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'buildTray');
assert.ok(buildTray);
const compiled = ts.transpileModule(buildTray.getText(parsed), {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

for (const platform of ['win32', 'darwin', 'linux'] as const) {
  for (const readable of [false, true]) {
    test(`${platform}: ${readable ? 'readable' : 'empty'} icons allow startup to reach the window`, () => {
      const calls: string[] = [];
      const image = {
        isEmpty: () => !readable,
        resize: () => image,
        setTemplateImage: () => {},
      };
      const context = {
        tray: null,
        DISPLAY_NAME: 'Timon',
        shellText, uiLocale: () => 'en',
        trayImage: () => loadTrayIcon({ platform, dir: 'tray', appIconPath: 'app.png', exists: () => true }, {
          createFromPath: () => image, warn: () => {},
        }),
        Tray: class {
          constructor() { calls.push('tray'); }
          setToolTip() { calls.push('tooltip'); }
          destroy() { calls.push('destroy'); }
        },
        refreshTray: () => { calls.push('refresh'); },
        console: { warn: () => { calls.push('warning'); } },
        dialog: { showMessageBox: (options: { detail: string }) => {
          assert.match(options.detail, /reinstall Timon/i);
          calls.push('dialog');
          // A dismissed dialog must not be required to continue startup.
          return new Promise(() => {});
        } },
        showWindow: () => { calls.push('window'); },
      };
      assert.doesNotThrow(() => runInNewContext(`${compiled}\nbuildTray({}, 'http://localhost'); showWindow();`, context));
      assert.deepEqual(calls, readable ? ['tray', 'tooltip', 'refresh', 'window'] : ['warning', 'dialog', 'window']);
      assert.equal(context.tray === null, !readable);
    });
  }
}

function closedHandler(): string {
  let handler: ts.ArrowFunction | undefined;
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && node.expression.getText(parsed) === 'w.on'
      && node.arguments[0]?.getText(parsed) === "'closed'") {
      const callback = node.arguments[1];
      if (callback && ts.isArrowFunction(callback)) handler = callback;
    }
    ts.forEachChild(node, visit);
  }
  visit(parsed);
  assert.ok(handler);
  return ts.transpileModule(`(${handler.getText(parsed)})();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

test('closing the window without a tray quits even with hidden browser sessions', () => {
  for (const hasTray of [false, true]) {
    for (const uninstalling of [false, true]) {
      // TODO #478: a box-then-quit sequence closes the window itself, then quits once.
      for (const quittingAfterProblem of [false, true]) {
        // Multi-window V3: only the last window closing can quit.
        for (const others of [0, 1]) {
          let quits = 0;
          const removed: number[] = [];
          const detached: number[] = [];
          const machineNames = new Map([[7, 'Office VPS']]);
          const context = {
            id: 7, tray: hasTray ? {} : null, uninstalling, quittingAfterProblem, machineNames,
            windows: { remove: (id: number) => { removed.push(id); }, get size() { return others; } },
            layoutKeeper: null,
            browserOwners: new Map([[7, 70]]),
            detachBrowser: (id: number) => { detached.push(id); },
            record: { pages: { everyPage: () => [] } },
            contentsOf: () => null,
            nativeBrowser: { hasSessions: true },
            app: { quit: () => { quits++; } },
          };
          runInNewContext(closedHandler(), context);
          assert.deepEqual(removed, [7], 'the closed window is forgotten');
          assert.equal(machineNames.has(7), false, 'and the machine name its top bar showed');
          assert.deepEqual(detached, [70], 'its presented tab returns to the browser host before the window is forgotten');
          assert.equal(quits, others === 0 && !hasTray && !uninstalling && !quittingAfterProblem ? 1 : 0);
        }
      }
    }
  }
});

test('macOS dock icon failure cannot abort startup before tray construction', () => {
  const main = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'main');
  assert.ok(main && ts.isFunctionDeclaration(main) && main.body);
  const dock = main.body.statements.find((node) => ts.isIfStatement(node)
    && node.expression.getText(parsed) === "process.platform === 'darwin'");
  assert.ok(dock);
  assert.match(dock.getText(parsed), /applyDockIcon\(readDockIcon\(desktopHome\)\)/);
  const apply = parsed.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'applyDockIcon');
  assert.ok(apply);
  const code = ts.transpileModule(`${apply.getText(parsed)}\n${dock.getText(parsed)}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  for (const state of ['empty', 'readable', 'throws'] as const) {
    let setIcons = 0;
    let continued = false;
    const paths: string[] = [];
    runInNewContext(`${code}\ncontinueStartup();`, {
      process: { platform: 'darwin' }, APP_ICON_PATH: 'app.png', desktopHome: 'home',
      readDockIcon: () => 'dark',
      dockIconPath: (classic: string, icon: string) => `${classic}:${icon}`,
      nativeImage: { createFromPath: (path: string) => { paths.push(path); return { isEmpty: () => state === 'empty' }; } },
      app: { dock: { setIcon: () => {
        if (state === 'throws') throw new Error('Invalid dock icon');
        setIcons++;
      } } },
      console: { warn: () => {} },
      continueStartup: () => { continued = true; },
    });
    assert.equal(continued, true);
    assert.deepEqual(paths, ['app.png:dark'], 'the chosen icon is the one loaded');
    assert.equal(setIcons, state === 'readable' ? 1 : 0);
  }
});
