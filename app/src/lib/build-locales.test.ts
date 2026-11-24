// french-ok-file: language names and pseudo-localised text, the data under test
/**
 * `scripts/build-locales.mjs`: a language is a folder, nothing else.
 */
import { strict as assert } from 'node:assert';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { IntlMessageFormat } from 'intl-messageformat';

import { buildLocales, coverageOf, discoverLocales, pseudoLocalize, writeLocales } from '../../scripts/build-locales.mjs';

function write(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** A sources tree with English and French, like the product's. */
function sources(): string {
  const root = mkdtempSync(join(tmpdir(), 'locales-'));
  write(join(root, 'en', 'meta.json'), { name: 'English', dir: 'ltr' });
  write(join(root, 'en', 'core.json'), { common: { close: 'Close', open: 'Open' } });
  write(join(root, 'en', 'files.json'), { files: { selected: '{count, plural, one {# file} other {# files}}' } });
  write(join(root, 'en', 'desktop.json'), { tray: { quit: 'Quit' } });
  write(join(root, 'fr', 'meta.json'), { name: 'Français', dir: 'ltr' });
  write(join(root, 'fr', 'core.json'), { common: { close: 'Fermer', open: 'Ouvrir' } });
  write(join(root, 'fr', 'files.json'), { files: { selected: '{count, plural, one {# fichier} other {# fichiers}}' } });
  return root;
}

test('a language added by a folder with a meta.json is discovered, nothing else to touch', () => {
  const root = sources();
  assert.deepEqual(buildLocales({ sourceDir: root }).manifest.map((entry) => entry.tag), ['en', 'fr']);

  write(join(root, 'pt-BR', 'meta.json'), { name: 'Português (Brasil)', dir: 'ltr', fallback: ['pt'], default: true });
  write(join(root, 'pt-BR', 'core.json'), { common: { close: 'Fechar' } });
  const { manifest, files } = buildLocales({ sourceDir: root });
  const pt = manifest.find((entry) => entry.tag === 'pt-BR');
  assert.ok(pt, 'pt-BR is in the manifest');
  assert.equal(pt.name, 'Português (Brasil)');
  assert.equal(pt.default, true);
  assert.deepEqual(pt.fallback, ['pt']);
  assert.equal(pt.coverage, 0.333, 'one message of three: a report, nothing hides the language');
  assert.deepEqual(JSON.parse(files.get('pt-BR.json') ?? '{}'), { common: { close: 'Fechar' } });
});

test('a folder without meta.json is not a language; a misnamed one stops the build', () => {
  const root = sources();
  mkdirSync(join(root, 'notes'));
  mkdirSync(join(root, '.generated'));
  assert.deepEqual(discoverLocales(root).map((locale) => locale.tag), ['en', 'fr']);
  write(join(root, 'pt-br', 'meta.json'), { name: 'Português (Brasil)' });
  assert.throws(() => discoverLocales(root), /canonical BCP 47 tag \(pt-BR\)/);
});

test('a broken meta.json stops the build with the file and the reason', () => {
  const root = sources();
  write(join(root, 'de', 'meta.json'), { dir: 'up' });
  assert.throws(() => discoverLocales(root), /de.meta\.json: "name" must be[\s\S]*"dir" must be/);
});

test('namespaces merge at the root, desktop.json stays out of the webview', () => {
  const { files } = buildLocales({ sourceDir: sources() });
  const en = JSON.parse(files.get('en.json') ?? '{}') as Record<string, unknown>;
  assert.deepEqual(Object.keys(en).sort(), ['common', 'files']);
});

test('coverage: the share of the English messages the language has', () => {
  const en = { a: 'A', b: 'B', n: { x: '{count, plural, one {x} other {xs}}' } };
  assert.equal(coverageOf(en, { a: 'A', n: { x: '{count, plural, other {xs}}' } }), 2 / 3);
  assert.equal(coverageOf(en, { a: 'A', stray: 'S' }), 1 / 3, 'a key English lacks counts for nothing');
});

test('the pseudo-locale accents and lengthens, placeholders intact', () => {
  assert.equal(pseudoLocalize('Hi {name}'), '[Ĥî {name}····]');
  const plural = pseudoLocalize("{count, plural, one {# file} other {# files}} in '{{vars.x}}'");
  assert.ok(plural.startsWith("[{count, plural, one {# ƒîļé} other {# ƒîļéš}} îñ '{{vars.x}}'·"), plural);
  assert.equal(new IntlMessageFormat(plural, 'en', undefined, { ignoreTag: true }).format({ count: 2 }), '[2 ƒîļéš îñ {{vars.x}}' + '·'.repeat(25) + ']');
  const { manifest } = buildLocales({ sourceDir: sources(), pseudo: true });
  assert.ok(manifest.some((entry) => entry.tag === 'en-XA'));
  assert.ok(!buildLocales({ sourceDir: sources() }).manifest.some((entry) => entry.tag === 'en-XA'), 'only on request');
});

test('writing: dictionaries, manifest and the generated English index; a removed language is cleaned up', () => {
  const root = sources();
  const out = mkdtempSync(join(tmpdir(), 'locales-out-'));
  const publicDir = join(out, 'public');
  const generatedDir = join(out, 'generated');
  write(join(root, 'de', 'meta.json'), { name: 'Deutsch' });
  writeLocales({ sourceDir: root, publicDir, generatedDir });
  assert.ok(existsSync(join(publicDir, 'de.json')));
  const manifest = JSON.parse(readFileSync(join(publicDir, 'manifest.json'), 'utf8')) as { tag: string; hash: string }[];
  assert.deepEqual(manifest.map((entry) => entry.tag), ['de', 'en', 'fr']);
  assert.match(manifest[0]?.hash ?? '', /^[0-9a-f]{12}$/);
  const index = readFileSync(join(generatedDir, 'en.ts'), 'utf8');
  assert.match(index, /import ns0 from '\.\.\/en\/core\.json';/);
  assert.match(index, /import ns1 from '\.\.\/en\/files\.json';/);
  assert.doesNotMatch(index, /desktop|meta/);

  const again = writeLocales({ sourceDir: root, publicDir, generatedDir });
  assert.equal(again.written, 0, 'nothing rewritten when nothing changed');

  rmSync(join(root, 'de'), { recursive: true });
  writeLocales({ sourceDir: root, publicDir, generatedDir });
  assert.equal(existsSync(join(publicDir, 'de.json')), false);
});

test('typecheck and test generate the locales first: a fresh worktree has no .generated folder', () => {
  // `src/locales/.generated/` is ignored by git, and `src/lib/i18n.ts` imports it: without
  // these pre-steps a fresh checkout fails its typecheck, and the failure gets waved off as pre-existing.
  const manifest = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  for (const script of ['pretypecheck', 'pretest', 'prebuild']) {
    assert.match(manifest.scripts[script] ?? '', /^node scripts\/build-locales\.mjs\b/, script);
  }
});
