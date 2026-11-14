/**
 * Chromium's spell checker downloads its dictionaries from Google
 * (`redirector.gvt1.com`) the first time a text field is focused: a request
 * nobody asked for, leaving the machine on the first launch.
 *
 * - Linux: those dictionaries are the only ones Chromium can use there, so the
 *   checker is turned off. Text fields lose the red underline, nothing else.
 * - Windows: Chromium uses the Windows spell checker, which needs no download;
 *   it stays on, and the download URL points to the loopback so a language
 *   Windows lacks cannot fall back to Google.
 * - macOS: the system spell checker, never a download. Nothing to do.
 *
 * Applied to every session (the window, the built-in browser's profiles, the
 * annotation bubble): each one downloads its own copy.
 */

/** Discard port on the loopback: a refused connection that never leaves the machine. */
export const NO_DICTIONARY_URL = 'http://127.0.0.1:9/';

export interface SpellCheckSession {
  setSpellCheckerEnabled(enable: boolean): void;
  setSpellCheckerDictionaryDownloadURL(url: string): void;
}

export function keepDictionariesLocal(session: SpellCheckSession, platform: NodeJS.Platform): void {
  if (platform === 'darwin') return;
  session.setSpellCheckerDictionaryDownloadURL(NO_DICTIONARY_URL);
  if (platform === 'linux') session.setSpellCheckerEnabled(false);
}
