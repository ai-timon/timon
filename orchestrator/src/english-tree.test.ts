/**
 * The language rule of AGENTS.md (rule 6) over the whole public tree: code,
 * comments, scripts and configuration are written in English. Interface text
 * goes through the locale files, which are the only place a translation lives.
 *
 * `english-messages.test.ts` and `english-comments.test.ts` look closer at the
 * daemon (French words without accents in its messages); this one is wider and
 * protects every file a contributor can touch:
 *
 * - scope: the tracked files with one of `SCANNED_EXTENSIONS`, the Dockerfiles,
 *   `.gitignore`, `.env.example`, the `*.template` files and the Markdown;
 * - left out: translations (`locales/`, `public-docs/i18n/`), JSON, and the
 *   maintainers' notes (`docs/`), which are not published;
 * - tests and fixtures are in scope like the rest: their titles and comments
 *   are English, and the French their data needs (a French locale under test,
 *   an accented name, a dictation sample) carries a marker with its reason;
 * - refused: a French letter (or `«`/`»`) anywhere, and a comment that is a
 *   French sentence without accents (three distinct French function words);
 * - in Markdown, where accented names and `«`/`»` quotes are English prose
 *   too: a line with a French letter and a French function word, or a
 *   paragraph with three distinct French function words;
 * - spared: the French column of a translation table in a script
 *   (`createTranslator({ en: {…}, fr: {…} })`, `{ en: 'Scarf', fr: 'Écharpe' }`),
 *   the way an example plugin ships its own strings.
 *
 * French kept on purpose (an example of a language, the patterns that detect
 * one, a proper name) carries its reason on the line or one of the two above:
 * `french-ok: <reason>`, in the comment syntax of the file. A script or
 * component whose code holds a whole table of French on purpose can say so
 * once, in a comment: `french-ok-file: <reason>`. That covers its code only,
 * never its comments, which stay in English. In Markdown, the markers go in an
 * HTML comment (`<!-- french-ok: <reason> -->`), and the file marker covers the
 * whole page: a translation guide quotes every language it covers.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.css', '.sh', '.yml', '.yaml', '.template', '.md']);
const SCANNED_NAMES = new Set(['Dockerfile', '.gitignore', '.env.example', '.dockerignore']);
const SCRIPT_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs']);

const FRENCH_LETTER = /[àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ«»]/;

/** The same unambiguous function words as `english-comments.test.ts`. */
const FRENCH_WORDS = [
  'le', 'la', 'les', 'de', 'des', 'du', 'au', 'aux', 'un', 'une', 'est', 'sont', 'pas', 'pour',
  'dans', 'avec', 'sans', 'mais', 'donc', 'sinon', 'cette', 'ces', 'leur',
  'qui', 'que', 'quand', 'comme', 'sur', 'ne', 'et', 'ou', 'peut', 'doit',
  'fait', 'tout', 'rien', 'jamais', 'toujours', 'chaque', 'depuis', 'puis',
];
const FRENCH_WORD = new RegExp(`(?<![\\w\`'-])(${FRENCH_WORDS.join('|')})(?![\\w\`'-])`, 'gi');
const SENTENCE_THRESHOLD = 3;

/**
 * Markdown prose names people and places (`Café`, `Zoë`) and quotes with
 * `«`/`»`: a letter alone proves nothing there. Its words are bounded by any
 * letter, so that `modèle` does not hold a `le`.
 */
const MARKDOWN_LETTER = /[àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ]/;
const MARKDOWN_WORD = new RegExp(`(?<![\\p{L}\\p{N}_\`'-])(${FRENCH_WORDS.join('|')})(?![\\p{L}\\p{N}_\`'-])`, 'giu');

/** A marker counts only with a reason after it, not with the end of its comment. */
const LINE_MARKER = /french-ok:\s*(?!-->|\*\/)\S/;
const FILE_MARKER = /french-ok-file:\s*(?!-->|\*\/)\S/;

function inScope(file: string): boolean {
  if (/^(docs|\.claude|\.agents|public-docs\/i18n)\//.test(file)) return false;
  if (/(^|\/)(node_modules|locales)\//.test(file)) return false;
  const name = basename(file);
  return SCANNED_NAMES.has(name) || name.endsWith('.Dockerfile') || SCANNED_EXTENSIONS.has(extname(name));
}

/** The tracked files, as git sees them: what a contributor's pull request can change. */
function trackedFiles(): string[] | null {
  try {
    return execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0').filter(Boolean);
  } catch {
    return null;
  }
}

/** "façade" is an English word too, and the plugin contract is named after it. */
function withoutLoanwords(text: string): string {
  return text.replace(/[Ff]a[çÇ]ade|FA[çÇ]ADE/g, 'facade');
}

/** The prose of a comment: code quotes removed. */
function prose(text: string): string {
  return withoutLoanwords(text).replace(/`[^`\n]*`/g, ' ');
}

function frenchWords(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(FRENCH_WORD)) found.add(match[1].toLowerCase());
  return [...found];
}

function isFrenchSentence(text: string): boolean {
  return frenchWords(prose(text)).length >= SENTENCE_THRESHOLD;
}

type Span = { pos: number; end: number };
type Comment = Span & { text: string };

/** A French column of a translation table: `fr: { … }` or `{ en: 'Scarf', fr: 'Écharpe' }`. */
function isFrenchColumn(node: ts.Node): node is ts.PropertyAssignment {
  if (!ts.isPropertyAssignment(node)) return false;
  const name = ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : '';
  return /^fr(-[A-Z]{2})?$/.test(name);
}

/**
 * The comments of a script, and the spans of its translation tables: a plugin
 * ships its own strings (`createTranslator({ en: {…}, fr: {…} })`), and its
 * French column is a translation like the files of `locales/`.
 */
function scriptParts(file: string, text: string): { comments: Comment[]; translations: Span[] } {
  const ext = extname(file);
  const kind = ext === '.tsx' ? ts.ScriptKind.TSX : ext === '.ts' ? ts.ScriptKind.TS : ts.ScriptKind.JSX;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const ranges = new Map<number, ts.CommentRange>();
  const translations: Span[] = [];
  const collect = (found: ts.CommentRange[] | undefined): void => {
    for (const range of found ?? []) ranges.set(range.pos, range);
  };
  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(text, node.pos));
    collect(ts.getTrailingCommentRanges(text, node.end));
    if (isFrenchColumn(node)) translations.push({ pos: node.initializer.getStart(source), end: node.initializer.end });
    node.getChildren(source).forEach(visit);
  };
  visit(source);
  const comments = [...ranges.values()].map((range) => ({ pos: range.pos, end: range.end, text: text.slice(range.pos, range.end) }));
  return { comments, translations };
}

/** The comments of a stylesheet or of a `#` language. */
function otherComments(file: string, text: string): Comment[] {
  const pattern = extname(file) === '.css' ? /\/\*[\s\S]*?\*\//g : /(?<=^|\s)#.*$/gm;
  return [...text.matchAll(pattern)].map((match) => ({ pos: match.index, end: match.index + match[0].length, text: match[0] }));
}

/** `text` with the given spans blanked out, line breaks kept: what is left is code. */
function blank(text: string, spans: Span[]): string {
  const chars = [...text.split('')];
  for (const { pos, end } of spans) for (let i = pos; i < end; i++) if (chars[i] !== '\n') chars[i] = ' ';
  return chars.join('');
}

function lineOf(text: string, pos: number): number {
  let line = 0;
  for (let i = 0; i < pos; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

function marked(lines: string[], from: number, to: number): boolean {
  for (let i = Math.max(0, from - 2); i <= to; i++) if (LINE_MARKER.test(lines[i] ?? '')) return true;
  return false;
}

/** The prose of a Markdown line: code quotes and link targets removed. */
function markdownProse(line: string): string {
  return prose(line).replace(/\]\([^)\s]*\)/g, '] ');
}

function markdownWords(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(MARKDOWN_WORD)) found.add(match[1].toLowerCase());
  return [...found];
}

/** A Markdown page, paragraph by paragraph (a heading, a list, a table, a code block). */
function frenchInMarkdown(file: string, text: string): string[] {
  if (FILE_MARKER.test(text)) return [];
  const lines = text.split('\n');
  const offenders: string[] = [];
  const read = (from: number, to: number): void => {
    if (to < from || marked(lines, from, to)) return;
    const paragraph = lines.slice(from, to + 1).map(markdownProse);
    const line = paragraph.findIndex((l) => MARKDOWN_LETTER.test(l) && markdownWords(l).length > 0);
    const at = line >= 0 ? from + line : markdownWords(paragraph.join('\n')).length >= SENTENCE_THRESHOLD ? from : -1;
    if (at >= 0) offenders.push(`${file}:${at + 1}: French paragraph: ${lines[at].trim().slice(0, 80)}`);
  };
  let from = 0;
  lines.forEach((line, i) => {
    if (line.trim() !== '') return;
    read(from, i - 1);
    from = i + 1;
  });
  read(from, lines.length - 1);
  return offenders;
}

/** What is French in a file, as `file:line: why: text` (1-based). */
function frenchIn(file: string, text: string): string[] {
  if (extname(file) === '.md') return frenchInMarkdown(file, text);
  const lines = text.split('\n');
  const script = SCRIPT_EXTENSIONS.has(extname(file));
  const { comments, translations } = script ? scriptParts(file, text) : { comments: otherComments(file, text), translations: [] };
  const offenders: string[] = [];
  const report = (line: number, why: string): void => {
    offenders.push(`${file}:${line + 1}: ${why}: ${lines[line].trim().slice(0, 80)}`);
  };
  for (const comment of comments) {
    const from = lineOf(text, comment.pos);
    const to = from + comment.text.split('\n').length - 1;
    if (marked(lines, from, to)) continue;
    const letter = comment.text.split('\n').findIndex((line) => FRENCH_LETTER.test(prose(line)));
    if (letter >= 0) report(from + letter, 'French letter in a comment');
    else if (isFrenchSentence(comment.text)) report(from, 'French sentence in a comment');
  }
  if (script && comments.some((c) => FILE_MARKER.test(c.text))) return offenders;
  blank(text, [...comments, ...translations]).split('\n').forEach((code, i) => {
    if (FRENCH_LETTER.test(withoutLoanwords(code)) && !marked(lines, i, i)) report(i, 'French letter');
  });
  return offenders;
}

test('no public file outside the translations is written in French', (t) => {
  const files = trackedFiles();
  if (!files) {
    t.skip('not a git checkout: nothing to list');
    return;
  }
  const offenders: string[] = [];
  for (const file of files.filter(inScope)) {
    let text: string;
    try {
      text = readFileSync(join(ROOT, ...file.split('/')), 'utf8');
    } catch {
      continue;
    }
    // Parsing is the slow part: a file with no French letter and too few French
    // words in it cannot hold a French comment.
    if (!FRENCH_LETTER.test(withoutLoanwords(text)) && frenchWords(text).length < SENTENCE_THRESHOLD) continue;
    offenders.push(...frenchIn(file, text));
  }
  assert.deepEqual(offenders, [], 'translate these lines, or justify each with `french-ok: <reason>`');
});

test('the comments of the web client and of the plugin templates are in scope', () => {
  // AGENTS.md wants every code comment in English: this guard is the one that
  // reads them outside the daemon, so its scope must not lose these two trees.
  for (const file of [
    'app/src/components/chat/composer.tsx',
    'app/src/plugins-client/kanban/kanban-page.tsx',
    'app/src/lib/i18n.ts',
    'app/src/vendor/vault-graph/page.js',
    'examples/plugin-hello/lib/client.js',
    'examples/plugin-provider/lib/index.mjs',
  ]) assert.ok(inScope(file), `${file} must be read by the language guard`);
  // Tests and their helpers are read too: the French their data needs is marked.
  for (const file of [
    'app/src/components/chat/composer.test.tsx',
    'orchestrator/src/english-tree.test.ts',
    'examples/plugin-provider-cursor/test/conformance.test.mjs',
    'examples/plugin-hello/test/helpers.mjs',
    'orchestrator/tests/fixtures/sample.ts',
  ]) assert.ok(inScope(file), `${file} must be read by the language guard`);
  // Translations stay out: they are French on purpose.
  for (const file of [
    'app/src/locales/fr/core.json',
    'app/src/locales/fr/notes.ts',
  ]) assert.ok(!inScope(file), `${file} must stay out of the language guard`);
});

test('the language guard sees French and spares what is justified', () => {
  assert.equal(frenchIn('a.ts', '// le garde ne voit pas les mots sans accent\nconst a = 1;\n').length, 1);
  assert.equal(frenchIn('a.ts', '/** Libellé du bouton. */\nconst a = 1;\n').length, 1);
  assert.equal(frenchIn('a.ts', "const label = 'Fermer la fenêtre';\n").length, 1);
  assert.equal(frenchIn('a.tsx', 'export const A = () => <p>Réessayer</p>;\n').length, 1);
  assert.equal(frenchIn('a.css', '/* Couleur de la barre pour les îlots */\n.a { color: red; }\n').length, 1);
  assert.equal(frenchIn('a.yml', '# Démarre le service\nservices: {}\n').length, 1);
  assert.equal(frenchIn('a.sh', '# lance le build et la suite des tests\necho ok\n').length, 1);

  assert.deepEqual(frenchIn('a.ts', "// The guard spares a `les` quote and a façade.\nconst a = 1;\n"), []);
  assert.deepEqual(frenchIn('a.ts', "// french-ok: a sample of the language the detector recognises\nconst sample = 'Réponds en français';\n"), []);
  assert.deepEqual(frenchIn('a.ts', "const sample = 'déjà'; // french-ok: an accented word the slug folds\n"), []);
  assert.deepEqual(frenchIn('a.yml', '# french-ok: the locale shown to a French tester\ntitle: Paramètres\n'), []);
  assert.deepEqual(frenchIn('a.ts', "// french-ok-file: the French month names the parser reads\nconst m = ['février', 'août'];\n"), []);

  // The French column of a plugin's own translator is a translation, its comments are not.
  assert.deepEqual(frenchIn('a.js', "const t = createTranslator({ en: { ok: 'Done' }, fr: { ok: 'Terminé' } })\n"), []);
  assert.deepEqual(frenchIn('a.js', "const label = { en: 'Scarf', fr: 'Écharpe' }\n"), []);
  assert.equal(frenchIn('a.js', "const t = { fr: {\n  // Libellé du bouton\n  ok: 'Terminé',\n} }\n").length, 1);
  assert.equal(frenchIn('a.js', "const t = { de: { ok: 'Fertig' }, to: 'Envoyé' }\n").length, 1);
  // Code that ends with a comment is still read.
  assert.equal(frenchIn('a.ts', "const label = 'Fermer la fenêtre'; // close button\n").length, 1);

  // A marker needs its reason, and the file marker never covers a comment.
  assert.equal(frenchIn('a.ts', "// french-ok:\nconst sample = 'été';\n").length, 1);
  assert.equal(frenchIn('a.ts', "// french-ok-file: the month names\n// Les mois de l'année.\nconst m = ['août'];\n").length, 1);
});

test('the language guard reads Markdown paragraph by paragraph', () => {
  assert.equal(frenchIn('a.md', '# Title\n\nCe paquet est un exemple\nqui sert de gabarit.\n').length, 1);
  assert.equal(frenchIn('a.md', '## Détails de la route\n').length, 1);
  assert.equal(frenchIn('a.md', 'See the section « Remplacer le sélecteur ».\n').length, 1);
  assert.equal(frenchIn('a.md', '```js\n// lance le build et la suite\n```\n').length, 1);

  // English prose with a quote, a name, a code span, a translated word or a link anchor.
  assert.deepEqual(frenchIn('a.md', 'The button reads « Add my agents ».\n'), []);
  assert.deepEqual(frenchIn('a.md', '| model | modèle | |\n| island | îlot | |\n'), []);
  assert.deepEqual(frenchIn('a.md', 'Set `la` and `de` in `est`: one value per line.\n'), []);
  assert.deepEqual(frenchIn('a.md', 'Read [the guide](guide.md#écrire-un-thème-de-la-page).\n'), []);
  assert.deepEqual(frenchIn('a.md', 'Votre café\n\nde la\n\nque\n'), []);

  // Markers, in an HTML comment.
  assert.deepEqual(frenchIn('a.md', '<!-- french-ok: a dictation sample -->\n« salut, comment ça va et toi ? »\n'), []);
  assert.deepEqual(frenchIn('a.md', '<!-- french-ok-file: a translation guide -->\n\nLa tâche est une étape.\n'), []);
  assert.equal(frenchIn('a.md', '<!-- french-ok: -->\nLa tâche est une étape.\n').length, 1);
});
