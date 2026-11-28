import assert from 'node:assert/strict';
import test from 'node:test';
import { frameAttributes, parseWindowFrameState, readWindowFrame, subscribeWindowFrame, windowFrameAction, type WindowFrameState } from './window-frame';

type Globals = { window?: unknown };
const g = globalThis as unknown as Globals;

const DRAWN = { frameless: true, controls: 'drawn', maximized: false, fullScreen: false, machineName: 'Office VPS' };

/** A desktop shell announcing its window's state the way the preload does. */
function shell(state: unknown = DRAWN) {
  const listeners = new Set<(state: unknown) => void>();
  const acted: unknown[] = [];
  const windowFrame = {
    get: async () => state,
    act: async (action: unknown) => { acted.push(action); return { done: true }; },
    onChange: (listener: (state: unknown) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  g.window = { timonDesktop: { restartAfterSetup: async () => {}, windowFrame } };
  return { acted, listeners, announce: (next: unknown) => { for (const listener of listeners) listener(next); } };
}

test.afterEach(() => { delete g.window; });

test('the web, the PWA and an older desktop draw no frame', async () => {
  assert.equal(await readWindowFrame(), null);
  assert.equal(await windowFrameAction('close'), false);
  subscribeWindowFrame(() => assert.fail('nothing to hear'))();
  g.window = { timonDesktop: { restartAfterSetup: async () => {} } };
  assert.equal(await readWindowFrame(), null);
  assert.equal(await windowFrameAction('minimize'), false);
});

test('a window that kept the system title bar draws nothing either', async () => {
  shell({ ...DRAWN, frameless: false });
  assert.equal(await readWindowFrame(), null);
});

test('a failing or refusing shell reads as no frame', async () => {
  g.window = {
    timonDesktop: {
      restartAfterSetup: async () => {},
      windowFrame: {
        get: async () => { throw new Error("No handler registered for 'timon:window-frame-get'"); },
        act: async () => { throw new Error('Only the page on screen moves its window.'); },
        onChange: () => () => {},
      },
    },
  };
  assert.equal(await readWindowFrame(), null);
  assert.equal(await windowFrameAction('close'), false);
});

test('the shell\'s state is read, and checked', async () => {
  shell();
  assert.deepEqual(await readWindowFrame(), { controls: 'drawn', maximized: false, fullScreen: false, machineName: 'Office VPS', active: true });
  assert.equal(parseWindowFrameState({ ...DRAWN, active: false })?.active, false, 'a page kept alive under the one on screen');
  assert.equal(parseWindowFrameState({ ...DRAWN, controls: 'custom' }), null);
  assert.equal(parseWindowFrameState('frameless'), null);
  assert.equal(parseWindowFrameState(null), null);
  assert.equal(parseWindowFrameState({ ...DRAWN, maximized: 'yes', machineName: '  ' })?.maximized, false);
  assert.equal(parseWindowFrameState({ ...DRAWN, machineName: 42 })?.machineName, null);
  assert.equal(parseWindowFrameState({ ...DRAWN, machineName: 'x'.repeat(500) })?.machineName?.length, 120);
});

test('every change of the window reaches the page, a malformed one never', () => {
  const { announce, listeners } = shell();
  const heard: WindowFrameState[] = [];
  const stop = subscribeWindowFrame((state) => heard.push(state));
  announce({ ...DRAWN, maximized: true });
  announce({ maximized: true });
  announce(null);
  assert.deepEqual(heard.map((state) => state.maximized), [true]);
  stop();
  assert.equal(listeners.size, 0);
});

test('a button sends its gesture to the shell', async () => {
  const { acted } = shell();
  assert.equal(await windowFrameAction('toggle-maximize'), true);
  assert.equal(await windowFrameAction('close'), true);
  assert.deepEqual(acted, ['toggle-maximize', 'close']);
});

test('the top bar keeps room for the buttons, for the way out of full screen, or for the traffic lights', () => {
  const drawn = parseWindowFrameState(DRAWN)!;
  const mac = parseWindowFrameState({ ...DRAWN, controls: 'native' })!;
  assert.deepEqual(frameAttributes(null, true), { frame: null, drag: false }, 'a browser: nothing');
  assert.deepEqual(frameAttributes(drawn, true), { frame: 'drawn', drag: true });
  assert.deepEqual(frameAttributes({ ...drawn, fullScreen: true }, true), { frame: 'drawn-full-screen', drag: true });
  assert.deepEqual(frameAttributes(mac, true), { frame: 'native', drag: true });
  assert.deepEqual(frameAttributes({ ...mac, fullScreen: true }, true), { frame: null, drag: true }, 'macOS hides its lights in full screen');
  assert.deepEqual(frameAttributes(drawn, false), { frame: 'drawn', drag: false }, 'a hidden page drops its drag areas');
  assert.deepEqual(frameAttributes({ ...drawn, active: false }, true), { frame: 'drawn', drag: false }, 'so does a page the shell put away');
});
