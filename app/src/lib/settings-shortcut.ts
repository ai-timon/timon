/**
 * Ctrl+, (Cmd+, on macOS) opens Settings, the chord every desktop app gives
 * its preferences. Handled by the page rather than by an Electron menu: the
 * desktop window loads this same page, and hides its menu bar on Windows and
 * Linux, so one listener here serves the browser and the desktop app alike.
 */
import type { TerminalKeyEvent, TerminalPlatform } from './terminal-keys';

/**
 * Whether a key event is the Settings chord. The comma is the character typed
 * on a latin layout (on AZERTY it sits where QWERTY has M), and the physical
 * key (`Comma`) only on a layout that types no ASCII character there, so a
 * Cyrillic or Greek layout gets the shortcut too. Shift and Alt make it
 * another chord, and so does the other platform's modifier: Ctrl+, on a Mac
 * is not Cmd+,.
 */
export function isSettingsShortcut(event: TerminalKeyEvent, platform: TerminalPlatform): boolean {
  if (event.shiftKey || event.altKey) return false;
  const command = platform === 'mac' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!command) return false;
  if (event.key === ',') return true;
  return !/^[\x20-\x7e]$/.test(event.key) && event.code === 'Comma';
}
