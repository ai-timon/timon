/**
 * The code and English agree (docs/I18N.md, "Contributor tooling").
 *
 * With `locale-parity.test.ts`, it replaces the screen-by-screen `*-i18n`
 * tests: they listed the keys of one screen and checked that each existed and
 * took its argument. Read from the code itself, every screen is covered:
 *
 *  - every key the code names exists in English — `t()` returns the key itself
 *    when nobody has it, and shows it on screen;
 *  - every call passes exactly the arguments its English message names: one
 *    missing shows `{name}` on screen, one too many means the message lost it;
 *  - English holds no French copy.
 *
 * Only English is required; another language may lack a key, it reads in
 * English (parity and coverage: `scripts/check-locales.mjs`).
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { DEFAULT_PATHS, leafKeys, lookup, readLocaleDictionary } from '../../scripts/build-locales.mjs';
import { parseMessage } from '../../scripts/check-locales.mjs';
import { codeFiles, objectKeys, probablyUnused, scanUsage } from '../../scripts/i18n-usage.mjs';

const english = readLocaleDictionary(join(DEFAULT_PATHS.sourceDir, 'en'));
const usage = scanUsage();

function isGroup(value: unknown): boolean {
  return typeof value === 'object' && value !== null;
}

test('the scan finds the code: thousands of literal calls, nearly all with readable arguments', () => {
  assert.ok(usage.calls.length > 3000, `only ${usage.calls.length} calls found — did the i18n import move?`);
  assert.ok(usage.calls.filter((call) => call.vars !== null).length / usage.calls.length > 0.95);
});

test('every key the code calls exists in English', () => {
  const missing = usage.calls.filter((call) => typeof lookup(english, call.key) !== 'string');
  assert.deepEqual(missing.map((call) => `${call.file}:${call.line} ${call.key}`), []);
});

test('a key quoted in a table, under a group English has, exists in English', () => {
  // `{ open: 'chatPage.fileMenu.open' }`: no `t(` before it, the group tells
  // it is a key. A quoted group (`'dictation.model.errors'`) is a prefix.
  const missing = [...usage.quoted].filter((quoted) => {
    const parts = quoted.split('.');
    return parts.length >= 3 && isGroup(lookup(english, parts.slice(0, -1).join('.'))) && lookup(english, quoted) === undefined;
  });
  assert.deepEqual(missing, []);
});

test('every call passes exactly the arguments of its English message', () => {
  const wrong: string[] = [];
  for (const call of usage.calls) {
    const message = lookup(english, call.key);
    if (typeof message !== 'string' || call.vars === null) continue;
    const expected = [...parseMessage(message, 'en').args].sort();
    const passed = [...new Set(call.vars)].sort();
    if (expected.join() !== passed.join()) wrong.push(`${call.file}:${call.line} ${call.key}: passes [${passed}], English names [${expected}]`);
  }
  assert.deepEqual(wrong, []);
});

/** Search keywords: a French reader types "français" to find the language setting. french-ok: the word a French reader types */
const FRENCH_ON_PURPOSE = new Set(['settingsSearch.tabKeywords.interface.language']);

test('English holds no French copy', () => {
  const french = leafKeys(english).filter((key) => {
    const message = lookup(english, key);
    return typeof message === 'string' && /[àâçéèêëîïôûùüÿœæ]/i.test(message) && !FRENCH_ON_PURPOSE.has(key); // french-ok: the French letters the check looks for
  });
  assert.deepEqual(french, []);
});

test('the scanner reads arguments, prefixes and quoted keys', () => {
  const dir = mkdtempSync(join(tmpdir(), 'i18n-usage-'));
  mkdirSync(join(dir, 'sub'));
  writeFileSync(join(dir, 'sub', 'page.tsx'), [
    "import { t } from '@/lib/i18n';",
    "const KEYS = { ok: 'a.b.ok' };",
    "t('a.plain'); t('a.vars', { name, count: n.length, 'odd-key': 1 });",
    't(`a.kind.${kind}`); t(\'a.cat.\' + x); t(\'a.spread\', { ...rest }); t(\'a.held\', vars);',
    "const [before] = t('a.split').split('{cmd}');",
  ].join('\n'));
  writeFileSync(join(dir, 'sub', 'own.tsx'), "const t = createTranslator({}); t('mine.key');");
  writeFileSync(join(dir, 'sub', 'page.test.tsx'), "import { t } from '@/lib/i18n'; t('test.only');");
  const files = codeFiles(dir);
  assert.deepEqual(files.map((file) => file.slice(dir.length + 1).replace(/\\/g, '/')), ['sub/own.tsx', 'sub/page.tsx']);
  const found = scanUsage(files, { root: dir });
  assert.deepEqual(found.calls.map((call) => [call.key, call.vars, call.line]), [
    ['a.plain', [], 3],
    ['a.vars', ['name', 'count', 'odd-key'], 3],
    ['a.spread', null, 4],
    ['a.held', null, 4],
    ['a.split', null, 5],
  ]);
  assert.deepEqual([...found.prefixes].sort(), ['a.cat.', 'a.kind.']);
  assert.ok(found.quoted.has('a.b.ok'));
  assert.deepEqual(
    probablyUnused(['a.plain', 'a.b.ok', 'a.kind.x', 'a.cat.y', 'a.never'], found),
    ['a.never'],
  );
});

test('objectKeys reads flat and nested literals, and gives up on what it cannot name', () => {
  const read = (text: string) => objectKeys(text, text.indexOf('{'));
  assert.deepEqual(read("{ a, b: f({ c: 1 }), 'd': `x${y}`, /* note */ e: [1, 2] }"), ['a', 'b', 'd', 'e']);
  assert.deepEqual(read('{}'), []);
  assert.equal(read('{ [k]: 1 }'), null);
  assert.equal(read('{ ...rest }'), null);
  assert.equal(read('{ a: 1'), null);
});
