/**
 * The ghost pointer's window in a real Electron, headless: transparent, on top, not focusable, over
 * the whole primary display; it draws the agent's glide, its name, the click halos and the element
 * frame; it leaves the screen during a capture and closes at Stop. Opt-in, like every Electron smoke.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import ts from 'typescript';
import { smokeArgs, smokeElectron, smokeEnv, smokeHeadless } from './electron-binary.fixture.js';

const SRC = fileURLToPath(new URL('.', import.meta.url));
const MODULES = ['computer-use-overlay.ts', 'computer-use-overlay-page.ts', 'computer-use-pointer.ts'];

const SMOKE = `
import { app, screen } from 'electron';
import { writeSync } from 'node:fs';
import { GhostPointer } from './computer-use-overlay.js';
const fail = (e) => { writeSync(2, (e && e.stack || String(e)) + '\\n'); app.exit(1); };
process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
app.on('window-all-closed', () => {});
app.setPath('userData', process.env.TIMON_HOME + '/shell');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// No top-level await in an ESM entry: Electron fires 'ready' only once the entry has finished evaluating.
app.whenReady().then(async () => {
let raised = 0;
const ghost = new GhostPointer(() => screen.getPrimaryDisplay(), () => { raised++; });
const state = () => ghost.current.webContents.executeJavaScript('window.timonPointerState()');
const out = { display: screen.getPrimaryDisplay().bounds };
ghost.draw({ t: 'move', fromX: 10, fromY: 20, x: 400, y: 300, ms: 200 }, 'designer');
const window = ghost.current;
for (let i = 0; i < 100 && !window.isVisible(); i++) await sleep(50);
await sleep(400);
out.window = { bounds: window.getBounds(), visible: window.isVisible(), onTop: window.isAlwaysOnTop(), focusable: window.isFocusable(), title: window.getTitle(), focused: window.isFocused() };
out.raised = raised;
out.afterMove = await state();
ghost.draw({ t: 'click', x: 400, y: 300, n: 2 }, 'designer');
await sleep(250);
out.halos = (await state()).halos;
await sleep(700);
out.halosLater = (await state()).halos;
ghost.draw({ t: 'frame', x: 50, y: 60, w: 120, h: 30 }, 'designer');
await sleep(100);
out.frame = (await state()).frame;
out.duringCapture = await ghost.withoutGhost(async () => window.isVisible());
out.afterCapture = window.isVisible();
out.stateAfterCapture = await state();
ghost.hide();
await sleep(200);
out.closed = window.isDestroyed() && ghost.current === null;
console.log('GHOST_SMOKE ' + JSON.stringify(out));
app.exit(0);
}).catch(fail);
`;

test('the ghost pointer window draws the agent and stays out of the way, in Electron', {
  skip: process.env.TIMON_ELECTRON_SMOKE !== '1', timeout: 60_000,
}, async () => {
  const home = await mkdtemp(join(tmpdir(), 'timon-ghost-smoke-'));
  try {
    for (const name of MODULES) {
      const output = ts.transpileModule(readFileSync(join(SRC, name), 'utf8'), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      }).outputText;
      await writeFile(join(home, name.replace(/\.ts$/, '.js')), output);
    }
    await writeFile(join(home, 'package.json'), '{"type":"module"}');
    await writeFile(join(home, 'smoke.js'), SMOKE);
    const result = await promisify(execFile)(smokeElectron(), smokeArgs(join(home, 'smoke.js')), {
      env: smokeEnv({ ...process.env, ELECTRON_RUN_AS_NODE: '', TIMON_HOME: home }), timeout: 55_000, maxBuffer: 2 * 1024 * 1024,
    }).catch((error) => { throw new Error(`ghost smoke failed (${error.code ?? error.signal}): ${error.stdout}\n${error.stderr}`); });
    const line = /GHOST_SMOKE (.*)/.exec(result.stdout)?.[1];
    assert.ok(line, result.stdout + result.stderr);
    const out = JSON.parse(line) as {
      display: object; raised: number; halos: number; halosLater: number; duringCapture: boolean; afterCapture: boolean; closed: boolean;
      window: { bounds: object; visible: boolean; onTop: boolean; focusable: boolean; title: string; focused: boolean };
      afterMove: { x: number; y: number; visible: boolean; label: string };
      frame: { x: number; y: number; w: number; h: number } | null;
      stateAfterCapture: { x: number; y: number; visible: boolean };
    };
    assert.deepEqual(out.window.bounds, out.display, 'the sheet covers the primary display');
    assert.equal(out.window.visible, true);
    // The headless platform has no window manager to keep a stacking order: it reports false.
    if (!smokeHeadless()) assert.equal(out.window.onTop, true);
    assert.equal(out.window.focusable, false, 'it never takes the keyboard');
    assert.equal(out.window.focused, false);
    assert.equal(out.window.title, '', 'untitled: the agent\'s window list skips it');
    assert.equal(out.raised, 1, 'the stop bar is raised back over the sheet');
    assert.deepEqual(out.afterMove, { ...out.afterMove, x: 400, y: 300, visible: true, label: 'designer' });
    assert.equal(out.halos, 2, 'a double click draws two halos');
    assert.equal(out.halosLater, 0, 'the halos fade and leave');
    assert.deepEqual(out.frame, { x: 50, y: 60, w: 120, h: 30 });
    assert.equal(out.duringCapture, false, 'off the screen during a capture');
    assert.equal(out.afterCapture, true, 'back after it');
    assert.deepEqual([out.stateAfterCapture.x, out.stateAfterCapture.y, out.stateAfterCapture.visible], [400, 300, true]);
    assert.equal(out.closed, true, 'closed at Stop');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
