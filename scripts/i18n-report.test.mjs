/**
 * The translation report (scripts/i18n-report.mjs): coverage, missing
 * messages by English file, the desktop shell apart, unused English keys.
 *
 * Collected by orchestrator's `../scripts/*.test.mjs`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildReport, formatReport, parseArgs } from './i18n-report.mjs';

const REPORT = join(dirname(fileURLToPath(import.meta.url)), 'i18n-report.mjs');

function write(root, path, value) {
  const file = join(root, ...path.split('/'));
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'i18n-report-'));
  const locales = join(root, 'locales');
  write(locales, 'en/meta.json', { name: 'English' });
  write(locales, 'en/core.json', { nav: { home: 'Home', help: 'Help' }, old: 'Old' });
  write(locales, 'en/files.json', { files: { count: '{count, plural, one {# file} other {# files}}' } });
  write(locales, 'en/desktop.json', { tray: { quit: 'Quit', open: 'Open' } });
  write(locales, 'de/meta.json', { name: 'Deutsch' });
  write(locales, 'de/core.json', { nav: { home: 'Start' }, old: 'Alt', stray: 'x' });
  write(locales, 'de/desktop.json', { tray: { quit: 'Beenden' } });
  write(locales, 'pt-BR/meta.json', { name: 'Português (Brasil)' }); // french-ok: the native name of a language
  const code = join(root, 'src');
  write(code, 'page.tsx', [
    "import { t } from '@/lib/i18n';",
    "t('nav.home'); t('files.count', { count: 2 });",
    "const LINKS = { help: 'nav.help' };",
  ].join('\n'));
  return { locales, code };
}

test('coverage per language against English, English first, the desktop shell apart', () => {
  const { locales } = fixture();
  const { languages, unused } = buildReport({ sourceDir: locales });
  assert.deepEqual(languages.map((l) => [l.tag, l.name, l.have, l.total]), [
    ['en', 'English', 4, 4],
    ['de', 'Deutsch', 2, 4],
    ['pt-BR', 'Português (Brasil)', 0, 4], // french-ok: the native name of a language
  ]);
  assert.equal(languages[1].coverage, 0.5);
  assert.deepEqual(languages.map((l) => l.desktop), [{ have: 2, total: 2 }, { have: 1, total: 2 }, { have: 0, total: 2 }]);
  assert.equal(unused, undefined);
});

test('missing messages are grouped by the English file holding them; an orphan is not counted', () => {
  const { locales } = fixture();
  const german = buildReport({ sourceDir: locales }).languages.find((l) => l.tag === 'de');
  assert.deepEqual(german.missing, { 'core.json': ['nav.help'], 'files.json': ['files.count'], 'desktop.json': ['tray.open'] });
});

test('unused: an English message neither called nor quoted in the code', () => {
  const { locales, code } = fixture();
  assert.deepEqual(buildReport({ sourceDir: locales, codeDir: code }).unused, ['old']);
});

test('the text report: one line per language, then the requested gaps and the unused keys', () => {
  const { locales, code } = fixture();
  const text = formatReport(buildReport({ sourceDir: locales, codeDir: code }), { missingFor: ['DE', 'xx'] });
  const lines = text.split('\n');
  assert.match(lines[0], /^en English\s+100 %\s+4\/4\s+desktop\s+100 %$/);
  assert.match(lines[1], /^de Deutsch\s+50 %\s+2\/4\s+desktop\s+50 %$/);
  assert.match(lines[2], /^pt-BR Português \(Brasil\)\s+0 %\s+0\/4/); // french-ok: the native name of a language
  assert.ok(text.includes('de: missing, by English file\n  core.json (1)\n    nav.help'));
  assert.ok(text.includes('xx: no such language'));
  assert.ok(text.includes('English messages no code seems to read: 1'));
});

test('options: --missing needs a tag, an unknown option is refused', () => {
  assert.deepEqual(parseArgs(['--missing', 'de', '--unused', '--json']), { missingFor: ['de'], unused: true, json: true });
  assert.throws(() => parseArgs(['--missing']), /needs a language tag/);
  assert.throws(() => parseArgs(['--missing', '--json']), /needs a language tag/);
  assert.throws(() => parseArgs(['--all']), /unknown option/);
});

test('runs on the real sources: English is whole', () => {
  const run = spawnSync(process.execPath, [REPORT, '--json'], { encoding: 'utf8', cwd: resolve(dirname(REPORT), '..') });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(run.stdout);
  assert.equal(report.languages[0].tag, 'en');
  assert.equal(report.languages[0].coverage, 1);
  assert.equal(report.languages[0].missing, undefined);
});
