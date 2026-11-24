import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_UI_ZOOM, UI_ZOOM_STEPS, nearestUiZoom, parseUiZoomSetRequest, parseUiZoomStepRequest, readUiZoom,
  stepUiZoom, writeUiZoom, zoomShortcut, type ZoomKeyInput,
} from './ui-zoom.js';

const press = (key: string, code: string, mods: Partial<ZoomKeyInput> = {}): ZoomKeyInput => ({
  type: 'keyDown', key, code, control: false, meta: false, shift: false, alt: false, ...mods,
});
const ctrl = { control: true };

/** A fresh home for one test, removed afterwards whatever happens. */
function withHome(run: (home: string) => void): void {
  const home = mkdtempSync(join(tmpdir(), 'timon-ui-zoom-'));
  try {
    run(home);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}

test('120 % and 125 % are each a stop, and 100 % is the default', () => {
  assert.equal(DEFAULT_UI_ZOOM, 1);
  assert.ok((UI_ZOOM_STEPS as readonly number[]).includes(1.2));
  assert.ok((UI_ZOOM_STEPS as readonly number[]).includes(1.25));
  assert.deepEqual([...UI_ZOOM_STEPS], [...UI_ZOOM_STEPS].sort((a, b) => a - b), 'stops go up');
});

test('any number lands on the closest stop, held at the ends', () => {
  assert.equal(nearestUiZoom(1), 1);
  assert.equal(nearestUiZoom(1.24), 1.25);
  assert.equal(nearestUiZoom(1.3333), 1.33);
  assert.equal(nearestUiZoom(0.1), 0.8);
  assert.equal(nearestUiZoom(9), 2);
  assert.equal(nearestUiZoom(Number.NaN), 1);
  assert.equal(nearestUiZoom(Number.POSITIVE_INFINITY), 1);
});

test('a step moves one stop, holds at the ends, and reset is 100 %', () => {
  assert.equal(stepUiZoom(1, 'in'), 1.1);
  assert.equal(stepUiZoom(1.1, 'in'), 1.2);
  assert.equal(stepUiZoom(1.2, 'in'), 1.25);
  assert.equal(stepUiZoom(1.25, 'out'), 1.2);
  assert.equal(stepUiZoom(1, 'out'), 0.9);
  assert.equal(stepUiZoom(2, 'in'), 2);
  assert.equal(stepUiZoom(0.8, 'out'), 0.8);
  assert.equal(stepUiZoom(1.75, 'reset'), 1);
});

test('a size never set, or a damaged file, is 100 %', () => {
  withHome((home) => {
    assert.equal(readUiZoom(home), 1);
    writeFileSync(join(home, 'ui-zoom.json'), '{broken');
    assert.equal(readUiZoom(home), 1);
    writeFileSync(join(home, 'ui-zoom.json'), JSON.stringify({ factor: 'big' }));
    assert.equal(readUiZoom(home), 1);
    writeFileSync(join(home, 'ui-zoom.json'), JSON.stringify({ factor: 1.26 }));
    assert.equal(readUiZoom(home), 1.25, 'a hand-edited size lands on a stop');
  });
});

test('a size is kept across launches, readable by its owner only', () => {
  withHome((home) => {
    assert.equal(writeUiZoom(home, 1.25), true);
    assert.equal(readUiZoom(home), 1.25);
    if (process.platform !== 'win32') assert.equal(statSync(join(home, 'ui-zoom.json')).mode & 0o777, 0o600);
    assert.equal(writeUiZoom(home, 1), true);
    assert.equal(readUiZoom(home), 1);
    assert.equal(writeUiZoom(join(home, 'missing', 'folder'), 1.5), false, 'an unwritable home reports it');
  });
});

test('a page asks for a size in range, snapped to a stop, and nothing else', () => {
  assert.equal(parseUiZoomSetRequest({ factor: 1.25 }), 1.25);
  assert.equal(parseUiZoomSetRequest({ factor: 1.21 }), 1.2);
  assert.equal(parseUiZoomSetRequest({ factor: 0.5 }), 0.8);
  assert.equal(parseUiZoomSetRequest({ factor: 3 }), 2);
  assert.equal(parseUiZoomSetRequest({ factor: 0.49 }), null);
  assert.equal(parseUiZoomSetRequest({ factor: 3.01 }), null);
  assert.equal(parseUiZoomSetRequest({ factor: Number.NaN }), null);
  assert.equal(parseUiZoomSetRequest({ factor: '1.25' }), null);
  assert.equal(parseUiZoomSetRequest(1.25), null);
  assert.equal(parseUiZoomSetRequest(null), null);
});

test('a page asks for a step by its direction only', () => {
  assert.equal(parseUiZoomStepRequest({ direction: 'in' }), 'in');
  assert.equal(parseUiZoomStepRequest({ direction: 'out' }), 'out');
  assert.equal(parseUiZoomStepRequest({ direction: 'reset' }), 'reset');
  assert.equal(parseUiZoomStepRequest({ direction: 'up' }), null);
  assert.equal(parseUiZoomStepRequest('in'), null);
  assert.equal(parseUiZoomStepRequest(undefined), null);
});

test('QWERTY: Ctrl with = or +, -, 0 on Windows and Linux', () => {
  for (const platform of ['linux', 'win32'] as const) {
    assert.equal(zoomShortcut(press('=', 'Equal', ctrl), platform), 'in');
    assert.equal(zoomShortcut(press('+', 'Equal', { ...ctrl, shift: true }), platform), 'in');
    assert.equal(zoomShortcut(press('-', 'Minus', ctrl), platform), 'out');
    assert.equal(zoomShortcut(press('_', 'Minus', { ...ctrl, shift: true }), platform), 'out');
    assert.equal(zoomShortcut(press('0', 'Digit0', ctrl), platform), 'reset');
  }
});

test('macOS takes Cmd, not Ctrl', () => {
  assert.equal(zoomShortcut(press('=', 'Equal', { meta: true }), 'darwin'), 'in');
  assert.equal(zoomShortcut(press('-', 'Minus', { meta: true }), 'darwin'), 'out');
  assert.equal(zoomShortcut(press('0', 'Digit0', { meta: true }), 'darwin'), 'reset');
  assert.equal(zoomShortcut(press('=', 'Equal', ctrl), 'darwin'), null);
  assert.equal(zoomShortcut(press('=', 'Equal', { meta: true }), 'linux'), null);
});

test('AZERTY: Ctrl with = or +, the - of the 6 key, and the zero key unshifted; Ctrl+) stays the page\'s', () => {
  assert.equal(zoomShortcut(press('=', 'Equal', ctrl), 'linux'), 'in');
  assert.equal(zoomShortcut(press('+', 'Equal', { ...ctrl, shift: true }), 'win32'), 'in');
  assert.equal(zoomShortcut(press('-', 'Digit6', ctrl), 'linux'), 'out');
  assert.equal(zoomShortcut(press('à', 'Digit0', ctrl), 'linux'), 'reset'); // french-ok: the AZERTY character of the zero key
  assert.equal(zoomShortcut(press('0', 'Digit0', { ...ctrl, shift: true }), 'win32'), 'reset');
  assert.equal(zoomShortcut(press(')', 'Minus', ctrl), 'linux'), null, 'the physical Minus key types ) on AZERTY');
  assert.equal(zoomShortcut(press('°', 'Minus', { ...ctrl, shift: true }), 'linux'), null);
});

test('QWERTZ: Ctrl with the + key, the - key and 0', () => {
  assert.equal(zoomShortcut(press('+', 'BracketRight', ctrl), 'linux'), 'in');
  assert.equal(zoomShortcut(press('-', 'Slash', ctrl), 'linux'), 'out');
  assert.equal(zoomShortcut(press('0', 'Digit0', ctrl), 'linux'), 'reset');
});

test('the numeric keypad zooms on every layout', () => {
  assert.equal(zoomShortcut(press('+', 'NumpadAdd', ctrl), 'win32'), 'in');
  assert.equal(zoomShortcut(press('-', 'NumpadSubtract', ctrl), 'win32'), 'out');
  assert.equal(zoomShortcut(press('0', 'Numpad0', ctrl), 'win32'), 'reset');
  assert.equal(zoomShortcut(press('Insert', 'Numpad0', ctrl), 'linux'), 'reset', 'Num Lock off');
});

test('a key typed in a field, a key release, an Alt chord or another key is left to the page', () => {
  assert.equal(zoomShortcut(press('=', 'Equal'), 'linux'), null);
  assert.equal(zoomShortcut(press('-', 'Minus'), 'linux'), null);
  assert.equal(zoomShortcut(press('0', 'Digit0'), 'linux'), null);
  assert.equal(zoomShortcut(press('=', 'Equal', { ...ctrl, type: 'keyUp' }), 'linux'), null);
  assert.equal(zoomShortcut(press('=', 'Equal', { ...ctrl, alt: true }), 'linux'), null);
  assert.equal(zoomShortcut(press('9', 'Digit9', ctrl), 'linux'), null);
  assert.equal(zoomShortcut(press('r', 'KeyR', ctrl), 'linux'), null);
});

test('macOS French AZERTY: Cmd with the - of the Equal key zooms out, with = or + of the Slash key zooms in', () => {
  const cmd = { meta: true };
  assert.equal(zoomShortcut(press('-', 'Equal', cmd), 'darwin'), 'out');
  assert.equal(zoomShortcut(press('_', 'Equal', { ...cmd, shift: true }), 'darwin'), 'out', 'Cmd+Shift+- never zooms in');
  assert.equal(zoomShortcut(press('=', 'Slash', cmd), 'darwin'), 'in');
  assert.equal(zoomShortcut(press('+', 'Slash', { ...cmd, shift: true }), 'darwin'), 'in');
});

test('the physical Equal key is read by what it types: QWERTZ, Spanish and Italian keep their own characters', () => {
  assert.equal(zoomShortcut(press('´', 'Equal', ctrl), 'linux'), null, 'QWERTZ: the acute accent');
  assert.equal(zoomShortcut(press('`', 'Equal', { ...ctrl, shift: true }), 'linux'), null, 'QWERTZ: the grave accent, with Shift');
  assert.equal(zoomShortcut(press('¡', 'Equal', ctrl), 'win32'), null, 'Spanish');
  assert.equal(zoomShortcut(press('^', 'Equal', { ...ctrl, shift: true }), 'win32'), null, 'Italian, with Shift');
});

test('Windows French AZERTY: AltGr, sent as Ctrl+Alt, types a character and never zooms', () => {
  const altGr = { control: true, alt: true };
  assert.equal(zoomShortcut(press('@', 'Digit0', altGr), 'win32'), null);
  assert.equal(zoomShortcut(press('}', 'Equal', altGr), 'win32'), null);
  assert.equal(zoomShortcut(press('|', 'Digit6', altGr), 'win32'), null);
});

test('the other command modifier makes it another chord', () => {
  const both = { control: true, meta: true };
  for (const platform of ['darwin', 'linux', 'win32'] as const) {
    assert.equal(zoomShortcut(press('=', 'Equal', both), platform), null, platform);
    assert.equal(zoomShortcut(press('-', 'Minus', both), platform), null, platform);
    assert.equal(zoomShortcut(press('0', 'Digit0', both), platform), null, platform);
  }
});
