/**
 * Ratchet for the comments of the daemon and its CLI (TODO #680): they are
 * written in English, like the messages `english-messages.test.ts` guards.
 *
 * That file reads lines, so it can only spot French through its accented
 * letters, and a French sentence without a single accent ("le garde ne voit
 * pas les mots sans accent") slipped through. This one reads the comments
 * themselves, through the TypeScript parser, and refuses two things in them:
 *
 * 1. a French letter — even in a file that carries French on purpose in its
 *    code (`FRENCH_ON_PURPOSE`): that exemption covers literals and patterns,
 *    never the prose around them;
 * 2. a sentence built on French function words: three distinct ones in a
 *    single comment (`les`, `pour`, `dans`…). One alone can be a name or a
 *    quote; three are a sentence.
 *
 * What sits between backticks is a quote of code or of a value the code
 * matches (`à tester Win/Mac`, the portability line of rule 9): it is left out
 * of both checks.
 *
 * The comments of the web client (`app/src`) and of the plugin templates
 * (`examples/`) follow the same two rules, with the same threshold and the
 * same backtick quotes left out: `english-tree.test.ts` reads them, and a
 * French comment kept on purpose there carries `french-ok: <reason>`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// french-ok-file: the French samples and patterns this guard tests
const SRC = dirname(fileURLToPath(import.meta.url));
const BIN = join(SRC, '..', 'bin');

const FRENCH_LETTER = /[àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ«»]/;

/**
 * Words that only French uses, so that a comment carrying three of them is a
 * French sentence. Kept to the unambiguous ones: `on`, `a`, `son`, `ce` or
 * `pour` in an identifier would be noise, `pour` stays because no English
 * sentence uses it as a word.
 */
const FRENCH_WORDS = [
  'le', 'la', 'les', 'de', 'des', 'du', 'au', 'aux', 'un', 'une', 'est', 'sont', 'pas', 'pour',
  'dans', 'avec', 'sans', 'mais', 'donc', 'sinon', 'cette', 'ces', 'leur',
  'qui', 'que', 'quand', 'comme', 'sur', 'ne', 'et', 'ou', 'peut', 'doit',
  'fait', 'tout', 'rien', 'jamais', 'toujours', 'chaque', 'depuis', 'puis',
];
const FRENCH_WORD = new RegExp(`(?<![\\w\`'-])(${FRENCH_WORDS.join('|')})(?![\\w\`'-])`, 'gi');
const SENTENCE_THRESHOLD = 3;

/** Comments that quote French on purpose, each with its reason. */
const COMMENT_EXCEPTIONS: ReadonlyArray<{ file: string; fragment: string; why: string }> = [
  {
    file: '../bin/console-ascii.mjs',
    fragment: '"é" as "├⌐"',
    why: 'shows the mojibake an accented letter turns into on a legacy Windows console',
  },
  {
    file: 'host/service-install.ts',
    fragment: '"Accès refusé"',
    why: 'quotes the error a French Windows prints, to explain the code page fix',
  },
];

function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'fixtures') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(path));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/** Same scope as `english-messages.test.ts`: `src/` and the CLI in `bin/`. */
function scope(): string[] {
  const bin = readdirSync(BIN, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.mjs') || !entry.name.includes('.')))
    .map((entry) => join(BIN, entry.name));
  return [...sources(SRC), ...bin].map((file) => relative(SRC, file));
}

function shown(file: string): string {
  return file.split(sep).join('/');
}

/** Every comment of a file, with its first line. */
function comments(file: string): Array<{ line: number; text: string }> {
  const text = readFileSync(join(SRC, file), 'utf8');
  const kind = file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
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

/** The prose of a comment: code quotes and the `facade` loanword removed. */
function prose(comment: string): string {
  return comment.replace(/`[^`\n]*`/g, ' ').replace(/[Ff]a[çÇ]ade|FAÇADE/g, 'facade');
}

function frenchWords(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(FRENCH_WORD)) found.add(match[1].toLowerCase());
  return [...found];
}

function excepted(file: string, comment: string): boolean {
  return COMMENT_EXCEPTIONS.some((e) => shown(file) === e.file && comment.includes(e.fragment));
}

test('no comment of the daemon or its CLI carries a French letter', () => {
  const offenders: string[] = [];
  for (const file of scope()) {
    for (const { line, text } of comments(file)) {
      if (FRENCH_LETTER.test(prose(text)) && !excepted(file, text)) {
        offenders.push(`${shown(file)}:${line}: ${text.replace(/\s+/g, ' ').slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('no comment of the daemon or its CLI is a French sentence without accents', () => {
  const offenders: string[] = [];
  for (const file of scope()) {
    for (const { line, text } of comments(file)) {
      const words = frenchWords(prose(text));
      if (words.length >= SENTENCE_THRESHOLD && !excepted(file, text)) {
        offenders.push(`${shown(file)}:${line}: [${words.join(' ')}] ${text.replace(/\s+/g, ' ').slice(0, 60)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('every comment exception still matches a comment', () => {
  for (const e of COMMENT_EXCEPTIONS) {
    const file = e.file.split('/').join(sep);
    assert.ok(comments(file).some(({ text }) => text.includes(e.fragment)), `${e.file}: "${e.fragment}" no longer exists, drop the exception`);
  }
});

test('the sentence detector catches French without accents and spares English', () => {
  assert.ok(frenchWords(prose('// le garde ne voit pas les mots sans accent')).length >= SENTENCE_THRESHOLD);
  assert.ok(frenchWords(prose('/** Module vendu : ne tourne que si la licence le nomme. */')).length >= SENTENCE_THRESHOLD);
  assert.ok(frenchWords(prose('/** Commits de retard sur la base. */')).length >= SENTENCE_THRESHOLD);
  assert.ok(frenchWords(prose('// The guard reads the comments, not the lines, and spares a `les` quote.')).length < SENTENCE_THRESHOLD);
  assert.ok(frenchWords(prose('// A chain whose coder wrote `a tester Win/Mac` closes like any other')).length < SENTENCE_THRESHOLD);
});
