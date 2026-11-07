/**
 * The core names no provider (`docs/PROVIDERS-SDK.md` § 4, volets 5b and 7).
 *
 * Until this test, adding a provider meant finding sixteen places that spelled the
 * names of the others: an npm package here, a folder there, an order of fallback, a
 * logo, a list of "CLIs that count". A third-party provider was second class for
 * that reason alone. The product's own providers now declare themselves in their
 * plugins — the profile in its code, the rest in its manifest
 * (`timon.provider.backends`, read by `builtin-declarations.ts`) — and the core
 * reads declarations.
 *
 * The test reads the code, comments aside: a string literal that IS a provider's
 * name, or an object key that is one, is refused in `orchestrator/src` and
 * `app/src` unless the file is on the list below with its reason and the volet that
 * removes it. The list only gets shorter: an entry that no longer matches anything
 * fails too. The names are the ones below AND every backend id the official
 * manifests declare, so a provider added tomorrow is covered without editing this file.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import ts from 'typescript';

process.env.TIMON_HOME ??= mkdtempSync(join(tmpdir(), 'timon-no-provider-names-'));
const { builtinProviderIds } = await import('./builtin-declarations.js');

const REPO = resolve(import.meta.dirname, '..', '..', '..');
const ROOTS = ['orchestrator/src', 'app/src'];

/** The product's backend ids, as its official plugins declare them. */
const PRODUCT_IDS = builtinProviderIds();
const PROVIDER_NAMES = new Set(['claude', 'codex', 'grok', 'copilot', 'opencode', 'hermes', 'hermes-acp', 'pi-acp', 'pi', 'kimi', 'ollama-cloud', ...PRODUCT_IDS]);
/** `pi` is also a number, and a key by that name is not a provider. */
const NOT_AS_KEY = new Set(['pi']);

type Exemption = { reason: string; until: string };

/** Paths relative to the repository, `/`-separated; a trailing `/` is a whole folder. */
const EXEMPT: Record<string, Exemption> = {
  'orchestrator/src/web-search.ts': { reason: 'Search routing is a fail-closed product rollout policy: exact official profiles qualify, never every profile sharing their dialect; opaque CLI permission files withhold routing', until: 'until other profiles prove independent native search suppression and permission translation' },
  'orchestrator/src/plugins/policy.ts': { reason: 'E13 — EXEC_DENIED / isSubscriptionCli: a plugin may not run the subscription CLIs for its own account; a denylist read from manifests would shrink when one is missing or altered, so it is written here, fail-closed', until: 'stays (security policy, lists names on purpose)' },
  'app/src/components/brand-mark.tsx': { reason: 'the logo registry: keys are logo names (a brand can outlive or precede a provider), not providers', until: 'stays (logo assets)' },
};

function exemption(file: string): string | undefined {
  return Object.keys(EXEMPT).find((entry) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry));
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return ['node_modules', 'dist', '.next', '__fixtures__', 'locales'].includes(name) ? [] : walk(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.|\.d\.ts$/.test(name) ? [path] : [];
  });
}

/** `line:text` of every provider name the code spells, comments aside. */
function hits(path: string): string[] {
  const source = readFileSync(path, 'utf8');
  const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const found: string[] = [];
  const at = (node: ts.Node): number => tree.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && PROVIDER_NAMES.has(node.text)) {
      found.push(`${at(node)}:'${node.text}'`);
    } else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && PROVIDER_NAMES.has(node.name.text) && !NOT_AS_KEY.has(node.name.text)) {
      found.push(`${at(node)}:${node.name.text}:`);
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
}

const scanned = ROOTS.flatMap((root) => walk(join(REPO, root)).map((path) => relative(REPO, path).split(sep).join('/')))
  .map((file) => ({ file, found: hits(join(REPO, file)) }))
  .filter(({ found }) => found.length > 0);

test('the core spells no provider name outside the declarations and the justified exceptions', () => {
  const offenders = scanned.filter(({ file }) => !exemption(file)).map(({ file, found }) => `${file} ${found.join(' ')}`);
  assert.deepEqual(offenders, [], 'read the declaration of the provider instead (profileDeclarations, the catalogue, the doctor report), or justify the file in EXEMPT');
});

test('every exception still matches something, and says why and until when', () => {
  for (const [entry, { reason, until }] of Object.entries(EXEMPT)) {
    assert.ok(reason.length > 10 && until.length > 3, entry);
    assert.ok(scanned.some(({ file }) => (entry.endsWith('/') ? file.startsWith(entry) : file === entry)), `${entry} no longer names a provider: remove it from EXEMPT`);
  }
});

test('the scan sees what it is meant to see', () => {
  const sample = ts.createSourceFile('x.ts', "const a = { claude: 1, pi: 3 }; const b = 'codex'; // 'grok'\nconst c = `kimi`; const d = 'not-a-provider';", ts.ScriptTarget.Latest, true);
  const names: string[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && PROVIDER_NAMES.has(node.text)) names.push(node.text);
    else if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && PROVIDER_NAMES.has(node.name.text) && !NOT_AS_KEY.has(node.name.text)) names.push(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sample);
  assert.deepEqual(names, ['claude', 'codex', 'kimi']);
});

test('the official manifests declare the product\'s backends', () => {
  for (const id of ['claude', 'codex', 'grok', 'copilot', 'opencode', 'hermes', 'pi', 'kimi', 'ollama-cloud']) assert.ok(PRODUCT_IDS.includes(id), id);
});

/**
 * Durable guard of volet 7: a profile of the product lives in its plugin. An object literal that carries
 * the `id` of a product backend next to a `dialect` is a profile declaration, refused anywhere in
 * `orchestrator/src` — the exemptions above included, and tests aside (a test may build one).
 */
test('no profile of a product backend is declared in orchestrator/src', () => {
  const declared: string[] = [];
  for (const path of walk(join(REPO, 'orchestrator/src'))) {
    const source = readFileSync(path, 'utf8');
    const tree = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isObjectLiteralExpression(node)) {
        const keys = new Map(node.properties.flatMap((prop) => (ts.isPropertyAssignment(prop) && (ts.isIdentifier(prop.name) || ts.isStringLiteral(prop.name))
          ? [[prop.name.text, prop.initializer] as const] : [])));
        const id = keys.get('id');
        if (id && keys.has('dialect') && ts.isStringLiteralLike(id) && PRODUCT_IDS.includes(id.text)) {
          declared.push(`${relative(REPO, path).split(sep).join('/')}:${tree.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${id.text}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  assert.deepEqual(declared, [], 'a product profile belongs to its official provider plugin (registerProductProfile)');
});
