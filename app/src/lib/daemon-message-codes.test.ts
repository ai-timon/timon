/**
 * The daemon and English agree on stored message codes (TODO #845, sibling of
 * `api-error-codes.test.ts`).
 *
 * Every `daemonMessage('code', { … })` in `orchestrator/src` has its English
 * under `daemonMessages.<code>`: one message for a blocked reason, a `title`
 * (and `body`) for a notification. The arguments its English reads are exactly
 * the params the daemon sends, so the screen never shows `{name}`, and no key is
 * left without a caller.
 */
import { strict as assert } from 'node:assert';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

import { DEFAULT_PATHS, lookup, readLocaleDictionary } from '../../scripts/build-locales.mjs';
import { daemonMessageReaderParams } from './api-error';
import { parseMessage } from '../../scripts/check-locales.mjs';

const ORCHESTRATOR_SRC = join(process.cwd(), '..', 'orchestrator', 'src');
const english = readLocaleDictionary(join(DEFAULT_PATHS.sourceDir, 'en'));

type Use = { code: string; params: string[] | null; where: string };

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'node_modules') out.push(...sourceFiles(path));
    } else if (/\.ts$/.test(name) && !/\.(test|d)\.ts$/.test(name)) out.push(path);
  }
  return out;
}

function literalKeys(node: ts.Expression): string[] | null {
  if (!ts.isObjectLiteralExpression(node)) return null;
  const keys: string[] = [];
  for (const property of node.properties) {
    if ((ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
      && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) keys.push(property.name.text);
    else return null;
  }
  return keys;
}

function daemonUses(): { uses: Use[]; dynamic: string[] } {
  const uses: Use[] = [];
  const dynamic: string[] = [];
  for (const file of sourceFiles(ORCHESTRATOR_SRC)) {
    const path = relative(ORCHESTRATOR_SRC, file).split(sep).join('/');
    if (path === 'daemon-message.ts') continue;
    const text = readFileSync(file, 'utf8');
    if (!text.includes('daemonMessage(')) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'daemonMessage') {
        const [codeArg, paramsArg] = node.arguments;
        const where = `${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
        if (codeArg && ts.isStringLiteral(codeArg)) {
          uses.push({ code: codeArg.text, params: paramsArg ? literalKeys(paramsArg) : [], where });
        } else if (codeArg && !(ts.isPropertyAccessExpression(codeArg) && codeArg.name.text === 'code')) {
          // `daemonMessage(message.code, …)` rebuilds a message already checked where it was made.
          dynamic.push(where);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return { uses, dynamic };
}

/** The English messages of a code: itself, or its title and body. */
function messagesOf(code: string): string[] | null {
  const value = lookup(english, `daemonMessages.${code}`);
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') {
    const { title, body } = value as { title?: unknown; body?: unknown };
    if (typeof title !== 'string') return null;
    return typeof body === 'string' ? [title, body] : [title];
  }
  return null;
}

const { uses, dynamic } = daemonUses();

test('the scan finds the daemon producers', () => {
  assert.ok(uses.length >= 15, `only ${uses.length} daemonMessage calls found — did the helper move?`);
});

test('every code the daemon stores has an English message', () => {
  const missing = uses.filter((use) => messagesOf(use.code) === null);
  assert.deepEqual(missing.map((use) => `${use.where} → daemonMessages.${use.code}`), [],
    'add these codes to app/src/locales/en/daemonMessages.json');
});

test('every message reads exactly the params the daemon sends', () => {
  const wrong: string[] = [];
  for (const use of uses) {
    const messages = messagesOf(use.code);
    if (!messages || use.params === null) continue;
    const args = [...new Set(messages.flatMap((message) => [...parseMessage(message, 'en').args]))].sort();
    // The webview adds its own (`{settingsPath}`) when it reads the row.
    const params = [...use.params, ...daemonMessageReaderParams(use.code)].sort();
    if (args.join() !== params.join()) wrong.push(`${use.where} sends {${params.join(', ')}}, daemonMessages.${use.code} reads {${args.join(', ')}}`);
  }
  assert.deepEqual(wrong, []);
});

test('the code is a literal wherever it can be: a computed code escapes this check', () => {
  assert.deepEqual(dynamic, []);
});

test('no English message is left without a daemon producer', () => {
  const sent = new Set(uses.map((use) => use.code));
  const keys = Object.keys((english as { daemonMessages?: Record<string, unknown> }).daemonMessages ?? {});
  assert.deepEqual(keys.filter((code) => !sent.has(code)), []);
});
