/**
 * Ratchet for the language rule of AGENTS.md: the daemon speaks English (CLI,
 * logs, notifications, route errors, the text an agent reads). TODO #545 then
 * TODO #628. Four checks over `src/` (tests and fixtures excluded) and `bin/`:
 *
 * 1. no `'fr-FR'` locale in `src/` — a hard-coded French locale put
 *    "jeu. 30 oct." inside English sentences on every tester's machine; dates
 *    in messages go through `message-dates.ts`;
 * 2. no string or template literal is French, whatever the file: literals
 *    are read with the TypeScript parser, so comments and regular expressions
 *    do not count. A literal is French when it carries a French letter, a
 *    French word that English never uses (`invalide`, `introuvable`…), or a
 *    space before a colon. The few legitimate ones are listed below with their
 *    reason;
 * 3. no file carries a French letter at all, comments included, unless it is
 *    in `english-messages-debt.json` (French comments not translated yet) or
 *    in `FRENCH_ON_PURPOSE`;
 * 4. the debt list only shrinks: a listed file that no longer has any French
 *    fails here until it is taken off the list.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = dirname(fileURLToPath(import.meta.url));
const BIN = join(SRC, '..', 'bin');

// french-ok-file: the French samples and patterns this guard tests

// `×` and `÷` share the Latin-1 range with accented letters: listed by hand.
// `«` and `»` count: English text uses straight quotes.
const FRENCH_LETTER = /[àâäçéèêëîïôöùûüÿœæÀÂÄÇÉÈÊËÎÏÔÖÙÛÜŸŒÆ«»]/;

// Whole French words that no English message uses, for the sentences that
// carry no accent at all: "id invalide", "purge de … impossible" and
// "Propositions en attente" went through the first version of this ratchet,
// which only looked for French letters (review of TODO #628).
const FRENCH_WORD = new RegExp('\\b(?:' + [
  'invalides?', 'introuvables?', 'requis', 'requises?', 'manquante?s?', 'aucune?',
  'impossible de', 'en attente', 'purge de', 'permutation de', 'capture de',
  'fichiers?', 'dossiers?', 'valeurs?', 'erreurs?', 'champs?', 'chemin', 'racine', 'jeton',
  'utilisateurs?', 'mot de passe', 'projets?', 'taches?', 'branche', 'conteneur', 'sauvegarde',
  'courante?', 'recherche', 'historique', 'rattrapage', 'propositions?',
  'depuis', 'avec', 'dans', 'cette', 'sont', 'vous', 'votre', 'jamais', 'toujours', 'encore',
  'rien', 'chaque', 'deja',
].join('|') + ')\\b', 'i');

// French typography puts a space before a colon ("plugin `x` : refused").
// A ternary inside a quoted snippet (`a ? b : c`) is the one English case.
const FRENCH_COLON = /[\p{L}`)\]] :(?: |$)/mu;

function isFrench(text: string): boolean {
  const plain = withoutLoanwords(text);
  return FRENCH_LETTER.test(plain) || FRENCH_WORD.test(plain)
    || (FRENCH_COLON.test(plain) && !/\?[^:]*:/.test(plain));
}

/** "façade" is an English word too, and the plugin contract is named after it. */
function withoutLoanwords(text: string): string {
  return text.replace(/[Ff]a[çÇ]ade|FAÇADE/g, 'facade');
}

/** Literals that must stay as they are, each with its reason. */
const LITERAL_EXCEPTIONS: ReadonlyArray<{ file: string; fragment: string; why: string }> = [
  {
    file: 'agent-roles.ts',
    fragment: 'Comment long → ',
    why: 'rewrites a stale sentence inside reviewer briefs seeded in French before TODO #523: the fix keeps their language',
  },
  {
    file: 'global-digest.ts',
    fragment: '- (à remplir)',
    why: 'placeholder of the French objectives.md written before TODO #628; files on disk are never rewritten',
  },
  {
    file: 'db.ts',
    fragment: "snippet(mission_search_fts, 0, '«', '»'",
    why: 'highlight markers of the mission search snippets, a contract with the app',
  },
  ...['«', '»'].map((quote) => ({
    file: '../bin/console-ascii.mjs',
    fragment: quote,
    why: 'the table that turns typographic quotes into ASCII for legacy Windows consoles',
  })),
];

/**
 * Whole files that carry French on purpose, outside any literal. The exemption
 * covers their code only: their comments stay checked by
 * `english-comments.test.ts`.
 */
const FRENCH_ON_PURPOSE: Readonly<Record<string, string>> = {
  'mission-titles.ts': 'strips the French quotes a model wraps a title in',
  'agent-roles.ts': 'rewrites a French sentence of reviewer briefs seeded before TODO #523 (see LITERAL_EXCEPTIONS)',
  'db.ts': 'the French quotes that mark the hits of mission search snippets (see LITERAL_EXCEPTIONS)',
  'global-digest.ts': 'recognises the placeholder of an objectives.md written in French (see LITERAL_EXCEPTIONS)',
  'memory-view.ts': 'reads the French target label of the proposals written before TODO #628',
  'todo-closure.ts': 'matches the French portability line of AGENTS.md rule 9',
  [join('host', 'service-install.ts')]: 'reads the status line of a localised Windows (statut, état) and quotes its French error',
  [join('..', 'bin', 'console-ascii.mjs')]: 'maps typographic characters to ASCII',
};

const DEBT_FILE = join(SRC, 'english-messages-debt.json');
const DEBT: ReadonlySet<string> = new Set(
  (JSON.parse(readFileSync(DEBT_FILE, 'utf8')) as { files: string[] }).files.map((file) => file.split('/').join(sep)),
);

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

/** Every file in scope, as a path relative to `src/` (bin files read `../bin/…`). */
function scope(): string[] {
  const bin = readdirSync(BIN, { withFileTypes: true })
    .filter((entry) => entry.isFile() && (entry.name.endsWith('.mjs') || !entry.name.includes('.')))
    .map((entry) => join(BIN, entry.name));
  return [...sources(SRC), ...bin].map((file) => relative(SRC, file));
}

function shown(file: string): string {
  return file.split(sep).join('/');
}

/** String and template literals of a file, with their line. */
function literals(file: string): Array<{ line: number; text: string }> {
  const text = readFileSync(join(SRC, file), 'utf8');
  const kind = file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  const out: Array<{ line: number; text: string }> = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)
      || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)
    ) {
      out.push({ line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1, text: node.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function excepted(file: string, text: string): boolean {
  return LITERAL_EXCEPTIONS.some((e) => shown(file) === e.file && text.includes(e.fragment));
}

test("no source of the daemon formats a date with the 'fr-FR' locale", () => {
  const offenders: string[] = [];
  for (const file of sources(SRC)) {
    readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      // `skills.ts` quotes `fr-FR` inside a grep pattern that hunts it in skills.
      if (/(['"`])fr-FR\1/.test(line)) offenders.push(`${shown(relative(SRC, file))}:${i + 1}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('no string literal of the daemon or its CLI is written in French', () => {
  const offenders: string[] = [];
  for (const file of scope()) {
    for (const { line, text } of literals(file)) {
      if (isFrench(text) && !excepted(file, text)) {
        offenders.push(`${shown(file)}:${line}: ${text.trim().slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

test('the ratchet sees French sentences that carry no accent', () => {
  for (const text of ['id invalide', 'Propositions en attente:', '[attachments] purge de x impossible',
    'conteneur hors compose : rebuild impossible', 'plugin `acme` : refused', 'Task blocked : x']) {
    assert.equal(isFrench(text), true, text);
  }
  for (const text of ['invalid id', 'Pending proposals:', 'plugin `acme`: refused', 'a non-empty string',
    "pour the work into it", 'reserved name (CON, PRN, AUX, NUL)', 'x ? y : z', 'façade']) {
    assert.equal(isFrench(text), false, text);
  }
});

test('every literal exception still matches a literal', () => {
  for (const e of LITERAL_EXCEPTIONS) {
    const file = e.file.split('/').join(sep);
    assert.ok(literals(file).some(({ text }) => text.includes(e.fragment)), `${e.file}: "${e.fragment}" no longer exists, drop the exception`);
  }
});

test('a file outside the debt list has no French at all, comments included', () => {
  const offenders: string[] = [];
  for (const file of scope()) {
    if (DEBT.has(file) || file in FRENCH_ON_PURPOSE) continue;
    readFileSync(join(SRC, file), 'utf8').split('\n').forEach((line, i) => {
      if (FRENCH_LETTER.test(withoutLoanwords(line))) offenders.push(`${shown(file)}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepEqual(offenders, []);
});

test('the French comment debt only shrinks', () => {
  const stale: string[] = [];
  for (const file of DEBT) {
    const path = join(SRC, file);
    if (!existsSync(path) || !FRENCH_LETTER.test(withoutLoanwords(readFileSync(path, 'utf8')))) stale.push(shown(file));
  }
  assert.deepEqual(stale, [], 'translated or removed: take these files off english-messages-debt.json');
});
