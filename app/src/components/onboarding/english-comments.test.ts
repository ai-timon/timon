/**
 * The onboarding's comments are in English (AGENTS.md, rule 6).
 *
 * `orchestrator/src/english-comments.test.ts` only reads the daemon and its
 * CLI: the app's comments quote screen labels between « » by house style, and
 * over a hundred older files still carry French, so the whole of `app/src`
 * cannot be held to it yet. This folder and the modules around it were made
 * clean and stay so. Three checks, the daemon's two plus the working words
 * of the onboarding's own briefs, which carry no accent and slipped through.
  *
  * french-ok: the guillemets named above and the French samples the checks must catch
  * french-ok-file: the French samples the checks must catch
 */
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, '..', '..');

/** French letters; the « » quotes of screen labels are left out on purpose. french-ok: the quotes it names */
const FRENCH_LETTER = /[àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ]/;

/** The daemon's list (`english-comments.test.ts`): three of them in one comment are a French sentence. */
const FRENCH_WORDS = [
  'le', 'la', 'les', 'de', 'des', 'du', 'au', 'aux', 'un', 'une', 'est', 'sont', 'pas', 'pour',
  'dans', 'avec', 'sans', 'mais', 'donc', 'sinon', 'cette', 'ces', 'leur',
  'qui', 'que', 'quand', 'comme', 'sur', 'ne', 'et', 'ou', 'peut', 'doit',
  'fait', 'tout', 'rien', 'jamais', 'toujours', 'chaque', 'depuis', 'puis',
];
const FRENCH_WORD = new RegExp(`(?<![\\w\`'-])(${FRENCH_WORDS.join('|')})(?![\\w\`'-])`, 'gi');

/** Words of the onboarding's French briefs, without accents, that read as English to the two checks above. */
const BRIEF_WORD = /(?<![\w`'-])(parcours|volet|volets|maquette|charpente|accueil|chantier)(?![\w`'-])/i;

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sources(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

function scope(): string[] {
  return [
    ...sources(HERE),
    join(SRC, 'lib', 'first-run-gate.ts'),
    join(SRC, 'components', 'first-run-gate.tsx'),
    join(SRC, 'lib', 'setup-plan.ts'),
  ];
}

function comments(file: string): Array<{ line: number; text: string }> {
  const text = readFileSync(file, 'utf8');
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const ranges = new Map<number, ts.CommentRange>();
  const collect = (found: ts.CommentRange[] | undefined): void => {
    for (const range of found ?? []) ranges.set(range.pos, range);
  };
  const visit = (node: ts.Node): void => {
    collect(ts.getLeadingCommentRanges(text, node.pos));
    collect(ts.getTrailingCommentRanges(text, node.end));
    node.getChildren(source).forEach(visit);
  };
  visit(source);
  return [...ranges.values()].map((range) => ({
    line: source.getLineAndCharacterOfPosition(range.pos).line + 1,
    text: text.slice(range.pos, range.end),
  }));
}

/** What sits between backticks quotes code or a value: left out. */
const prose = (comment: string): string => comment.replace(/`[^`\n]*`/g, ' ');

function frenchWords(text: string): string[] {
  return [...new Set([...text.matchAll(FRENCH_WORD)].map((match) => (match[1] ?? '').toLowerCase()))];
}

function offenders(rule: (text: string) => boolean): string[] {
  return scope().flatMap((file) => comments(file)
    .filter(({ text }) => rule(prose(text)))
    .map(({ line, text }) => `${relative(SRC, file).split(sep).join('/')}:${line}: ${text.replace(/\s+/g, ' ').slice(0, 80)}`));
}

test('no comment of the onboarding carries a French letter', () => {
  assert.deepEqual(offenders((text) => FRENCH_LETTER.test(text)), []);
});

test('no comment of the onboarding is a French sentence, nor uses the briefs\' French words', () => {
  assert.deepEqual(offenders((text) => frenchWords(text).length >= 3 || BRIEF_WORD.test(text)), []);
});

test('the checks catch French without accents and spare English', () => {
  assert.ok(frenchWords(prose('// le garde ne voit pas les mots sans accent')).length >= 3);
  assert.ok(BRIEF_WORD.test(prose('/** The parcours of the mockup. */')));
  assert.equal(BRIEF_WORD.test(prose('// The `volet` quote and « Continue » are fine.')), false);
  assert.ok(frenchWords(prose('// The guard reads the comments and spares a `les` quote.')).length < 3);
});
