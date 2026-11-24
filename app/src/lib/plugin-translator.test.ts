// french-ok-file: the translations a plugin ships, the data under test
import { strict as assert } from 'node:assert';
import { afterEach, test } from 'node:test';

import { availableLocales, registerLocale, setLocale, setLocaleCatalog } from './i18n';
import { createTranslator, type TranslatorMessages } from './plugin-translator';

const PRODUCT_CATALOG = availableLocales();

/** Switches the product to `tag`, as if the reader had chosen it. */
function readIn(tag: string): void {
  registerLocale(tag, {});
  setLocale(tag);
}

afterEach(() => {
  setLocaleCatalog(PRODUCT_CATALOG);
  setLocale('en');
});

const FILES = {
  en: { files: { selected: '{count, plural, one {# file selected} other {# files selected}}' }, hello: 'Hello {name}' },
  fr: { files: { selected: '{count, plural, one {# fichier sélectionné} other {# fichiers sélectionnés}}' }, hello: 'Bonjour {name}' },
  pl: { files: { selected: 'Wybrano {count, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}' } },
  ja: { files: { selected: '{count, plural, other {#個のファイルを選択}}' } },
  'pt-BR': { hello: 'Olá {name}' },
};

test('a plural picks its form by the rules of the language it comes from', () => {
  const t = createTranslator(FILES);
  assert.equal(t('files.selected', { count: 1 }), '1 file selected');
  assert.equal(t('files.selected', { count: 1234 }), '1,234 files selected');
  readIn('fr');
  assert.equal(t('files.selected', { count: 1 }), '1 fichier sélectionné');
  assert.equal(t('files.selected', { count: 2 }), '2 fichiers sélectionnés');
  readIn('pl');
  assert.equal(t('files.selected', { count: 1 }), 'Wybrano 1 plik');
  assert.equal(t('files.selected', { count: 3 }), 'Wybrano 3 pliki');
  assert.equal(t('files.selected', { count: 5 }), 'Wybrano 5 plików');
  assert.equal(t('files.selected', { count: 1.5 }), 'Wybrano 1,5 pliku');
  readIn('ja');
  assert.equal(t('files.selected', { count: 1 }), '1個のファイルを選択');
});

test('a language the plugin does not ship reads its English, then the key', () => {
  const t = createTranslator(FILES);
  readIn('de');
  assert.equal(t('hello', { name: 'Ada' }), 'Hello Ada');
  assert.equal(t('files.selected', { count: 2 }), '2 files selected');
  assert.equal(t('no.such.key'), 'no.such.key');
});

test('a missing message falls back key by key, never the whole language', () => {
  const t = createTranslator(FILES);
  readIn('pl');
  assert.equal(t('files.selected', { count: 2 }), 'Wybrano 2 pliki');
  assert.equal(t('hello', { name: 'Ada' }), 'Hello Ada', 'pl has no `hello`: English');
});

test('a regional variant finds its sibling, and the product\'s fallbacks are followed', () => {
  const t = createTranslator(FILES);
  readIn('pt-PT');
  assert.equal(t('hello', { name: 'Ana' }), 'Olá Ana', 'pt-PT → pt-BR beats English');
  setLocaleCatalog([...PRODUCT_CATALOG, { tag: 'gl', name: 'Galego', dir: 'ltr', coverage: 0, hash: 'x', fallback: ['pt-BR'] }]);
  readIn('gl');
  assert.equal(t('hello', { name: 'Ana' }), 'Olá Ana', 'gl falls back on pt-BR before English');
});

test('the language is read at each call', () => {
  const t = createTranslator(FILES);
  assert.equal(t('hello', { name: 'Ada' }), 'Hello Ada');
  readIn('fr');
  assert.equal(t('hello', { name: 'Ada' }), 'Bonjour Ada');
});

test('client API 2 translators keep working: `{ en, fr }`, flat dotted keys, `{name}`', () => {
  const t = createTranslator({
    en: { 'cockpit.mail.ago': '{age} ago', 'cockpit.mail.count': '{count} message(s)' },
    fr: { 'cockpit.mail.ago': 'il y a {age}' },
  });
  assert.equal(t('cockpit.mail.ago', { age: '3 min' }), '3 min ago');
  assert.equal(t('cockpit.mail.count', { count: 2 }), '2 message(s)');
  assert.equal(t('cockpit.mail.ago'), '{age} ago', 'a variable not given stays visible');
  readIn('fr');
  assert.equal(t('cockpit.mail.ago', { age: '3 min' }), 'il y a 3 min');
  assert.equal(t('cockpit.mail.count', { count: 2 }), '2 message(s)', 'fr lacks it: English');
});

test('a message ICU cannot parse keeps the old interpolation instead of showing raw', () => {
  const t = createTranslator({ en: { broken: 'Use {{name}} in {place}', plain: 'Don\'t panic' } });
  assert.equal(t('broken', { place: 'the template' }), 'Use {{name}} in the template');
  assert.equal(t('plain'), 'Don\'t panic');
});

test('a malformed tag is ignored, a tag in another case is canonical', () => {
  const t = createTranslator({ en: { hi: 'Hi' }, 'pt-br': { hi: 'Oi' }, 'not a tag': { hi: '??' } });
  readIn('pt-BR');
  assert.equal(t('hi'), 'Oi');
});

test('a plugin without English shows the key outside its languages', () => {
  const t = createTranslator({ fr: { hi: 'Salut' } });
  assert.equal(t('hi'), 'hi');
  readIn('fr');
  assert.equal(t('hi'), 'Salut');
});

test('languages added after the translator was created are read (TODO #888)', () => {
  const MESSAGES: Record<string, TranslatorMessages> = {};
  const t = createTranslator(MESSAGES);
  assert.equal(t('hello', { name: 'Ada' }), 'hello', 'nothing shipped yet: the key');
  MESSAGES.en = { hello: 'Hello {name}', files: { selected: '{count, plural, one {# file} other {# files}}' } };
  assert.equal(t('hello', { name: 'Ada' }), 'Hello Ada');
  readIn('fr');
  assert.equal(t('hello', { name: 'Ada' }), 'Hello Ada', 'no French yet: English');
  MESSAGES.fr = { hello: 'Bonjour {name}' };
  assert.equal(t('hello', { name: 'Ada' }), 'Bonjour Ada');
  assert.equal(t('files.selected', { count: 2 }), '2 files', 'fr lacks it: English');
  delete MESSAGES.fr;
  assert.equal(t('hello', { name: 'Ada' }), 'Hello Ada', 'a language removed is no longer read');
});

test('a dictionary replaced by a new object is read again, its ICU state with it', () => {
  const MESSAGES: Record<string, TranslatorMessages> = { en: { files: 'Use {{name}} in {place}' } };
  const t = createTranslator(MESSAGES);
  assert.equal(t('files', { place: 'here', count: 2 }), 'Use {{name}} in here', 'not ICU: old interpolation');
  MESSAGES.en = { files: '{count, plural, one {# file} other {# files}}' };
  assert.equal(t('files', { count: 2 }), '2 files', 'the new message is parsed, not the cached verdict reused');
});

test('the template examples/plugin-i18n: every language parses, names the arguments of English, and reads', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const { join, resolve } = await import('node:path');
  const { messageArguments } = await import('./i18n-core');
  const dir = resolve(process.cwd(), '..', 'examples', 'plugin-i18n', 'locales');
  const locales: Record<string, { widget: Record<string, string> }> = {};
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
    locales[file.slice(0, -'.json'.length)] = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  }
  const english = locales.en?.widget ?? {};
  for (const [tag, { widget }] of Object.entries(locales)) {
    for (const [key, message] of Object.entries(widget)) {
      const source = english[key];
      assert.ok(source !== undefined, `${tag}: widget.${key} is not in English`);
      assert.deepEqual(
        [...messageArguments(message, tag)].sort(), [...messageArguments(source)].sort(),
        `${tag}: widget.${key}`,
      );
    }
  }
  const t = createTranslator(locales);
  readIn('pl');
  assert.equal(t('widget.notes', { count: 0 }), 'Brak notatek');
  assert.equal(t('widget.notes', { count: 22 }), '22 notatki');
  assert.equal(t('widget.notes', { count: 25 }), '25 notatek');
  readIn('de-AT');
  assert.equal(t('widget.add'), 'Notiz hinzufügen');
  assert.equal(t('widget.language', { tag: 'de' }), 'Shown in de');
});
