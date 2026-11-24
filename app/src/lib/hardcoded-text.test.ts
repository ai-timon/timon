// french-ok-file: the French samples the hard-coded text detector must find
/**
 * No visible text written straight into a component of `app/src` or the
 * desktop shell (`desktop/src`): it goes through a message file, or no
 * language but the one it was written in will ever show it (docs/I18N.md).
 *
 * A ratchet over the debt of 04/11/2026 (`scripts/hardcoded-text-baseline.json`):
 * a file may hold less, never more; a file absent from it holds none. The
 * rules, the marker `i18n-exempt: <reason>` and `--update` are described in
 * `scripts/check-hardcoded-text.mjs`.
 */
import { strict as assert } from 'node:assert';
import { existsSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';

import { DEFAULT_ROOTS, compareToBaseline, findHardcodedText, readBaseline, scanHardcodedText } from '../../scripts/check-hardcoded-text.mjs';

test('no file holds more hard-coded text than the baseline allows', () => {
  const { over } = compareToBaseline(scanHardcodedText(), readBaseline());
  const report = over.map((entry) => [
    `${entry.file}: ${entry.count} ${entry.kind}, baseline ${entry.allowed} — move the text to app/src/locales/en/, or mark a literal nobody translates with i18n-exempt: <reason>`,
    ...entry.findings.map((finding) => `  line ${finding.line}: ${finding.text}`),
  ].join('\n'));
  assert.deepEqual(report, []);
});

test('the scan sees the desktop shell and the app', () => {
  // Neither holds hard-coded text any more (the app's words are in its locales, the
  // shell's in desktop.json): their roots are checked instead.
  const app = DEFAULT_ROOTS.find((root) => root.dir.split(sep).slice(-2).join('/') === 'app/src');
  assert.ok(app && existsSync(join(app.dir, 'lib', 'i18n.ts')), 'the app is no longer read — did it move?');
  assert.deepEqual([...app.kinds].sort(), ['french', 'jsxAttr', 'jsxText']);
  const shell = DEFAULT_ROOTS.find((root) => root.dir.split(sep).slice(-2).join('/') === 'desktop/src');
  assert.ok(shell && existsSync(join(shell.dir, 'main.ts')), 'the desktop shell is no longer read — did it move?');
  assert.ok(shell.kinds.includes('french'));
});

const kinds = (text: string, name = 'page.tsx') => findHardcodedText(text, name).map((finding) => `${finding.kind}:${finding.line}`);

test('text between tags and in a visible attribute counts; code, generics and keys do not', () => {
  assert.deepEqual(kinds([
    'const [a] = useState<string>(null);',
    'export const P = () => (',
    '  <div title="Close the panel" className="flex gap-2" data-id="x">',
    '    Save changes',
    '    {t(\'page.save\')}',
    '    <code>npm test</code><kbd>Ctrl</kbd>',
    '    <input placeholder={t(\'page.search\')} aria-label={"Search"} />',
    '    → · 3 {count}',
    '    Timon',
    '  </div>',
    ');',
  ].join('\n')), ['jsxAttr:3', 'jsxText:4', 'jsxAttr:7']);
});

test('a French literal counts anywhere, comments aside', () => {
  assert.deepEqual(kinds([
    '// Une règle écrite en commentaire ne compte pas.',
    "const copy = { fr: 'Fermer la fenêtre', en: 'Close the window' };",
    'const html = `<p>${name} — prêt</p>`;',
  ].join('\n'), 'shell.ts'), ['french:2', 'french:3']);
});

test('i18n-exempt with a reason excuses its line and the next one, not without a reason', () => {
  assert.deepEqual(kinds([
    'export const P = () => (<div>',
    '  {/* i18n-exempt: sample value of a format */}',
    '  <input placeholder="TMN-XXXX-XXXX" />',
    '  <input placeholder="Search" /> {/* i18n-exempt: */}',
    '</div>);',
  ].join('\n')), ['jsxAttr:4']);
});

test('a count under the baseline passes and is offered for --update; a new file must hold none', () => {
  const byFile = {
    'app/src/a.tsx': [{ kind: 'jsxText' as const, line: 1, text: 'x' }],
    'app/src/new.tsx': [{ kind: 'french' as const, line: 2, text: 'é' }],
  };
  const { over, under } = compareToBaseline(byFile, { 'app/src/a.tsx': { jsxText: 3 }, 'app/src/gone.tsx': { french: 1 } });
  assert.deepEqual(over.map((entry) => [entry.file, entry.kind, entry.count, entry.allowed]), [['app/src/new.tsx', 'french', 1, 0]]);
  assert.deepEqual(under.map((entry) => [entry.file, entry.kind, entry.count, entry.allowed]), [
    ['app/src/a.tsx', 'jsxText', 1, 3],
    ['app/src/gone.tsx', 'french', 0, 1],
  ]);
});
