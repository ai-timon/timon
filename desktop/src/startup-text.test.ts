/**
 * The failed-start dialogs (TODO #841): translated like the rest of the
 * shell, and still readable when the locale files are not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { daemonLogHint } from './service.js';
import { reopenHint } from './reopen-hint.js';
import { shellLocalesDir, useShellLocales } from './shell-i18n.js';
import { STARTUP_ENGLISH, startupText } from './startup-text.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const sources = () => useShellLocales(shellLocalesDir({ packaged: false, resourcesPath: 'unused', desktopRoot: join(repo, 'desktop') }));

test('the built-in English is en/desktop.json\'s desktop.startup, word for word', () => {
  const english = JSON.parse(readFileSync(join(repo, 'app', 'src', 'locales', 'en', 'desktop.json'), 'utf8')) as { desktop: { startup: unknown } };
  assert.deepEqual(STARTUP_ENGLISH, { desktop: { startup: english.desktop.startup } }, 'copy desktop.startup of en/desktop.json into STARTUP_ENGLISH');
});

test('every startup message has its French', () => {
  const french = JSON.parse(readFileSync(join(repo, 'app', 'src', 'locales', 'fr', 'desktop.json'), 'utf8')) as { desktop: { startup: Record<string, string> } };
  const english = (STARTUP_ENGLISH as { desktop: { startup: Record<string, string> } }).desktop.startup;
  for (const [key, message] of Object.entries(english)) {
    const translated = french.desktop.startup[key];
    assert.ok(translated, `fr startup.${key} is missing`);
    if (!/^\{[a-zA-Z]+\}$/.test(message)) assert.notEqual(translated, message, `fr startup.${key} is still English`);
  }
});

test('the dialogs speak the language asked for, the OS\'s included', () => {
  sources();
  const fr = startupText('fr-FR');
  assert.equal(fr('startup.crashing'), 'Le daemon plante sans cesse.');
  assert.equal(fr('startup.silent', { app: 'Timon' }), 'Le daemon Timon ne répond pas.'); // french-ok: the French locale under test
  assert.equal(startupText('xx')('startup.crashing'), 'The daemon keeps crashing.');
});

test('the English text of the "daemon does not answer" box is unchanged', () => {
  sources();
  const home = join('home', 'sam', '.timon');
  const t = startupText('en');
  const detail = t('startup.silentDetail', {
    origin: 'http://127.0.0.1:3001',
    supervisor: 'systemd',
    seconds: 180,
    reopen: reopenHint('en', true, 'Timon', 'minute'),
    logHint: daemonLogHint('en', home, false),
  });
  assert.equal(detail,
    'Expected at http://127.0.0.1:3001, supervised by systemd; nothing answered within 180 s. '
    + 'It may still be starting (a first launch after an update checks the installation and the providers), '
    + 'or it may have failed: reopen the window from the Timon icon in the notification area in a minute, and if it stays silent, read its log.\n\n'
    + 'Check the daemon supervisor configured for this installation. Your data has been preserved.');
  assert.equal(
    t('startup.slowDetail', { origin: 'http://127.0.0.1:3001', seconds: 90, reopen: reopenHint('en', false, 'Timon', 'moment') }),
    'Started in portable mode but http://127.0.0.1:3001 stayed silent for 90s. It may still be migrating its database — quit Timon and launch it again in a moment.',
  );
});

test('unreadable locale files leave the dialogs in English, never on their keys', () => {
  useShellLocales(join(tmpdir(), 'no-such-locales-dir-for-timon-startup'));
  try {
    const t = startupText('fr');
    assert.equal(t('startup.uiMissing'), 'The interface did not come up.');
    assert.equal(t('startup.portTaken', { origin: 'http://127.0.0.1:3001' }), 'Another service is using http://127.0.0.1:3001.');
    assert.equal(reopenHint('fr', false, 'Timon'), 'quit Timon and launch it again');
    assert.equal(t('startup.no.such.key'), 'startup.no.such.key');
  } finally {
    sources();
  }
});
