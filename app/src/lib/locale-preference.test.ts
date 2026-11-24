import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import type { LocaleInfo } from './i18n';
import {
  LOCALE_COOKIE, localeCookie, negotiateLocale, parseLocaleChoice, readLocaleChoice, resolveLocale, selectableLocales,
} from './locale-preference';

function info(tag: string, name: string, coverage = 1): LocaleInfo {
  return { tag, name, dir: 'ltr', coverage, hash: tag };
}

/** The product's languages plus a Brazilian Portuguese barely started. */
const CATALOG: LocaleInfo[] = [info('fr', 'Français'), info('pt-BR', 'Português (Brasil)', 0.1), info('en', 'English'), info('de', 'Deutsch')]; // french-ok: language names, the catalogue under test

test('Accept-Language: the first language present wins, by weight then order', () => {
  assert.equal(negotiateLocale('fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7', CATALOG), 'fr');
  assert.equal(negotiateLocale('en-US,en;q=0.9,fr;q=0.8', CATALOG), 'en');
  assert.equal(negotiateLocale('ja-JP,ja;q=0.9,fr;q=0.8,en;q=0.5', CATALOG), 'fr');
  assert.equal(negotiateLocale('en;q=0.4,fr-CA;q=0.6', CATALOG), 'fr');
  assert.equal(negotiateLocale('fr;q=0,en', CATALOG), 'en');
});

test('Accept-Language: the region counts — fr-CA reads French, pt-BR and pt-PT the Brazilian Portuguese', () => {
  assert.equal(negotiateLocale('fr-CA', CATALOG), 'fr');
  assert.equal(negotiateLocale('pt-BR', CATALOG), 'pt-BR');
  assert.equal(negotiateLocale('pt-PT,en;q=0.5', CATALOG), 'pt-BR');
  assert.equal(negotiateLocale(['de-AT', 'en'], CATALOG), 'de', 'the browser list of languages works too');
});

test('Accept-Language: absent or unknown reads English', () => {
  assert.equal(negotiateLocale(null, CATALOG), 'en');
  assert.equal(negotiateLocale('', CATALOG), 'en');
  assert.equal(negotiateLocale('sw,ja;q=0.5', CATALOG), 'en');
  assert.equal(negotiateLocale('*', CATALOG), 'en');
});

test('an explicit choice beats the browser; auto follows it', () => {
  assert.equal(resolveLocale('en', 'fr-FR,fr', CATALOG), 'en');
  assert.equal(resolveLocale('fr', 'en-US', CATALOG), 'fr');
  assert.equal(resolveLocale('pt-BR', 'en-US', CATALOG), 'pt-BR');
  assert.equal(resolveLocale('auto', 'fr-FR,fr', CATALOG), 'fr');
});

test('the cookie holds any language present; anything else is auto', () => {
  assert.equal(parseLocaleChoice('fr', CATALOG), 'fr');
  assert.equal(parseLocaleChoice('pt-BR', CATALOG), 'pt-BR');
  assert.equal(parseLocaleChoice('pt-br', CATALOG), 'pt-BR', 'canonical form');
  assert.equal(parseLocaleChoice('pt', CATALOG), 'pt', 'kept as written, it resolves');
  assert.equal(resolveLocale(parseLocaleChoice('pt', CATALOG), null, CATALOG), 'pt-BR');
  assert.equal(parseLocaleChoice(undefined, CATALOG), 'auto');
  assert.equal(parseLocaleChoice('xx', CATALOG), 'auto');
  assert.equal(parseLocaleChoice('auto', CATALOG), 'auto');
  assert.equal(parseLocaleChoice('../../etc/passwd', CATALOG), 'auto');
  assert.equal(parseLocaleChoice('fr;q=1', CATALOG), 'auto');
});

test('the cookie the settings write is the one they read back', () => {
  const stored = localeCookie('pt-BR').split(';')[0] ?? '';
  assert.equal(stored, `${LOCALE_COOKIE}=pt-BR`);
  assert.equal(readLocaleChoice(`theme=dark; ${stored}; other=1`, CATALOG), 'pt-BR');
  assert.match(localeCookie('auto'), /Max-Age=0/);
  assert.match(localeCookie('not a tag'), /Max-Age=0/, 'nothing forged is written');
  assert.equal(readLocaleChoice('theme=dark', CATALOG), 'auto');
});

test('the selector offers every language present, English first then by tag, whatever its coverage', () => {
  assert.deepEqual(selectableLocales(CATALOG).map((entry) => entry.tag), ['en', 'de', 'fr', 'pt-BR']);
});
