// french-ok-file: the French sentences a daemon or the French locale returns
/**
 * The gallery used to drop every refusal: `if (!response.ok) return`. A `core`
 * module (403), an unknown id (404) or an expired session (401) all looked the
 * same on screen — a switch that would not move, with nothing said. These tests
 * pin the wording that now reaches the user, in both locales.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setLocale, t } from './i18n';
import './i18n-test-locales';
import { toggleFailureMessage } from './plugin-gallery';
import en from '../locales/en/core.json';
import fr from '../locales/fr/core.json';

const page = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', 'app', '(main)', 'plugins', 'plugins-client.tsx'),
  'utf8',
);

test('the daemon sentence wins: it names the actual module and the actual reason', () => {
  const daemonSaid = '@timon/db est un module core : il ne se désactive pas';
  assert.equal(toggleFailureMessage(403, { error: daemonSaid }), daemonSaid);
});

test('every status the route can answer produces a sentence, never an empty toast', () => {
  for (const status of [401, 403, 404, 500, 502]) {
    const message = toggleFailureMessage(status, null);
    assert.ok(message.length > 0, `status ${status} must say something`);
    assert.ok(!message.startsWith('pluginsPage.'), `status ${status} must resolve its i18n key`);
  }
});

test('an unusable body falls back on the status instead of showing "[object Object]"', () => {
  assert.match(toggleFailureMessage(500, { error: 42 }), /500/);
  assert.match(toggleFailureMessage(503, 'boom'), /503/);
  assert.equal(toggleFailureMessage(403, { error: '   ' }), t('pluginsPage.toggleForbidden'));
});

test('the toggle messages exist in both locales', () => {
  const keys = [
    'toggleFailed', 'toggleFailedStatus', 'toggleForbidden', 'toggleUnknown', 'toggleUnauthenticated',
    'toggleUnreachable', 'toggleApplied', 'toggleSyncFailed',
  ];
  const enPage = (en as { pluginsPage: Record<string, unknown> }).pluginsPage;
  const frPage = (fr as { pluginsPage: Record<string, unknown> }).pluginsPage;
  for (const key of keys) {
    assert.equal(typeof enPage[key], 'string', `en.${key}`);
    assert.equal(typeof frPage[key], 'string', `fr.${key}`);
  }
});

test('an applied change and a failed change do not share a sentence', () => {
  // The distinction is the point: a network failure changed nothing, a failed
  // refresh changed everything but the screen.
  assert.notEqual(t('pluginsPage.toggleUnreachable'), t('pluginsPage.toggleSyncFailed'));
  assert.notEqual(t('pluginsPage.toggleFailed', { plugin: 'x' }), t('pluginsPage.toggleApplied', { plugin: 'x' }));
  assert.match(t('pluginsPage.toggleApplied', { plugin: '@timon/memory' }), /@timon\/memory/);
});

test('the French toast is French, and both keep their placeholders', () => {
  setLocale('fr');
  assert.match(t('pluginsPage.toggleFailed', { plugin: '@timon/memory' }), /@timon\/memory/);
  assert.match(toggleFailureMessage(404, null), /inconnu/i);
  setLocale('en');
  assert.match(t('pluginsPage.toggleFailed', { plugin: '@timon/memory' }), /@timon\/memory/);
  assert.match(toggleFailureMessage(404, null), /unknown/i);
});

test('a lost answer is reported as unconfirmed, never as "nothing changed"', () => {
  // The write may well have happened and only the response died on the way
  // back. Promising the opposite would send the user to redo it.
  for (const locale of ['en', 'fr'] as const) {
    setLocale(locale);
    const message = t('pluginsPage.toggleUnreachable');
    assert.doesNotMatch(message, /nothing was changed|rien n’a été modifié|rien n'a été modifié/i);
    assert.match(message, /reload|recharge/i, 'it tells the user how to find out');
  }
  setLocale('en');
});

test('the toggle asks for a strict refresh, the boot path stays silent', () => {
  // `load()` returns early on a failed GET; without `strict` a 500 on the
  // gallery would pass for a successful refresh and the warning would never
  // fire.
  assert.match(page, /load\(\{ strict: true \}\), syncClientPlugins\(\)/);
  assert.match(page, /if \(opts\?\.strict\) throw new Error/);
  // And no path may leave a floating rejection in the effect.
  assert.doesNotMatch(page, /void load\(\);/);
  assert.match(page, /void load\(\)\.catch\(\(\) => \{\}\)/);
});

 test('Free composition refusals remain translated through the shared toggle feedback', () => {
  for (const locale of ['en', 'fr'] as const) {
    setLocale(locale);
    assert.equal(toggleFailureMessage(403, { error: 'plugin_composition_fixed' }), t('freeLicense.plugin_composition_fixed'));
    assert.notEqual(toggleFailureMessage(403, { error: 'plugin_composition_fixed' }), 'plugin_composition_fixed');
  }
  setLocale('en');
});
