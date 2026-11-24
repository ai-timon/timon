/**
 * Compiles `app/sdk-guards/sdk-mirrors.ts`, the guards of the app's copies of
 * `@timon-ai/sdk` types (TODO #576).
 *
 * The app cannot import the SDK (its Docker context is `app/`), so its
 * copies used to drift unseen: a widget option the SDK documented and the
 * host ignored, a dictation event the host dropped. The guard file names
 * `packages/`, which only exists in the repository, so it is compiled here
 * rather than by `npm run typecheck`, and three things are checked:
 *   1. the guards hold;
 *   2. they bite: each mutation below, on either side, turns one red;
 *   3. every type of `src/` named like an SDK export is guarded — a new copy
 *      cannot slip in beside the others.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const APP = process.cwd();
const SRC = join(APP, 'src');
const GUARD = join(APP, 'sdk-guards', 'sdk-mirrors.ts');
const SDK_ENTRY = resolve(APP, '..', 'packages', 'sdk', 'src', 'index.ts');

/** Absolute path → replacement text, for the mutations. */
type Overrides = ReadonlyMap<string, string>;
type Failure = { alias: string; message: string };

const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile(join(APP, 'tsconfig.json'), ts.sys.readFile).config,
  ts.sys,
  APP,
);
const options: ts.CompilerOptions = { ...config.options, noEmit: true, incremental: false, plugins: [] };

// Unchanged files are parsed once for every program of this file.
const parsed = new Map<string, ts.SourceFile>();

function hostFor(overrides: Overrides): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const readFile = host.readFile.bind(host);
  host.readFile = (name) => overrides.get(resolve(name)) ?? readFile(name);
  host.getSourceFile = (name, version) => {
    const override = overrides.get(resolve(name));
    if (override !== undefined) return ts.createSourceFile(name, override, version, true);
    const cached = parsed.get(name);
    if (cached) return cached;
    const text = readFile(name);
    if (text === undefined) return undefined;
    const source = ts.createSourceFile(name, text, version, true);
    parsed.set(name, source);
    return source;
  };
  return host;
}

function compile(overrides: Overrides = new Map()): ts.Program {
  return ts.createProgram({ rootNames: [GUARD], options, host: hostFor(overrides) });
}

/** The guard's errors, each named by the type alias that holds it. */
function failures(program: ts.Program): Failure[] {
  const source = program.getSourceFile(GUARD);
  assert.ok(source, 'the guard file is not in the program');
  const diagnostics = [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)];
  return diagnostics.map((diagnostic) => {
    const holder = source.statements.find((statement) =>
      diagnostic.start !== undefined && statement.getStart(source) <= diagnostic.start && diagnostic.start < statement.end);
    const alias = holder && ts.isTypeAliasDeclaration(holder) ? holder.name.text : `line ${holder ? source.getLineAndCharacterOfPosition(holder.getStart(source)).line + 1 : '?'}`;
    return { alias, message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' ') };
  });
}

function withEdit(path: string, from: string, to: string): Overrides {
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes(from), `mutation anchor not found in ${relative(APP, path)}: ${JSON.stringify(from)}`);
  return new Map([[resolve(path), text.replace(from, to)]]);
}

/** Every exported type alias or interface of `src/` (tests aside), as `file#Name`. */
function appTypeExports(overrides: Overrides): Array<{ file: string; name: string }> {
  const found: Array<{ file: string; name: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!/\.tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue;
      const text = overrides.get(resolve(path)) ?? readFileSync(path, 'utf8');
      const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
      for (const statement of source.statements) {
        if (!ts.isTypeAliasDeclaration(statement) && !ts.isInterfaceDeclaration(statement)) continue;
        if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
        found.push({ file: resolve(path), name: statement.name.text });
      }
    }
  };
  walk(SRC);
  return found;
}

/** `file#Name` of every declaration a type in the guard file refers to, aliases followed. */
function guardedDeclarations(program: ts.Program): Set<string> {
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(GUARD);
  assert.ok(source);
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    const name = ts.isTypeReferenceNode(node) ? node.typeName : ts.isTypeQueryNode(node) ? node.exprName : null;
    if (name) {
      let symbol = checker.getSymbolAtLocation(name);
      if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
      for (const declaration of symbol?.declarations ?? []) out.add(`${resolve(declaration.getSourceFile().fileName)}#${symbol!.name}`);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/** App types named like an SDK export whose copy, or whose SDK side, no guard names. */
function unguardedTwins(program: ts.Program, overrides: Overrides): string[] {
  const checker = program.getTypeChecker();
  const entry = program.getSourceFile(SDK_ENTRY);
  assert.ok(entry, 'the SDK entry is not in the program');
  const entrySymbol = checker.getSymbolAtLocation(entry);
  assert.ok(entrySymbol);
  const sdkNames = new Set(checker.getExportsOfModule(entrySymbol).map((symbol) => symbol.name));
  const guarded = [...guardedDeclarations(program)];
  const appSide = new Set(guarded.filter((key) => key.startsWith(SRC)));
  const sdkSide = new Set(guarded.filter((key) => !key.startsWith(SRC)).map((key) => key.slice(key.lastIndexOf('#') + 1)));
  return appTypeExports(overrides)
    .filter(({ file, name }) => sdkNames.has(name) && !(appSide.has(`${file}#${name}`) && sdkSide.has(name)))
    .map(({ file, name }) => `${relative(APP, file).split(sep).join('/')} ${name}`);
}

const base = compile();

test('the SDK sources are reachable from app/ (repository checkout, not the Docker context)', () => {
  assert.ok(existsSync(SDK_ENTRY), `${SDK_ENTRY} is missing: run this test from a full checkout`);
  assert.ok(base.getSourceFile(SDK_ENTRY), 'the guard file no longer imports the SDK entry');
});

test('the guard file stays out of the app build, which has no packages/', () => {
  assert.ok(!config.fileNames.map((name) => resolve(name)).includes(GUARD),
    'sdk-guards/ is in tsconfig.json: `next build` would fail in the Docker context');
});

test('the app copies of SDK types hold their guards', () => {
  assert.deepEqual(failures(base), []);
});

test('every app type named like an SDK export is guarded', () => {
  assert.deepEqual(unguardedTwins(base, new Map()), [],
    'guard each in app/sdk-guards/sdk-mirrors.ts (Equals for a copy, Accepts for a view), or rename it if it is unrelated');
});

const SLOTS = join(SRC, 'lib', 'plugin-host', 'slots.ts');
const LOADER = join(SRC, 'lib', 'plugin-host', 'loader.ts');
const DICTATION = join(SRC, 'lib', 'dictation', 'contract.ts');
const BACKENDS = join(SRC, 'lib', 'backends.ts');
const DAEMON_BACKEND_TYPES = resolve(APP, '..', 'orchestrator', 'src', 'backends', 'types.ts');

const MUTATIONS: Array<{ name: string; edit: () => Overrides; expect: string }> = [
  {
    name: 'the SDK documents a widget option the host does not read',
    edit: () => withEdit(SDK_ENTRY, 'export type WidgetOptions = {\n', 'export type WidgetOptions = {\n  badge?: string;\n'),
    expect: '_WidgetOptions',
  },
  {
    name: 'the SDK publishes a host-only widget option',
    edit: () => withEdit(SDK_ENTRY, 'export type WidgetOptions = {\n', 'export type WidgetOptions = {\n  formerIds?: readonly string[];\n'),
    expect: '_HostOnlyWidgetKeysUnpublished',
  },
  {
    name: 'the host drops a dictation event the SDK lets an engine send',
    edit: () => withEdit(DICTATION, "\n  | { type: 'stopped' };", ';'),
    expect: '_DictationEvent',
  },
  {
    name: 'the context the host builds loses a member the SDK promises',
    edit: () => withEdit(LOADER, '    navigate: (href: string) => { window.location.assign(href); },\n', ''),
    expect: '_ContextKeys',
  },
  {
    name: 'a context member changes type under the SDK',
    edit: () => withEdit(LOADER, "theme: { current: () => document", 'theme: { current: (): string => document'),
    expect: '_ContextSatisfiesSdk',
  },
  {
    name: 'the host reads a register option the SDK does not declare',
    edit: () => withEdit(LOADER, '          order?: number;\n', '          order?: number;\n          secret?: string;\n'),
    expect: '_RegisterOptions',
  },
  {
    name: 'a host-only key leaves the app but stays listed',
    edit: () => withEdit(SLOTS, '  formerIds?: readonly string[];\n', ''),
    expect: '_HostOnlyWidgetKeysExist',
  },
  {
    name: 'the app catalogue view names a field the daemon does not send',
    edit: () => withEdit(BACKENDS, 'export type CatalogModel = {\n', 'export type CatalogModel = {\n  phantom?: string;\n'),
    expect: '_CatalogModelNoPhantom',
  },
  {
    name: 'the daemon renames a capability the app reads',
    edit: () => withEdit(DAEMON_BACKEND_TYPES, "'worktree', 'timonMcp',", "'worktree', 'timonTools',"),
    expect: '_BackendCapabilityView',
  },
];

for (const mutation of MUTATIONS) {
  test(`guard bites: ${mutation.name}`, () => {
    const found = failures(compile(mutation.edit()));
    assert.ok(found.some((failure) => failure.alias === mutation.expect),
      `expected ${mutation.expect} to fail, got ${JSON.stringify(found)}`);
  });
}

test('inventory bites: a new copy of an SDK type with no guard', () => {
  const overrides = withEdit(SLOTS, 'export type SlotKind =', 'export type WidgetChromeProps = { handle: unknown };\nexport type SlotKind =');
  assert.deepEqual(unguardedTwins(compile(overrides), overrides), ['src/lib/plugin-host/slots.ts WidgetChromeProps']);
});

test('inventory bites: a guard removed', () => {
  const overrides = withEdit(GUARD,
    'type _DictationSession = Assert<Equals<Dictation.DictationSession, Sdk.DictationSession>>;\n', '');
  assert.deepEqual(unguardedTwins(compile(overrides), overrides), ['src/lib/dictation/contract.ts DictationSession']);
});
