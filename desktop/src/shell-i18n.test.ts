// french-ok-file: the language names and translations under test
/**
 * The shell's languages (docs/I18N.md): the same core as the webview, the
 * same folders, the same rules for a contributor's `desktop.json`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDictionary, messageArguments, type Dictionary } from './i18n-core.js';
import { readShellLanguages, resolveShellLocale, shellLocalesDir, shellText, useShellLocales } from './shell-i18n.js';
import { LOCALE_COOKIE, ShellLocale, cookieTag, pickLocaleCookie } from './shell-locale.js';
import { uninstallRequest } from './uninstall.js';

const repo = fileURLToPath(new URL('../..', import.meta.url));
const locales = join(repo, 'app', 'src', 'locales');

function leaves(node: Dictionary, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else if (isDictionary(value)) for (const [k, v] of leaves(value, path)) out.set(k, v);
    else out.set(path, `<not a string: ${typeof value}>`);
  }
  return out;
}

function fixture(languages: Record<string, { meta?: object; desktop?: object | string }>): string {
  const dir = mkdtempSync(join(tmpdir(), 'shell-i18n-'));
  for (const [tag, files] of Object.entries(languages)) {
    mkdirSync(join(dir, tag));
    if (files.meta) writeFileSync(join(dir, tag, 'meta.json'), JSON.stringify(files.meta));
    if (files.desktop !== undefined) {
      writeFileSync(join(dir, tag, 'desktop.json'), typeof files.desktop === 'string' ? files.desktop : JSON.stringify(files.desktop));
    }
  }
  return dir;
}

test('i18n-core.ts is the webview\'s, byte for byte', () => {
  assert.ok(
    readFileSync(join(repo, 'desktop', 'src', 'i18n-core.ts')).equals(readFileSync(join(repo, 'app', 'src', 'lib', 'i18n-core.ts'))),
    'copy app/src/lib/i18n-core.ts over desktop/src/i18n-core.ts',
  );
});

test('the cookie the shell reads is the one the app writes', () => {
  const app = readFileSync(join(repo, 'app', 'src', 'lib', 'locale-preference.ts'), 'utf8');
  assert.match(app, new RegExp(`export const LOCALE_COOKIE = '${LOCALE_COOKIE}';`));
});

test('every desktop.json parses as ICU and names the same arguments as English', () => {
  const english = leaves(JSON.parse(readFileSync(join(locales, 'en', 'desktop.json'), 'utf8')) as Dictionary);
  assert.ok(english.size > 100);
  for (const [key, message] of english) {
    assert.ok(key.startsWith('desktop.'), `${key}: every shell key lives under desktop.`);
    assert.doesNotThrow(() => messageArguments(message, 'en'), `en ${key}`);
  }
  const tags = readdirSync(locales, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => entry.name);
  assert.ok(tags.includes('fr'));
  for (const tag of tags) {
    let raw: string;
    try { raw = readFileSync(join(locales, tag, 'desktop.json'), 'utf8'); } catch { continue; }
    for (const [key, message] of leaves(JSON.parse(raw) as Dictionary)) {
      const source = english.get(key);
      assert.ok(source !== undefined, `${tag} ${key}: English has no such key`);
      const args = (text: string, lang: string) => [...messageArguments(text, lang)].sort();
      assert.deepEqual(args(message, tag), args(source, 'en'), `${tag} ${key}: arguments differ from English`);
    }
  }
});

test('every key the shell names in its code exists in English', () => {
  const english = leaves(JSON.parse(readFileSync(join(locales, 'en', 'desktop.json'), 'utf8')) as Dictionary);
  const src = join(repo, 'desktop', 'src');
  const used = new Set<string>();
  for (const name of readdirSync(src).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'))) {
    const text = readFileSync(join(src, name), 'utf8');
    for (const match of text.matchAll(/\bt\(\s*'([a-zA-Z]+\.[a-zA-Z.]+)'/g)) used.add(match[1] ?? '');
    for (const match of text.matchAll(/\? '([a-z]+\.[a-zA-Z]+)' : '([a-z]+\.[a-zA-Z]+)'/g)) { used.add(match[1] ?? ''); used.add(match[2] ?? ''); }
  }
  assert.ok(used.size > 80, `only ${used.size} keys found: the scan no longer matches the code`);
  for (const key of used) assert.ok(english.has(`desktop.${key}`), `desktop.${key} is used but missing from en/desktop.json`);
});

test('the shell speaks the language asked for, negotiated like the webview, English otherwise', () => {
  useShellLocales(shellLocalesDir({ packaged: false, resourcesPath: 'unused', desktopRoot: join(repo, 'desktop') }));
  assert.equal(shellText('fr')('menu.quit'), 'Quitter');
  assert.equal(shellText('fr-CA')('menu.quit'), 'Quitter');
  assert.equal(shellText('fr-CA').tag, 'fr');
  assert.equal(shellText('xx')('menu.quit'), 'Quit');
  assert.equal(shellText(null).tag, 'en');
  assert.equal(shellText('fr')('menu.daemon', { state: 'running', origin: 'http://127.0.0.1:3001' }), 'Daemon : en marche (http://127.0.0.1:3001)');
  assert.equal(shellText('en')('menu.daemon', { state: 'unreachable', origin: 'o' }), 'Daemon: unreachable (o)');
  assert.equal(shellText('en')('update.bytes', { copied: 1234, total: 5678 }), '1,234 / 5,678 bytes');
  assert.equal(shellText('en')('no.such.key'), 'no.such.key');
  // The bubble's page puts the number in itself.
  assert.equal(shellText('en')('bubble.send'), 'Send ({count})');
});

test('a language without desktop.json reads English, a broken one is skipped, and a fallback is honoured', () => {
  const warnings: string[] = [];
  const dir = fixture({
    en: { meta: { name: 'English', dir: 'ltr' }, desktop: { desktop: { menu: { quit: 'Quit', open: 'Open {appName}' } } } },
    de: { meta: { name: 'Deutsch', dir: 'ltr' } },
    nl: { meta: { name: 'Nederlands', dir: 'ltr' }, desktop: '{ not json' },
    'pt-BR': { meta: { name: 'Português (Brasil)', dir: 'ltr', default: true }, desktop: { desktop: { menu: { quit: 'Sair' } } } },
    'pt-PT': { meta: { name: 'Português', dir: 'ltr', fallback: ['pt-BR'] }, desktop: { desktop: { menu: { open: 'Abrir {appName}' } } } },
    ar: { meta: { name: 'العربية', dir: 'rtl' }, desktop: { desktop: { menu: { quit: 'خروج' } } } },
    'not-a-tag!': { meta: { name: 'x' } },
  });
  assert.deepEqual([...readShellLanguages(dir, (m) => warnings.push(m)).keys()], ['ar', 'de', 'en', 'pt-BR', 'pt-PT']);
  assert.equal(warnings.length, 1);
  useShellLocales(dir);
  try {
    assert.equal(shellText('de')('menu.quit'), 'Quit');
    assert.equal(shellText('de').tag, 'de');
    assert.equal(shellText('pt')('menu.quit'), 'Sair');
    assert.equal(shellText('pt-PT')('menu.quit'), 'Sair');
    assert.equal(shellText('pt-PT')('menu.open', { appName: 'Timon' }), 'Abrir Timon');
    assert.equal(shellText('ar').dir, 'rtl');
    assert.equal(resolveShellLocale(['nl', 'de-AT']), 'de');
  } finally {
    useShellLocales(shellLocalesDir({ packaged: false, resourcesPath: 'unused', desktopRoot: join(repo, 'desktop') }));
  }
});

test('a missing locales folder leaves the shell on its keys instead of crashing', () => {
  const warnings: string[] = [];
  assert.equal(readShellLanguages(join(tmpdir(), 'no-such-locales-dir-for-timon'), (m) => warnings.push(m)).size, 0);
  assert.equal(warnings.length, 1);
});

test('a package reads its languages from resources/locales, the sources from the app', () => {
  assert.equal(shellLocalesDir({ packaged: true, resourcesPath: join('r'), desktopRoot: 'd' }), join('r', 'locales'));
  assert.equal(shellLocalesDir({ packaged: false, resourcesPath: 'r', desktopRoot: join('repo', 'desktop') }), join('repo', 'desktop', '..', 'app', 'src', 'locales'));
});

test('the cookie: auto and anything not a tag mean the OS, the daemon\'s host wins', () => {
  assert.equal(cookieTag('auto'), null);
  assert.equal(cookieTag('<script>'), null);
  assert.equal(cookieTag('pt-br'), 'pt-BR');
  const cookies = [
    { name: 'other', value: 'de' },
    { name: LOCALE_COOKIE, value: 'en', domain: 'remote.example' },
    { name: LOCALE_COOKIE, value: 'fr', domain: 'localhost' },
  ];
  assert.equal(pickLocaleCookie(cookies, 'localhost'), 'fr');
  assert.equal(pickLocaleCookie(cookies, null), 'en');
  assert.equal(pickLocaleCookie([], 'localhost'), null);
});

test('the shell follows the app\'s choice and rebuilds only when the language changes', () => {
  useShellLocales(shellLocalesDir({ packaged: false, resourcesPath: 'unused', desktopRoot: join(repo, 'desktop') }));
  const changes: string[] = [];
  // Swedish is not shipped: the OS language falls back to English.
  const locale = new ShellLocale(() => ['sv-SE', 'en-US'], (tag) => changes.push(tag));
  assert.equal(locale.current, 'en');
  locale.load([{ name: LOCALE_COOKIE, value: 'fr', domain: 'localhost' }], 'localhost');
  assert.equal(locale.current, 'fr');
  // An overwrite is a removal then the new value: no flash of the OS's language.
  locale.changed({ name: LOCALE_COOKIE, value: 'fr' }, true, 'overwrite');
  locale.changed({ name: LOCALE_COOKIE, value: 'fr-CA' }, false, 'explicit');
  locale.changed({ name: 'session', value: 'x' }, true, 'explicit');
  assert.deepEqual(changes, ['fr']);
  // "System language" removes the cookie.
  locale.changed({ name: LOCALE_COOKIE, value: 'fr' }, true, 'explicit');
  assert.equal(locale.current, 'en');
  assert.deepEqual(changes, ['fr', 'en']);
  const french = new ShellLocale(() => ['fr-FR']);
  assert.equal(french.current, 'fr');
  french.load([{ name: LOCALE_COOKIE, value: 'auto' }], null);
  assert.equal(french.current, 'fr');
});

test('the uninstall bridge takes any language tag, and nothing else', () => {
  assert.equal(uninstallRequest({ mode: 'keep', locale: 'pt-BR' }).locale, 'pt-BR');
  for (const locale of ['', '../fr', 'fr_FR', 42, null]) assert.throws(() => uninstallRequest({ mode: 'keep', locale }));
});
