import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  framelessWindowOptions, parseWindowFrameAction, runWindowFrameAction, SYSTEM_TITLE_BAR_ENV, windowControls, windowFrameless, windowFrameState,
  type FramedWindow,
} from './window-frame.js';

test('the main window drops the system title bar unless the person keeps it', () => {
  assert.equal(windowFrameless({}), true);
  assert.equal(windowFrameless({ [SYSTEM_TITLE_BAR_ENV]: '1' }), false);
  assert.equal(windowFrameless({ [SYSTEM_TITLE_BAR_ENV]: '0' }), true, 'only 1 keeps it');
});

test('Windows and Linux lose the frame, macOS keeps its traffic lights over the bar', () => {
  assert.deepEqual(framelessWindowOptions('win32', true), { frame: false });
  assert.deepEqual(framelessWindowOptions('linux', true), { frame: false });
  const mac = framelessWindowOptions('darwin', true);
  assert.equal(mac.titleBarStyle, 'hiddenInset');
  assert.equal(mac.frame, undefined, 'a hidden title bar, not a frameless window: the lights stay');
  assert.ok(mac.trafficLightPosition && mac.trafficLightPosition.x > 0 && mac.trafficLightPosition.y > 0);
  for (const platform of ['win32', 'linux', 'darwin'] as const) assert.deepEqual(framelessWindowOptions(platform, false), {}, `${platform} keeps its frame on request`);
});

test('the page draws the buttons everywhere but on macOS', () => {
  assert.equal(windowControls('win32'), 'drawn');
  assert.equal(windowControls('linux'), 'drawn');
  assert.equal(windowControls('darwin'), 'native');
  assert.deepEqual(
    windowFrameState('win32', true, { maximized: true, fullScreen: false, machineName: 'Office VPS', active: false }),
    { frameless: true, controls: 'drawn', maximized: true, fullScreen: false, machineName: 'Office VPS', active: false },
  );
});

test('a page names one of three gestures, nothing else', () => {
  assert.equal(parseWindowFrameAction({ action: 'minimize' }), 'minimize');
  assert.equal(parseWindowFrameAction({ action: 'toggle-maximize' }), 'toggle-maximize');
  assert.equal(parseWindowFrameAction({ action: 'close' }), 'close');
  for (const bad of [{ action: 'destroy' }, { action: 'setBounds' }, { action: ['close'] }, 'close', null, undefined, 42]) {
    assert.equal(parseWindowFrameAction(bad), null, JSON.stringify(bad));
  }
});

function fakeWindow(state: { maximized?: boolean; fullScreen?: boolean } = {}) {
  const calls: string[] = [];
  const window: FramedWindow & { destroy(): void } = {
    minimize: () => { calls.push('minimize'); },
    maximize: () => { calls.push('maximize'); },
    unmaximize: () => { calls.push('unmaximize'); },
    isMaximized: () => state.maximized === true,
    isFullScreen: () => state.fullScreen === true,
    setFullScreen: (flag) => { calls.push(`fullScreen ${flag}`); },
    close: () => { calls.push('close'); },
    destroy: () => { calls.push('destroy'); },
  };
  return { window, calls };
}

test('the buttons minimize, maximize or restore, and close by asking', () => {
  const plain = fakeWindow();
  runWindowFrameAction(plain.window, 'minimize');
  runWindowFrameAction(plain.window, 'toggle-maximize');
  runWindowFrameAction(plain.window, 'close');
  assert.deepEqual(plain.calls, ['minimize', 'maximize', 'close'], 'close goes through the close event, never destroy');
  const maximized = fakeWindow({ maximized: true });
  runWindowFrameAction(maximized.window, 'toggle-maximize');
  assert.deepEqual(maximized.calls, ['unmaximize']);
  const full = fakeWindow({ maximized: true, fullScreen: true });
  runWindowFrameAction(full.window, 'toggle-maximize');
  assert.deepEqual(full.calls, ['fullScreen false'], 'restore leaves full screen first');
});
