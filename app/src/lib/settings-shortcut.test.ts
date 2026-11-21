/**
 * Ctrl+, opens Settings on Linux and Windows, Cmd+, on macOS, whatever the
 * keyboard layout, and no neighbouring chord does.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSettingsShortcut } from './settings-shortcut';
import type { TerminalKeyEvent } from './terminal-keys';

function chord(mods: string[], key: string, code = 'Comma'): TerminalKeyEvent {
  return {
    key,
    code,
    ctrlKey: mods.includes('Ctrl'),
    shiftKey: mods.includes('Shift'),
    altKey: mods.includes('Alt'),
    metaKey: mods.includes('Cmd'),
  };
}

test('Ctrl+, on Linux and Windows, Cmd+, on macOS', () => {
  for (const platform of ['other', 'windows'] as const) {
    assert.equal(isSettingsShortcut(chord(['Ctrl'], ','), platform), true);
    assert.equal(isSettingsShortcut(chord(['Cmd'], ','), platform), false);
  }
  assert.equal(isSettingsShortcut(chord(['Cmd'], ','), 'mac'), true);
  // Ctrl+, on a Mac is another chord, as in every macOS app.
  assert.equal(isSettingsShortcut(chord(['Ctrl'], ','), 'mac'), false);
});

test('a bare comma, or the chord with Shift, Alt or both modifiers, is not the shortcut', () => {
  assert.equal(isSettingsShortcut(chord([], ','), 'other'), false);
  assert.equal(isSettingsShortcut(chord(['Ctrl', 'Shift'], '<'), 'other'), false);
  assert.equal(isSettingsShortcut(chord(['Ctrl', 'Alt'], ','), 'windows'), false);
  assert.equal(isSettingsShortcut(chord(['Cmd', 'Ctrl'], ','), 'mac'), false);
});

test('the comma is the character typed, not the QWERTY key, on a latin layout', () => {
  // AZERTY: the comma is on the key QWERTY calls M; its Comma key types ';'.
  assert.equal(isSettingsShortcut(chord(['Ctrl'], ',', 'KeyM'), 'other'), true);
  assert.equal(isSettingsShortcut(chord(['Ctrl'], ';', 'Comma'), 'other'), false);
});

test('a layout without a comma there still gets it from the physical key', () => {
  // Russian ЙЦУКЕН: the Comma key types 'б'.
  assert.equal(isSettingsShortcut(chord(['Ctrl'], 'б', 'Comma'), 'other'), true);
  assert.equal(isSettingsShortcut(chord(['Ctrl'], 'б', 'KeyM'), 'other'), false);
});
