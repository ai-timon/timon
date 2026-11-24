/**
 * Copy and paste in the built-in terminal: each OS keeps its habit, and the
 * chords a shell needs (Ctrl+C = SIGINT, Ctrl+V = ^V) still reach it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectTerminalPlatform, terminalClipboardAction, type TerminalKeyEvent } from './terminal-keys';

function chord(spec: string, code?: string): TerminalKeyEvent {
  const parts = spec.split('+');
  const key = parts.at(-1)!;
  return {
    key,
    code: code ?? (/^[a-z]$/i.test(key) ? `Key${key.toUpperCase()}` : key),
    ctrlKey: parts.includes('Ctrl'),
    shiftKey: parts.includes('Shift'),
    altKey: parts.includes('Alt'),
    metaKey: parts.includes('Cmd'),
  };
}

test('Ctrl+Shift+C copies and Ctrl+Shift+V pastes on Linux and Windows', () => {
  for (const platform of ['other', 'windows'] as const) {
    assert.equal(terminalClipboardAction(chord('Ctrl+Shift+C'), platform, true), 'copy');
    // Swallowed even without a selection: the browser would open its inspector.
    assert.equal(terminalClipboardAction(chord('Ctrl+Shift+C'), platform, false), 'copy');
    assert.equal(terminalClipboardAction(chord('Ctrl+Shift+V'), platform, false), 'paste');
  }
});

test('Ctrl+C stays SIGINT, except on a selection on Windows', () => {
  assert.equal(terminalClipboardAction(chord('Ctrl+c'), 'other', true), null);
  assert.equal(terminalClipboardAction(chord('Ctrl+c'), 'other', false), null);
  assert.equal(terminalClipboardAction(chord('Ctrl+c'), 'mac', true), null);
  assert.equal(terminalClipboardAction(chord('Ctrl+c'), 'windows', false), null);
  assert.equal(terminalClipboardAction(chord('Ctrl+c'), 'windows', true), 'copy');
});

test('Ctrl+V stays ^V for the shell', () => {
  for (const platform of ['other', 'windows', 'mac'] as const) {
    assert.equal(terminalClipboardAction(chord('Ctrl+v'), platform, true), null);
  }
});

test('Cmd+C copies a selection and Cmd+V pastes on macOS', () => {
  assert.equal(terminalClipboardAction(chord('Cmd+c'), 'mac', true), 'copy');
  assert.equal(terminalClipboardAction(chord('Cmd+c'), 'mac', false), null);
  assert.equal(terminalClipboardAction(chord('Cmd+v'), 'mac', false), 'paste');
  assert.equal(terminalClipboardAction(chord('Cmd+Shift+C'), 'mac', true), null);
  assert.equal(terminalClipboardAction(chord('Ctrl+Shift+C'), 'mac', true), null);
});

test('Alt and other letters are left to the shell', () => {
  assert.equal(terminalClipboardAction(chord('Ctrl+Alt+Shift+C'), 'other', true), null);
  assert.equal(terminalClipboardAction(chord('Ctrl+Shift+X'), 'other', true), null);
  assert.equal(terminalClipboardAction(chord('c'), 'other', true), null);
  assert.equal(terminalClipboardAction(chord('Cmd+c'), 'other', true), null);
});

test('a non-latin layout matches on the physical key', () => {
  assert.equal(terminalClipboardAction(chord('Ctrl+Shift+С', 'KeyC'), 'other', true), 'copy');
  assert.equal(terminalClipboardAction(chord('Cmd+м', 'KeyV'), 'mac', false), 'paste');
});

test('the platform comes from userAgentData, else navigator.platform', () => {
  assert.equal(detectTerminalPlatform({ userAgentData: { platform: 'macOS' } }), 'mac');
  assert.equal(detectTerminalPlatform({ platform: 'MacIntel' }), 'mac');
  assert.equal(detectTerminalPlatform({ platform: 'iPad' }), 'mac');
  assert.equal(detectTerminalPlatform({ userAgentData: { platform: 'Windows' }, platform: 'Win32' }), 'windows');
  assert.equal(detectTerminalPlatform({ platform: 'Win32' }), 'windows');
  assert.equal(detectTerminalPlatform({ platform: 'Linux x86_64' }), 'other');
  // An explicit `undefined` takes the default, the real navigator (Node has one): an empty one stands for none.
  assert.equal(detectTerminalPlatform({}), 'other');
});
