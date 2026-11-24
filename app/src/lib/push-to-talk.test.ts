import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PUSH_TO_TALK_DEFAUT,
  estDeclencheurPushToTalk,
  libelleTouche,
  lirePushToTalk,
  serialiserPushToTalk,
  toucheAutorisee,
} from './push-to-talk';

test('keys that type or drive the page are refused', () => {
  for (const code of ['KeyA', 'Digit1', 'Space', 'Enter', 'Tab', 'Backspace', 'Escape', 'Numpad1', 'Comma', '']) {
    assert.equal(toucheAutorisee(code), false, code);
  }
});

test('free keys are acceptable as a binding', () => {
  for (const code of ['Insert', 'F8', 'ShiftRight', 'ControlLeft', 'ScrollLock', 'Pause', 'Home']) {
    assert.equal(toucheAutorisee(code), true, code);
  }
});

test('the label separates the words stuck to the code', () => {
  assert.equal(libelleTouche('Insert'), 'Insert');
  assert.equal(libelleTouche('ShiftLeft'), 'Shift Left');
  assert.equal(libelleTouche(''), '');
});

test('a missing or unreadable preference falls back to the default', () => {
  assert.deepEqual(lirePushToTalk(null), PUSH_TO_TALK_DEFAUT);
  assert.deepEqual(lirePushToTalk('{'), PUSH_TO_TALK_DEFAUT);
  assert.deepEqual(lirePushToTalk('"insert"'), PUSH_TO_TALK_DEFAUT);
});

test('a stored key that became forbidden falls back to the default', () => {
  assert.deepEqual(
    lirePushToTalk(JSON.stringify({ actif: true, code: 'KeyA' })),
    { actif: true, code: 'Insert' },
  );
});

test('serialisation round trip', () => {
  const prefs = { actif: true, code: 'F8' };
  assert.deepEqual(lirePushToTalk(serialiserPushToTalk(prefs)), prefs);
});

test('the trigger only reacts to the bound key, with the setting on', () => {
  const prefs = { actif: true, code: 'Insert' };
  assert.equal(estDeclencheurPushToTalk({ code: 'Insert' }, prefs), true);
  assert.equal(estDeclencheurPushToTalk({ code: 'F8' }, prefs), false);
  assert.equal(estDeclencheurPushToTalk({ code: 'Insert' }, { ...prefs, actif: false }), false);
});

test('the keyboard auto-repeat does not reopen the dictation', () => {
  assert.equal(
    estDeclencheurPushToTalk({ code: 'Insert', repeat: true }, { actif: true, code: 'Insert' }),
    false,
  );
});
