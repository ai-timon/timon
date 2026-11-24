import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  canonicalTag, localeChain, messageArguments, negotiate, parseAcceptLanguage, resolveMessage, translate,
  type LocaleInfo, type LocaleLayer, type LocaleOffer,
} from './i18n-core';

const OFFERS: LocaleOffer[] = [
  { tag: 'en' }, { tag: 'fr' }, { tag: 'pt-BR' }, { tag: 'de' }, { tag: 'ja' },
];

test('negotiation: a regional variant reads its language', () => {
  assert.equal(negotiate(['fr-CA'], OFFERS), 'fr');
  assert.equal(negotiate(['de-AT', 'en'], OFFERS), 'de');
});

test('negotiation: an exact regional tag wins, whatever its case', () => {
  assert.equal(negotiate(['pt-BR'], OFFERS), 'pt-BR');
  assert.equal(negotiate(['pt-br'], OFFERS), 'pt-BR');
});

test('negotiation: another variant of the same language beats English', () => {
  assert.equal(negotiate(['pt'], OFFERS), 'pt-BR');
  assert.equal(negotiate(['pt-PT'], OFFERS), 'pt-BR');
});

test('negotiation: the variant marked default wins, then the first by tag', () => {
  const offers: LocaleOffer[] = [{ tag: 'en' }, { tag: 'es-AR' }, { tag: 'es-MX' }, { tag: 'es-419', default: true }];
  assert.equal(negotiate(['es'], offers), 'es-419');
  assert.equal(negotiate(['es'], offers.map(({ tag }) => ({ tag }))), 'es-419', 'by tag: "es-419" < "es-AR"');
  assert.equal(negotiate(['es-MX'], offers), 'es-MX');
});

test('negotiation: an unknown language resolves to nothing, the caller reads English', () => {
  assert.equal(negotiate(['sw'], OFFERS), null);
  assert.equal(negotiate(['sw', 'ja-JP'], OFFERS), 'ja', 'the next tag is tried');
  assert.equal(negotiate([], OFFERS), null);
  assert.equal(negotiate(['not a tag', '../../etc'], OFFERS), null);
});

test('negotiation: Chinese never crosses between Simplified and Traditional', () => {
  const offers: LocaleOffer[] = [{ tag: 'en' }, { tag: 'zh' }];
  assert.equal(negotiate(['zh-CN'], offers), 'zh');
  assert.equal(negotiate(['zh-Hant-TW'], offers), null);
  assert.equal(negotiate(['zh-TW'], [...offers, { tag: 'zh-Hant' }]), 'zh-Hant');
});

test('Accept-Language: by weight then order, q=0 and * dropped', () => {
  assert.deepEqual(parseAcceptLanguage('fr-CA,fr;q=0.9,en;q=0.8'), ['fr-CA', 'fr', 'en']);
  assert.deepEqual(parseAcceptLanguage('en;q=0.5, de, *;q=0.1, ja;q=0'), ['de', 'en']);
  assert.deepEqual(parseAcceptLanguage(''), []);
  assert.deepEqual(parseAcceptLanguage(null), []);
});

test('canonical tags', () => {
  assert.equal(canonicalTag('pt-br'), 'pt-BR');
  assert.equal(canonicalTag('EN'), 'en');
  assert.equal(canonicalTag('fr;q=1'), null);
  assert.equal(canonicalTag('<script>'), null);
  assert.equal(canonicalTag(''), null);
});

const PL: LocaleLayer = {
  tag: 'pl',
  dictionary: {
    files: { selected: 'Wybrano {count, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}' },
  },
};
const EN: LocaleLayer = {
  tag: 'en',
  dictionary: {
    files: { selected: '{count, plural, one {# file selected} other {# files selected}}', none: 'No file' },
    only: { english: 'English only' },
  },
};

test('plurals: Polish picks one, few and many inside one ICU message', () => {
  const chain = [PL, EN];
  assert.equal(translate(chain, 'files.selected', { count: 1 }), 'Wybrano 1 plik');
  assert.equal(translate(chain, 'files.selected', { count: 2 }), 'Wybrano 2 pliki');
  assert.equal(translate(chain, 'files.selected', { count: 5 }), 'Wybrano 5 plików');
  assert.equal(translate(chain, 'files.selected', { count: 22 }), 'Wybrano 22 pliki');
  assert.equal(translate(chain, 'files.selected', { count: 1.5 }), 'Wybrano 1,5 pliku');
});

test('plurals: English one and other, # written the way the language writes numbers', () => {
  assert.equal(translate([EN], 'files.selected', { count: 1 }), '1 file selected');
  assert.equal(translate([EN], 'files.selected', { count: 1234 }), '1,234 files selected');
});

test('a plain {name} argument is written as given', () => {
  const layer: LocaleLayer = { tag: 'en', dictionary: { n: '{count} pending', zero: '{count}' } };
  assert.equal(translate([layer], 'n', { count: 2000 }), '2000 pending');
  assert.equal(translate([layer], 'zero', { count: 0 }), '0');
});

test('fallback: key by key to English, null when nobody has it', () => {
  const chain = [PL, EN];
  assert.equal(translate(chain, 'only.english'), 'English only');
  assert.equal(translate(chain, 'files.none'), 'No file');
  assert.equal(translate(chain, 'nobody.has.this'), null);
  assert.equal(resolveMessage(chain, 'files'), null, 'a branch is not a message');
});

test('a variable not given stays visible; a message that does not parse shows its raw text', () => {
  const layer: LocaleLayer = {
    tag: 'en',
    dictionary: { hello: 'Hello {name}, {missing}', broken: 'Hello {name', plural: '{count, plural, one {#} other {# x}}' },
  };
  assert.equal(translate([layer], 'hello', { name: 'Ada' }), 'Hello Ada, {missing}');
  assert.equal(translate([layer], 'broken', { name: 'Ada' }), 'Hello {name');
  assert.equal(translate([layer], 'plural'), '{count, plural, one {#} other {# x}}', 'a plural without its count');
});

test('ICU quoting: quoted braces are literal, a doubled apostrophe is one, a lone one stays', () => {
  const layer: LocaleLayer = {
    tag: 'en',
    dictionary: { template: "Use '{{vars.x}}' in {place}", apostrophe: "Don't, it''s {name}'s", plain: "it's plain" },
  };
  assert.equal(translate([layer], 'template', { place: 'a header' }), 'Use {{vars.x}} in a header');
  assert.equal(translate([layer], 'apostrophe', { name: 'Ada' }), "Don't, it's Ada's");
  assert.equal(translate([layer], 'plain'), "it's plain");
});

test('ICU tags are plain text, never markup', () => {
  const layer: LocaleLayer = { tag: 'en', dictionary: { tag: 'Press <Enter> to send {name}' } };
  assert.equal(translate([layer], 'tag', { name: 'it' }), 'Press <Enter> to send it');
});

test('the arguments of a message, plural and select included', () => {
  assert.deepEqual([...messageArguments('{n} of {count, plural, one {# {kind}} other {# {kind}s}}')].sort(), ['count', 'kind', 'n']);
  assert.deepEqual([...messageArguments('{who, select, me {You} other {{who}}} left')], ['who']);
  assert.throws(() => messageArguments('{count, plural, one {#}}'), /MISSING_OTHER_CLAUSE/);
});

test('the lookup chain: the language, its declared fallbacks, then English', () => {
  const catalog: LocaleInfo[] = [
    { tag: 'en', name: 'English', dir: 'ltr', coverage: 1, hash: 'a' },
    { tag: 'pt-BR', name: 'Português (Brasil)', dir: 'ltr', coverage: 1, hash: 'b', fallback: ['pt'] }, // french-ok: a language name, the catalogue under test
  ];
  assert.deepEqual(localeChain('pt-BR', catalog), ['pt-BR', 'pt', 'en']);
  assert.deepEqual(localeChain('en', catalog), ['en']);
  assert.deepEqual(localeChain('fr', catalog), ['fr', 'en']);
});
